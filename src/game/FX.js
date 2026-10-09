/* FX.js - particles and transient effects.

   Billboard particles (one instanced mesh, soft round sprites, camera-facing
   in the vertex shader): dust, smoke, sparks, embers, mist, splashes,
   blood (kept small and dark), ash. Additive ones (sparks, embers, flame
   glow) use a second mesh.
   Chips: real little wood chips with physics that bounce off the ground and
   stay a while (chopping a tree leaves a scatter at its foot).
   Flames: animated noise flame cards, one cluster per fire.
   Rain: streaks in a box around the camera, with splash flecks.
   Ambient: fireflies at dusk near water, drifting leaves under maples,
   moths around lights, falling snow up on the peak.
   Footprints: instanced decals on the ground (also the Wendigo's). */
import * as THREE from '../../lib/three.module.js';
import { tex } from '../core/Textures.js';
import { GU } from '../core/Shading.js';
import { clamp, lerp } from '../core/Util.js';

const MAXP = 2400, MAXA = 1200, MAXCHIP = 500, MAXFP = 400;

function spriteMat(additive) {
  const m = new THREE.ShaderMaterial({
    uniforms: { fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 }, fogNear: { value: 0 }, fogFar: { value: 0 }, ...pick(GU, ['uSunDir', 'uFogSun', 'uFogHeight', 'uFogBase']) },
    vertexShader: `
      attribute vec4 aCol; attribute vec4 aData; // data: size, rotation, softness, unused
      varying vec4 vCol; varying vec2 vUv; varying float vSoft;
      #include <fog_pars_vertex>
      void main(){
        vCol = aCol; vUv = uv; vSoft = aData.z;
        vec3 ip = instanceMatrix[3].xyz;
        vec4 mvPosition = modelViewMatrix * vec4(ip, 1.0);
        float c = cos(aData.y), s = sin(aData.y);
        vec2 off = mat2(c, s, -s, c) * position.xy * aData.x;
        mvPosition.xy += off;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      varying vec4 vCol; varying vec2 vUv; varying float vSoft;
      #include <fog_pars_fragment>
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        float a = smoothstep(1.0, mix(0.9, 0.0, vSoft), d) * vCol.a;
        if (a < 0.003) discard;
        gl_FragColor = vec4(vCol.rgb, a);
        #include <fog_fragment>
        ${additive ? 'gl_FragColor.rgb *= gl_FragColor.a;' : ''}
      }`,
    transparent: true, depthWrite: false, fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  return m;
}
function pick(o, keys) { const r = {}; for (const k of keys) r[k] = o[k]; return r; }

class Pool {
  constructor(n, additive, scene) {
    this.n = n; this.list = [];
    const g = new THREE.PlaneGeometry(1, 1);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); this.col.setUsage(THREE.DynamicDrawUsage);
    this.data = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4); this.data.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aCol', this.col); g.setAttribute('aData', this.data);
    this.mesh = new THREE.InstancedMesh(g, spriteMat(additive), n);
    this.mesh.frustumCulled = false; this.mesh.count = 0; this.mesh.renderOrder = additive ? 6 : 5;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }
  spawn(p) { if (this.list.length >= this.n) this.list.shift(); this.list.push(p); }
  update(dt) {
    const L = this.list, m = this.mesh.instanceMatrix.array, c = this.col.array, d = this.data.array;
    let w = 0;
    for (let i = 0; i < L.length; i++) {
      const p = L[i];
      p.t += dt; if (p.t >= p.life) continue;
      p.vy -= p.g * dt;
      const dr = Math.exp(-p.drag * dt); p.vx *= dr; p.vy *= dr; p.vz *= dr;
      p.vx += (p.wind || 0) * GU.uWindDir.value.x * dt; p.vz += (p.wind || 0) * GU.uWindDir.value.y * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.floor !== undefined && p.y < p.floor) { p.y = p.floor; p.vy *= -0.2; p.vx *= 0.5; p.vz *= 0.5; }
      const k = p.t / p.life, fade = p.fadeIn ? Math.min(1, p.t / p.fadeIn) : 1;
      const a = p.a * fade * (1 - Math.pow(k, p.fadePow || 1.5));
      const size = lerp(p.s0, p.s1, k);
      L[w++] = p;
      const j = w - 1;
      m[j * 16 + 12] = p.x; m[j * 16 + 13] = p.y; m[j * 16 + 14] = p.z; m[j * 16 + 15] = 1;
      c[j * 4] = p.r; c[j * 4 + 1] = p.gg; c[j * 4 + 2] = p.b; c[j * 4 + 3] = a;
      if (p.cool) { const h = 1 - k * p.cool; c[j * 4 + 1] *= h; c[j * 4 + 2] *= h * h; }
      d[j * 4] = size; d[j * 4 + 1] = p.rot + p.spin * p.t; d[j * 4 + 2] = p.soft;
    }
    L.length = w;
    this.mesh.count = w;
    this.mesh.instanceMatrix.needsUpdate = true; this.col.needsUpdate = true; this.data.needsUpdate = true;
  }
}

