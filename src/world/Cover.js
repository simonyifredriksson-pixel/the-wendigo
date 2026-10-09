/* Cover.js - everything on the forest floor that is too small to place
   globally: grass clumps, ferns, bushes, red-leaved plants, mushrooms,
   pebbles and rocks, fallen branches. It is generated per 16 m tile from a
   hash of the tile (so it is the same for every player and every visit) and
   streamed around the camera; each kind has its own radius and density
   driven by the Island masks.

   Grass shrinks to nothing at the edge of its radius (in the shader) so
   the streaming never pops. Rocks and boulders that block movement are not
   here - see Scatter in World.js. */
import * as THREE from '../../lib/three.module.js';
import { hash2, clamp, lerp, rng } from '../core/Util.js';
import { mergeGeos, xf, cardCross, noisify } from '../core/Geo.js';
import { tex } from '../core/Textures.js';
import { windify, foliage, GU } from '../core/Shading.js';

const TILE = 16;

function grassClump() {
  const r = rng(3), parts = [];
  for (let b = 0; b < 7; b++) {
    const a = r() * Math.PI * 2, off = r() * 0.18, h = 0.35 + r() * 0.45, w = 0.035 + r() * 0.025, lean = 0.12 + r() * 0.25;
    const P = [], C = [], I = [], Nn = [], U = [];
    const ox = Math.cos(a) * off, oz = Math.sin(a) * off, dx = Math.cos(a + 1.3), dz = Math.sin(a + 1.3), lx = Math.cos(a) * lean, lz = Math.sin(a) * lean;
    const S = 4;
    for (let i = 0; i <= S; i++) {
      const t = i / S, ww = w * (1 - t * 0.92), y = h * t, bend = t * t;
      for (const s of [-1, 1]) {
        P.push(ox + lx * bend + dx * ww * s, y, oz + lz * bend + dz * ww * s);
        const g = lerp(0.25, 1, t);
        C.push(g, g, g); Nn.push(lx * 0.4, 1, lz * 0.4); U.push(s < 0 ? 0 : 1, t);
      }
    }
    for (let i = 0; i < S; i++) { const k = i * 2; I.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setIndex(I);
    parts.push(g);
  }
  return mergeGeos(parts);
}
function fernGeo() {
  const parts = [];
  for (let k = 0; k < 5; k++) {
    const g = new THREE.PlaneGeometry(0.55, 1.2, 1, 3);
    // arch the frond: tip droops outward and down
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) { const y = p.getY(i) + 0.6; const t = y / 1.2; p.setXYZ(i, p.getX(i), y * 0.75 - t * t * 0.35, t * t * 0.7 + t * 0.25); }
    g.computeVertexNormals();
    const n = g.attributes.normal; for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0.3);
    xf(g, { r: [0, k / 5 * Math.PI * 2 + 0.3, 0] });
    parts.push(g);
  }
  return mergeGeos(parts);
}
function bushGeo() {
  const parts = [];
  const r = rng(8);
  for (let k = 0; k < 6; k++) {
    const g = new THREE.PlaneGeometry(1.3, 1.3);
    xf(g, { r: [(r() - 0.5) * 0.9, r() * Math.PI, 0], p: [(r() - 0.5) * 0.6, 0.55 + r() * 0.35, (r() - 0.5) * 0.6] });
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i) - 0.4, z = p.getZ(i), l = Math.hypot(x, y, z) || 1; n.setXYZ(i, x / l, y / l + 0.3, z / l); }
    parts.push(g);
  }
  return mergeGeos(parts);
}
function redPlantGeo() {
  // little sprigs of red leaves on thin stems (the red dots of the reference forest)
  const parts = [], r = rng(12);
  for (let k = 0; k < 4; k++) {
    const g = new THREE.PlaneGeometry(0.22, 0.22);
    xf(g, { r: [-1.0 + r() * 0.6, r() * Math.PI * 2, 0], p: [(r() - 0.5) * 0.3, 0.25 + r() * 0.35, (r() - 0.5) * 0.3] });
    parts.push(g);
  }
  return mergeGeos(parts);
}
function mushroomGeo() {
  const parts = [];
  for (let k = 0; k < 3; k++) {
    const s = 0.6 + k * 0.25;
    const stem = new THREE.CylinderGeometry(0.012 * s, 0.016 * s, 0.07 * s, 6); xf(stem, { p: [k * 0.05 - 0.05, 0.035 * s, (k % 2) * 0.04] });
    const cap = new THREE.SphereGeometry(0.04 * s, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2); xf(cap, { p: [k * 0.05 - 0.05, 0.065 * s, (k % 2) * 0.04], s: [1, 0.6, 1] });
    parts.push(stem, cap);
  }
  return mergeGeos(parts);
}
function pebbleGeo(seed, detail = 1) {
  const g = new THREE.IcosahedronGeometry(0.5, detail);
  noisify(g, 0.16, 1.6, seed);
  xf(g, { s: [1, 0.55, 0.85], p: [0, 0.12, 0] });
  return g;
}
function branchGeo() {
  const r = rng(4), parts = [];
  const main = new THREE.CylinderGeometry(0.025, 0.04, 1.6, 5); xf(main, { r: [0, 0, Math.PI / 2], p: [0, 0.04, 0] }); parts.push(main);
  for (let k = 0; k < 3; k++) { const t = new THREE.CylinderGeometry(0.008, 0.015, 0.45, 4); xf(t, { r: [0, r() * 3, Math.PI / 2 + (r() - 0.5)], p: [(r() - 0.5) * 1.2, 0.05, (r() - 0.5) * 0.2] }); parts.push(t); }
  return mergeGeos(parts);
}

