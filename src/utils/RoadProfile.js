// Isang source of truth: carriageway is never widened for props or traffic.
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const DEFAULT_WIDTH = {
  motorway: 17.5, trunk: 14, primary: 9, secondary: 14, tertiary: 7,
  residential: 5.5, unclassified: 5.5, living_street: 5, service: 3.5, track: 3,
};
const number = (value) => {
  const match = /\d+(?:\.\d+)?/.exec(String(value ?? ''));
  return match ? Number(match[0]) : 0;
};

export function defaultSidewalkWidth(cls) {
  if (['service', 'track', 'living_street', 'motorway'].includes(cls)) return 0;
  return ['primary', 'secondary', 'trunk'].includes(cls) ? 2.5 : 1.5;
}

export function oneWayDirection(tags = {}) {
  const value = String(tags.oneway ?? '').toLowerCase();
  if (value === '-1' || value === 'reverse') return -1;
  if (['yes', 'true', '1'].includes(value)) return 1;
  if (['no', 'false', '0'].includes(value)) return 0;
  return tags.junction === 'roundabout' || tags.highway === 'motorway' ? 1 : 0;
}

export function createRoadProfile(tags = {}, cls = tags.highway || 'residential') {
  const explicitLanes = number(tags.lanes);
  const carriageWidth = number(tags.width) ||
    (explicitLanes ? explicitLanes * (MAJOR.has(cls) ? 3.5 : 2.75) : DEFAULT_WIDTH[cls] || 5.5);
  const laneCount = explicitLanes || Math.max(1, Math.floor(carriageWidth / (MAJOR.has(cls) ? 3.5 : 2.75)));
  const sw = String(tags.sidewalk ?? '');
  const sidewalk = defaultSidewalkWidth(cls);
  const sideWidth = (side) => {
    const sideTag = tags[`sidewalk:${side}`] ?? tags['sidewalk:both'];
    if (['no', 'none', 'separate'].includes(sideTag) || ['no', 'none', 'separate'].includes(sw)) return 0;
    if (sw === (side === 'left' ? 'right' : 'left')) return 0;
    return number(tags[`sidewalk:${side}:width`]) || sidewalk;
  };
  const surface = String(tags.surface || '');
  const unpaved = ['unpaved', 'ground', 'gravel', 'dirt', 'earth', 'grass', 'sand', 'mud'];
  const surfaceType = unpaved.includes(surface) ? 'unpaved' :
    surface === 'asphalt' ? 'asphalt' : ['concrete', 'paved'].includes(surface) ? 'concrete' :
      MAJOR.has(cls) ? 'asphalt' : 'concrete';
  const canal = tags.waterway === 'canal' || tags.waterway === 'drain' ||
    ['yes', 'canal', 'drain', 'ditch'].includes(tags.drainage) ||
    ['yes', 'canal', 'drain'].includes(tags.canal);
  return {
    carriageWidth, laneCount,
    leftSidewalkWidth: sideWidth('left'), rightSidewalkWidth: sideWidth('right'),
    shoulderWidth: cls === 'primary' ? 0.5 : 0,
    parkingWidth: carriageWidth > 8 ? 2 : 0,
    drainageWidth: canal ? 0.6 : 0,
    surfaceType, isOneWay: oneWayDirection(tags) !== 0,
  };
}

// Legacy/synthetic roads in tools remain supported; generated roads carry profile.
export function getRoadProfile(road) {
  if (road.profile) return road.profile;
  return createRoadProfile({
    ...road.tags, width: road.w ?? (road.half !== undefined ? road.half * 2 : undefined),
    sidewalk: road.sw, surface: road.surf,
  }, road.cls);
}

export function canRunTraffic(road) { return getRoadProfile(road).carriageWidth >= 6; }
export function canPark(road) {
  const profile = getRoadProfile(road);
  return profile.carriageWidth >= 6 && profile.parkingWidth > 0;
}