export class FX {
  constructor(game) {
    this.g = game;
    const S = game.scene;
    this.soft = new Pool(MAXP, false, S);
    this.glow = new Pool(MAXA, true, S);
    // identity rotation/scale in the instance matrices (only translation is used)
    for (const pool of [this.soft, this.glow]) { const m = pool.mesh.instanceMatrix.array; for (let i = 0; i < pool.n; i++) { m[i * 16] = 1; m[i * 16 + 5] = 1; m[i * 16 + 10] = 1; m[i * 16 + 15] = 1; } }
    // wood chips
    const fw = tex('freshWood');
    const chipGeo = new THREE.BoxGeometry(0.07, 0.012, 0.035);
    this.chips = new THREE.InstancedMesh(chipGeo, new THREE.MeshStandardMaterial({ map: fw.map, roughness: 0.9 }), MAXCHIP);
    this.chips.count = 0; this.chips.frustumCulled = false; this.chips.castShadow = false; this.chips.receiveShadow = true;
    this.chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    S.add(this.chips); this.chipList = [];
    // footprints
    this._initPrints(S);
    // flames
    this.flames = [];
    this._flameMat = this._makeFlameMat();
    // rain
    this._initRain(S);
    this.ambT = 0; this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
  }

  /* ---------------- spawning helpers */
  _p0(o) { return { t: 0, life: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 0, drag: 1, s0: 0.2, s1: 0.4, r: 1, gg: 1, b: 1, a: 1, rot: Math.random() * 6.28, spin: 0, soft: 0.8, ...o }; }
  dust(p, n = 10, col = [0.42, 0.37, 0.3], size = 1.2, spread = 1) {
    for (let i = 0; i < n; i++) this.soft.spawn(this._p0({ x: p.x + (Math.random() - 0.5) * spread, y: p.y + Math.random() * 0.4, z: p.z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 2.5 * spread, vy: Math.random() * 1.2, vz: (Math.random() - 0.5) * 2.5 * spread, drag: 1.8, g: -0.15, life: 1.8 + Math.random() * 1.8, s0: size * 0.4, s1: size * 1.6, r: col[0], gg: col[1], b: col[2], a: 0.35, spin: (Math.random() - 0.5) * 0.5, soft: 1, wind: 0.6 }));
  }
  smoke(p, n = 1, dark = 0.25, size = 0.8) {
    for (let i = 0; i < n; i++) this.soft.spawn(this._p0({ x: p.x + (Math.random() - 0.5) * 0.3, y: p.y, z: p.z + (Math.random() - 0.5) * 0.3, vx: (Math.random() - 0.5) * 0.3, vy: 0.9 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 0.3, drag: 0.4, life: 4 + Math.random() * 3, s0: size * 0.5, s1: size * 3, r: dark, gg: dark, b: dark * 1.05, a: 0.22, fadeIn: 0.6, spin: (Math.random() - 0.5) * 0.4, soft: 1, wind: 1.2 }));
  }
  sparks(p, n = 12, col = [1.6, 0.8, 0.3], speed = 4) {
    for (let i = 0; i < n; i++) this.glow.spawn(this._p0({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * speed, vy: Math.random() * speed, vz: (Math.random() - 0.5) * speed, g: 9, drag: 0.6, life: 0.4 + Math.random() * 0.6, s0: 0.05, s1: 0.02, r: col[0], gg: col[1], b: col[2], a: 1, soft: 0.2, floor: p.floor }));
  }
  embers(p, n = 1, spread = 0.4, size = 0.05) {
    for (let i = 0; i < n; i++) this.glow.spawn(this._p0({ x: p.x + (Math.random() - 0.5) * spread, y: p.y, z: p.z + (Math.random() - 0.5) * spread, vx: (Math.random() - 0.5) * 0.6, vy: 1.2 + Math.random() * 1.8, vz: (Math.random() - 0.5) * 0.6, g: -0.2, drag: 0.8, life: 1.5 + Math.random() * 2, s0: size, s1: size * 0.3, r: 2.2, gg: 0.9, b: 0.3, a: 1, cool: 0.8, soft: 0.3, wind: 1.5 }));
  }
  blood(p, n = 8, dir) {
    // dark and brief; this is not a gore game
    for (let i = 0; i < n; i++) this.soft.spawn(this._p0({ x: p.x, y: p.y, z: p.z, vx: (dir ? dir.x * 2 : 0) + (Math.random() - 0.5) * 2, vy: Math.random() * 2, vz: (dir ? dir.z * 2 : 0) + (Math.random() - 0.5) * 2, g: 9, drag: 1, life: 0.5 + Math.random() * 0.4, s0: 0.08, s1: 0.04, r: 0.22, gg: 0.02, b: 0.02, a: 0.9, soft: 0.4, floor: p.floor }));
  }
  splash(p, size = 1) {
    for (let i = 0; i < 14 * size; i++) this.soft.spawn(this._p0({ x: p.x, y: p.y, z: p.z, vx: (Math.random() - 0.5) * 3 * size, vy: 2 + Math.random() * 3 * size, vz: (Math.random() - 0.5) * 3 * size, g: 9, drag: 0.5, life: 0.7, s0: 0.12 * size, s1: 0.25 * size, r: 0.8, gg: 0.85, b: 0.88, a: 0.5, soft: 0.7, floor: p.y - 0.1 }));
  }
  mist(p, n = 1, size = 4) {
    for (let i = 0; i < n; i++) this.soft.spawn(this._p0({ x: p.x + (Math.random() - 0.5) * 6, y: p.y + Math.random(), z: p.z + (Math.random() - 0.5) * 6, vx: (Math.random() - 0.5) * 0.2, vy: 0.05, vz: (Math.random() - 0.5) * 0.2, drag: 0.1, life: 8 + Math.random() * 6, s0: size, s1: size * 1.6, r: 0.6, gg: 0.65, b: 0.7, a: 0.08, fadeIn: 3, soft: 1, wind: 0.3 }));
  }
  /** wood chips flying off an axe hit (dir = from the tree toward the chopper) */
  chipBurst(p, dir, n = 8, groundY) {
    for (let i = 0; i < n; i++) {
      if (this.chipList.length >= MAXCHIP) this.chipList.shift();
      this.chipList.push({ x: p.x, y: p.y, z: p.z, vx: dir.x * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2.5, vy: 1.5 + Math.random() * 3, vz: dir.z * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2.5, rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6, sp: (Math.random() - 0.5) * 30, s: 0.6 + Math.random() * 1.2, t: 0, floor: groundY ?? (p.y - 1), rest: false });
    }
    this.dust(p, 3, [0.55, 0.45, 0.32], 0.4, 0.3);
  }

