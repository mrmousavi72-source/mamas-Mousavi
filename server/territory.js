// Territory geometry: turning a recorded loop into a polygon and resolving
// captures against other players' land. All coordinates are [lng, lat].
const turf = require('@turf/turf');
const { isInsideIran } = require('./iran');

const RULES = {
  // The loop must end within this distance of where it started.
  closeDistanceMeters: 200,
  minPoints: 4,
  minAreaSqMeters: 500,
  maxAreaSqMeters: 20_000_000, // 20 km² per single loop
  // Fastest plausible sustained speed per mode, used to reject vehicle trips.
  maxSpeedKmh: { run: 25, ride: 70 },
  // Share of segments allowed above the speed limit (GPS jumps happen).
  maxFastSegmentRatio: 0.1,
};

const MODES = Object.keys(RULES.maxSpeedKmh);

class ClaimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function distanceMeters(a, b) {
  return turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
}

function trackLengthMeters(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += distanceMeters(coords[i - 1], coords[i]);
  return total;
}

// points: [{ lat, lng, t }] where t is epoch milliseconds.
function validateTrack(points, mode) {
  if (!MODES.includes(mode)) throw new ClaimError('bad_mode', 'نوع فعالیت نامعتبر است.');
  if (!Array.isArray(points) || points.length < RULES.minPoints) {
    throw new ClaimError('too_short', 'مسیر خیلی کوتاه است.');
  }
  for (const p of points) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !Number.isFinite(p.t)) {
      throw new ClaimError('bad_point', 'داده‌ی مسیر نامعتبر است.');
    }
  }
  for (let i = 1; i < points.length; i++) {
    if (points[i].t < points[i - 1].t) throw new ClaimError('bad_time', 'زمان‌بندی مسیر نامعتبر است.');
  }

  const coords = points.map((p) => [p.lng, p.lat]);
  if (!coords.every(isInsideIran)) {
    throw new ClaimError('outside_iran', 'مسیر باید داخل ایران باشد.');
  }

  const gap = distanceMeters(coords[0], coords[coords.length - 1]);
  if (gap > RULES.closeDistanceMeters) {
    throw new ClaimError(
      'not_closed',
      `حلقه بسته نشده؛ باید در فاصله‌ی ${RULES.closeDistanceMeters} متری نقطه‌ی شروع تمام شود.`,
    );
  }

  let fast = 0;
  const limit = RULES.maxSpeedKmh[mode];
  for (let i = 1; i < points.length; i++) {
    const hours = (points[i].t - points[i - 1].t) / 3_600_000;
    const km = distanceMeters(coords[i - 1], coords[i]) / 1000;
    if (hours <= 0 ? km > 0.05 : km / hours > limit) fast++;
  }
  if (fast / (points.length - 1) > RULES.maxFastSegmentRatio) {
    throw new ClaimError('too_fast', 'سرعت غیرعادی است؛ فعالیت با وسیله‌ی نقلیه قابل قبول نیست.');
  }

  return coords;
}

// Union a list of polygon/multipolygon features; returns null when empty.
function unionAll(features) {
  const parts = features.filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return turf.union(turf.featureCollection(parts));
}

// GPS loops cross and retrace themselves (figure-eights, out-and-back spurs).
// Unioning the raw ring with itself makes the clipper rebuild it as valid
// polygons covering every enclosed area.
function loopToPolygon(coords) {
  let ring = turf.cleanCoords(turf.lineString(coords)).geometry.coordinates;
  // Drop a final point that already returns exactly to the start.
  const [first, last] = [ring[0], ring[ring.length - 1]];
  if (first[0] === last[0] && first[1] === last[1]) ring = ring.slice(0, -1);
  // The closing segment back to the start becomes part of the boundary.
  ring = [...ring, ring[0]];
  if (ring.length < 4) throw new ClaimError('too_short', 'مسیر خیلی کوتاه است.');

  let poly;
  try {
    const raw = turf.polygon([ring]);
    poly = turf.union(turf.featureCollection([raw, raw]));
  } catch {
    poly = null;
  }
  if (!poly) throw new ClaimError('bad_shape', 'شکل مسیر قابل پردازش نیست.');

  const area = turf.area(poly);
  if (area < RULES.minAreaSqMeters) throw new ClaimError('too_small', 'مساحت حلقه خیلی کم است.');
  if (area > RULES.maxAreaSqMeters) throw new ClaimError('too_large', 'مساحت حلقه بیش از حد مجاز است.');
  return poly;
}

// Remnants smaller than a claimable loop are slivers; drop them entirely.
function geometryOrNull(feature) {
  if (!feature) return null;
  const parts = turf.flatten(feature).features.filter((p) => turf.area(p) >= RULES.minAreaSqMeters);
  return unionAll(parts)?.geometry ?? null;
}

// Resolve a claim. `claim` is the new polygon feature, `own` is the claimer's
// current geometry (or null), `others` is [{ userId, geometry }]. Returns the
// claimer's merged geometry, every changed rival geometry, and how much
// area was taken from each rival.
function resolveCapture(claim, own, others) {
  const merged = unionAll([own && turf.feature(own), claim]);
  const losses = [];
  for (const rival of others) {
    const before = turf.feature(rival.geometry);
    if (!turf.booleanIntersects(before, claim)) continue;
    const remaining = geometryOrNull(turf.difference(turf.featureCollection([before, claim])));
    const taken = turf.area(before) - (remaining ? turf.area(remaining) : 0);
    if (taken < 1) continue;
    losses.push({ userId: rival.userId, geometry: remaining, takenSqMeters: taken });
  }
  return { geometry: merged.geometry, losses };
}

function bboxOf(geometry) {
  return geometry ? turf.bbox(geometry) : null;
}

function areaOf(geometry) {
  return geometry ? turf.area(geometry) : 0;
}

module.exports = {
  RULES,
  MODES,
  ClaimError,
  validateTrack,
  loopToPolygon,
  resolveCapture,
  trackLengthMeters,
  bboxOf,
  areaOf,
};
