import { ROADS, MAP_ORIGIN } from '../src/world/roadData.js';
const MPD_LAT = 111132;
const MPD_LON = 111320 * Math.cos(MAP_ORIGIN.lat * Math.PI/180);
const toLocal = ([lat,lon]) => ({ x:(lon-MAP_ORIGIN.lon)*MPD_LON, z:-(lat-MAP_ORIGIN.lat)*MPD_LAT });
function dSeg(px,pz,a,b){const dx=b.x-a.x,dz=b.z-a.z,l2=dx*dx+dz*dz;let t=l2?((px-a.x)*dx+(pz-a.z)*dz)/l2:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(a.x+dx*t),pz-(a.z+dz*t));}
let best={d:Infinity};let minX=1e9,maxX=-1e9,minZ=1e9,maxZ=-1e9,totalPts=0;
for(const r of ROADS){const pts=r.pts.map(toLocal);totalPts+=pts.length;for(const p of pts){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minZ=Math.min(minZ,p.z);maxZ=Math.max(maxZ,p.z);}for(let i=0;i<pts.length-1;i++){const d=dSeg(0,0,pts[i],pts[i+1]);if(d<best.d)best={d,name:r.name,cls:r.cls,w:r.w};}}
console.log('spawn dist to nearest road:', best);
console.log('map bounds x:', Math.round(minX), Math.round(maxX), ' z:', Math.round(minZ), Math.round(maxZ));
console.log('total points:', totalPts, ' roads:', ROADS.length);

