// Checked geographic anchors; deliberately low-poly approximate models.
import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { gpsToLocal, terrainHeight } from '../utils/geo.js';
import { LANDMARKS } from './landmarkData.js';
import { ROAD_LINES, distToPolyline, nearestDistanceOnRoad, sampleRoad } from '../utils/roadLayout.js';

export class Landmarks {
  constructor(scene) {
    this.group = new THREE.Group(); this.group.name = 'Marikina landmarks';
    this.collisionBoxes = []; this.obbColliders = []; this.positions = [];
    scene.add(this.group);
  }
  build() {
    for (const data of LANDMARKS) this.buildLandmark(data);
  }
  buildLandmark(data) {
    const { x, z } = gpsToLocal(...data.gps), gy = terrainHeight(x, z);
    let nearest = null, distance = Infinity;
    for (const road of ROAD_LINES) {
      if (road.cls === 'service' || road.cls === 'track') continue;
      const d = distToPolyline(x, z, road.pts);
      if (d < distance) { distance = d; nearest = road; }
    }
    const roadPoint = nearest ? sampleRoad(nearest.i, nearestDistanceOnRoad(nearest.i, x, z).along, 0) : { x, z: z + 1 };
    const yaw = Math.atan2(roadPoint.x - x, roadPoint.z - z);
    const group = new THREE.Group(); group.name = data.label;
    group.userData.landmarkId = data.id; group.userData.gps = data.gps;
    const mesh = new ColoredMeshBuilder();
    // Point anchors are not surveyed footprints: fit the stylized model inside
    // the available road clearance instead of blocking surrounding streets.
    let available = Infinity;
    for (const road of ROAD_LINES) available = Math.min(available, distToPolyline(x, z, road.pts) - road.half - 1.5);
    const footprintScale = Math.min(1, Math.max(0.1, available / (Math.hypot(data.width, data.depth) / 2 + 0.6)));
    const w = data.width * footprintScale, d = data.depth * footprintScale, h = data.height;
    const point = (lx, lz) => ({ x: x + lx * Math.cos(yaw) + lz * Math.sin(yaw), z: z - lx * Math.sin(yaw) + lz * Math.cos(yaw) });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w + data.grounds * 2, d + data.grounds * 2),
      new THREE.MeshStandardMaterial({ color: 0xbab8af, roughness: 0.95 }));
    ground.rotation.set(-Math.PI / 2, 0, -yaw); ground.position.set(x, gy + 0.025, z);
    ground.receiveShadow = true; group.add(ground);
    mesh.box(x, gy + h / 2, z, w, h, d, data.wall, yaw);
    mesh.box(x, gy + h + 0.25, z, w + 0.6, 0.5, d + 0.6, data.roof, yaw);
    if (data.id === 'parish') {
      mesh.gable(x, gy + h + 0.5, z, w + 1, d + 1, 3, data.roof, yaw);
      const tower = point(-w / 2 + 2.6, -d / 2 + 2.6);
      mesh.box(tower.x, gy + 7.5, tower.z, 5, 15, 5, 0xf3f0e8, yaw);
      mesh.gable(tower.x, gy + 15, tower.z, 5.4, 5.4, 1.4, data.roof, yaw);
      const cross = point(0, d / 2 + 0.12);
      mesh.box(cross.x, gy + h + 1, cross.z, 0.3, 2, 0.2, 0x777777, yaw);
      mesh.box(cross.x, gy + h + 1.3, cross.z, 1.3, 0.3, 0.2, 0x777777, yaw);
      // Arched doorway: rectangular lower opening + low-poly semicircle.
      const front = point(0, d / 2 + 0.08);
      mesh.box(front.x, gy + 1.5, front.z, 3, 3, 0.12, 0x423b35, yaw);
      for (let i = 0; i < 8; i++) {
        const a = Math.PI * i / 8, b = Math.PI * (i + 1) / 8;
        const p = point(1.5 * Math.cos(a), d / 2 + 0.15), q = point(1.5 * Math.cos(b), d / 2 + 0.15);
        mesh.tri([front.x, gy + 3, front.z], [p.x, gy + 3 + 1.5 * Math.sin(a), p.z],
          [q.x, gy + 3 + 1.5 * Math.sin(b), q.z], 0x423b35, [Math.sin(yaw), 0, Math.cos(yaw)]);
      }
      this.addCollider(tower.x, gy, tower.z, 5, 5, 16.4, yaw);
    } else {
      for (let i = -2; i <= 2; i++) {
        const p = point(i * w / 6, d / 2 + 0.08);
        mesh.box(p.x, gy + 1.7, p.z, w / 9, 3.4, 0.12, 0x35414a, yaw);
      }
    }
    const geometry = mesh.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
    geometry.castShadow = true; group.add(geometry);
    this.addSign(group, data.label, point(0, d / 2 + 0.2), gy + h - 1.1, w * 0.9, yaw, data.id === 'market' ? '#27683b' : '#264e6a');
    this.group.add(group);
    this.addCollider(x, gy, z, w, d, h, yaw);
    this.positions.push({ id: data.id, x, z, y: gy, yaw, width: w, depth: d, footprintScale });
  }
  addCollider(x, y, z, w, d, h, yaw) {
    this.obbColliders.push({ x, z, y: y + h / 2, hx: w / 2, hz: d / 2, hy: h / 2,
      cos: Math.cos(yaw), sin: Math.sin(yaw) });
  }
  addSign(group, label, p, y, width, yaw, color) {
    let texture = null;
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 96;
      const ctx = canvas.getContext?.('2d');
      if (ctx) {
        ctx.fillStyle = color; ctx.fillRect?.(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#ffffff'; ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, canvas.width / 2, canvas.height / 2, 980);
        texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      }
    }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, 1.4), new THREE.MeshBasicMaterial({
      map: texture, color: texture ? 0xffffff : color, side: THREE.DoubleSide }));
    sign.name = label; sign.position.set(p.x, y, p.z); sign.rotation.y = yaw; group.add(sign);
  }
  getCollisionBoxes() { return this.collisionBoxes; }
}