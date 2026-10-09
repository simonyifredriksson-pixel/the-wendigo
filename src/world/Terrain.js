/* Terrain.js - draws the island heightfield.

   16 x 16 chunks of 128 m, each built at two resolutions (4 m and 8 m
   spacing) with skirts so the seams never show. One shared material blends
   the ground layers in the fragment shader:
     forest floor (needles, twigs, moss) where the forest is dense,
     grass in meadows, rock on steep slopes (triplanar so cliffs are not
     stretched), sand on beaches, mud in the swamp and along banks, ash in
     the burned forest, autumn leaf litter under the maples, snow on the peak.
   Two texture scales + a macro noise break up visible tiling, and the
   detail normal maps are blended per layer. */
import * as THREE from '../../lib/three.module.js';
import { tex } from '../core/Textures.js';
import { N, CELL, HALF } from './Island.js';

const CH = 32;                // cells per chunk side
const CHUNKS = (N - 1) / CH;  // 16

export class Terrain {
  constructor(island) {
    this.island = island;
    this.group = new THREE.Group(); this.group.name = 'terrain';
    this.material = makeMaterial();
    this.chunks = [];
    for (let cj = 0; cj < CHUNKS; cj++) for (let ci = 0; ci < CHUNKS; ci++) {
      // skip chunks that are entirely deep sea
      let maxH = -99;
      for (let j = cj * CH; j <= (cj + 1) * CH; j += 4) for (let i = ci * CH; i <= (ci + 1) * CH; i += 4) maxH = Math.max(maxH, island.H[j * N + i]);
      if (maxH < -6) continue;
      const hi = new THREE.Mesh(this._geo(ci, cj, 1), this.material);
      const lo = new THREE.Mesh(this._geo(ci, cj, 2), this.material);
      for (const m of [hi, lo]) { m.receiveShadow = true; m.castShadow = false; m.matrixAutoUpdate = false; this.group.add(m); }
      lo.visible = false;
      this.chunks.push({ hi, lo, cx: (ci + 0.5) * CH * CELL - HALF, cz: (cj + 0.5) * CH * CELL - HALF });
    }
  }
  _geo(ci, cj, step) {
    const isl = this.island, n = CH / step + 1;
    const i0 = ci * CH, j0 = cj * CH;
    const verts = n * n + n * 4;
    const pos = new Float32Array(verts * 3), nor = new Float32Array(verts * 3), spl = new Float32Array(verts * 4);
    const idx = [];
    const put = (v, i, j, drop) => {
      const k = j * N + i, x = i * CELL - HALF, z = j * CELL - HALF;
      pos[v * 3] = x; pos[v * 3 + 1] = isl.H[k] - drop; pos[v * 3 + 2] = z;
      const hl = isl.H[j * N + Math.max(0, i - 1)], hr = isl.H[j * N + Math.min(N - 1, i + 1)];
      const hd = isl.H[Math.max(0, j - 1) * N + i], hu = isl.H[Math.min(N - 1, j + 1) * N + i];
      let nx = hl - hr, ny = 2 * CELL, nz = hd - hu; const l = Math.hypot(nx, ny, nz);
      nor[v * 3] = nx / l; nor[v * 3 + 1] = ny / l; nor[v * 3 + 2] = nz / l;
      spl[v * 4] = isl.forest[k]; spl[v * 4 + 1] = isl.wet[k]; spl[v * 4 + 2] = isl.burn[k]; spl[v * 4 + 3] = isl.autumn[k];
    };
    for (let b = 0; b < n; b++) for (let a = 0; a < n; a++) put(b * n + a, i0 + a * step, j0 + b * step, 0);
    for (let b = 0; b < n - 1; b++) for (let a = 0; a < n - 1; a++) {
      const p = b * n + a;
      // diagonal (a, b+1)-(a+1, b) to match Island._sample
      idx.push(p, p + n, p + 1, p + 1, p + n, p + n + 1);
    }
    // skirts: a curtain hanging 6 m below each edge
    let v = n * n;
    const edge = (list) => {
      const start = v;
      for (const [a, b] of list) { put(v++, i0 + a * step, j0 + b * step, 6); }
      for (let k = 0; k < list.length - 1; k++) {
        const t0 = list[k][1] * n + list[k][0], t1 = list[k + 1][1] * n + list[k + 1][0];
        idx.push(t0, start + k, t1, t1, start + k, start + k + 1);
        idx.push(t0, t1, start + k, t1, start + k + 1, start + k);
      }
    };
    const L = [...Array(n).keys()];
    edge(L.map(a => [a, 0])); edge(L.map(a => [a, n - 1])); edge(L.map(b => [0, b])); edge(L.map(b => [n - 1, b]));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aSplat', new THREE.BufferAttribute(spl, 4));
    g.setIndex(idx);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
  /** swap chunk resolutions around the camera; call a few times a second */
  update(camPos, lodDist = 330) {
    for (const c of this.chunks) {
      const near = Math.hypot(c.cx - camPos.x, c.cz - camPos.z) < lodDist;
      c.hi.visible = near; c.lo.visible = !near;
    }
  }
}

function makeMaterial() {
  const T = { grass: tex('grass'), forest: tex('forest'), rock: tex('rock'), sand: tex('sand'), mud: tex('mud'), noise: tex('noise') };
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, {
      tGrass: { value: T.grass.map }, tForest: { value: T.forest.map }, tRock: { value: T.rock.map }, tSand: { value: T.sand.map }, tMud: { value: T.mud.map }, tNoise: { value: T.noise.map },
      nGrass: { value: T.grass.normalMap }, nForest: { value: T.forest.normalMap }, nRock: { value: T.rock.normalMap },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aSplat; varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWNor;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = aSplat; vWPos = (modelMatrix * vec4(position, 1.0)).xyz; vWNor = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tGrass, tForest, tRock, tSand, tMud, tNoise, nGrass, nForest, nRock;
        varying vec4 vSplat; varying vec3 vWPos; varying vec3 vWNor;
        vec3 tnBlend; float wRockG;
        vec4 tri(sampler2D t, vec3 p, vec3 w, float s) { return texture2D(t, p.zy * s) * w.x + texture2D(t, p.xz * s) * w.y + texture2D(t, p.xy * s) * w.z; }
        // two scales, rotated, to hide the tile repeat
        vec4 dual(sampler2D t, vec2 uv) { vec2 r = mat2(0.8, 0.6, -0.6, 0.8) * uv * 0.27 + 0.37; return mix(texture2D(t, uv), texture2D(t, r), 0.35); }`)
      .replace('#include <map_fragment>', `
        vec3 wn = normalize(vWNor);
        vec2 uv = vWPos.xz / 3.2;
        float macro = texture2D(tNoise, vWPos.xz / 160.0).r;
        float micro = texture2D(tNoise, vWPos.xz / 23.0).g;
        float slope = 1.0 - wn.y;
        float hgt = vWPos.y;
        float forestW = smoothstep(0.25, 0.6, vSplat.x + (macro - 0.5) * 0.35);
        float wetW = smoothstep(0.45, 0.8, vSplat.y + (micro - 0.5) * 0.25);
        float burnW = smoothstep(0.4, 0.75, vSplat.z + (macro - 0.5) * 0.3);
        float autW = smoothstep(0.55, 0.85, vSplat.w) * (0.6 + forestW * 0.4);
        float sandW = smoothstep(3.2, 1.6, hgt + (micro - 0.5) * 1.2) * (1.0 - wetW * 0.5);
        float rockW = smoothstep(0.2, 0.36, slope + (micro - 0.5) * 0.12);
        rockW = max(rockW, smoothstep(170.0, 200.0, hgt + (macro - 0.5) * 30.0) * 0.8);
        float snowW = smoothstep(196.0, 214.0, hgt + (macro - 0.5) * 22.0) * (1.0 - smoothstep(0.45, 0.6, slope));
        vec3 grass = dual(tGrass, uv).rgb;
        vec3 forest = dual(tForest, uv * 1.15).rgb;
        vec3 sand = dual(tSand, uv).rgb;
        vec3 mud = dual(tMud, uv).rgb;
        vec3 tw = pow(abs(wn), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec3 rock = tri(tRock, vWPos, tw, 1.0 / 5.0).rgb;
        // autumn litter: forest floor tinted orange-red
        vec3 leaves = forest * vec3(1.45, 0.95, 0.55);
        vec3 col = mix(grass * mix(vec3(1.0), vec3(1.12, 1.05, 0.8), macro * 0.6), forest, forestW);
        col = mix(col, leaves, autW * 0.75);
        col = mix(col, mud, wetW);
        col = mix(col, forest * vec3(0.35, 0.33, 0.32) + vec3(0.02), burnW * 0.85);
        col = mix(col, sand, sandW);
        col = mix(col, rock, rockW);
        col = mix(col, vec3(0.86, 0.9, 0.96), snowW);
        col *= (0.82 + macro * 0.36) * 1.55;
        // canopy darkening under dense forest
        col *= 1.0 - forestW * 0.18;
        diffuseColor.rgb *= col;
        wRockG = rockW;
        vec3 tg = dual(nGrass, uv).xyz * 2.0 - 1.0;
        vec3 tf = dual(nForest, uv * 1.15).xyz * 2.0 - 1.0;
        vec3 tr = tri(nRock, vWPos, tw, 1.0 / 5.0).xyz * 2.0 - 1.0;
        tnBlend = normalize(mix(mix(mix(tg, tf, forestW), vec3(0.0, 0.0, 1.0), max(sandW, wetW) * 0.6), tr, rockW));
        `)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness; roughnessFactor = mix(roughnessFactor, 0.45, wetW * 0.7); roughnessFactor = mix(roughnessFactor, 0.75, snowW);`)
      .replace('#include <normal_fragment_maps>', `
        {
          // world-aligned tangent frame for a ground-projected normal map
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - wn * wn.x);
          vec3 B = normalize(cross(wn, T));
          vec3 nw = normalize(T * tnBlend.x * 1.1 - B * tnBlend.y * 1.1 + wn * tnBlend.z);
          normal = normalize((viewMatrix * vec4(nw, 0.0)).xyz);
        }`);
  };
  m.customProgramCacheKey = () => 'terrain-v1';
  return m;
}