  /* ---------------- flames */
  _makeFlameMat() {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: GU.uTime },
      vertexShader: `varying vec2 vUv; attribute float aSeed; varying float vSeed; uniform float uTime;
        void main(){ vUv = uv; vSeed = aSeed;
          vec4 mv = modelViewMatrix * vec4(0.0, position.y, 0.0, 1.0);
          mv.x += position.x * (1.0 + 0.1 * sin(uTime * 7.0 + aSeed * 9.0));
          gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec2 vUv; varying float vSeed; uniform float uTime;
        float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+vec2(1,1)), f.x), f.y); }
        void main(){
          vec2 uv = vUv; float t = uTime * 2.4 + vSeed * 10.0;
          float x = (uv.x - 0.5) * 2.0;
          float noise = n(vec2(uv.x * 4.0 + vSeed * 3.0, uv.y * 3.0 - t)) * 0.6 + n(vec2(uv.x * 9.0, uv.y * 7.0 - t * 1.6)) * 0.4;
          float shape = 1.0 - abs(x) / max(0.05, (1.0 - uv.y) * 0.9 + 0.08);
          float f = shape - uv.y * 0.85 + (noise - 0.5) * 0.9;
          if (f < 0.02) discard;
          vec3 hot = vec3(4.0, 2.4, 1.0), mid = vec3(2.6, 0.9, 0.15), cool = vec3(0.9, 0.18, 0.03);
          vec3 c = mix(cool, mid, smoothstep(0.02, 0.3, f)); c = mix(c, hot, smoothstep(0.3, 0.7, f));
          gl_FragColor = vec4(c * smoothstep(0.02, 0.2, f), 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
  }
  /** a fire's flames: returns a handle {group, setSize(s), remove()} */
  flame(parent, size = 1) {
    const g = new THREE.Group();
    const geo = new THREE.PlaneGeometry(0.7, 1.3); geo.translate(0, 0.62, 0);
    const n = 4;
    const seeds = new Float32Array(geo.attributes.position.count).fill(0);
    for (let i = 0; i < n; i++) {
      const gg = geo.clone(); gg.setAttribute('aSeed', new THREE.BufferAttribute(seeds.map(() => i * 0.37 + Math.random()), 1));
      const m = new THREE.Mesh(gg, this._flameMat); m.frustumCulled = false;
      m.position.set((Math.random() - 0.5) * 0.25, 0, (Math.random() - 0.5) * 0.25); m.scale.setScalar(0.65 + Math.random() * 0.5); m.renderOrder = 7;
      g.add(m);
    }
    g.scale.setScalar(size); parent.add(g);
    const h = { group: g, size, setSize: (s) => { h.size = s; g.scale.setScalar(Math.max(0.0001, s)); g.visible = s > 0.02; }, remove: () => { g.removeFromParent(); this.flames.splice(this.flames.indexOf(h), 1); } };
    this.flames.push(h);
    return h;
  }

  /* ---------------- footprints */
  _initPrints(S) {
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 128; const c = cv.getContext('2d');
    c.fillStyle = 'rgba(30,22,16,0.75)';
    c.beginPath(); c.ellipse(32, 44, 17, 30, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(32, 98, 13, 18, 0, 0, Math.PI * 2); c.fill();
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({ map: t, transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 });
    this.prints = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.16, 0.3).rotateX(-Math.PI / 2), mat, MAXFP);
    this.prints.count = 0; this.prints.frustumCulled = false; this.prints.receiveShadow = true; S.add(this.prints);
    this.printList = [];
    // giant clawed prints (the Wendigo): drawn procedurally
    const cv2 = document.createElement('canvas'); cv2.width = 128; cv2.height = 256; const c2 = cv2.getContext('2d');
    c2.fillStyle = 'rgba(22,16,12,0.85)';
    c2.beginPath(); c2.ellipse(64, 170, 36, 60, 0, 0, Math.PI * 2); c2.fill();
    for (const [dx, a] of [[-36, -0.35], [-12, -0.1], [12, 0.1], [36, 0.35]]) { c2.save(); c2.translate(64 + dx, 110); c2.rotate(a); c2.beginPath(); c2.moveTo(-8, 0); c2.quadraticCurveTo(0, -95, 3, -100); c2.quadraticCurveTo(6, -60, 8, 0); c2.fill(); c2.restore(); }
    const t2 = new THREE.CanvasTexture(cv2); t2.colorSpace = THREE.SRGBColorSpace;
    const mat2 = mat.clone(); mat2.map = t2;
    this.bigPrints = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.6, 3.2).rotateX(-Math.PI / 2), mat2, 200);
    this.bigPrints.count = 0; this.bigPrints.frustumCulled = false; this.bigPrints.receiveShadow = true; S.add(this.bigPrints);
    this.bigList = [];
  }
  /** a footprint at (x,z) facing yaw; big = the Wendigo's */
  footprint(x, z, yaw, big = false, life = big ? 900 : 240) {
    const L = big ? this.bigList : this.printList, max = big ? 200 : MAXFP;
    if (L.length >= max) L.shift();
    const isl = this.g.island, y = (this.g.physics.ground(x, z) ?? isl.height(x, z)) + 0.03;
    const n = isl.normal(x, z, new THREE.Vector3());
    L.push({ x, y, z, yaw, n, t: 0, life });
    this._printsDirty = true;
  }
  _rebuildPrints() {
    const m = this._m, q = this._q, q2 = new THREE.Quaternion(), s = this._s, p = this._p, up = new THREE.Vector3(0, 1, 0);
    for (const [mesh, L, sc] of [[this.prints, this.printList, 1], [this.bigPrints, this.bigList, 1]]) {
      L.forEach((f, i) => {
        q.setFromUnitVectors(up, f.n); q2.setFromAxisAngle(up, f.yaw); q.multiply(q2);
        const fade = Math.min(1, (f.life - f.t) / 20);
        m.compose(p.set(f.x, f.y, f.z), q, s.set(sc, 1, sc * Math.max(0.01, fade)));
        mesh.setMatrixAt(i, m);
      });
      mesh.count = L.length; mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /* ---------------- rain */
  _initRain(S) {
    const N = 4000, P = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) { const x = (Math.random() - 0.5) * 50, y = Math.random() * 30, z = (Math.random() - 0.5) * 50; P.set([x, y, z, x, y - 0.6, z], i * 6); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    this.rainU = { uTime: GU.uTime, uCam: { value: new THREE.Vector3() }, uAmt: { value: 0 }, uWindDir: GU.uWindDir, uWind: GU.uWind, uCol: { value: new THREE.Color(0.6, 0.65, 0.7) } };
    const m = new THREE.ShaderMaterial({
      uniforms: this.rainU, transparent: true, depthWrite: false,
      vertexShader: `uniform float uTime, uAmt, uWind; uniform vec3 uCam; uniform vec2 uWindDir; varying float vA;
        void main(){ vec3 p = position;
          float top = float(gl_VertexID % 2 == 0);
          float baseY = p.y + (1.0 - top) * 0.6;
          float fall = mod(baseY - uTime * 16.0, 30.0);
          vec3 w = vec3(mod(p.x - uCam.x + 25.0, 50.0) - 25.0 + uCam.x, fall + uCam.y - 10.0 - (1.0 - top) * 0.6, mod(p.z - uCam.z + 25.0, 50.0) - 25.0 + uCam.z);
          w.xz += uWindDir * uWind * (1.0 - top) * 0.6;
          vA = step(fract(sin(dot(position.xz, vec2(12.9, 78.2))) * 437.5), uAmt) * 0.35;
          gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0); }`,
      fragmentShader: `uniform vec3 uCol; varying float vA; void main(){ if (vA <= 0.0) discard; gl_FragColor = vec4(uCol, vA); }`,
    });
    this.rain = new THREE.LineSegments(g, m); this.rain.frustumCulled = false; this.rain.renderOrder = 8; S.add(this.rain);
  }

  /* ---------------- per frame */
  update(dt) {
    const g = this.g, cam = g.camera.position;
    this.soft.update(dt); this.glow.update(dt);
    // chips
    const m = this._m, q = this._q, e = this._e, s = this._s, p = this._p;
    let n = 0;
    for (const c of this.chipList) {
      c.t += dt;
      if (!c.rest) {
        c.vy -= 12 * dt; c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt; c.rx += c.sp * dt; c.rz += c.sp * 0.7 * dt;
        if (c.y < c.floor) { c.y = c.floor; c.vy *= -0.25; c.vx *= 0.4; c.vz *= 0.4; c.sp *= 0.4; if (Math.abs(c.vy) < 0.4) { c.rest = true; c.rx = (Math.random() - 0.5) * 0.3; c.rz = (Math.random() - 0.5) * 0.3; } }
      }
      const fade = c.t > 50 ? Math.max(0.001, 1 - (c.t - 50) / 10) : 1;
      if (fade <= 0.001) continue;
      e.set(c.rx, c.ry, c.rz); q.setFromEuler(e);
      m.compose(p.set(c.x, c.y + 0.005, c.z), q, s.setScalar(c.s * fade));
      this.chips.setMatrixAt(n++, m);
    }
    this.chipList = this.chipList.filter(c => c.t < 60);
    this.chips.count = n; this.chips.instanceMatrix.needsUpdate = true;
    // footprints age
    this._printT = (this._printT || 0) - dt;
    if (this._printT <= 0 || this._printsDirty) {
      this._printT = 2; this._printsDirty = false;
      for (const L of [this.printList, this.bigList]) { for (const f of L) f.t += 2; for (let i = L.length - 1; i >= 0; i--) if (L[i].t > L[i].life) L.splice(i, 1); }
      this._rebuildPrints();
    }
    // rain
    const A = g.atmos.out;
    this.rainU.uCam.value.copy(cam); this.rainU.uAmt.value = g.inCave ? 0 : A.rain;
    this.rainU.uCol.value.setRGB(0.5, 0.55, 0.6).multiplyScalar(0.3 + A.daylight * 0.7 + A.flash * 2);
    this.rain.visible = A.rain > 0.02 && !g.inCave;
    if (A.rain > 0.2 && !g.inCave && Math.random() < A.rain * dt * 30) {
      const x = cam.x + (Math.random() - 0.5) * 16, z = cam.z + (Math.random() - 0.5) * 16, y = g.physics.ground(x, z);
      this.soft.spawn(this._p0({ x, y: y + 0.03, z, life: 0.3, s0: 0.05, s1: 0.18, r: 0.7, gg: 0.75, b: 0.8, a: 0.4, soft: 0.6 }));
    }
    // ambience
    this.ambT -= dt;
    if (this.ambT <= 0 && !g.inCave) {
      this.ambT = 0.2;
      const isl = g.island, rx = cam.x + (Math.random() - 0.5) * 40, rz = cam.z + (Math.random() - 0.5) * 40;
      // fireflies at dusk and early night, near water and meadows
      if (A.dusk + A.night * 0.5 > 0.3 && A.rain < 0.2 && (isl.wetAt(rx, rz) > 0.3 || isl.meadowAt(rx, rz) > 0.4) && Math.random() < 0.6 && !g.director?.silence) {
        const y = isl.height(rx, rz) + 0.5 + Math.random() * 1.5;
        this.glow.spawn(this._p0({ x: rx, y, z: rz, vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.2, vz: (Math.random() - 0.5) * 0.4, drag: 0.2, life: 6 + Math.random() * 5, s0: 0.06, s1: 0.06, r: 1.4, gg: 1.8, b: 0.4, a: 1, fadeIn: 1.5, fadePow: 4, soft: 0.2 }));
      }
      // drifting leaves under autumn trees and in wind
      if (isl.autumnAt(rx, rz) > 0.5 && Math.random() < 0.5 + A.wind * 0.5) {
        const y = isl.height(rx, rz) + 6 + Math.random() * 8;
        this.soft.spawn(this._p0({ x: rx, y, z: rz, vx: 0, vy: -0.8, vz: 0, drag: 2, g: 0.6, life: 9, s0: 0.09, s1: 0.09, r: 0.62, gg: 0.28, b: 0.08, a: 0.95, spin: 3, soft: 0.1, wind: 3, floor: isl.height(rx, rz) + 0.02 }));
      }
      // valley mist at dawn and night
      if ((A.night > 0.5 || (g.atmos.hour > 4.5 && g.atmos.hour < 8)) && Math.random() < 0.15) {
        const y = isl.height(rx, rz);
        if (isl.wetAt(rx, rz) > 0.2 || y < 20) this.mist({ x: rx, y, z: rz }, 1, 5);
      }
      // snow flurries up high
      if (cam.y > 180 && Math.random() < 0.8) for (let i = 0; i < 4; i++) this.soft.spawn(this._p0({ x: rx, y: cam.y + 8, z: rz, vx: 0, vy: -1.2, vz: 0, drag: 1, life: 8, s0: 0.04, s1: 0.04, r: 0.95, gg: 0.97, b: 1, a: 0.9, soft: 0.4, wind: 4 }));
    }
  }
}
