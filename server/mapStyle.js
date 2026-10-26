// MapLibre style for the base map. With a local Iran PMTiles extract the map
// is fully self-hosted vector tiles with Persian labels; without it, the
// public OpenStreetMap raster tiles are used.
const fs = require('node:fs');
const basemaps = require('@protomaps/basemaps');

const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Slate night map: muted streets so the players' colours carry the map.
const FLAVOR = {
  ...basemaps.namedFlavor('dark'),
  background: '#2a2e33',
  earth: '#2a2e33',
  buildings: '#23272c',
  water: '#1b2440',
  park_a: '#24372f',
  park_b: '#24372f',
  wood_a: '#273530',
  wood_b: '#273530',
  minor_service: '#3a4047',
  minor_a: '#414850',
  minor_b: '#3a4047',
  other: '#3a4047',
  link: '#4a5159',
  major: '#4a5159',
  highway: '#5a626c',
  bridges_major: '#4a5159',
  bridges_highway: '#5a626c',
  minor_casing: '#2a2e33',
  major_casing_early: '#2a2e33',
  roads_label_minor: '#9aa1aa',
  roads_label_minor_halo: '#2a2e33',
  roads_label_major: '#c4c9d0',
  roads_label_major_halo: '#2a2e33',
  subplace_label: '#d6dae0',
  subplace_label_halo: '#1d2024',
  city_label: '#ffffff',
  city_label_halo: '#1d2024',
  country_label: '#c4c9d0',
  boundaries: '#6b7280',
};

// `{origin}` is replaced in the browser: MapLibre needs absolute asset URLs.
function vectorStyle() {
  return {
    version: 8,
    glyphs: '{origin}/map-assets/fonts/{fontstack}/{range}.pbf',
    sprite: '{origin}/map-assets/sprites/dark',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://{origin}/map/iran.pmtiles',
        attribution: ATTRIBUTION,
      },
    },
    layers: basemaps.layers('protomaps', FLAVOR, { lang: 'fa' }),
  };
}

function rasterStyle() {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: ATTRIBUTION,
      },
    },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
  };
}

function mapStyle(tilesPath) {
  return tilesPath && fs.existsSync(tilesPath) ? vectorStyle() : rasterStyle();
}

module.exports = { mapStyle };