export class Cover {
  constructor(island, forest) {
    this.island = island; this.forest = forest;
    this.group = new THREE.Group(); this.group.name = 'cover';
    this.uGrassR = { value: 34 };
    const grassMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 0.85, color: 0xffffff });
    windify(grassMat, { mode: 'grass', height: 0.8, bend: 1 });
    const gPrev = grassMat.onBeforeCompile;
    grassMat.onBeforeCompile = (sh, r) => {
      gPrev.call(grassMat, sh, r); sh.uniforms.uGrassR = this.uGrassR;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uGrassR;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
          { float dg = distance(instanceMatrix[3].xz, cameraPosition.xz); transformed *= smoothstep(uGrassR, uGrassR * 0.7, dg); }
          #endif`);
    };
    foliage(grassMat, { translucency: 0.5 });
    const card = (name, color = 0xffffff, transl = 0.5, h = 1) => {
      const t = tex(name);
      const m = new THREE.MeshStandardMaterial({ map: t.map, color, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 });
      return foliage(windify(m, { mode: 'grass', height: h, bend: 0.6 }), { translucency: transl });
    };
    const redMat = new THREE.MeshStandardMaterial({ map: tex('leavesAutumn').map, color: 0xd02010, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.7 });
    foliage(windify(redMat, { mode: 'grass', height: 0.6 }), { translucency: 0.9 });
    const rockT = tex('rock');
    const rockMat = new THREE.MeshStandardMaterial({ map: rockT.map, normalMap: rockT.normalMap, roughness: 0.92, color: 0xb8b4ac });
    const woodMat = new THREE.MeshStandardMaterial({ map: tex('barkOak').map, roughness: 0.95, color: 0x8a7a6a });
    const mushMat = new THREE.MeshStandardMaterial({ color: 0xb08a5e, roughness: 0.7 });
    // kind: geometry, material, radius, cap, density fn(x,z,y) per m², scale range, shadows
    const I = this.island;
    this.kinds = [
      { name: 'grass', geo: grassClump(), mat: grassMat, R: 34, cap: 26000, s: [0.7, 1.35], tilt: 0.15, dens: (x, z, y) => this._open(x, z, y) * 1.5 + 0.18 * I.forestAt(x, z) * (1 - I.burnAt(x, z)), color: true },
      { name: 'fern', geo: fernGeo(), mat: card('fern', 0xd8e8c8, 0.6, 1.2), R: 60, cap: 9000, s: [0.6, 1.3], dens: (x, z, y) => this._floor(x, z, y) * 0.16, shadow: true },
      { name: 'bush', geo: bushGeo(), mat: card('bush', 0xe0e8d0, 0.55, 1.2), R: 80, cap: 3500, s: [0.6, 1.4], dens: (x, z, y) => (this._floor(x, z, y) * 0.03 + this._open(x, z, y) * 0.012) * (1 - I.burnAt(x, z)), shadow: true },
      { name: 'red', geo: redPlantGeo(), mat: redMat, R: 45, cap: 5000, s: [0.6, 1.4], dens: (x, z, y) => this._floor(x, z, y) * 0.05 + this._open(x, z, y) * 0.02 },
      { name: 'mushroom', geo: mushroomGeo(), mat: mushMat, R: 30, cap: 1200, s: [0.8, 1.6], dens: (x, z, y) => this._floor(x, z, y) * 0.015 + I.wetAt(x, z) * 0.01 },
      { name: 'pebble', geo: pebbleGeo(1, 1), mat: rockMat, R: 70, cap: 4000, s: [0.15, 0.7], tilt: 0.5, dens: (x, z, y) => 0.012 + this._steep(x, z) * 0.05, shadow: true },
      { name: 'rock', geo: pebbleGeo(7, 2), mat: rockMat, R: 140, cap: 1200, s: [0.9, 2.2], tilt: 0.4, dens: (x, z, y) => 0.0018 + this._steep(x, z) * 0.012, shadow: true },
      { name: 'branch', geo: branchGeo(), mat: woodMat, R: 50, cap: 2500, s: [0.6, 1.3], tilt: 0.1, dens: (x, z, y) => this._floor(x, z, y) * 0.03, shadow: true },
    ];
    for (const k of this.kinds) {
      k.mesh = new THREE.InstancedMesh(k.geo, k.mat, k.cap);
      k.mesh.count = 0; k.mesh.frustumCulled = false; k.mesh.castShadow = !!k.shadow; k.mesh.receiveShadow = true;
      if (k.color) for (let i = 0; i < k.cap; i++) k.mesh.setColorAt(i, new THREE.Color(1, 1, 1));
      this.group.add(k.mesh);
    }
    this.cache = new Map();
    this._last = new THREE.Vector3(1e9, 0, 0);
    this.density = 1;
  }
  _open(x, z, y) { const I = this.island; if (y < 1.6) return 0; return clamp(1 - I.forestAt(x, z) * 1.4, 0, 1) * (1 - I.wetAt(x, z) * 0.6) * (1 - I.burnAt(x, z)) * (y > 170 ? 0.2 : 1) * (1 - this._steep(x, z)); }
  _floor(x, z, y) { const I = this.island; if (y < 1.6) return 0; return I.forestAt(x, z) * (1 - I.burnAt(x, z) * 0.9) * (1 - this._steep(x, z) * 0.8); }
  _steep(x, z) { const g = this.island.grad(x, z); return clamp((Math.hypot(g.x, g.z) - 0.45) * 2.5, 0, 1); }

  /** instance data for one kind in one tile (cached) */
  _tile(k, ki, tx, tz) {
    const key = ki * 1e8 + (tx + 5000) * 1e4 + (tz + 5000);
    let c = this.cache.get(key);
    if (c) { c.used = this._frame; return c; }
    const I = this.island, out = [], cols = [];
    const x0 = tx * TILE, z0 = tz * TILE;
    // expected count from the density at the tile centre, then each candidate re-tests its own spot
    const cy = I.height(x0 + TILE / 2, z0 + TILE / 2);
    const dMax = Math.max(k.dens(x0 + TILE / 2, z0 + TILE / 2, cy), k.dens(x0, z0, I.height(x0, z0)), k.dens(x0 + TILE, z0 + TILE, I.height(x0 + TILE, z0 + TILE))) * 1.3 * this.density;
    const n = Math.min(400, Math.ceil(dMax * TILE * TILE));
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), s = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const h1 = hash2(tx * 131 + i, tz * 71 - i, ki * 7 + 1), h2 = hash2(tx * 17 - i, tz * 37 + i, ki * 7 + 2), h3 = hash2(tx + i * 3, tz - i * 5, ki * 7 + 3);
      const x = x0 + h1 * TILE, z = z0 + h2 * TILE, y = I.height(x, z);
      const d = k.dens(x, z, y) * this.density;
      if (h3 * dMax > d) continue;
      if (I.waterDepth(x, z) > 0.02) continue;
      let blocked = false;
      this.forest.grid.near(x, z, 1.5, t => { if (Math.hypot(t.x - x, t.z - z) < t.r + 0.25) blocked = true; });
      if (blocked) continue;
      const sc = lerp(k.s[0], k.s[1], hash2(i, tx + tz, ki));
      const tilt = k.tilt || 0.08;
      e.set((hash2(i, tx, 3) - 0.5) * tilt, hash2(i, tz, 4) * Math.PI * 2, (hash2(tz, i, 5) - 0.5) * tilt);
      q.setFromEuler(e);
      m4.compose(p.set(x, y - (k.name === 'rock' ? sc * 0.25 : 0.02), z), q, s.set(sc, sc, sc));
      out.push(...m4.elements);
      if (k.color) {
        // grass: greener in the forest, dry gold in exposed meadows and up high
        const dry = clamp(I.meadowAt(x, z) * 0.6 + (y - 60) / 200 + (hash2(x | 0, z | 0, 9) - 0.5) * 0.3, 0, 1);
        cols.push(lerp(0.36, 0.62, dry), lerp(0.5, 0.56, dry), lerp(0.2, 0.26, dry));
      }
    }
    c = { m: new Float32Array(out), c: k.color ? new Float32Array(cols) : null, used: this._frame };
    this.cache.set(key, c);
    return c;
  }
  setQuality(q) { this.density = q === 'high' ? 1 : q === 'medium' ? 0.7 : 0.45; this.uGrassR.value = q === 'high' ? 34 : q === 'medium' ? 28 : 22; this.cache.clear(); this._last.set(1e9, 0, 0); }
  update(camPos) {
    if (this._last.distanceToSquared(camPos) < 36) return;
    this._last.copy(camPos);
    this._frame = (this._frame || 0) + 1;
    this.kinds.forEach((k, ki) => {
      const R = k.name === 'grass' ? this.uGrassR.value : k.R;
      const t0x = Math.floor((camPos.x - R) / TILE), t1x = Math.floor((camPos.x + R) / TILE), t0z = Math.floor((camPos.z - R) / TILE), t1z = Math.floor((camPos.z + R) / TILE);
      let n = 0;
      const arr = k.mesh.instanceMatrix.array, carr = k.mesh.instanceColor ? k.mesh.instanceColor.array : null;
      for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
        const cx = (tx + 0.5) * TILE - camPos.x, cz = (tz + 0.5) * TILE - camPos.z;
        if (cx * cx + cz * cz > (R + TILE) * (R + TILE)) continue;
        const c = this._tile(k, ki, tx, tz);
        const cnt = c.m.length / 16;
        if (n + cnt > k.cap) continue;
        arr.set(c.m, n * 16);
        if (carr && c.c) carr.set(c.c, n * 3);
        n += cnt;
      }
      k.mesh.count = n; k.mesh.instanceMatrix.needsUpdate = true; if (carr) k.mesh.instanceColor.needsUpdate = true;
    });
    // forget tiles we have not used for a while
    if (this.cache.size > 6000) for (const [key, c] of this.cache) if (this._frame - c.used > 30) this.cache.delete(key);
  }
}
