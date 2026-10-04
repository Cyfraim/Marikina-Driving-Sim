// ---------------------------------------------------------------------------
// geo.js - GPS -> Three.js scene coordinate conversion para sa Nangka map
//
// Equirectangular approximation, centred on MAP_ORIGIN (barangay centre).
// 1 scene unit = 1 metre ("1:1000 scale": ang 1 km na kalsada = 1000 units).
// Axes: +x = east, -z = north (so north is "up" on the minimap).
// ---------------------------------------------------------------------------
import { MAP_ORIGIN } from '../world/roadData.js';
import { riverDistance, WATER_Y } from './riverGeometry.js';

// Same constants as tools/generate-road-data.ps1 so both sides agree exactly
const M_PER_DEG_LAT = 111132;
const M_PER_DEG_LON = 111320 * Math.cos((MAP_ORIGIN.lat * Math.PI) / 180); // ~107,716 m

/** Convert latitude/longitude to local scene units {x, z}. */
export function gpsToLocal(lat, lon) {
  return {
    x: (lon - MAP_ORIGIN.lon) * M_PER_DEG_LON,
    z: -(lat - MAP_ORIGIN.lat) * M_PER_DEG_LAT,
  };
}

/** Inverse: local scene units back to {lat, lon} (used by minimap overlays). */
export function localToGps(x, z) {
  return {
    lat: MAP_ORIGIN.lat - z / M_PER_DEG_LAT,
    lon: MAP_ORIGIN.lon + x / M_PER_DEG_LON,
  };
}

/**
 * Extent of the drivable map in metres from the centre.
 * Fix 2: the map grew from the Nangka-only 600 m radius to the whole of
 * Marikina City. Measured extents of the generated roadData.js:
 *   x -2692 .. +3769 m, z -4223 .. +4112 m  ->  4223 m is the largest
 *   magnitude on either axis.
 */
export const MAP_EXTENT = 4300;

// Stylized valley, not an elevation survey. Zero noise, 2m rise over 800m
// away from the ACTUAL river banks; no fake east-side river or mountain ramp.
export const TERRAIN_MAX = WATER_Y + 2;
export function terrainHeight(x, z) {
  const river = riverDistance(x, z);
  if (river.centerDistance < river.halfWidth) return 0;
  return WATER_Y + Math.min(800, river.bankDistance) * (2 / 800);
}

/** Taas ng lupa sa isang GPS point. */
export function terrainHeightAt(lat, lon) {
  const p = gpsToLocal(lat, lon);
  return terrainHeight(p.x, p.z);
}

