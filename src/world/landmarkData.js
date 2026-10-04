// Checked OSM-derived point locations (2026-10-04). Models are stylized, not surveyed footprints.
// Source IDs and URLs retained for reproducible location review.
export const LANDMARKS = [
  { id: 'market', label: 'MARIKINA PUBLIC MARKET', gps: [14.633, 121.09621], width: 40, depth: 30, height: 7,
    source: 'https://mapcarta.com/W124349760', osmWayId: 124349760, roof: 0x888888, wall: 0xc8c8c8, grounds: 4 },
  { id: 'sports', label: 'MARIKINA SPORTS CENTER', gps: [14.63459, 121.09846], width: 60, depth: 40, height: 10,
    source: 'https://mapcarta.com/W4392196', osmWayId: 4392196, roof: 0x4a6b8a, wall: 0xd6d6ce, grounds: 14 },
  { id: 'parish', label: 'IMMACULATE CONCEPTION PARISH', gps: [14.6514, 121.10417], width: 22, depth: 34, height: 9,
    source: 'https://mapcarta.com/W5367185', osmWayId: 5367185, roof: 0x8b2525, wall: 0xf3f0e8, grounds: 8 },
  { id: 'museum', label: 'MARIKINA SHOE MUSEUM', gps: [14.62946, 121.09638], width: 24, depth: 14, height: 4,
    source: 'https://mapcarta.com/W93063146', osmWayId: 93063146, roof: 0x8b2525, wall: 0xd5c7b2, grounds: 3 },
];
// User-selected starting area, NOT asserted to be the Nangka barangay hall.
export const SPAWN_GPS = [14.6512, 121.1086];