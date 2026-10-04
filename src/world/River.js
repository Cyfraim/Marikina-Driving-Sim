import * as THREE from 'three';
import { ColoredMeshBuilder } from '../utils/coloredMesh.js';
import { RIVER_SEGMENTS, WATER_Y, BANK_HEIGHT, clipPolygon, clipLine } from '../utils/riverGeometry.js';

export class River {
  constructor() { this.collisionBoxes = []; }
  build(bounds, target) {
    const water = new ColoredMeshBuilder(), banks = new ColoredMeshBuilder();
    for (const s of RIVER_SEGMENTS) {
      const polygon = clipPolygon([s.leftA, s.leftB, s.rightB, s.rightA], bounds);
      for (let i = 1; i + 1 < polygon.length; i++) {
        const p = [polygon[0], polygon[i], polygon[i + 1]].map(v => [v.x, WATER_Y, v.z]);
        water.tri(...p, 0x1a3a4a, [0, 1, 0]);
      }
      for (const [a, b] of [[s.leftA, s.leftB], [s.rightA, s.rightB]]) {
        const line = clipLine(a, b, bounds);
        if (!line) continue;
        const [p, q] = line;
        banks.quad([p.x, WATER_Y, p.z], [q.x, WATER_Y, q.z],
          [q.x, WATER_Y + BANK_HEIGHT, q.z], [p.x, WATER_Y + BANK_HEIGHT, p.z], 0x888888);
      }
    }
    if (water.count) {
      const mesh = water.build(new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.25, metalness: 0.15, side: THREE.DoubleSide }));
      mesh.name = 'Marikina River water'; mesh.castShadow = false; target.add(mesh);
    }
    if (banks.count) {
      const mesh = banks.build(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
      mesh.name = 'Marikina River concrete banks'; mesh.castShadow = false; target.add(mesh);
    }
  }
}