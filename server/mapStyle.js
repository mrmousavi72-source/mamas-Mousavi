// MapLibre style for the base map. With a local Iran PMTiles extract the map
// is fully self-hosted vector tiles with Persian labels; without it, the
// public OpenStreetMap raster tiles are used.
const fs = require('node:fs');
const basemaps = require('@protomaps/basemaps');

const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// `{origin}` is replaced in the browser: MapLibre needs absolute asset URLs.
function vectorStyle() {
  return {
    version: 8,
    glyphs: '{origin}/map-assets/fonts/{fontstack}/{range}.pbf',
    sprite: '{origin}/map-assets/sprites/light',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles://{origin}/map/iran.pmtiles',
        attribution: ATTRIBUTION,
      },
    },
    layers: basemaps.layers('protomaps', basemaps.namedFlavor('light'), { lang: 'fa' }),
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
