// ---------------------------------------------------------------------------
// geo.js - GPS -> Three.js scene coordinate conversion para sa Nangka map
//
// Equirectangular approximation, centred on MAP_ORIGIN (barangay centre).
// 1 scene unit = 1 metre ("1:1000 scale": ang 1 km na kalsada = 1000 units).
// Axes: +x = east, -z = north (so north is "up" on the minimap).
// ---------------------------------------------------------------------------
import { MAP_ORIGIN } from '../world/roadData.js';

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

// ---------------------------------------------------------------------------
// TERRAIN - Marikina River floodplain
//
// Real Marikina: ang lupa ay bahagyang nakaslungsong - mas mataas sa WEST
// (Papamin/Palayan side) at bumababa patungo sa SILANGAN kung saan ang
// Marikina River. Banayad na 0-3 m na gradient sa buong mapa.
//
// Ang terrainHeight(x, z) ay sinusukat sa METRES mula sa sea level at
// tinatawag ng Roads/Buildings/Vegetation/StreetObjects/Vehicle upang
// lahat ay nasa lupa (hindi lumulutang sa ere).
//
// FIX 2: ang lahat ng constants dito ay na-rescale para sa buong Marikina.
// Ang dating map ay 1200 m lang, kaya RIVER_X=268 at GRADIENT_SPAN=900.
// Sa 9 km na mapa dapat ang tilt mag-umpisa sa kanlanging gilid (x=-4500)
// at pumunta sa ilog (x=+860).
// ---------------------------------------------------------------------------

// River channel runs N-S through eastern Marikina. Real position is about
// lon 121.113, which is (121.113 - 121.105) x 107,700 ~= 860 m east of the
// new MAP_ORIGIN.
export const RIVER_X = 860;
export const RIVER_HALF_WIDTH = 26;

// Kanlanging gilid ng mapa - dito pinakamataas ang lupa.
export const WEST_EDGE = -4500;
// --- Fix 4: Marikina ay patag na RIVER VALLEY, walang kabundukan --------
// Ang dating GRADIENT_M = 3.0 ay may kasamang +-0.7 m na undulation,
// kaya ang SUKAT naVariation ay 3.855 m (higit sa 3 m ng spec) - sa
// malalaking distansya ito ay nagmumukhang banayad na mga "kabundukan".
// Ang totoong Marikina ay patag: ang tanging elevation change ay ang
// banayad na pagbagsak patungo sa Marikina River sa silangan.
// GRADIENT_M + undulation ay limitado sa < 3 m (beripikado sa check-*)
const GRADIENT_M = 2.3;
const GRADIENT_SPAN = RIVER_X - WEST_EDGE; // 5360 m across the whole city

// Banayad na cross-slope + micro-undulation para hindi ito perfect na ramp.
// Ang amplitudes ay maliit (0.35 m total) - dapat hindi bumuo ng burol.
function undulation(x, z) {
  return (
    Math.sin(x * 0.0042) * 0.14 +
    Math.cos(z * 0.0031) * 0.12 +
    Math.sin((x + z) * 0.0017) * 0.09
  );
}

/** Taas ng lupa (metres) sa world (x, z). ~0 = antas ng tubig ng river. */
export function terrainHeight(x, z) {
  // t: 0 sa kanlanging gilid -> 1 sa kahingan ng ilog
  const t = Math.max(0, Math.min(1, (x - WEST_EDGE) / GRADIENT_SPAN));
  let h = (1 - t) * GRADIENT_M + undulation(x, z);
  // i-flat sa bandahan ng river para tama ang water plane
  if (x > RIVER_X - 60) {
    const k = Math.max(0, Math.min(1, (x - (RIVER_X - 60)) / 60));
    h = h * (1 - k) + 0.15 * k;
  }
  return h;
}

/** Taas ng lupa sa isang GPS point. */
export function terrainHeightAt(lat, lon) {
  const p = gpsToLocal(lat, lon);
  return terrainHeight(p.x, p.z);
}

