/* Forest.js - every tree on the island.

   Placement is deterministic (a jittered grid driven by Island masks), so
   all players have the same trees with the same ids; only the felled list
   travels over the network and into the save.

   Drawing, per species/variant:
     lod 0  (< near0)  full model, casts shadows
     lod 1  (< near1)  lighter model
     impostor          one instanced mesh for the whole island: two crossed
                       quads textured from a baked atlas; it dithers itself
                       out inside near1 so the hand-over does not pop.
   The near instance lists are rebuilt a few times a second around the camera.

   A tree that is being chopped is "promoted": Chop.js draws it as its own
   mesh and the instanced copies skip it (state 1). A felled tree leaves a
   stump (state 2). */
import * as THREE from '../../lib/three.module.js';
import { Grid2, hash2, clamp, lerp } from '../core/Util.js';
import { SPECIES, VARIANTS, model, materials, bakeImpostors } from '../art/Trees.js';
import { foliage } from '../core/Shading.js';
import { tex } from '../core/Textures.js';
import { HALF } from './Island.js';

const SPACING = 6.4;
export const STANDING = 0, PROMOTED = 1, FELLED = 2, GONE = 3;

export class Forest {
  constructor(island, renderer) {
    this.island = island;
    this.group = new THREE.Group(); this.group.name = 'forest';
    this.trees = []; this.grid = new Grid2(16);
    this.near0 = 60; this.near1 = 150;
    this._generate();
    this.M = materials();
    this._buildNear();
    this._buildImpostors(renderer);
    this._buildStumps();
    this._last = new THREE.Vector3(1e9, 0, 0); this._t = 0;
    this.dirty = true;
  }

  /* ------------------------------------------------------------ placement */
  _generate() {
    const isl = this.island;
    let id = 0;
    for (let z = -HALF + 8; z < HALF - 8; z += SPACING) for (let x = -HALF + 8; x < HALF - 8; x += SPACING) {
      const gx = Math.round(x / SPACING), gz = Math.round(z / SPACING);
      const r1 = hash2(gx, gz, 1), r2 = hash2(gx, gz, 2), r3 = hash2(gx, gz, 3), r4 = hash2(gx, gz, 4);
      const px = x + (r1 - 0.5) * SPACING * 0.95, pz = z + (r2 - 0.5) * SPACING * 0.95;
      const f = isl.forestAt(px, pz);
      if (f <= 0.02 || r3 > f * 0.82) continue;
      const y = isl.height(px, pz);
      if (y < 1.5 || isl.waterDepth(px, pz) > 0.05) continue;
      const wet = isl.wetAt(px, pz), burn = isl.burnAt(px, pz), au = isl.autumnAt(px, pz), mead = isl.meadowAt(px, pz);
      let sp;
      if (burn > 0.55) { if (r4 > 0.45 + burn * 0.4) continue; sp = 'dead'; }
      else if (wet > 0.65) sp = r4 < 0.55 ? 'dead' : r4 < 0.85 ? 'birch' : 'fir';
      else if (au > 0.45 && r4 < au * 0.85) sp = r4 < au * 0.55 ? 'maple' : 'birch';
      else if (mead > 0.25 && r4 < 0.35) sp = r4 < 0.22 ? 'fir' : 'birch';
      else sp = r4 < 0.19 ? 'fir' : r4 < 0.23 ? 'birch' : 'pine';
      const v = Math.floor(hash2(gx, gz, 5) * VARIANTS);
      const m = model(sp, v, 0);
      // size: pines are tall in deep forest, stunted up high
      let s = 0.75 + hash2(gx, gz, 6) * 0.5;
      if (sp === 'pine') s *= lerp(1.12, 0.7, clamp((y - 80) / 120, 0, 1)) * (0.85 + f * 0.25);
      if (sp === 'fir') s *= 0.6 + hash2(gx, gz, 7) * 0.7;
      const t = {
        id: id++, sp, v, x: px, y, z: pz, s, rot: hash2(gx, gz, 8) * Math.PI * 2,
        r: m.radius * s * (sp === 'fir' ? 1 : 1.05), h: m.height * s, state: STANDING,
        charred: sp === 'dead' && burn > 0.55, tint: hash2(gx, gz, 9),
      };
      this.trees.push(t); this.grid.add(t, px, pz);
    }
  }

