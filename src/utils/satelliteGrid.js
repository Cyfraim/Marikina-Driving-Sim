import { gpsToLocal, localToGps } from './geo.js';

const worldPixel = (lat, lon, zoom) => {
  const size = 256 * 2 ** zoom;
  const sine = Math.sin(lat * Math.PI / 180);
  return { x: (lon + 180) / 360 * size, y: (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size };
};
const pixelGps = (x, y, zoom) => {
  const size = 256 * 2 ** zoom;
  return { lon: x / size * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI };
};

/** Adjacent Mercator pixel bounds mapped into the SAME projection as vector roads. */
export function satelliteGrid(x, z, zoom = 16, size = 640) {
  const gps = localToGps(x, z);
  const pixel = worldPixel(gps.lat, gps.lon, zoom);
  const tiles = [];
  for (let row = -1; row <= 1; row++) for (let col = -1; col <= 1; col++) {
    const px = pixel.x + col * size, py = pixel.y + row * size;
    const center = pixelGps(px, py, zoom);
    const nw = pixelGps(px - size / 2, py - size / 2, zoom);
    const se = pixelGps(px + size / 2, py + size / 2, zoom);
    const min = gpsToLocal(nw.lat, nw.lon), max = gpsToLocal(se.lat, se.lon);
    tiles.push({ center, minX: min.x, minZ: min.z, maxX: max.x, maxZ: max.z });
  }
  return tiles;
}