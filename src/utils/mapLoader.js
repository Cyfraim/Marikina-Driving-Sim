// ---------------------------------------------------------------------------
// mapLoader.js - Google Maps Static API helper (satellite minimap)
//
// Kinukuha ang satellite tile ng Nangka mula sa Google Maps Static API at
// inilalagay ito bilang texture. Kung walang key (o may error), nag-fallback
// tayo sa vector minimap mula sa roadData.js - laro pa rin, satellite lang
// ang nawawala.
//
// Ang key ay galing sa .env: GOOGLE_MAPS_API_KEY=... (huwag i-commit!)
// Vite ang nag-e-expose nito bilang import.meta.env.GOOGLE_MAPS_API_KEY
// dahil envPrefix = ['VITE_', 'GOOGLE_MAPS_'] sa vite.config.js
// ---------------------------------------------------------------------------

// FIX 2: DEFENSIVE. Sa browser (Vite) nandoon ang import.meta.env, pero sa
// ay nagta-throw ng TypeError at PAPATAYIN ang buong test run. Ginagawa namin
// ay nagtatÃ¦Å â€ºÃ¥â€¡Âº ng TypeError at PAPATAYIN ang buong test run. Ginagawa namin
// itong optional chaining para gumana sa dalawang environment.
const RAW_KEY = (import.meta.env && import.meta.env.GOOGLE_MAPS_API_KEY) || '';

// placeholder pa (halimbawa "your_key_here") = para pa ring walang key
const PLACEHOLDERS = ['', 'your_key_here', 'your-key-here', 'xxx', 'changeme'];

/** Tunay na ba ang key (hindi placeholder)? */
export function hasApiKey() {
  const k = String(RAW_KEY).trim();
  if (!k) return false;
  return !PLACEHOLDERS.includes(k.toLowerCase());
}

export function getApiKey() {
  return hasApiKey() ? String(RAW_KEY).trim() : null;
}

/**
 * Metres per pixel sa isang zoom level (Web Mercator).
 * Ito ang ginagamit para i-scale ang dev reference plane at i-tile
 * ang minimap nang eksakto sa totoong mundo.
 */
export function metersPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

/**
 * URL ng satellite tile para sa ibinigay na center/size/zoom.
 * Lahat ng opsyonal na param (markers, path) ay puwedeng isama.
 */
export function buildStaticMapUrl({
  center,        // { lat, lon }
  zoom = 16,
  width = 640,
  height = 640,
  mapType = 'satellite',
  scale = 1,     // 1 = 640px, 2 = 1280px device pixels
  markers = null // [{ lat, lon, color, label }]
} = {}) {
  if (!hasApiKey() || !center) return null;
  const params = new URLSearchParams({
    center: `${center.lat},${center.lon}`,
    zoom: String(zoom),
    size: `${width}x${height}`,
    scale: String(scale),
    maptype: mapType,
    key: getApiKey()
  });
  if (markers && markers.length) {
    // limit 5 markers bawat static map request
    const m = markers.slice(0, 5).map((mk) =>
      `${mk.color || 'red'}|${mk.label || ''}|${mk.lat},${mk.lon}`
    ).join('|');
    params.set('markers', m);
  }
  return `https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`;
}

/**
 * I-load ang satellite image (naka-cache). Nagbabalik ng Promise<Image>.
 * Nagre-resolve sa null kapag walang key o may loading error - kaya
 * ligtas ang fallback chain.
 */
const imageCache = new Map();

export function loadSatelliteImage(opts = {}) {
  const url = buildStaticMapUrl(opts);
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return imageCache.get(url);

  const promise = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn('[mapLoader] Hindi na-load ang Google Static Map image.');
      resolve(null);
    };
    img.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

/** Malinis ang cache (para sa pag-i-toggle o pag-reload ng key). */
export function clearMapCache() {
  imageCache.clear();
}