  /* ------------------------------------------------------------ near instances */
  _buildNear() {
    const cap0 = 1600, cap1 = 3200;
    this.sets = [];
    const col = new THREE.Color();
    for (const sp of SPECIES) for (let v = 0; v < VARIANTS; v++) for (const lod of [0, 1]) {
      const m = model(sp, v, lod), cap = lod ? cap1 : cap0;
      const trunk = new THREE.InstancedMesh(m.trunk, this.M.bark[sp], cap);
      trunk.count = 0; trunk.castShadow = lod === 0; trunk.receiveShadow = true; trunk.frustumCulled = false;
      trunk.customDepthMaterial = this.M.depth[sp + 'Bark'];
      this.group.add(trunk);
      let leaves = null;
      if (m.leaves) {
        leaves = new THREE.InstancedMesh(m.leaves, this.M.leaves[sp], cap);
        leaves.count = 0; leaves.castShadow = lod === 0; leaves.receiveShadow = true; leaves.frustumCulled = false;
        leaves.customDepthMaterial = this.M.depth[sp];
        // per-instance tint (a few greener, a few browner)
        for (let i = 0; i < cap; i++) leaves.setColorAt(i, col.setRGB(1, 1, 1));
        this.group.add(leaves);
      }
      for (let i = 0; i < cap; i++) trunk.setColorAt(i, col.setRGB(1, 1, 1));
      this.sets.push({ sp, v, lod, trunk, leaves, cap });
    }
    this.setOf = (sp, v, lod) => this.sets[(SPECIES.indexOf(sp) * VARIANTS + v) * 2 + lod];
  }

