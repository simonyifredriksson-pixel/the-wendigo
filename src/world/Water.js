/* Water.js - the sea, the lakes, the rivers and the swamp pools.

   One material family: a glossy MeshStandardMaterial whose normal is two
   scrolling ripple maps, with opacity and colour driven by the water depth
   (read from a half-float texture of the terrain heights), plus a soft foam
   line on the shore. Reflections come from an environment map of the sky
   that is re-rendered every few seconds (see SkyEnv), so the lakes go gold
   at sunset and black at night.  The river is a ribbon whose ripples flow
   downstream. */
import * as THREE from '../../lib/three.module.js';
import { tex } from '../core/Textures.js';
import { GU } from '../core/Shading.js';
import { N, HALF, CELL } from './Island.js';

export class Water {
  constructor(island, envTex) {
    this.island = island;
    this.group = new THREE.Group(); this.group.name = 'water';
    // terrain heights as a texture
    const hd = new Uint16Array(N * N);
    for (let i = 0; i < N * N; i++) hd[i] = THREE.DataUtils.toHalfFloat(island.H[i]);
    this.hTex = new THREE.DataTexture(hd, N, N, THREE.RedFormat, THREE.HalfFloatType);
    this.hTex.magFilter = this.hTex.minFilter = THREE.LinearFilter; this.hTex.needsUpdate = true;
    const nrm = tex('noise').normalMap.clone(); nrm.wrapS = nrm.wrapT = THREE.RepeatWrapping; nrm.needsUpdate = true;
    this.nrm = nrm;
    this.env = envTex;
    this.mats = [];
    const sea = this._mat({ deep: 0x0b2a33, shallow: 0x3d7a78, flow: 0, scale: 0.035, foam: 1 });
    const lake = this._mat({ deep: 0x0a1c1f, shallow: 0x3b5a4a, flow: 0, scale: 0.08, foam: 0.3, rough: 0.03 });
    const river = this._mat({ deep: 0x13282a, shallow: 0x4e6a58, flow: 1, scale: 0.12, foam: 0.6 });
    const swamp = this._mat({ deep: 0x1a1d12, shallow: 0x3a3a22, flow: 0, scale: 0.1, foam: 0, rough: 0.2 });
    // sea: a big plane, finer near the island
    const seaGeo = new THREE.PlaneGeometry(6000, 6000, 1, 1); seaGeo.rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(seaGeo, sea); this.sea.position.y = 0; this.group.add(this.sea);
    // lakes
    for (const L of island.lakes) {
      const g = new THREE.CircleGeometry(L.r * 1.45, 64); g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, lake); m.position.set(L.x, L.level, L.z); this.group.add(m);
    }
    // swamp
    const S = island.swamp;
    const sg = new THREE.CircleGeometry(S.r * 1.25, 64); sg.rotateX(-Math.PI / 2);
    const sm = new THREE.Mesh(sg, swamp); sm.position.set(S.x, S.level, S.z); this.group.add(sm);
    // rivers: ribbons along the dense path; uv.y = distance downstream (flow)
    for (const R of island.rivers) {
      const pts = R.dense, P = [], U = [], I = [];
      let dist = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
        let dx = q.x - o.x, dz = q.z - o.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
        if (i > 0) dist += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
        const w = p.w * 1.35;
        P.push(p.x - dz * w, p.level, p.z + dx * w, p.x + dz * w, p.level, p.z - dx * w);
        U.push(0, dist / 8, 1, dist / 8);
        if (i > 0) { const b = (i - 1) * 2; I.push(b, b + 2, b + 1, b + 1, b + 2, b + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(P.length).fill(0).map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
      g.setIndex(I);
      const m = new THREE.Mesh(g, river); m.renderOrder = 1; this.group.add(m);
    }
    for (const c of this.group.children) { c.receiveShadow = true; c.matrixAutoUpdate = true; }
  }
  _mat({ deep, shallow, flow, scale, foam, rough = 0.06 }) {
    const m = new THREE.MeshStandardMaterial({ color: deep, roughness: rough, metalness: 0.0, transparent: true, envMap: this.env, envMapIntensity: 1.0, depthWrite: true });
    m.normalMap = this.nrm; m.normalScale = new THREE.Vector2(0.35, 0.35);
    const u = { tH: { value: this.hTex }, uShallow: { value: new THREE.Color(shallow) }, uDeep: { value: new THREE.Color(deep) }, uFlow: { value: flow }, uScale: { value: scale }, uFoam: { value: foam } };
    const prev = m.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      Object.assign(sh.uniforms, u, { uTime: GU.uTime });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWP; varying vec2 vRUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWP = (modelMatrix * vec4(position, 1.0)).xyz; vRUv = uv;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tH; uniform vec3 uShallow, uDeep; uniform float uFlow, uScale, uFoam, uTime;
          varying vec3 vWP; varying vec2 vRUv; float wDepth;`)
        .replace('#include <map_fragment>', `
          vec2 huv = (vWP.xz + ${HALF.toFixed(1)}) / ${(CELL * (N - 1)).toFixed(1)} + 0.5 / ${N.toFixed(1)};
          float ground = texture2D(tH, huv).r;
          wDepth = max(vWP.y - ground, 0.0);
          float dk = 1.0 - exp(-wDepth * 0.45);
          diffuseColor.rgb = mix(uShallow, uDeep, dk);
          diffuseColor.a = mix(0.35, 0.94, smoothstep(0.0, 2.5, wDepth));
          float fn = fract(sin(dot(floor(vWP.xz * 3.0), vec2(12.9, 78.2))) * 43758.5);
          float foam = uFoam * (1.0 - smoothstep(0.0, 0.55, wDepth)) * (0.55 + 0.45 * sin(uTime * 1.5 + wDepth * 14.0 + fn * 3.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.86, 0.85), clamp(foam, 0.0, 1.0) * 0.55);`)
        .replace('#include <normal_fragment_maps>', `
          vec2 ruv = uFlow > 0.5 ? vec2(vRUv.x * 0.6, vRUv.y - uTime * 0.35) : vWP.xz * uScale;
          vec3 n1 = texture2D(normalMap, ruv + vec2(uTime * 0.013, uTime * 0.007)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(normalMap, ruv * 2.3 - vec2(uTime * 0.017, -uTime * 0.011)).xyz * 2.0 - 1.0;
          vec3 tn = normalize(vec3((n1.xy + n2.xy) * normalScale, 1.0));
          normal = normalize((viewMatrix * vec4(tn.x, tn.z, -tn.y, 0.0)).xyz);`);
    };
    m.customProgramCacheKey = () => 'water' + flow + foam;
    this.mats.push(m);
    return m;
  }
  setEnv(t) { for (const m of this.mats) { m.envMap = t; m.needsUpdate = true; } }
}

/** a small environment map of the sky (sky dome only), refreshed every few seconds */
export class SkyEnv {
  constructor(renderer, skyMesh) {
    this.r = renderer;
    this.scene = new THREE.Scene();
    this.mesh = new THREE.Mesh(skyMesh.geometry, skyMesh.material); this.mesh.frustumCulled = false; this.scene.add(this.mesh);
    this.rt = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
    this.cam = new THREE.CubeCamera(0.1, 2000, this.rt);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.texture = null; this.t = 0;
    this.refresh();
  }
  refresh() {
    const prevTM = this.r.toneMapping; this.r.toneMapping = THREE.NoToneMapping;
    this.cam.update(this.r, this.scene);
    // reuse the same target so materials keep pointing at one texture
    this.out = this.pmrem.fromCubemap(this.rt.texture, this.out || null);
    this.texture = this.out.texture;
    this.r.toneMapping = prevTM;
  }
  update(dt) { this.t -= dt; if (this.t <= 0) { this.t = 3; this.refresh(); return true; } return false; }
}