  /* ------------------------------------------------------------ impostors */
  _buildImpostors(renderer) {
    const baked = bakeImpostors(renderer);
    this.baked = baked;
    // two crossed unit quads; aView tells the shader which atlas cell to use
    const P = [], U = [], V = [], Nn = [], I = [];
    for (let q = 0; q < 2; q++) {
      const a = q * Math.PI / 2, cx = Math.cos(a), cz = Math.sin(a), b = P.length / 3;
      const corners = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
      for (const [s, y] of corners) {
        P.push(cx * s, y, cz * s); U.push(s + 0.5, y); V.push(q);
        // normals lean up and outward so the quads take light like a crown
        const nx = -cz * 0.35, nz = cx * 0.35; const l = Math.hypot(nx, 0.9, nz); Nn.push(nx / l, 0.9 / l, nz / l);
      }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(Nn, 3));
    g.setAttribute('aView', new THREE.Float32BufferAttribute(V, 1));
    g.setIndex(I);
    const n = this.trees.length;
    const aCell = new Float32Array(n * 4), aTint = new Float32Array(n);
    const mat = new THREE.MeshStandardMaterial({ map: baked.texture, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.9 });
    this.impMat = mat;
    const uNear = { value: this.near1 };
    this.uNear = uNear;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (sh, r) => {
      prev.call(mat, sh, r);
      sh.uniforms.uNear = uNear;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aView; attribute vec4 aCell; attribute float aTint; uniform float uNear; varying float vFade; varying float vTint;')
        .replace('#include <uv_vertex>', `#include <uv_vertex>
          vec2 cu = aView < 0.5 ? aCell.xy : aCell.zw;
          vMapUv = vec2(mix(cu.x, cu.y, uv.x), uv.y);`)
        .replace('#include <project_vertex>', `
          vec3 ipos = instanceMatrix[3].xyz;
          float dcam = distance(ipos.xz, cameraPosition.xz);
          vFade = smoothstep(uNear - 14.0, uNear, dcam);
          vTint = aTint;
          #include <project_vertex>
          if (vFade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFade; varying float vTint;')
        .replace('#include <map_fragment>', `#include <map_fragment>
          if (fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453) > vFade) discard;
          diffuseColor.rgb *= mix(vec3(0.85, 0.95, 0.85), vec3(1.1, 1.0, 0.9), vTint);`);
    };
    foliage(mat, { translucency: 0.35 });
    const im = new THREE.InstancedMesh(g, mat, n);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < n; i++) {
      const t = this.trees[i], info = baked.info[t.sp + t.v];
      const c0 = baked.info[t.sp + t.v + ':0'], c1 = baked.info[t.sp + t.v + ':1'];
      aCell.set([c0[0], c0[2], c1[0], c1[2]], i * 4);
      aTint[i] = t.tint;
      q.setFromAxisAngle(up, t.rot);
      m4.compose(p.set(t.x, t.y - 0.3, t.z), q, s.set(info.w * t.s, info.h * t.s, info.w * t.s));
      im.setMatrixAt(i, m4);
    }
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(aCell, 4));
    g.setAttribute('aTint', new THREE.InstancedBufferAttribute(aTint, 1));
    im.frustumCulled = false; im.castShadow = false; im.receiveShadow = false;
    this.impostors = im;
    this.group.add(im);
  }
  _hideImpostor(t) {
    const m4 = new THREE.Matrix4().makeScale(0, 0, 0);
    this.impostors.setMatrixAt(t.id, m4); this.impostors.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------ stumps */
  _buildStumps() {
    const t = tex('barkPine'), e = tex('logEnd');
    const side = new THREE.CylinderGeometry(1, 1.15, 1, 12, 1, true); side.translate(0, 0.5, 0);
    const top = new THREE.CircleGeometry(1, 16); top.rotateX(-Math.PI / 2); top.translate(0, 1, 0);
    const endMap = e.map.clone(); endMap.wrapS = endMap.wrapT = THREE.ClampToEdgeWrapping; endMap.needsUpdate = true;
    this.stumpSide = new THREE.InstancedMesh(side, new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughness: 0.95 }), 4000);
    this.stumpTop = new THREE.InstancedMesh(top, new THREE.MeshStandardMaterial({ map: endMap, roughness: 0.8 }), 4000);
    for (const m of [this.stumpSide, this.stumpTop]) { m.count = 0; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; this.group.add(m); }
  }
  _rebuildStumps() {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    for (const t of this.trees) {
      if (t.state !== FELLED && t.state !== GONE) continue;
      if (n >= 4000) break;
      q.setFromAxisAngle(up, t.rot);
      const hgt = t.stumpH || 0.85;
      m4.compose(p.set(t.x, t.y - 0.25, t.z), q, s.set(t.r * 1.05, hgt + 0.25, t.r * 1.05));
      this.stumpSide.setMatrixAt(n, m4); this.stumpTop.setMatrixAt(n, m4); n++;
    }
    this.stumpSide.count = this.stumpTop.count = n;
    this.stumpSide.instanceMatrix.needsUpdate = this.stumpTop.instanceMatrix.needsUpdate = true;
  }

  /* ------------------------------------------------------------ per frame */
  setQuality(q) {
    this.near0 = q === 'high' ? 70 : q === 'medium' ? 52 : 36;
    this.near1 = q === 'high' ? 170 : q === 'medium' ? 135 : 100;
    this.uNear.value = this.near1; this.dirty = true;
  }
  update(dt, camPos) {
    this._t -= dt;
    const moved = this._last.distanceToSquared(camPos) > 16;
    if (!this.dirty && !(moved && this._t <= 0)) return;
    this._t = 0.2; this.dirty = false; this._last.copy(camPos);
    for (const s of this.sets) s.n = 0;
    const m4 = this._m4 || (this._m4 = new THREE.Matrix4()), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const r0 = this.near0 * this.near0, r1 = this.near1 * this.near1;
    this.grid.near(camPos.x, camPos.z, this.near1, (t) => {
      if (t.state !== STANDING) return;
      const d = (t.x - camPos.x) ** 2 + (t.z - camPos.z) ** 2; if (d > r1) return;
      const set = this.setOf(t.sp, t.v, d < r0 ? 0 : 1);
      if (set.n >= set.cap) return;
      q.setFromAxisAngle(up, t.rot);
      m4.compose(p.set(t.x, t.y, t.z), q, sc.set(t.s, t.s, t.s));
      set.trunk.setMatrixAt(set.n, m4);
      if (t.charred) set.trunk.setColorAt(set.n, col.setRGB(0.18, 0.16, 0.15)); else set.trunk.setColorAt(set.n, col.setRGB(1, 1, 1));
      if (set.leaves) {
        set.leaves.setMatrixAt(set.n, m4);
        const k = t.tint;
        if (t.sp === 'maple') col.setRGB(lerp(0.85, 1.1, k), lerp(0.7, 1.15, k), lerp(0.7, 0.9, k));
        else col.setRGB(lerp(0.82, 1.08, k), lerp(0.9, 1.05, k), lerp(0.82, 0.95, k));
        set.leaves.setColorAt(set.n, col);
      }
      set.n++;
    });
    for (const s of this.sets) {
      s.trunk.count = s.n; s.trunk.instanceMatrix.needsUpdate = true; if (s.trunk.instanceColor) s.trunk.instanceColor.needsUpdate = true;
      if (s.leaves) { s.leaves.count = s.n; s.leaves.instanceMatrix.needsUpdate = true; if (s.leaves.instanceColor) s.leaves.instanceColor.needsUpdate = true; }
    }
  }

  /* ------------------------------------------------------------ queries & state */
  /** trees whose trunk is within r of (x,z): calls fn(tree, dist) */
  near(x, z, r, fn) {
    this.grid.near(x, z, r + 2, (t) => { if (t.state === GONE) return; const d = Math.hypot(t.x - x, t.z - z); if (d < r + t.r) fn(t, d); });
  }
  /** push a circle (x,z,rad) out of trunks and stumps; returns corrected [x,z] */
  collide(x, z, rad) {
    this.grid.near(x, z, rad + 2, (t) => {
      if (t.state === GONE || t.state === PROMOTED && t.fallen) return;
      const rr = t.r + rad, dx = x - t.x, dz = z - t.z, d2 = dx * dx + dz * dz;
      if (d2 < rr * rr && d2 > 1e-6) { const d = Math.sqrt(d2), k = (rr - d) / d; x += dx * k; z += dz * k; }
    });
    return [x, z];
  }
  /** the first standing trunk hit by a ray (origin o, dir d normalised, max distance) */
  raycast(o, d, maxD) {
    let best = null, bt = maxD;
    const steps = Math.ceil(maxD / 8);
    const seen = new Set();
    for (let s = 0; s <= steps; s++) {
      const px = o.x + d.x * s * 8, pz = o.z + d.z * s * 8;
      this.grid.near(px, pz, 10, (t) => {
        if (seen.has(t) || t.state === GONE || t.state === FELLED) return; seen.add(t);
        // ray vs vertical cylinder (2D) and then check the hit height
        const ox = o.x - t.x, oz = o.z - t.z, a = d.x * d.x + d.z * d.z; if (a < 1e-6) return;
        const b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - t.r * t.r, disc = b * b - 4 * a * c;
        if (disc < 0) return;
        const tt = (-b - Math.sqrt(disc)) / (2 * a);
        if (tt < 0 || tt > bt) return;
        const hy = o.y + d.y * tt;
        if (hy < t.y - 0.5 || hy > t.y + t.h) return;
        bt = tt; best = { tree: t, dist: tt, point: new THREE.Vector3(o.x + d.x * tt, hy, o.z + d.z * tt) };
      });
    }
    return best;
  }
  get(id) { return this.trees[id]; }
  setState(id, state, extra) {
    const t = this.trees[id]; if (!t) return;
    t.state = state; if (extra) Object.assign(t, extra);
    if (state !== STANDING) this._hideImpostor(t);
    if (state === FELLED || state === GONE) this._rebuildStumps();
    this.dirty = true;
  }
  /** restore from a save: {id: state} */
  applySaved(map) {
    let any = false;
    for (const k in map) { const t = this.trees[+k]; if (!t) continue; t.state = map[k] === GONE ? GONE : FELLED; this._hideImpostor(t); any = true; }
    if (any) this._rebuildStumps();
    this.dirty = true;
  }
}
