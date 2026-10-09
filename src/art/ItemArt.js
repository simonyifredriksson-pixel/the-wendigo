/* ItemArt.js - hand-held items, pickups and player-built log shelter pieces.

   createItem(name, opts)  -> THREE.Group   (cached template, cheap clones)
   ITEM_INFO[name]         -> { hold: 'two'|'right'|'left'|'none', len, kind }
   createPiece(kind, opts) -> THREE.Group   (opts.ghost -> translucent placement preview)
   PIECE_INFO[kind]        -> { size: [w,h,d], colliders: [{x,z,w,d,h,y?,rot?}], snap }
   setPieceDamage(group, d)   0..1 charring + a few logs knocked loose
   setItemEnv(intensity)      scale the small built-in reflection environment (dim it at night)
   lineup(ctx)                screenshot viewer hook (_view.html)

   HELD FRAME (items): the right-hand grip is at the origin and the handle runs
   along +Y, business end up. The item's "front" (axe blade, rifle scope/top,
   flare-gun barrel) faces +Z; X is the thin axis. Two-handed items carry an
   Object3D 'gripL' lower on the handle. Every item has a 'tip'.
   RESOURCES (log, stick, stone, ...) are modelled lying on the ground with their
   resting bottom at y = 0.

   PIECES: grid unit 2 m, origin at the centre of the footprint at its base;
   walls run along X with their thickness along Z.

   Everything is generated here: no external assets. Most meshes use one "uber"
   MeshStandardMaterial whose per-vertex attributes carry metalness, roughness,
   a micro-detail amount and a detail mode (wood grain, rope strands, page
   layers), so a whole item - painted steel, varnished wood and friction tape -
   is a single draw call. The detail itself (albedo breakup + bump) is
   procedural noise in object space, evaluated per pixel. Log pieces use at most
   four materials: bark, end grain, sawn/split wood and the uber material. */
import * as THREE from '../../lib/three.module.js';
import { xf } from '../core/Geo.js';
import { rng, Noise, clamp, lerp, sstep, TAU } from '../core/Util.js';
import { tex, makeCanvas, toTex } from '../core/Textures.js';
import '../core/Shading.js';

const V3 = THREE.Vector3;
const NZ = new Noise(4711);
const v3 = a => (a.isVector3 ? a.clone() : new V3(a[0], a[1], a[2]));
const fnOf = x => (typeof x === 'function' ? x : () => x);
const col = hex => new THREE.Color(hex);
const n3 = (x, y, z, o = 3) => NZ.fbm3(x, y, z, o);
const nzp = (p, f, s = 0, o = 3) => NZ.fbm3(p.x * f + s, p.y * f + s * 0.37, p.z * f - s * 0.71, o);
const spow = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
const gauss = (x, w) => Math.exp(-(x / w) * (x / w));

/* ====================================================================== materials
   per-vertex aMR = [metalness, roughness, detail 0..1, mode]
   modes: 0 isotropic | 1/2/3 grain stretched along Y/X/Z | 4.xxx rope strands
   (twists per metre = .xxx*1000, uses uv: u around, v metres along) | 5/6/7 fine
   layers stacked across X/Y/Z (paper edges). */
const MR = {
  steel: [0.85, 0.3, 0.12, 0], steelWorn: [0.8, 0.45, 0.3, 0], paint: [0.0, 0.42, 0.25, 0], blued: [0.75, 0.36, 0.12, 0],
  chrome: [0.95, 0.4, 0.12, 1], brass: [0.92, 0.3, 0.08, 0], iron: [0.7, 0.62, 0.5, 0],
  woodY: [0, 0.62, 0.6, 1], woodX: [0, 0.7, 0.6, 2], woodZ: [0, 0.7, 0.6, 3], varnish: [0, 0.4, 0.45, 1], walnut: [0, 0.38, 0.4, 1],
  bark: [0, 0.94, 0.5, 0], barkTex: [0, 0.95, 0.3, 0], end: [0, 0.9, 0.35, 0], char: [0, 0.97, 0.9, 0],
  rope: [0, 0.95, 1, 4.06], cord: [0, 0.9, 1, 4.15], sinew: [0, 0.55, 0.8, 4.2],
  leather: [0, 0.62, 0.7, 0], hide: [0, 0.92, 1, 0], cloth: [0, 0.97, 0.75, 0], tape: [0, 0.78, 0.55, 0],
  bone: [0, 0.6, 0.6, 0], horn: [0, 0.42, 0.5, 1], antler: [0, 0.7, 0.9, 1], stone: [0, 0.84, 0.9, 0], river: [0, 0.6, 0.45, 0],
  obsid: [0, 0.08, 0.05, 0], rubber: [0, 0.86, 0.4, 0], plastic: [0, 0.38, 0.12, 0], glass: [0, 0.04, 0, 0],
  paper: [0, 0.92, 0.25, 0], pages: [0, 0.9, 0.8, 5], flesh: [0, 0.32, 0.45, 0], cooked: [0, 0.62, 0.7, 0],
  leaf: [0, 0.62, 0.3, 0], fur: [0, 0.97, 1, 1], resin: [0, 0.12, 0.15, 0], card: [0, 0.85, 0.4, 0],
};

const UB_VH = `
attribute vec4 aMR; attribute float aGlow; attribute vec4 aPiv;
varying vec4 vWdMR; varying float vWdGlow; varying vec3 vWdOP; varying vec2 vWdUv;
uniform float uDamage;
float wdR1(float n) { return fract(sin(n) * 43758.5453); }
`;
const UB_VB = `
vWdMR = aMR; vWdGlow = aGlow; vWdOP = position; vWdUv = uv;
if (uDamage > 0.0 && aPiv.w >= 0.0) {
  float wdk = step(1.0 - uDamage * 0.7, wdR1(aPiv.w * 91.7 + 1.3)) * uDamage;
  vec3 wdd = transformed - aPiv.xyz;
  float wa = (wdR1(aPiv.w * 13.1) - 0.5) * 0.28 * wdk; float wc = cos(wa); float ws = sin(wa);
  wdd.xy = vec2(wc * wdd.x - ws * wdd.y, ws * wdd.x + wc * wdd.y);
  wa = (wdR1(aPiv.w * 7.7) - 0.5) * 0.3 * wdk; wc = cos(wa); ws = sin(wa);
  wdd.xz = vec2(wc * wdd.x - ws * wdd.z, ws * wdd.x + wc * wdd.z);
  transformed = aPiv.xyz + wdd - vec3(0.0, 0.05 * wdk, 0.0);
}
`;
const UB_FH = `
varying vec4 vWdMR; varying float vWdGlow; varying vec3 vWdOP; varying vec2 vWdUv;
uniform float uChar;
float wdHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float wdN(vec3 x) { vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wdHash(i), wdHash(i + vec3(1.0, 0.0, 0.0)), f.x), mix(wdHash(i + vec3(0.0, 1.0, 0.0)), wdHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(wdHash(i + vec3(0.0, 0.0, 1.0)), wdHash(i + vec3(1.0, 0.0, 1.0)), f.x), mix(wdHash(i + vec3(0.0, 1.0, 1.0)), wdHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z); }
`;
// after color_fragment: micro detail, cracks, char
const UB_F1 = `
float wdMode = vWdMR.w;
vec3 wdS = vec3(1.0);
if (wdMode > 0.5 && wdMode < 1.5) wdS = vec3(1.0, 0.1, 1.0);
else if (wdMode > 1.5 && wdMode < 2.5) wdS = vec3(0.1, 1.0, 1.0);
else if (wdMode > 2.5 && wdMode < 3.5) wdS = vec3(1.0, 1.0, 0.1);
else if (wdMode > 4.5 && wdMode < 5.5) wdS = vec3(9.0, 0.12, 0.12);
else if (wdMode > 5.5 && wdMode < 6.5) wdS = vec3(0.12, 9.0, 0.12);
else if (wdMode > 6.5 && wdMode < 7.5) wdS = vec3(0.12, 0.12, 9.0);
vec3 wdP = vWdOP * wdS * 90.0;
float wdLo = wdN(wdP) * 0.65 + wdN(wdP * 3.7 + 7.1) * 0.35;
float wdHt = wdLo * 0.8 + wdN(wdP * 13.1 + 3.3) * 0.2;
float wdFade = 1.0 - smoothstep(0.3, 1.2, length(fwidth(wdP * 13.1)));
if (wdMode > 3.5 && wdMode < 4.5) {
  float wdK = fract(wdMode) * 1000.0;
  float wdSt = fract(vWdUv.x * 3.0 + vWdUv.y * wdK);
  wdHt = sin(wdSt * 3.14159) * 0.85 + wdHt * 0.15; wdLo = wdHt;
  wdFade = 1.0 - smoothstep(0.35, 0.9, fwidth(vWdUv.y * wdK) * 2.0);
}
if (wdMode > 0.5 && wdMode < 3.5) {   // wood: long fine grain lines
  vec3 wdGs = wdS * wdS;
  float gl = wdN(vWdOP * wdGs * 650.0 + wdN(vWdOP * wdGs * 40.0) * 4.0);
  wdLo = mix(wdLo, gl, 0.6); wdHt = mix(wdHt, gl, 0.5);
  diffuseColor.rgb *= mix(1.0, 0.66 + 0.55 * gl * gl, clamp(vWdMR.z, 0.0, 1.0));
}
float wdAmt = clamp(vWdMR.z, 0.0, 1.0);
diffuseColor.rgb *= mix(1.0, 0.76 + 0.48 * wdLo, wdAmt * 0.75) * mix(1.0, 0.86 + 0.28 * wdN(vWdOP * 7.0 + 11.0), wdAmt);
// painted metal (mode 8 + 0.9*wear): per-pixel chips through the paint where wear is high
float wdChip = 0.0;
if (wdMode > 7.5 && wdMode < 9.0) {
  float wear = fract(wdMode) / 0.9;
  float m = wdN(vWdOP * 160.0) * 0.55 + wdN(vWdOP * 520.0 + 5.0) * 0.3 + wdN(vWdOP * 1500.0 + 2.0) * 0.15;
  wdChip = 1.0 - smoothstep(wear - 0.04, wear + 0.005, 1.0 - m);
  float rim = (1.0 - smoothstep(wear - 0.1, wear - 0.03, 1.0 - m)) - wdChip;
  diffuseColor.rgb *= 1.0 - clamp(rim, 0.0, 1.0) * 0.45;
  vec3 wdBare = mix(vec3(0.5, 0.51, 0.53), diffuseColor.rgb * 1.1, step(0.22, vColor.g));
  diffuseColor.rgb = mix(diffuseColor.rgb, wdBare * (0.85 + 0.3 * wdN(vWdOP * 900.0)), wdChip);
}
float wdCrack = 0.0;
if (vWdGlow < 0.0) {
  float c1 = abs(wdN(vWdOP * 34.0) - 0.5) + abs(wdN(vWdOP * 80.0 + 3.0) - 0.5) * 0.3;
  wdCrack = 1.0 - smoothstep(0.012, 0.045, c1);
  diffuseColor.rgb *= 1.0 - wdCrack * 0.7;
}
float wdChar = 0.0;
if (uChar > 0.0) {
  wdChar = smoothstep(0.0, 0.25, uChar * 1.4 - wdN(vWdOP * 2.1) * 0.7 - wdN(vWdOP * 9.0) * 0.3);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.022, 0.018, 0.015), wdChar * 0.93);
}
`;
const UB_F2 = `roughnessFactor = mix(clamp(vWdMR.y + (wdHt - 0.5) * 0.25 * wdAmt + wdChar * 0.4, 0.04, 1.0), 0.3, wdChip);`;
const UB_F3 = `
{
  float wdAmp = (wdMode > 3.5 && wdMode < 4.5) ? 0.0026 : 0.0012;
  float wdBH = (wdHt - 0.5) * wdAmt * wdAmp * wdFade - wdCrack * 0.0012;
  vec3 wdSx = dFdx(-vViewPosition); vec3 wdSy = dFdy(-vViewPosition);
  vec3 wdR1 = cross(wdSy, normal); vec3 wdR2 = cross(normal, wdSx);
  float wdDet = dot(wdSx, wdR1) * faceDirection;
  vec3 wdG = sign(wdDet) * (dFdx(wdBH) * wdR1 + dFdy(wdBH) * wdR2);
  normal = normalize(abs(wdDet) * normal - wdG);
}
`;
const UB_F4 = `
if (vWdGlow > 0.0) totalEmissiveRadiance += vColor.rgb * vWdGlow;
if (vWdGlow < 0.0) totalEmissiveRadiance += vec3(1.0, 0.26, 0.05) * wdCrack * (-vWdGlow) * (0.75 + 0.5 * wdN(vWdOP * 9.0));
`;

/** patch a MeshStandardMaterial with the uber shader (keeps the global fog patch) */
function uberize(mat) {
  const u = { uDamage: { value: 0 }, uChar: { value: 0 } };
  mat.userData.wd = u;
  const prev = THREE.Material.prototype.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    sh.uniforms.uDamage = u.uDamage; sh.uniforms.uChar = u.uChar;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + UB_VH)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + UB_VB);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + UB_FH)
      .replace('#include <roughnessmap_fragment>', UB_F1 + '\n#include <roughnessmap_fragment>\n' + UB_F2)
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(vWdMR.x, 0.9, wdChip);')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + UB_F3)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + UB_F4);
  };
  mat.customProgramCacheKey = () => 'wd-uber-1';
  return mat;
}

let ENV = null, ENV_I = 0.55;
const ENV_MATS = [];
function envTex() {
  if (ENV) return ENV;
  const c = makeCanvas(128, 64), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 64);
  gr.addColorStop(0, '#b8c2cc'); gr.addColorStop(0.45, '#8e9398'); gr.addColorStop(0.52, '#4c4a44'); gr.addColorStop(1, '#1c1914');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 64);
  const s = g.createRadialGradient(40, 14, 1, 40, 14, 16); s.addColorStop(0, 'rgba(255,248,230,0.9)'); s.addColorStop(1, 'rgba(255,248,230,0)');
  g.fillStyle = s; g.fillRect(0, 0, 128, 64);
  ENV = toTex(c, { repeat: false, mips: false }); ENV.mapping = THREE.EquirectangularReflectionMapping;
  return ENV;
}
/** scale the reflection environment baked into item materials (e.g. 0.15 at night) */
export function setItemEnv(intensity) { ENV_I = intensity; for (const m of ENV_MATS) m.envMapIntensity = intensity; }

function uber(o = {}) {
  const m = uberize(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1, envMap: envTex(), envMapIntensity: ENV_I, ...o }));
  ENV_MATS.push(m);
  return m;
}
const MATS = new Map();
const LABELS = {};   // canvas painters for printed items, filled in below
function MAT(key) {
  if (MATS.has(key)) return MATS.get(key);
  let m;
  if (key === 'u') m = uber();
  else if (key === 'bark') { const t = tex('barkPine'); m = uber({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.3, 1.3) }); }
  else if (key === 'end') { const t = tex('logEnd'); m = uber({ map: t.map, normalMap: t.normalMap }); }
  else if (key === 'wood') { const t = tex('freshWood'); m = uber({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(0.22, 0.22) }); }
  else if (key === 'glass') m = uber({ transparent: true, opacity: 0.35, depthWrite: false });
  else if (key === 'paper') m = uber({ map: LABELS.note(), side: THREE.DoubleSide });
  else if (LABELS[key]) m = uber({ map: LABELS[key]() });
  else throw new Error('ItemArt: no material ' + key);
  MATS.set(key, m);
  return m;
}
let GHOST = null;
function ghostMat() {
  return GHOST || (GHOST = new THREE.MeshStandardMaterial({ color: 0xbfe2ff, emissive: 0x3c6e9a, emissiveIntensity: 0.6, roughness: 0.6, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false }));
}

/* ====================================================================== geometry core */
const _p = new V3(), _n = new V3();
/** write vertex colour + aMR (+ aGlow): c = hex | Color | fn(p, n, i) -> Color; mr = array | fn */
function paint(geo, c = 0xffffff, mr = MR.woodY, glow = 0) {
  const P = geo.attributes.position, N = geo.attributes.normal, n = P.count;
  const cf = typeof c === 'function' ? c : null, cc = cf ? null : (c.isColor ? c : col(c));
  const mf = typeof mr === 'function' ? mr : null, gf = typeof glow === 'function' ? glow : null;
  const C = new Float32Array(n * 3), M = new Float32Array(n * 4), G = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    _p.fromBufferAttribute(P, i); _n.fromBufferAttribute(N, i);
    const k = cf ? cf(_p, _n, i) : cc;
    C[i * 3] = k.r; C[i * 3 + 1] = k.g; C[i * 3 + 2] = k.b;
    const m = mf ? mf(_p, _n, i) : mr;
    M[i * 4] = m[0]; M[i * 4 + 1] = m[1]; M[i * 4 + 2] = m[2]; M[i * 4 + 3] = m[3];
    G[i] = gf ? gf(_p, _n, i) : glow;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
  geo.setAttribute('aMR', new THREE.BufferAttribute(M, 4));
  geo.setAttribute('aGlow', new THREE.BufferAttribute(G, 1));
  return geo;
}
/** multiply existing vertex colours by fn(p, n) */
function shade(geo, fn) {
  const P = geo.attributes.position, N = geo.attributes.normal, C = geo.attributes.color;
  if (!C) return geo;
  for (let i = 0; i < P.count; i++) {
    _p.fromBufferAttribute(P, i); _n.fromBufferAttribute(N, i);
    const k = fn(_p, _n);
    C.setXYZ(i, C.getX(i) * k, C.getY(i) * k, C.getZ(i) * k);
  }
  return geo;
}
function setPiv(geo, c, id) {
  const n = geo.attributes.position.count, a = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { a[i * 4] = c.x; a[i * 4 + 1] = c.y; a[i * 4 + 2] = c.z; a[i * 4 + 3] = id; }
  geo.setAttribute('aPiv', new THREE.BufferAttribute(a, 4));
  return geo;
}

const ATTR = [['position', 3, null], ['normal', 3, null], ['uv', 2, [0, 0]], ['color', 3, [1, 1, 1]], ['aMR', 4, [0, 0.85, 0.5, 0]], ['aGlow', 1, [0]], ['aPiv', 4, [0, 0, 0, -1]]];
/** merge geometries keeping all custom attributes (indexed output) */
function merge(list) {
  const gs = list.filter(Boolean);
  let nv = 0, ni = 0;
  for (const g of gs) { if (!g.attributes.normal) g.computeVertexNormals(); nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const arrs = {};
  for (const [name, sz] of ATTR) arrs[name] = new Float32Array(nv * sz);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of gs) {
    const cnt = g.attributes.position.count;
    for (const [name, sz, def] of ATTR) {
      const a = g.attributes[name], dst = arrs[name];
      if (a && a.itemSize === sz) dst.set(a.array.subarray(0, cnt * sz), vo * sz);
      else for (let i = 0; i < cnt; i++) dst.set(def, (vo + i) * sz);
    }
    if (g.index) { const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx[io++] = ia[i] + vo; }
    else for (let i = 0; i < cnt; i++) idx[io++] = vo + i;
    vo += cnt;
  }
  const out = new THREE.BufferGeometry();
  for (const [name, sz] of ATTR) out.setAttribute(name, new THREE.BufferAttribute(arrs[name], sz));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}
function geoFrom(pos, uv, idx) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
/** average the normals of vertices that share a position (seams, poles) */
function weldNormals(geo) {
  if (!geo.attributes.normal) geo.computeVertexNormals();
  const P = geo.attributes.position, N = geo.attributes.normal, map = new Map(), keys = new Array(P.count);
  for (let i = 0; i < P.count; i++) {
    const k = Math.round(P.getX(i) * 2e4) + ',' + Math.round(P.getY(i) * 2e4) + ',' + Math.round(P.getZ(i) * 2e4);
    keys[i] = k; let s = map.get(k); if (!s) map.set(k, s = [0, 0, 0]);
    s[0] += N.getX(i); s[1] += N.getY(i); s[2] += N.getZ(i);
  }
  for (let i = 0; i < P.count; i++) { const s = map.get(keys[i]), l = Math.hypot(s[0], s[1], s[2]) || 1; N.setXYZ(i, s[0] / l, s[1] / l, s[2] / l); }
  N.needsUpdate = true;
  return geo;
}
/** displace along (welded) normals by fn(p) or by noise */
function lumpy(geo, amp, freq, seed = 0, oct = 3) {
  geo.computeVertexNormals(); weldNormals(geo);
  const P = geo.attributes.position, N = geo.attributes.normal;
  for (let i = 0; i < P.count; i++) {
    _p.fromBufferAttribute(P, i); _n.fromBufferAttribute(N, i);
    const d = (typeof amp === 'function' ? amp(_p, _n) : amp * nzp(_p, freq, seed, oct));
    P.setXYZ(i, _p.x + _n.x * d, _p.y + _n.y * d, _p.z + _n.z * d);
  }
  P.needsUpdate = true; geo.computeVertexNormals(); weldNormals(geo);
  return geo;
}
function warp(geo, fn, smooth = true) {
  const P = geo.attributes.position;
  for (let i = 0; i < P.count; i++) { _p.fromBufferAttribute(P, i); fn(_p, i); P.setXYZ(i, _p.x, _p.y, _p.z); }
  P.needsUpdate = true; geo.computeVertexNormals(); if (smooth) weldNormals(geo);
  return geo;
}

/** a cap that closes a ring of points: concentric rings, optional bulge / displacement */
function capGeo(ring, c, out, R = 1, disp = null, bulge = 0) {
  const n = ring.length, pos = [], uv = [], idx = [];
  const cen = c.clone().addScaledVector(out, bulge + (disp ? disp(0, 0) : 0));
  pos.push(cen.x, cen.y, cen.z); uv.push(0.5, 0.5);
  for (let k = 1; k <= R; k++) {
    const s = k / R;
    for (let j = 0; j < n; j++) {
      const p = c.clone().lerp(ring[j], s);
      if (k < R) { p.addScaledVector(out, bulge * (1 - s * s)); if (disp) p.addScaledVector(out, disp(s, j)); }
      const a = (j / n) * TAU;
      pos.push(p.x, p.y, p.z); uv.push(0.5 + Math.cos(a) * 0.47 * s, 0.5 + Math.sin(a) * 0.47 * s);
    }
  }
  for (let j = 0; j < n; j++) idx.push(0, 1 + j, 1 + ((j + 1) % n));
  for (let k = 1; k < R; k++) {
    const b0 = 1 + (k - 1) * n, b1 = 1 + k * n;
    for (let j = 0; j < n; j++) { const a = b0 + j, b = b0 + ((j + 1) % n), c2 = b1 + j, d = b1 + ((j + 1) % n); idx.push(a, c2, b, b, c2, d); }
  }
  // orient outward
  const P = (i) => new V3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
  const sum = new V3();
  for (let t = 0; t < n * 3; t += 3) { const a = P(idx[t]), b = P(idx[t + 1]), d = P(idx[t + 2]); sum.add(b.sub(a).cross(d.sub(a))); }
  if (sum.dot(out) < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  return geoFrom(pos, uv, idx);
}

/** loft closed rings (arrays of V3, equal length) into a tube surface; caps optional */
function loftRings(rings, o = {}) {
  const M = rings[0].length, R = rings.length, pos = [], uv = [], idx = [];
  const cen = rings.map(r => r.reduce((a, p) => a.add(p), new V3()).multiplyScalar(1 / M));
  let vacc = 0;
  for (let i = 0; i < R; i++) {
    if (i > 0) vacc += cen[i].distanceTo(cen[i - 1]);
    for (let j = 0; j <= M; j++) {
      const p = rings[i][j % M]; pos.push(p.x, p.y, p.z);
      const u = (j / M) * (o.uRep || 1), v = vacc * (o.vScale ?? 1);
      if (o.swapUV) uv.push(v, u); else uv.push(u, v);
    }
  }
  for (let i = 0; i < R - 1; i++) for (let j = 0; j < M; j++) { const a = i * (M + 1) + j, b = a + M + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  // make sure the surface faces outward (sample the fattest ring)
  let best = 0, bi = Math.floor(R / 2);
  for (let i = 0; i < R; i++) { const d = rings[i][0].distanceTo(cen[i]); if (d > best) { best = d; bi = i; } }
  const i0 = Math.min(bi, R - 2), a = i0 * (M + 1), pa = new V3(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]);
  const pb = new V3(pos[(a + M + 1) * 3], pos[(a + M + 1) * 3 + 1], pos[(a + M + 1) * 3 + 2]), pc = new V3(pos[(a + 1) * 3], pos[(a + 1) * 3 + 1], pos[(a + 1) * 3 + 2]);
  const nrm = pb.clone().sub(pa).cross(pc.clone().sub(pa));
  if (nrm.dot(pa.clone().sub(cen[i0])) < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  const g = geoFrom(pos, uv, idx);
  const N = g.attributes.normal;
  for (let i = 0; i < R; i++) { // close the uv seam smoothly
    const a0 = i * (M + 1), a1 = a0 + M;
    const x = N.getX(a0) + N.getX(a1), y = N.getY(a0) + N.getY(a1), z = N.getZ(a0) + N.getZ(a1), l = Math.hypot(x, y, z) || 1;
    N.setXYZ(a0, x / l, y / l, z / l); N.setXYZ(a1, x / l, y / l, z / l);
  }
  const res = { geo: g, cap0: null, cap1: null, cen };
  const caps = o.caps === true ? [true, true] : (o.caps || [false, false]);
  for (const end of [0, 1]) {
    if (!caps[end]) continue;
    const i = end ? R - 1 : 0, j = end ? R - 2 : 1;
    const out = cen[i].clone().sub(cen[j]).normalize();
    res[end ? 'cap1' : 'cap0'] = capGeo(rings[i], cen[i], out, o.capRings || 1, o.capFn ? (s, k) => o.capFn(s, k, end) : null, Array.isArray(o.bulge) ? o.bulge[end] : (o.bulge || 0));
  }
  return res;
}

/** sweep a section along a smooth curve. rx/ry are the half sizes along the side (B)
    and up (N) axes; up is a hint vector. rmod(t, angle, centre) scales the radius. */
function sweep(points, o = {}) {
  const seg = o.seg || 16, radial = o.radial || 10, e = o.e ?? 1;
  const pts = points.map(v3);
  const curve = pts.length > 2 ? new THREE.CatmullRomCurve3(pts, false, 'centripetal') : new THREE.LineCurve3(pts[0], pts[1]);
  const L = curve.getLength();
  const rxf = fnOf(o.rx ?? o.r ?? 0.05), ryf = fnOf(o.ry ?? o.rx ?? o.r ?? 0.05);
  const C = [], T = [], N = [], B = [];
  for (let i = 0; i <= seg; i++) { const t = i / seg; C.push(curve.getPointAt(t)); T.push(curve.getTangentAt(t).normalize()); }
  const perp = (v, t) => {
    v.addScaledVector(t, -v.dot(t));
    if (v.lengthSq() < 1e-8) { v.set(Math.abs(t.x) < 0.9 ? 1 : 0, Math.abs(t.x) < 0.9 ? 0 : 1, 0); v.addScaledVector(t, -v.dot(t)); }
    return v.normalize();
  };
  let n = perp(v3(o.up || [0, 0, 1]), T[0]);
  const q = new THREE.Quaternion();
  for (let i = 0; i <= seg; i++) {
    if (i > 0) { if (o.fixedUp) n = v3(o.up); else { q.setFromUnitVectors(T[i - 1], T[i]); n.applyQuaternion(q); } perp(n, T[i]); }
    N.push(n.clone()); B.push(new V3().crossVectors(T[i], n).normalize());
  }
  const rings = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, rx = rxf(t), ry = ryf(t), ring = [];
    for (let j = 0; j < radial; j++) {
      const a = (j / radial) * TAU; let ca = Math.cos(a), sa = Math.sin(a);
      if (e !== 1) { ca = spow(ca, e); sa = spow(sa, e); }
      const m = o.rmod ? o.rmod(t, a, C[i]) : 1;
      const lx = ca * rx * m, ly = sa * ry * m;
      const p = C[i].clone().addScaledVector(B[i], lx).addScaledVector(N[i], ly);
      if (o.endTilt && (i === 0 || i === seg)) { const et = o.endTilt[i ? 1 : 0]; if (et) p.addScaledVector(T[i], et[0] * lx + et[1] * ly); }
      ring.push(p);
    }
    rings.push(ring);
  }
  const res = loftRings(rings, { uRep: o.uRep, vScale: o.vScale, swapUV: o.swapUV, caps: o.caps, capRings: o.capRings, capFn: o.capFn, bulge: o.bulge });
  Object.assign(res, { L, C, T, N, B, curve });
  return res;
}
const parts = r => [r.geo, r.cap0, r.cap1].filter(Boolean);

/** helix coil (rope lashing / leather wrap) around the segment a -> b */
function coil(a, b, rad, turns, thick, o = {}) {
  const A = v3(a), B = v3(b), ax = B.clone().sub(A), L = ax.length(); ax.normalize();
  const e1 = o.e1 ? v3(o.e1) : new V3(Math.abs(ax.y) < 0.9 ? 0 : 1, Math.abs(ax.y) < 0.9 ? 1 : 0, 0).cross(ax).normalize();
  const e2 = new V3().crossVectors(ax, e1);
  const [rx, ry] = Array.isArray(rad) ? rad : [rad, rad];
  const thin = thick < 0.005 && !o.flat, per = Math.min(o.perTurn || 12, thin ? 10 : 12);   // budget: rope relief comes from the shader
  const n = Math.max(6, Math.ceil(turns * per)), pts = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, th = s * turns * TAU + (o.phase || 0);
    const wob = o.wobble ? 1 + o.wobble * Math.sin(th * 3.1 + i) : 1;
    pts.push(A.clone().addScaledVector(ax, s * L).addScaledVector(e1, Math.cos(th) * rx * wob).addScaledVector(e2, Math.sin(th) * ry * wob));
  }
  const flat = o.flat || 0;   // > 0 = flat strap of that width
  return merge(parts(sweep(pts, { seg: n, radial: o.radial || (flat || thin ? 4 : 5), rx: thick, ry: flat ? flat : thick, up: [ax.x, ax.y, ax.z], fixedUp: !!flat, e: flat ? 0.5 : 1, caps: true, bulge: flat ? 0 : thick * 0.6 })));
}
/** rounded box: every edge/corner bevelled with radius r over s segments (analytic
    normals); mid = segments across each flat span (for later deformation) */
function rbox(w, h, d, r = 0.01, s = 2, mid = [1, 1, 1]) {
  const H = [w / 2, h / 2, d / 2];
  r = Math.max(0.0002, Math.min(r, H[0] * 0.98, H[1] * 0.98, H[2] * 0.98));
  const n = mid.map(m => 2 * s + m);
  const g = new THREE.BoxGeometry(1, 1, 1, n[0], n[1], n[2]);
  const P = g.attributes.position, N = g.attributes.normal, u = [0, 0, 0], c = [0, 0, 0], o = [0, 0, 0];
  for (let i = 0; i < P.count; i++) {
    u[0] = P.getX(i); u[1] = P.getY(i); u[2] = P.getZ(i);
    for (let a = 0; a < 3; a++) {
      const k = Math.round((u[a] + 0.5) * n[a]), m = mid[a], inner = H[a] - r;
      let x;
      if (k <= s) x = -inner - r * Math.sin(((s - k) / s) * Math.PI / 2);
      else if (k >= n[a] - s) x = inner + r * Math.sin(((k - (n[a] - s)) / s) * Math.PI / 2);
      else x = -inner + ((k - s) / m) * 2 * inner;
      c[a] = clamp(x, -inner, inner); o[a] = x - c[a];
    }
    let l = Math.hypot(o[0], o[1], o[2]);
    if (l < 1e-9) { o[0] = N.getX(i); o[1] = N.getY(i); o[2] = N.getZ(i); l = 1; }
    o[0] /= l; o[1] /= l; o[2] /= l;
    P.setXYZ(i, c[0] + o[0] * r, c[1] + o[1] * r, c[2] + o[2] * r); N.setXYZ(i, o[0], o[1], o[2]);
  }
  return g;
}
function ell(rx, ry, rz, ws = 14, hs = 10) { const g = new THREE.SphereGeometry(1, ws, hs); xf(g, { s: [rx, ry, rz] }); return g; }
function cyl(r0, r1, h, rs = 12, open = false) { return new THREE.CylinderGeometry(r1, r0, h, rs, 1, open); }
function lath(profile, seg = 24) { if (profile[0][1] > profile[profile.length - 1][1]) profile = profile.slice().reverse(); const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)), seg); g.computeVertexNormals(); weldNormals(g); return g; }
/** smooth river/field stone */
function stoneGeo(r, s = [1, 0.7, 0.85], seed = 0, ws = 12, hs = 8, amp = 0.18) {
  const g = new THREE.SphereGeometry(1, ws, hs);
  lumpy(g, (p) => nzp(p, 1.3, seed) * amp + nzp(p, 3.1, seed + 5) * amp * 0.35 + nzp(p, 7.5, seed + 9) * amp * 0.16 - Math.abs(nzp(p, 4.2, seed + 2)) * amp * 0.25, 1);
  xf(g, { s: [r * s[0], r * s[1], r * s[2]], r: [0, seed * 1.7, 0] });
  weldNormals(g);
  return g;
}
/** a double-sided leaf, base at origin, along +Y, face toward +Z */
function leafGeo(len, wid, o = {}) {
  const nx = o.nx || 4, pos = [], uv = [], idx = [];
  for (let i = 0; i <= nx; i++) {
    const s = i / nx, w = (wid / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.92 + 0.04)), 0.8);
    for (let j = 0; j < 3; j++) {
      const a = j - 1, x = a * w, y = s * len, z = Math.abs(a) * w * (o.fold ?? 0.35) + (o.curl ?? 0.2) * len * s * s;
      pos.push(x, y, z); uv.push(j / 2, s);
    }
  }
  for (let i = 0; i < nx; i++) for (let j = 0; j < 2; j++) { const a = i * 3 + j, b = a + 3; idx.push(a, a + 1, b, a + 1, b + 1, b); }
  const front = geoFrom(pos, uv, idx);
  const back = geoFrom(pos, uv, idx.map((v, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]]));
  return merge([front, back]);
}
/** knapped stone blade (obsidian / flint) along +Y from y = 0 (base) to y = len (point) */
function knapBlade(len, wid, thick, seed, o = {}) {
  const R = rng(seed), rs = o.rings || 28, M = o.radial || 18;
  const W = s => (wid / 2) * (s < 0.28 ? lerp(o.base ?? 0.55, 1, sstep(0, 0.28, s)) : 1 - Math.pow((s - 0.28) / 0.72, 1.35));
  const Tk = s => (thick / 2) * (s < 0.3 ? 1 : 1 - Math.pow((s - 0.3) / 0.7, 1.15) * 0.92);
  const scars = [];
  for (const face of [-1, 1]) for (const side of [-1, 1]) for (let k = 0; k < (o.scars || 7); k++) {
    const s = (k + R.range(0.1, 0.9)) / (o.scars || 7) * 0.95;
    scars.push({ face, side, y: s * len, s, r: W(s) * R.range(0.55, 0.85) + wid * 0.06, d: Tk(s) * R.range(0.5, 0.8) });
  }
  const rings = [], info = [];   // info: per ring vertex [scar id, distance ratio, edge factor]
  for (let i = 0; i <= rs; i++) {
    const s = i / rs, w = Math.max(W(s), 1e-4), t = Math.max(Tk(s), 1e-4), ring = [];
    for (let j = 0; j < M; j++) {
      const a = (j / M) * TAU, ca = Math.cos(a), sa = Math.sin(a);
      const x = ca * w; let z = sa * t * (1 - ca * ca * 0.15);
      const face = Math.sign(sa) || 1; let cut = 0, win = -1, wq = 0;
      scars.forEach((sc, k) => {
        if (sc.face !== face) return;
        const dx = x - sc.side * W(sc.s) * 1.05, dy = s * len - sc.y, q = 1 - (dx * dx + dy * dy) / (sc.r * sc.r);
        if (q > 0 && sc.d * q * q > cut) { cut = sc.d * q * q; win = k; wq = q; }
      });
      z = face * Math.max(Math.abs(z) * 0.22, Math.abs(z) - cut);
      ring.push(new V3(x, s * len, z));
      info.push([win, wq, Math.abs(ca) ** 6]);
    }
    rings.push(ring);
  }
  const r = loftRings(rings, { caps: [true, false] });
  if (o.c0 !== undefined) { // facet-by-facet tone + conchoidal ripples + pale translucent edges
    const c0 = col(o.c0), c1 = col(o.c1 ?? o.c0), c = new THREE.Color(), H = (k) => ((Math.sin(k * 91.7 + seed) * 43758.5) % 1 + 1) % 1;
    paint(r.geo, (p, n, idx) => {
      const [k, q, e] = info[Math.floor(idx / (M + 1)) * M + (idx % (M + 1)) % M];
      const tone = k < 0 ? 1 : 0.75 + 0.5 * H(k) + 0.12 * Math.sin(q * 22);
      return c.copy(c0).multiplyScalar(tone).lerp(c1, e * 0.8);
    }, o.mr || MR.obsid);
    paint(r.cap0, c0, o.mr || MR.obsid);
  }
  if (o.flat === false) return merge([r.geo, r.cap0]);
  // faceted shading: each knapping facet catches the light on its own, like real flaked stone
  const f = r.geo.toNonIndexed(); f.computeVertexNormals();
  return merge([f, r.cap0]);
}

/* ====================================================================== logs, planks, rope */
let LOG_N = 1;
/** a log / pole / branch from a to b. Returns { bark, ends: [], tip? } geometries,
    already painted. o: seed, bend, taper, amp, knots, radial, seg, tint, endTint,
    point (fraction sharpened into a wood tip), chop (domed axe-cut ends), capsAt */
function logAB(a, b, r, o = {}) {
  const A = v3(a), B = v3(b), L = A.distanceTo(B), seed = o.seed ?? (LOG_N++ * 7.31) % 1000;
  const R = rng(Math.floor(seed * 977) + 3);
  const dir = B.clone().sub(A).normalize();
  const s1 = new V3(Math.abs(dir.y) < 0.95 ? 0 : 1, Math.abs(dir.y) < 0.95 ? 1 : 0, 0).cross(dir).normalize();
  const s2 = new V3().crossVectors(dir, s1);
  const ba = R() * TAU, bend = (o.bend ?? 0.012) * L, bdir = s1.clone().multiplyScalar(Math.cos(ba)).addScaledVector(s2, Math.sin(ba));
  const pf = o.point || 0, tEnd = 1 - pf, pts = [];
  for (let k = 0; k <= 4; k++) { const s = (k / 4) * tEnd; pts.push(A.clone().lerp(B, s).addScaledVector(bdir, Math.sin(Math.PI * s) * bend)); }
  const taper = o.taper ?? 0.07, amp = o.amp ?? 0.045, flip = o.flip ? -1 : 1;
  const knots = [];
  for (let k = 0; k < (o.knots ?? Math.round(L * 1.5)); k++) knots.push([R.range(0.08, 0.92), R() * TAU, R.range(0.05, 0.12)]);
  const rf = t => r * (1 + taper * (0.5 - t) * 2 * flip);
  const radial = o.radial ?? 10, seg = o.seg ?? Math.max(3, Math.round(L * tEnd / 0.3));
  const rmod = (t, an) => {
    const tt = t * tEnd; let m = 1 + amp * n3(tt * L * 1.7 + seed, Math.cos(an) * 0.9, Math.sin(an) * 0.9) + amp * 0.4 * n3(tt * L * 7 + seed, Math.cos(an) * 2.5, Math.sin(an) * 2.5);
    for (const [kt, ka, kh] of knots) { let da = Math.abs(an - ka); da = Math.min(da, TAU - da); m += kh * gauss((tt - kt) * L, 0.045) * gauss(da, 0.45); }
    return m;
  };
  const caps = o.capsAt || [true, !pf];
  const chop = o.chop || 0;
  const sw = sweep(pts, {
    seg, radial, rx: t => rf(t * tEnd), up: o.up || [s1.x, s1.y, s1.z], rmod, uRep: Math.max(1, Math.round(TAU * r / 0.42)), vScale: 1 / 0.9,
    caps, capRings: chop ? 3 : 1, capFn: chop ? (s) => chop * r * (1 - s) * (0.7 + 0.3 * Math.sin(s * 9 + seed)) : null, bulge: 0,
    endTilt: o.endTilt,
  });
  const tint = col(o.tint ?? 0xd8d0c4), endTint = col(o.endTint ?? 0xb8aa98);
  const mid = A.clone().lerp(B, 0.5), id = R();
  const barkCol = new THREE.Color();
  const charK = (p) => (o.charY !== undefined ? sstep(o.charY + 0.06, o.charY - 0.06, p.y + 0.05 * nzp(p, 8, seed)) : 0);
  paint(sw.geo, (p, n) => {
    // x1.6: vertex colours may exceed 1 - lifts the dark pine bark map to a natural grey-brown
    const k = 1.6 * (0.72 + 0.28 * clamp(n.y * 0.5 + 0.6, 0, 1)) * (1 + 0.14 * nzp(p, 2.2, seed));
    barkCol.copy(tint).multiplyScalar(k);
    if (o.moss) { const m = clamp((n.y - 0.2) * 1.4, 0, 1) * clamp(nzp(p, 3, seed + 9) * 2 + 0.3, 0, 1) * o.moss; barkCol.lerp(MOSS, m * 0.7); }
    return barkCol.lerp(CHAR, charK(p) * 0.92);
  }, MR.barkTex);
  setPiv(sw.geo, mid, id);
  const ends = [sw.cap0, sw.cap1].filter(Boolean);
  const endCol = new THREE.Color();
  for (const e of ends) { paint(e, (p) => endCol.copy(endTint).multiplyScalar(0.9 + 0.15 * nzp(p, 9, seed)).lerp(CHAR, charK(p) * 0.95), MR.end); setPiv(e, mid, id); }
  const out = { bark: sw.geo, ends, sw };
  if (pf > 0) { // carved point
    const c = sw.curve, P0 = c.getPointAt(1), T0 = c.getTangentAt(1), tipL = L * pf, r0 = rf(tEnd);
    const tp = [P0.clone().addScaledVector(T0, -0.01 * L), P0, P0.clone().addScaledVector(T0, tipL * 0.5), P0.clone().addScaledVector(T0, tipL)];
    const tsw = sweep(tp, { seg: 7, radial, rx: t => r0 * Math.pow(Math.max(0, 1 - t), 0.9) * (1.03 + 0.02 * t) + 0.0006, up: o.up || [s1.x, s1.y, s1.z], swapUV: true, vScale: 1 / 0.5,
      rmod: (t, an) => 1 - 0.09 * t * Math.abs(Math.sin(an * 2.5 + seed)) });
    const fresh = col(0xc9b08a), charC = col(0x1a1410), wc = new THREE.Color();
    paint(tsw.geo, (p, n, i) => {
      const t = Math.floor(i / (radial + 1)) / 7;
      return wc.copy(fresh).lerp(charC, o.charTip ? sstep(0.35, 1, t + 0.15 * nzp(p, 30, seed)) : 0).multiplyScalar(0.85 + 0.2 * nzp(p, 20, seed));
    }, MR.woodX);
    setPiv(tsw.geo, mid, id);
    out.tip = tsw.geo;
  }
  return out;
}
const MOSS = col(0x4d5a2c), CHAR = col(0x0d0b09);

/** sawn / split plank with grain along its length (local X), centred */
function plankGeo(len, w, t, seed = 0, o = {}) {
  const g = new THREE.BoxGeometry(len, t, w, Math.max(2, Math.round(len / 0.25)), 1, 2);
  const R = rng(seed * 131 + 7), cup = o.cup ?? 0.15, tw = R.range(-0.02, 0.02);
  warp(g, (p) => {
    const u = p.x / len;
    p.y += cup * t * (p.z / (w / 2)) ** 2 * 0.5 + tw * p.z * u * 2 + n3(p.x * 2 + seed, p.z * 3, seed) * t * 0.12;
    if (o.split) p.y -= t * 0.3 * (1 - Math.cos((p.z / (w / 2)) * 1.2)) * (p.y < 0 ? 1 : 0);
    p.z += n3(p.x * 1.5 + seed, 7, seed) * w * 0.04;
  }, false);
  // uv: grain runs along u (freshWood stripes are horizontal in canvas space)
  const P = g.attributes.position, U = g.attributes.uv;
  for (let i = 0; i < P.count; i++) U.setXY(i, P.getX(i) / 0.6 + seed * 0.37, (P.getY(i) + P.getZ(i)) / 0.6 + seed * 0.21);
  return g;
}
function paintPlank(g, base, seed, o = {}) {
  const c = new THREE.Color(), b = col(base);
  return paint(g, (p, n) => {
    let k = 0.86 + 0.22 * nzp(p, 3, seed) ;
    if (o.edgeDark) k *= 0.85 + 0.15 * clamp(n.y, 0, 1);
    return c.copy(b).multiplyScalar(k);
  }, o.mr || MR.woodX);
}

/* ====================================================================== Kit: collects parts per material */
class Kit {
  constructor() { this.parts = new Map(); this.nodes = []; this.kids = []; }
  add(mat, ...geos) { let l = this.parts.get(mat); if (!l) this.parts.set(mat, l = []); for (const g of geos) if (g) l.push(g); return this; }
  node(name, p = [0, 0, 0], r = null) { const o = new THREE.Object3D(); o.name = name; o.position.set(p[0], p[1], p[2]); if (r) o.rotation.set(r[0], r[1], r[2]); this.nodes.push(o); return o; }
  kid(obj) { this.kids.push(obj); return obj; }
  log(a, b, r, o = {}) { const L = logAB(a, b, r, o); this.add('bark', L.bark); this.add('end', ...L.ends); if (L.tip) this.add('wood', L.tip); return L; }
  rope(a, b, rad, turns, thick = 0.009, o = {}) { const g = coil(a, b, rad, turns, thick, o); paint(g, o.c ?? 0x9c845c, o.mr || MR.rope); this.add(o.mat || 'u', g); return g; }
  build(group = new THREE.Group(), o = {}) {
    for (const [k, list] of this.parts) {
      if (!list.length) continue;
      const g = merge(list);
      if (o.groundAO) shade(g, (p) => lerp(0.5, 1, sstep(-0.02, 0.35, p.y)));
      const m = new THREE.Mesh(g, MAT(k)); m.name = 'm_' + k; m.castShadow = m.receiveShadow = true;
      group.add(m);
    }
    for (const n of this.nodes) group.add(n);
    for (const k of this.kids) group.add(k);
    return group;
  }
}

/* ====================================================================== small shared helpers */
function vary(hex, amt = 0.15, f = 20, seed = 0) { const b = col(hex), c = new THREE.Color(); return (p) => c.copy(b).multiplyScalar(1 + amt * nzp(p, f, seed)); }
const Y_UP = new V3(0, 1, 0);
/** rotate a geometry so its +Y points along dir, then move it to pos */
function aim(g, dir, pos) { g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(Y_UP, v3(dir).normalize())); if (pos) g.translate(pos[0] ?? pos.x, pos[1] ?? pos.y, pos[2] ?? pos.z); return g; }
/** loft through key sections perpendicular to Y: keys [y, cx, cz, hx, hz, e?] */
function loftKeys(keys, o = {}) {
  const n = o.n || 32, M = o.radial || 16, y0 = keys[0][0], y1 = keys[keys.length - 1][0];
  const K = (i) => keys[clamp(i, 0, keys.length - 1)];
  const cr = (a, b, c, d, t) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const at = (y) => {
    let k = 0; while (k < keys.length - 2 && keys[k + 1][0] < y) k++;
    const t = clamp((y - keys[k][0]) / (keys[k + 1][0] - keys[k][0]), 0, 1), out = [];
    for (let c = 1; c <= 5; c++) out.push(cr((K(k - 1)[c] ?? o.e ?? 0.8), (K(k)[c] ?? o.e ?? 0.8), (K(k + 1)[c] ?? o.e ?? 0.8), (K(k + 2)[c] ?? o.e ?? 0.8), t));
    return out;
  };
  const rings = [];
  for (let i = 0; i <= n; i++) {
    const s = i / n, y = lerp(y0, y1, o.ease ? 0.5 - 0.5 * Math.cos(s * Math.PI) : s), [cx, cz, hx, hz, e] = at(y), ring = [];
    for (let j = 0; j < M; j++) { const a = (j / M) * TAU; ring.push(new V3(cx + hx * spow(Math.cos(a), e), y, cz + hz * spow(Math.sin(a), e))); }
    if (o.ringFn) o.ringFn(ring, s, y);
    rings.push(ring);
  }
  return loftRings(rings, { caps: o.caps ?? true, bulge: o.bulge, capRings: o.capRings });
}
/** a feather along +Y, vane facing +Z */
function featherGeo(len, wid, seed = 1, o = {}) {
  const R = rng(seed), list = [];
  const rach = sweep([[0, -len * 0.1, 0], [0, len * 0.45, 0.002], [0, len, 0.007]], { seg: 10, radial: 5, rx: t => lerp(0.0017, 0.0003, t) * (len / 0.2), up: [0, 0, 1], caps: [true, false] });
  list.push(rach.geo, rach.cap0);
  const nx = 12, gaps = [R.range(0.35, 0.55), R.range(0.6, 0.85)];
  for (const side of [-1, 1]) {
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= nx; i++) {
      const s = i / nx, w = (wid / 2) * Math.pow(Math.sin(Math.PI * Math.min(1, s * 0.86 + 0.1)), 0.55) * (side < 0 ? 0.72 : 1);
      for (let j = 0; j <= 3; j++) {
        const u = j / 3, notch = gaps.some(gp => Math.abs(s - gp) < 0.045) && u > 0.3 ? 0.35 : 0;
        const x = side * (0.0009 + u * w * (1 - notch * 0.4)), y = s * len + u * w * 0.6 - notch * u * w * 0.5;
        pos.push(x, y, 0.007 * s * s - u * u * w * 0.22); uv.push(u, s);
      }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < 3; j++) { const a = i * 4 + j, b = a + 4; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    list.push(geoFrom(pos, uv, idx), geoFrom(pos, uv, idx.map((v, k) => idx[k - (k % 3) + [0, 2, 1][k % 3]])));
  }
  const g = merge(list);
  const dark = col(o.dark ?? 0x3a2818), mid = col(o.mid ?? 0x7a5634), light = col(o.light ?? 0xd8ccb4), c = new THREE.Color();
  return paint(g, (p) => {
    const s = p.y / len, edge = Math.abs(p.x) / (wid / 2);
    if (Math.abs(p.x) < 0.0012 && s < 1) return c.copy(light).multiplyScalar(0.95);
    const bar = sstep(0.55, 0.85, Math.sin(s * Math.PI * (o.bars ?? 7) + edge * 1.2 + seed));
    c.copy(mid).lerp(dark, bar * 0.8).lerp(light, sstep(0.2, 0.0, s) * 0.8);
    if (s > 0.86) c.lerp(dark, 0.6);
    return c.multiplyScalar(0.9 + 0.2 * nzp(p, 120, seed));
  }, [0, 0.75, 0.6, 1]);
}

/* ====================================================================== printed things (canvas) */
const once = f => { let v; return () => v || (v = f()); };
function canvasTex(w, h, draw) { const c = makeCanvas(w, h); draw(c.getContext('2d'), w, h); return toTex(c, { repeat: false }); }
function grime(g, w, h, n, seed, alpha = 0.12) {
  const R = rng(seed);
  for (let i = 0; i < n; i++) {
    const x = R() * w, y = R() * h, r = 4 + R() * 30, gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, `rgba(70,50,30,${alpha * R()})`); gr.addColorStop(1, 'rgba(70,50,30,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
}
LABELS.can = once(() => canvasTex(512, 192, (g, w, h) => {
  g.fillStyle = '#d9b46a'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#7e2416'; g.fillRect(0, 0, w, 26); g.fillRect(0, h - 26, w, 26);
  g.fillStyle = '#e8dcc0'; g.fillRect(0, 26, w, 4); g.fillRect(0, h - 30, w, 4);
  for (const x0 of [0, 256]) {
    g.save(); g.translate(x0, 0);
    g.font = 'bold 66px Impact, "Arial Black", sans-serif'; g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = '#f2e6c8'; g.strokeText('BEANS', 128, 108); g.fillStyle = '#6a1c10'; g.fillText('BEANS', 128, 108);
    g.font = 'bold 15px Arial, sans-serif'; g.fillStyle = '#4a2a14'; g.fillText('PORK & BEANS IN TOMATO SAUCE', 128, 136);
    g.font = '12px Arial, sans-serif'; g.fillText('NET WT 15 OZ (425 g)', 128, 154);
    for (let i = 0; i < 9; i++) { g.fillStyle = i % 2 ? '#7a3a1a' : '#93502a'; g.beginPath(); g.ellipse(40 + i * 22, 52 - (i % 3) * 3, 9, 6, 0.4 * i, 0, TAU); g.fill(); }
    g.restore();
  }
  grime(g, w, h, 40, 3, 0.35);
  const R = rng(9); g.strokeStyle = 'rgba(255,240,210,0.35)';
  for (let i = 0; i < 30; i++) { g.lineWidth = R() * 1.5; g.beginPath(); const x = R() * w, y = R() * h; g.moveTo(x, y); g.lineTo(x + R() * 40 - 20, y + R() * 6 - 3); g.stroke(); }
}));
LABELS.note = once(() => canvasTex(512, 360, (g, w, h) => {
  g.fillStyle = '#e4dcc6'; g.fillRect(0, 0, w, h);
  grime(g, w, h, 30, 5, 0.25);
  g.strokeStyle = 'rgba(80,110,160,0.45)'; g.lineWidth = 1;
  for (let y = 40; y < h; y += 22) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
  g.strokeStyle = 'rgba(170,60,60,0.4)'; g.beginPath(); g.moveTo(34, 0); g.lineTo(34, h); g.moveTo(290, 0); g.lineTo(290, h); g.stroke();
  g.fillStyle = 'rgba(28,30,48,0.88)'; g.font = 'italic 19px "Segoe Script", "Bradley Hand", "Comic Sans MS", cursive';
  const lines = ['day 9 -', 'it walks upright now.', 'it called me in', 'Daniels voice.', 'keep the fire going', 'DO NOT go north', 'of the lake'];
  lines.forEach((t, i) => g.fillText(t, 40 + (i % 2) * 3, 58 + i * 22));
  ['the cave is its', 'larder. bones', 'everywhere. the', 'old ones burned', 'it once. ember', 'spear - the stone', 'is in the cave'].forEach((t, i) => g.fillText(t, 298, 58 + i * 22));
  g.fillStyle = 'rgba(90,40,20,0.25)'; g.beginPath(); g.ellipse(420, 300, 40, 26, 0.3, 0, TAU); g.fill();
  g.fillStyle = 'rgba(0,0,0,0.08)'; g.fillRect(253, 0, 6, h);
}));
LABELS.photo = once(() => canvasTex(256, 320, (g) => {
  g.fillStyle = '#e6e0cc'; g.fillRect(0, 0, 256, 300);
  const x0 = 16, y0 = 16, W = 224, Hh = 216;
  const sky = g.createLinearGradient(0, y0, 0, y0 + Hh); sky.addColorStop(0, '#6f7f86'); sky.addColorStop(0.55, '#3d4a44'); sky.addColorStop(1, '#1e231c');
  g.fillStyle = sky; g.fillRect(x0, y0, W, Hh);
  const R = rng(17);
  for (let i = 0; i < 26; i++) { const x = x0 + R() * W, tw = 4 + R() * 12, sh = 30 + R() * 50; g.fillStyle = `rgba(${18 + sh * 0.2 | 0},${22 + sh * 0.2 | 0},${18 + sh * 0.15 | 0},0.95)`; g.fillRect(x, y0, tw, Hh); }
  g.fillStyle = 'rgba(190,200,195,0.18)'; g.fillRect(x0, y0 + 120, W, 60);
  // a pale, too-tall figure between the trees
  g.fillStyle = 'rgba(205,200,186,0.85)'; g.fillRect(x0 + 150, y0 + 92, 5, 62); g.beginPath(); g.ellipse(x0 + 152.5, y0 + 88, 4, 6, 0, 0, TAU); g.fill();
  g.strokeStyle = 'rgba(205,200,186,0.8)'; g.lineWidth = 1.4; g.beginPath();
  g.moveTo(x0 + 151, y0 + 83); g.lineTo(x0 + 144, y0 + 70); g.lineTo(x0 + 139, y0 + 72); g.moveTo(x0 + 144, y0 + 70); g.lineTo(x0 + 145, y0 + 62);
  g.moveTo(x0 + 154, y0 + 83); g.lineTo(x0 + 161, y0 + 70); g.lineTo(x0 + 166, y0 + 72); g.moveTo(x0 + 161, y0 + 70); g.lineTo(x0 + 160, y0 + 62);
  g.moveTo(x0 + 150, y0 + 100); g.lineTo(x0 + 143, y0 + 140); g.moveTo(x0 + 155, y0 + 100); g.lineTo(x0 + 162, y0 + 140); g.stroke();
  const vg = g.createRadialGradient(x0 + W / 2, y0 + Hh / 2, 40, x0 + W / 2, y0 + Hh / 2, 170); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(10,6,0,0.6)');
  g.fillStyle = vg; g.fillRect(x0, y0, W, Hh);
  g.fillStyle = 'rgba(255,190,90,0.12)'; g.fillRect(x0, y0, W, Hh);
  g.fillStyle = 'rgba(30,30,60,0.8)'; g.font = 'italic 20px "Segoe Script", "Comic Sans MS", cursive'; g.fillText("north shore '87", 40, 268);
  grime(g, 256, 300, 25, 8, 0.3);
  g.fillStyle = '#3a3836'; g.fillRect(0, 300, 256, 20);
}));
LABELS.ammo = once(() => canvasTex(256, 160, (g, w, h) => {
  g.fillStyle = '#5a6440'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#c9a43a'; g.fillRect(0, 18, w, 30);
  g.fillStyle = '#20240f'; g.font = 'bold 26px Impact, "Arial Black", sans-serif'; g.textAlign = 'center'; g.fillText('.308 WIN', w / 2, 43);
  g.fillStyle = '#e8e0c4'; g.font = 'bold 16px Arial, sans-serif'; g.fillText('HUNTING CARTRIDGES', w / 2, 82);
  g.font = '13px Arial, sans-serif'; g.fillText('150 GR  SOFT POINT  -  20 CT', w / 2, 104);
  g.strokeStyle = '#e8e0c4'; g.lineWidth = 2; g.strokeRect(10, 112, w - 20, 34); g.font = 'bold 12px Arial'; g.fillText('KEEP AWAY FROM CHILDREN', w / 2, 134);
  grime(g, w, h, 30, 11, 0.4);
}));

/* ====================================================================== ITEMS
   Each builder fills a Kit in the held frame (or resting frame for resources). */
const ITEMS = {};
const ITEM_INFO_SRC = {};
function item(name, info, fn) { ITEMS[name] = fn; ITEM_INFO_SRC[name] = info; }

/* ---------- the crash-kit fire axe (hero item: seen inches from the camera) */
item('axe', { hold: 'two', len: 0.9 }, (K) => {
  const yb = -0.55, yt = 0.355, H = yt - yb, yh = 0.272;
  const hr = t => { const y = yb + t * H; return 0.0128 + 0.0043 * gauss(y + 0.527, 0.02) - 0.0014 * sstep(0.06, 0.24, y) + 0.0005 * gauss(y + 0.02, 0.1); };
  const hs = sweep([[0, yb, 0.003], [0, -0.25, 0.0016], [0, 0.05, -0.0008], [0, yt, 0]], { seg: 38, radial: 16, rx: hr, ry: t => hr(t) * 1.42, up: [0, 0, 1], caps: true, bulge: [0.007, 0.0015] });
  // varnished ash, darkened by hands at both grips, varnish worn through in patches
  const wood = col(0x8a6646), dirt = col(0x2e1c10), raw = col(0xb09478), hc = new THREE.Color();
  const grip = y => clamp(gauss(y + 0.45, 0.075) + gauss(y - 0.0, 0.13) * 0.4, 0, 1);
  const worn = p => clamp(nzp(p, 22, 3) * 2.6 - 0.35, 0, 1) * (0.4 + grip(p.y));
  for (const g of parts(hs)) paint(g, (p) => {
    hc.copy(wood).multiplyScalar(0.88 + 0.22 * nzp(p, 7, 1) + 0.06 * Math.sin(p.y * 260 + nzp(p, 30, 2) * 4));
    return hc.lerp(raw, worn(p) * 0.45).lerp(dirt, grip(p.y) * 0.45 + sstep(-0.5, -0.56, p.y) * 0.4);
  }, (p) => [0, lerp(0.34, 0.72, clamp(worn(p) + grip(p.y) * 0.4, 0, 1)), 0.55, 1]);
  K.add('u', ...parts(hs));
  // black friction tape spiral at the right-hand grip
  const tc = []; for (let k = 0; k <= 4; k++) { const y = lerp(-0.118, 0.098, k / 4); tc.push(hs.curve.getPointAt((y - yb) / H)); }
  const tr = t => hr((lerp(-0.118, 0.098, t) - yb) / H) + 0.0016;
  const tape = sweep(tc, { seg: 30, radial: 16, rx: tr, ry: t => tr(t) * 1.38, up: [0, 0, 1],
    rmod: (t, a, c) => { const f = (((a / TAU + c.y / 0.019) % 1) + 1) % 1; return 1 + 0.055 * f + 0.02 * sstep(0.85, 1, t) * 0; } });
  const tcol = col(0x1b1b1d), tdust = col(0x4a4640), tcc = new THREE.Color();
  paint(tape.geo, (p) => tcc.copy(tcol).lerp(tdust, clamp(nzp(p, 40, 7) * 1.5 - 0.2, 0, 0.5)), [0, 0.74, 0.7, 0]);
  K.add('u', tape.geo);
  // head: lofted cross-sections along Z (blade +Z, pick -Z)
  const M = 28, zs = [];
  for (let i = 0; i <= 13; i++) zs.push(lerp(-0.172, -0.045, Math.pow(i / 13, 0.85)));
  for (let i = 1; i <= 5; i++) zs.push(lerp(-0.045, 0.045, i / 5));
  for (let i = 1; i <= 30; i++) zs.push(0.045 + 0.155 * (1 - Math.pow(1 - i / 30, 1.35)));
  const bow = (z, sy) => 0.013 * sstep(0.07, 0.2, z) * (1 - sy * sy);
  const prof = (z) => {
    if (z < -0.045) {
      const s = (z + 0.172) / 0.127, g = Math.pow(s, 1.7);
      return { tx: lerp(0.0022, 0.0215, Math.pow(s, 1.1)), hy: lerp(0.003, 0.054, g), yc: yh + 0.004 * g - 0.03 * (1 - s) * (1 - s), e: lerp(0.6, 0.42, s), zone: 0, s };
    }
    if (z <= 0.045) return { tx: 0.0215 + 0.0008 * gauss(z, 0.02), hy: 0.054, yc: yh, e: 0.4, zone: 1, s: 0 };
    const s = (z - 0.045) / 0.155, yhi = yh + 0.054 + 0.024 * s * s, ylo = yh - 0.054 - 0.056 * Math.pow(s, 1.65);
    const tx = s < 0.84 ? lerp(0.0205, 0.0052, s / 0.84) : lerp(0.0052, 0.0006, (s - 0.84) / 0.16);
    return { tx, hy: (yhi - ylo) / 2, yc: (yhi + ylo) / 2, e: lerp(0.42, 0.85, sstep(0.6, 1, s)), zone: 2, s };
  };
  const meta = [], rings = zs.map((z) => {
    const pr = prof(z), ring = [];
    for (let j = 0; j < M; j++) {
      const a = (j / M) * TAU, sx = spow(Math.cos(a), pr.e), sy = spow(Math.sin(a), pr.e);
      ring.push(new V3(pr.tx * sx, pr.yc + pr.hy * sy, z + (pr.zone === 2 ? bow(z, sy) : 0)));
    }
    meta.push(pr);
    return ring;
  });
  const head = loftRings(rings, { caps: true, bulge: [0.001, 0] });
  const red = col(0x8c1710), redD = col(0x4a0c08), bright = col(0xc3c6c9), steelD = col(0x5a5d61), hcol = new THREE.Color();
  const zoneOf = (i) => { const r = Math.floor(i / (M + 1)), j = (i % (M + 1)) % M; return { pr: meta[r], a: (j / M) * TAU }; };
  // wear 0..1 per vertex: the shader cuts per-pixel chips through the paint where it is high
  const wearAt = (p, i) => {
    const { pr, a } = zoneOf(i), sy = Math.abs(Math.sin(a)), sx = Math.abs(Math.cos(a));
    if (pr.zone === 2 && pr.s > 0.74) return sstep(0.74, 0.82, pr.s);             // ground bevel: bare
    let w = 0.06 + 0.06 * nzp(p, 20, 4);
    w += 0.62 * Math.pow(sy, 6) + 0.5 * Math.pow(sx * sy, 1.2);                  // top/bottom edges and corners
    if (pr.zone === 0) w += 0.7 * sstep(0.5, 0.1, pr.s);                           // the pick point is worn bare
    if (pr.zone === 2) w += 0.15 * sstep(0.4, 0.74, pr.s);                         // strikes near the edge
    w += 0.12 * clamp(nzp(p, 30, 9) * 2 - 0.3, 0, 1) * sx;                          // scrapes on the cheeks
    return clamp(w, 0, 1);
  };
  paint(head.geo, (p, n, i) => {
    const { pr } = zoneOf(i);
    if (pr.zone === 2 && pr.s > 0.74) return hcol.copy(red).lerp(bright, sstep(0.74, 0.8, pr.s)).multiplyScalar(0.92 + 0.1 * nzp(p, 200, 1));
    return hcol.copy(red).multiplyScalar(0.85 + 0.2 * nzp(p, 25, 5)).lerp(redD, clamp(nzp(p, 12, 8) * 1.4, 0, 0.5) + 0.25 * gauss(p.z, 0.05) * sstep(0.02, -0.04, p.y - yh));
  }, (p, n, i) => [0.03, 0.38, 0.22, 8 + 0.9 * wearAt(p, i)]);
  for (const c of [head.cap0, head.cap1]) paint(c, bright, [0.95, 0.25, 0.1, 8.89]);
  K.add('u', head.geo, head.cap0, head.cap1);
  // steel wedge in the top of the handle + a stencilled white band on the neck
  const wedge = rbox(0.004, 0.006, 0.026, 0.0015, 1); wedge.translate(0, yt + 0.0005, 0); paint(wedge, 0x6a6d70, MR.steelWorn); K.add('u', wedge);
  K.node('tip', [0, yh, 0.2 + 0.013]); K.node('gripL', [0, -0.45, 0]);
});

/* ---------- primitive stone axe */
item('axeCrafted', { hold: 'right', len: 0.67 }, (K) => {
  K.log([0, -0.4, 0], [0, 0.27, 0], 0.016, { seed: 11, amp: 0.08, knots: 3, bend: 0.025, taper: 0.1, radial: 10, seg: 16, chop: 0.4, tint: 0xd8c8b0, endTint: 0xd8c8b0 });
  const st = new THREE.SphereGeometry(1, 22, 16);
  warp(st, p => { const sh = sstep(-0.15, 1, p.z); p.x *= lerp(1, 0.1, sh); p.y *= 1 - 0.15 * sh; });
  xf(st, { s: [0.024, 0.042, 0.074] });
  lumpy(st, (p) => nzp(p, 48, 4) * 0.0024 + Math.abs(nzp(p, 22, 6)) * -0.002, 1);
  st.translate(0, 0.2, 0.032);
  const sc = col(0x4c4a46), flake = col(0x8a8780), c = new THREE.Color();
  paint(st, (p) => c.copy(sc).multiplyScalar(0.8 + 0.35 * nzp(p, 40, 3)).lerp(flake, sstep(0.07, 0.1, p.z) * 0.6), MR.stone);
  K.add('u', st);
  const rc = 0x8f7a55;
  K.rope([0, 0.133, 0], [0, 0.17, 0], 0.0186, 5, 0.0031, { c: rc, mr: MR.cord, perTurn: 14 });
  K.rope([0, 0.228, 0], [0, 0.26, 0], 0.0178, 4.5, 0.0031, { c: rc, mr: MR.cord, perTurn: 14 });
  K.rope([0, 0.19, -0.004], [0, 0.205, 0.008], [0.03, 0.026], 3, 0.003, { c: rc, mr: MR.cord, perTurn: 16, e1: [1, 0, 0] });
  K.rope([0, 0.21, -0.004], [0, 0.195, 0.008], [0.03, 0.026], 3, 0.003, { c: rc, mr: MR.cord, perTurn: 16, e1: [1, 0, 0] });
  K.node('tip', [0, 0.2, 0.106]);
});

/* ---------- sharpened stick spear */
item('spear', { hold: 'two', len: 2.0 }, (K) => {
  K.log([0, -1.1, 0], [0, 0.9, 0], 0.0158, { seed: 21, amp: 0.05, knots: 5, bend: 0.004, taper: 0.06, radial: 10, seg: 44, point: 0.09, charTip: true, tint: 0xd6c4a8, chop: 0.3 });
  K.rope([0, 0.655, 0], [0, 0.712, 0], 0.0163, 8, 0.0025, { mr: MR.cord, c: 0x9a8258, perTurn: 14 });
  K.rope([0, -0.09, 0], [0, 0.11, 0], 0.0168, 22, 0.0026, { mr: MR.cord, c: 0x7a6446, perTurn: 12 });
  K.rope([0, -0.64, 0], [0, -0.47, 0], 0.0172, 18, 0.0026, { mr: MR.cord, c: 0x7a6446, perTurn: 12 });
  K.node('tip', [0, 0.9, 0]); K.node('gripL', [0, -0.55, 0]);
});

/* ---------- the Ember Spear (legendary) */
item('emberSpear', { hold: 'two', len: 2.08 }, (K) => {
  const sh = sweep([[0, -1.1, 0], [0.003, -0.5, 0], [-0.002, 0.1, 0.001], [0, 0.6, 0]], { seg: 30, radial: 12, rx: t => 0.0172 - 0.0022 * t, up: [0, 0, 1], caps: true, bulge: [0.009, 0],
    rmod: (t, a, c) => 1 + 0.035 * n3(c.y * 7, Math.cos(a), Math.sin(a)) });
  const wd = col(0x3e2a1c), wl = col(0x6a4a30), wc = new THREE.Color();
  for (const g of parts(sh)) paint(g, (p) => wc.copy(wd).lerp(wl, clamp(nzp(p, 9, 2) * 0.8 + 0.3, 0, 1) * 0.5).multiplyScalar(0.9 + 0.12 * Math.sin(p.y * 180 + nzp(p, 20, 1) * 5)), MR.walnut);
  K.add('u', ...parts(sh));
  const leather = 0x4a2216;
  K.add('u', paint(coil([0, -0.13, 0], [0, 0.13, 0], 0.0175, 7, 0.0013, { flat: 0.0105, perTurn: 10, wobble: 0.04 }), vary(leather, 0.25, 40, 1), MR.leather));
  K.add('u', paint(coil([0, -0.66, 0], [0, -0.44, 0], 0.0185, 6, 0.0013, { flat: 0.0105, perTurn: 10, wobble: 0.04 }), vary(leather, 0.25, 40, 2), MR.leather));
  // two antler tines lashed along the neck, flaring out round the head
  const ant = col(0x4e3c2a), antTip = col(0xd2c4a6), ac = new THREE.Color();
  for (const s of [-1, 1]) {
    const pts = [[s * 0.019, 0.21, 0.003], [s * 0.021, 0.42, 0.006], [s * 0.025, 0.6, 0.008], [s * 0.046, 0.715, 0.012], [s * 0.072, 0.79, 0.004]];
    const an = sweep(pts, { seg: 18, radial: 8, rx: t => lerp(0.0105, 0.0026, Math.pow(t, 0.8)) + 0.0035 * gauss(t, 0.035), up: [0, 0, 1], caps: true, bulge: [0, 0.002],
      rmod: (t, a) => 1 + 0.2 * Math.abs(Math.sin(a * 3 + t * 40)) * (1 - t) + 0.1 * n3(t * 30, Math.cos(a) * 2, Math.sin(a) * 2) });
    for (const g of parts(an)) paint(g, (p) => { const t = clamp((p.y - 0.21) / 0.58, 0, 1); return ac.copy(ant).lerp(antTip, sstep(0.72, 0.98, t)).multiplyScalar(0.75 + 0.45 * nzp(p, 70, s)); }, MR.antler);
    K.add('u', ...parts(an));
  }
  for (const [y0, y1] of [[0.245, 0.275], [0.42, 0.45], [0.555, 0.585]]) K.rope([0, y0, 0.004], [0, y1, 0.004], [0.022, 0.033], 4, 0.0021, { c: 0xc4ae86, mr: MR.sinew, perTurn: 8 });
  // carved bone collar
  const cp = [[0.0001, 0.584], [0.0165, 0.585]];
  for (let i = 0; i <= 26; i++) {   // a swelling socket with three carved grooves
    const y = lerp(0.588, 0.704, i / 26), u = i / 26;
    const r = 0.0178 + 0.0042 * Math.sin(Math.PI * Math.min(1, u * 1.15)) - 0.0016 * (gauss(y - 0.615, 0.0022) + gauss(y - 0.64, 0.0022) + gauss(y - 0.676, 0.0022)) - 0.004 * sstep(0.85, 1, u);
    cp.push([r, y]);
  }
  cp.push([0.0001, 0.707]);
  const coll = lath(cp, 14);
  const bone = col(0xb8a682), bc = new THREE.Color();
  // carved bands and a zig-zag frieze, grime packed into the cuts
  paint(coll, (p) => {
    const a = Math.atan2(p.z, p.x), zig = Math.abs(((a * 6 / Math.PI + p.y * 300) % 2 + 2) % 2 - 1);
    const cut = 1.5 * (gauss(p.y - 0.615, 0.003) + gauss(p.y - 0.64, 0.003) + gauss(p.y - 0.676, 0.003)) + (p.y > 0.645 && p.y < 0.671 ? 0.6 * sstep(0.3, 0.1, Math.abs(zig - 0.5)) : 0);
    return bc.copy(bone).multiplyScalar(0.8 + 0.3 * nzp(p, 60, 4)).lerp(col(0x3a2c1c), clamp(cut, 0, 1) * 0.75);
  }, MR.bone);
  K.add('u', coll);
  // the ember: a dark stone holding a molten core that shows through its pores
  const em = ell(0.0118, 0.0142, 0.0085, 13, 10); lumpy(em, 0.0012, 160, 3); em.translate(0, 0.662, 0.0185);
  const e1 = col(0xff7a20), e2 = col(0x220604), ec = new THREE.Color();
  const hot = (p) => clamp(nzp(p, 420, 2) * 2.2 + 0.25, 0, 1);
  paint(em, (p) => ec.copy(e2).lerp(e1, hot(p)), [0, 0.35, 0.5, 0], (p) => 3.2 * Math.pow(hot(p), 1.5));
  K.add('u', em);
  K.rope([-0.016, 0.648, 0.012], [0.016, 0.648, 0.012], [0.009, 0.004], 1.5, 0.0013, { c: 0xc4ae86, mr: MR.sinew, perTurn: 12, e1: [0, 0, 1] });
  // obsidian blade
  const bl = knapBlade(0.27, 0.07, 0.0145, 77, { rings: 28, radial: 20, scars: 8, base: 0.42, c0: 0x24222a, c1: 0x5a5466, mr: [0, 0.2, 0.1, 0] }); bl.translate(0, 0.703, 0);
  K.add('u', bl);
  // a charm: cord, bone bead and a small feather hanging from the collar
  const cd = sweep([[-0.02, 0.598, 0], [-0.03, 0.56, 0.006], [-0.033, 0.5, 0.004]], { seg: 8, radial: 4, r: 0.0011, up: [0, 0, 1] });
  paint(cd.geo, 0x3a2a1c, MR.cord); K.add('u', cd.geo);
  const bead = ell(0.0048, 0.006, 0.0048, 10, 8); bead.translate(-0.033, 0.497, 0.004); paint(bead, vary(0xd8ccb0, 0.15, 90), MR.bone); K.add('u', bead);
  const fe = featherGeo(0.085, 0.022, 4, { mid: 0x5a3a24 }); xf(fe, { r: [0, 0.4, Math.PI] }); fe.translate(-0.033, 0.492, 0.004); K.add('u', fe);
  K.node('tip', [0, 0.973, 0]); K.node('ember', [0, 0.662, 0.02]); K.node('gripL', [0, -0.55, 0]);
});

/* ---------- clubs */
function clubBody(K, seed, base, opt = {}) {
  const R = rng(seed), knobs = [];
  for (let k = 0; k < 9; k++) knobs.push([R.range(0.6, 0.97), R() * TAU, R.range(0.12, 0.32)]);
  const rf = t => { const y = lerp(-0.2, 0.52, t); return 0.0185 + 0.032 * sstep(0.05, 0.43, y) + 0.004 * gauss(y + 0.2, 0.012); };
  const cb = sweep([[0, -0.2, 0], [0.004, 0.1, 0], [-0.006, 0.35, 0.004], [0.002, 0.52, 0]], { seg: 30, radial: 16, rx: rf, up: [0, 0, 1], caps: true, bulge: [0.008, 0.03],
    rmod: (t, a, c) => {
      let m = 1 + (0.02 + 0.06 * sstep(0.3, 0.7, t)) * n3(c.y * 14 + seed, Math.cos(a) * 1.3, Math.sin(a) * 1.3);
      for (const [kt, ka, kh] of knobs) { let da = Math.abs(a - ka); da = Math.min(da, TAU - da); m += kh * gauss(t - kt, 0.045) * gauss(da, 0.5); }
      return m;
    } });
  const wood = col(base), barkC = col(opt.bark ?? 0x3e3226), stain = col(opt.stain ?? 0x2a1610), c = new THREE.Color();
  for (const g of parts(cb)) paint(g, (p) => {
    c.copy(wood).multiplyScalar(0.85 + 0.25 * nzp(p, 9, seed) + 0.05 * Math.sin(p.y * 220));
    const barkM = sstep(0.05, 0.25, p.y) * clamp(nzp(p, 14, seed + 3) * 2.2 + 0.2, 0, 1);
    c.lerp(barkC, barkM * 0.9);
    if (opt.stain) c.lerp(stain, clamp(nzp(p, 18, seed + 7) * 2 + 0.1, 0, 1) * sstep(0.2, 0.45, p.y) * 0.75);
    return c;
  }, (p) => (sstep(0.05, 0.25, p.y) * clamp(nzp(p, 14, seed + 3) * 2.2 + 0.2, 0, 1) > 0.5 ? MR.bark : MR.varnish));
  K.add('u', ...parts(cb));
  K.add('u', paint(coil([0, -0.17, 0], [0, 0.07, 0], 0.0198, 12, 0.0013, { flat: 0.0215, perTurn: 12, wobble: 0.04 }), vary(opt.wrap ?? 0x4a2e1c, 0.25, 40, seed), MR.leather));
  K.node('tip', [0, 0.555, 0]);
  return rf;
}
item('club', { hold: 'right', len: 0.75 }, (K) => { clubBody(K, 3, 0x7e5c3e); });
item('boneClub', { hold: 'right', len: 0.78 }, (K) => {
  const rf = clubBody(K, 8, 0x4a3222, { stain: 1, bark: 0x2a2018, wrap: 0x2e1c12 });
  const R = rng(81), ivory = col(0xdccfb4), root = col(0x8a6a44), c = new THREE.Color();
  for (let k = 0; k < 11; k++) {
    const y = R.range(0.27, 0.5), a = R() * TAU, t = (y + 0.2) / 0.72, r = rf(t) * 0.75;
    const base = new V3(Math.cos(a) * r, y, Math.sin(a) * r), dir = new V3(Math.cos(a), R.range(0.1, 0.6), Math.sin(a)).normalize();
    const L = R.range(0.03, 0.05), side = new V3(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(R.range(-0.006, 0.006));
    const tooth = sweep([base, base.clone().addScaledVector(dir, L * 0.55).add(side), base.clone().addScaledVector(dir, L).addScaledVector(side, 2.2)], { seg: 5, radial: 6, rx: tt => lerp(0.0065, 0.0006, Math.pow(tt, 0.8)), ry: tt => lerp(0.0045, 0.0006, tt), up: [0, 1, 0], caps: [true, false] });
    for (const g of parts(tooth)) paint(g, (p) => c.copy(root).lerp(ivory, sstep(r + 0.012, r + 0.03, Math.hypot(p.x, p.z))).multiplyScalar(0.85 + 0.25 * nzp(p, 120, k)), MR.bone);
    K.add('u', ...parts(tooth));
  }
  K.rope([0, 0.27, 0], [0, 0.295, 0], 0.036, 4, 0.0022, { c: 0xb8a07a, mr: MR.sinew, perTurn: 20 });
  K.rope([0, 0.47, 0], [0, 0.495, 0], 0.05, 4, 0.0022, { c: 0xb8a07a, mr: MR.sinew, perTurn: 22 });
});

/* ---------- recurve bow (limbs in the YZ plane, string toward -Z) */
item('bow', { hold: 'left', len: 1.3 }, (K) => {
  const zf = (y) => { const u = Math.abs(y) / 0.65; return -0.19 * Math.pow(u, 1.7) + 0.07 * Math.pow(sstep(0.7, 1, u), 1.4); };
  const pts = []; for (let i = 0; i <= 26; i++) { const y = lerp(-0.65, 0.65, i / 26); pts.push([0, y, zf(y)]); }
  const uOf = t => Math.abs(2 * t - 1);
  const bw = sweep(pts, { seg: 50, radial: 12, e: 0.7, up: [1, 0, 0],
    rx: t => { const u = uOf(t); return lerp(0.0155, 0.0072, sstep(0.07, 0.28, u)) - 0.0028 * sstep(0.6, 1, u); },
    ry: t => { const u = uOf(t); return u < 0.1 ? 0.0135 : lerp(0.0135, lerp(0.019, 0.0062, sstep(0.3, 1, u)), sstep(0.1, 0.22, u)); },
    caps: true, bulge: 0.003 });
  const wd = col(0x86603a), dk = col(0x4a3220), c = new THREE.Color();
  for (const g of parts(bw)) paint(g, (p) => c.copy(wd).multiplyScalar(0.85 + 0.22 * nzp(p, 8, 2) + 0.06 * Math.sin(p.y * 150)).lerp(dk, sstep(0.0, -0.01, p.z - zf(p.y)) * 0.35), MR.woodY);
  K.add('u', ...parts(bw));
  K.add('u', paint(coil([0, -0.065, -0.002], [0, 0.07, -0.002], [0.0175, 0.0165], 9, 0.0012, { flat: 0.0165, perTurn: 12, e1: [0, 0, 1] }), vary(0x4a2e1c, 0.25, 40), MR.leather));
  const zt = zf(0.632) - 0.002;
  for (const s of [-1, 1]) K.rope([0, s * 0.6, zf(0.6)], [0, s * 0.625, zf(0.625)], [0.0072, 0.01], 4, 0.0012, { c: 0xc8b48c, mr: MR.sinew, perTurn: 12, e1: [0, 0, 1] });
  const str = sweep([[0, -0.632, zt], [0, 0.632, zt]], { seg: 2, radial: 5, r: 0.0011, up: [1, 0, 0] });
  const serve = sweep([[0, -0.05, zt], [0, 0.05, zt]], { seg: 2, radial: 6, r: 0.0017, up: [1, 0, 0], caps: true });
  paint(str.geo, 0xd2c09a, MR.sinew); for (const g of parts(serve)) paint(g, 0x2a2420, MR.cord);
  K.add('u', str.geo, ...parts(serve));
  K.node('string', [0, 0, zt]); K.node('tip', [0, 0.65, zf(0.65)]);
});

/* ---------- arrow */
item('arrow', { hold: 'right', len: 0.75 }, (K) => {
  const sh = sweep([[0, -0.06, 0], [0, 0.62, 0]], { seg: 6, radial: 8, r: 0.0042, up: [0, 0, 1], caps: true, bulge: [0.002, 0] });
  const wd = col(0xb48c5e), c = new THREE.Color();
  for (const g of parts(sh)) paint(g, (p) => {
    if (p.y > 0.1 && p.y < 0.106 || p.y > 0.113 && p.y < 0.13) return c.setHex(0x7a1810);
    if (p.y > 0.106 && p.y < 0.113) return c.setHex(0x111111);
    return c.copy(wd).multiplyScalar(0.9 + 0.15 * nzp(p, 40, 1));
  }, MR.woodY);
  K.add('u', ...parts(sh));
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * TAU, pos = [], uv = [], idx = [], nx = 9;
    for (let i = 0; i <= nx; i++) { const s = i / nx, h = 0.0035 + 0.0115 * sstep(0, 0.3, s) * (1 - 0.55 * s); for (let j = 0; j <= 2; j++) { const u = j / 2, r = 0.004 + u * h; pos.push(Math.cos(a + s * 0.25) * r, -0.045 + s * 0.13, Math.sin(a + s * 0.25) * r); uv.push(u, s); } }
    for (let i = 0; i < nx; i++) for (let j = 0; j < 2; j++) { const q = i * 3 + j, b = q + 3; idx.push(q, b, q + 1, q + 1, b, b + 1); }
    const v = merge([geoFrom(pos, uv, idx), geoFrom(pos, uv, idx.map((vv, kk) => idx[kk - (kk % 3) + [0, 2, 1][kk % 3]]))]);
    paint(v, (p) => c.setHex(k === 0 ? 0xb8a890 : 0x5a4a3a).multiplyScalar(0.8 + 0.3 * sstep(0.4, 0.9, Math.sin(p.y * 260))), [0, 0.8, 0.6, 1]);
    K.add('u', v);
  }
  K.rope([0, -0.054, 0], [0, -0.04, 0], 0.0047, 5, 0.0009, { c: 0xc8b48c, mr: MR.sinew, perTurn: 10 });
  const tp = knapBlade(0.05, 0.02, 0.0062, 13, { rings: 12, radial: 10, scars: 3 }); tp.translate(0, 0.612, 0);
  paint(tp, vary(0x3c3a38, 0.3, 160, 2), [0, 0.4, 0.3, 0]); K.add('u', tp);
  K.rope([0, 0.6, 0], [0, 0.625, 0], [0.0052, 0.0055], 6, 0.001, { c: 0xc8b48c, mr: MR.sinew, perTurn: 10 });
  K.node('tip', [0, 0.662, 0]);
});

/* ---------- torch */
function torchHead(K, y0, y1, r, seed) {
  const head = sweep([[0, y0, 0], [0, (y0 + y1) / 2, 0.002], [0, y1, 0]], { seg: 16, radial: 16, rx: t => r * (0.75 + 0.35 * Math.sin(Math.PI * Math.min(1, t * 1.1))), up: [0, 0, 1], caps: true, bulge: [0.01, r * 0.45],
    rmod: (t, a, c) => 1 + 0.14 * n3(c.y * 30 + seed, Math.cos(a) * 1.5, Math.sin(a) * 1.5) });
  const cloth = col(0x6e6252), soot = col(0x0d0b09), resin = col(0x3a220e), c = new THREE.Color();
  const pc = (p) => { const t = (p.y - y0) / (y1 - y0); return c.copy(cloth).lerp(soot, sstep(0.05, 0.55, t + 0.15 * nzp(p, 25, seed))).lerp(resin, clamp(nzp(p, 40, seed + 2) * 2 - 0.4, 0, 1) * 0.7); };
  const pm = (p) => (nzp(p, 40, seed + 2) > 0.25 ? MR.resin : MR.cloth);
  for (const g of parts(head)) paint(g, pc, pm);
  K.add('u', ...parts(head));
  for (let k = 0; k < 4; k++) K.add('u', paint(coil([0, lerp(y0, y1, 0.08 + k * 0.2), 0], [0, lerp(y0, y1, 0.26 + k * 0.2), 0], r * (0.95 + 0.25 * Math.sin(Math.PI * (0.2 + k * 0.2))), 1.3, 0.0018, { flat: 0.013, perTurn: 18, wobble: 0.08, phase: k * 2 }), pc, pm));
}
item('torch', { hold: 'left', len: 0.62 }, (K) => {
  K.log([0, -0.36, 0], [0, 0.22, 0], 0.0165, { seed: 31, radial: 10, seg: 12, amp: 0.06, knots: 2, taper: 0.06, chop: 0.3, tint: 0xd0c0a8 });
  torchHead(K, 0.09, 0.27, 0.031, 3);
  K.node('fire', [0, 0.29, 0]); K.node('tip', [0, 0.29, 0]);
});

/* ---------- zippo-style lighter, lid open */
item('lighter', { hold: 'left', len: 0.06 }, (K) => {
  const W = 0.038, D = 0.013, chrome = col(0xc4c6ca), c = new THREE.Color();
  const pc = (p) => c.copy(chrome).multiplyScalar(0.88 + 0.12 * nzp(p, 300, 1) - 0.2 * clamp(nzp(p, 60, 3) * 2 - 0.6, 0, 1));
  const body = rbox(W, 0.036, D, 0.0032, 3, [2, 2, 1]); body.translate(0, -0.013, 0); paint(body, pc, MR.chrome);
  const seam = rbox(W + 0.0002, 0.0006, D + 0.0002, 0.003, 2); seam.translate(0, 0.0048, 0); paint(seam, 0x3a3b3d, MR.steel);
  const ins = rbox(W - 0.0045, 0.018, D - 0.0032, 0.0012, 2); ins.translate(0, 0.0138, 0); paint(ins, (p) => c.copy(chrome).multiplyScalar(0.8), MR.chrome);
  K.add('u', body, seam, ins);
  for (const s of [-1, 1]) for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) {
    const h = new THREE.CircleGeometry(0.00125, 10); if (s < 0) h.rotateY(Math.PI);
    h.translate(-0.012 + i * 0.008, 0.0105 + j * 0.0065, s * ((D - 0.0032) / 2 + 0.00005)); paint(h, 0x050505, [0, 0.9, 0, 0]); K.add('u', h);
  }
  const wheel = sweep([[0.0062, 0.0255, -0.0016], [0.0062, 0.0255, 0.0016]], { seg: 1, radial: 18, r: 0.0034, up: [0, 1, 0], caps: true, rmod: (t, a) => 1 + 0.06 * Math.abs(Math.sin(a * 12)) });
  for (const g of parts(wheel)) paint(g, 0x6a6b6e, MR.steelWorn);
  K.add('u', ...parts(wheel));
  for (const z of [-0.0028, 0.0028]) { const br = rbox(0.009, 0.006, 0.0007, 0.0003, 1); br.translate(0.0062, 0.024, z); paint(br, pc, MR.chrome); K.add('u', br); }
  const wick = cyl(0.0014, 0.0012, 0.005, 8); wick.translate(-0.006, 0.0245, 0);
  paint(wick, (p) => c.setHex(p.y > 0.0255 ? 0x141210 : 0xd8d0bc), MR.cloth); K.add('u', wick);
  // the lid, hinged on the +X side and flipped open
  const lid = rbox(W, 0.022, D, 0.0032, 3, [2, 2, 1]); lid.translate(-W / 2, 0.011 + 0.0002, 0); lid.rotateZ(-1.95); lid.translate(W / 2, 0.0048, 0);
  paint(lid, pc, MR.chrome);
  const hinge = cyl(0.0014, 0.0014, D * 0.6, 10); hinge.rotateX(Math.PI / 2); hinge.translate(W / 2 + 0.0008, 0.0048, 0); paint(hinge, pc, MR.chrome);
  K.add('u', lid, hinge);
  K.node('flame', [-0.006, 0.033, 0]); K.node('tip', [-0.006, 0.033, 0]);
});

/* ---------- rubberised flashlight */
item('flashlight', { hold: 'left', len: 0.25 }, (K) => {
  const prof = [[0.0001, -0.094], [0.011, -0.094], [0.0148, -0.091], [0.0158, -0.085], [0.0158, -0.068]];
  for (let i = 0; i < 10; i++) { const y = -0.064 + i * 0.008; prof.push([0.0156, y], [0.0167, y + 0.0025], [0.0167, y + 0.0055], [0.0156, y + 0.008]); }
  prof.push([0.0158, 0.055], [0.0172, 0.085], [0.0236, 0.118], [0.0244, 0.122], [0.0244, 0.148], [0.0251, 0.151], [0.0251, 0.157], [0.0215, 0.158], [0.0205, 0.154], [0.0001, 0.154]);
  const b = lath(prof, 26);
  const c = new THREE.Color();
  paint(b, (p) => (p.y > 0.147 ? c.setHex(0x55585c) : p.y > 0.05 ? c.setHex(0x1d1f22) : c.setHex(0x151618)).multiplyScalar(0.9 + 0.2 * nzp(p, 120, 3)),
    (p) => (p.y > 0.147 ? [0.85, 0.35, 0.2, 0] : p.y > 0.05 ? [0.55, 0.45, 0.15, 0] : MR.rubber));
  K.add('u', b);
  const lens = new THREE.CircleGeometry(0.0205, 30); lens.rotateX(-Math.PI / 2); lens.translate(0, 0.1545, 0);
  paint(lens, (p) => c.setHex(0x9aa6b0).multiplyScalar(0.6 + 0.6 * sstep(0.02, 0.004, Math.hypot(p.x, p.z))), MR.glass); K.add('u', lens);
  const led = ell(0.004, 0.0015, 0.004, 10, 6); led.translate(0, 0.1546, 0); paint(led, 0xf2f0e0, [0, 0.2, 0, 0], 0.3); K.add('u', led);
  const btn = ell(0.0062, 0.0062, 0.003, 14, 8); btn.translate(0, 0.072, 0.0172); paint(btn, 0x2a2a2c, MR.rubber); K.add('u', btn);
  const ring = new THREE.TorusGeometry(0.0045, 0.0009, 6, 14); ring.translate(0, -0.099, 0); paint(ring, 0x6a6c70, MR.steel); K.add('u', ring);
  K.node('beam', [0, 0.158, 0]); K.node('tip', [0, 0.158, 0]);
});

/* ---------- bolt-action hunting rifle (barrel along +Y, scope on +Z) */
item('rifle', { hold: 'two', len: 1.15 }, (K) => {
  const zA = 0.04, c = new THREE.Color();
  const walnut = col(0x5c331e), walnutL = col(0x8a5a36), blued = col(0x1f2326), bare = col(0x8c9095);
  const wc = (p) => c.copy(walnut).multiplyScalar(0.8 + 0.3 * nzp(p, 6, 2) + 0.08 * Math.sin(p.y * 90 + nzp(p, 14, 1) * 6)).lerp(walnutL, clamp(nzp(p, 30, 5) * 2 - 0.5, 0, 0.6));
  const stock = loftKeys([
    [-0.392, 0, -0.004, 0.0195, 0.066, 0.62], [-0.33, 0, 0.0, 0.021, 0.064, 0.62], [-0.22, 0, 0.008, 0.019, 0.05, 0.7], [-0.12, 0, 0.01, 0.0165, 0.034, 0.75],
    [-0.05, 0, 0.004, 0.0148, 0.022, 0.8], [0.0, 0, 0.006, 0.0152, 0.023, 0.8], [0.05, 0, 0.018, 0.0185, 0.031, 0.7], [0.17, 0, 0.022, 0.0185, 0.026, 0.7],
    [0.3, 0, 0.026, 0.0165, 0.02, 0.75], [0.432, 0, 0.03, 0.0132, 0.0135, 0.8]], { n: 40, radial: 18, caps: true, bulge: [0, 0.006] });
  for (const g of parts(stock)) paint(g, wc, MR.walnut);
  K.add('u', ...parts(stock));
  const pad = loftKeys([[-0.406, 0, -0.004, 0.0199, 0.0665, 0.6], [-0.392, 0, -0.004, 0.0197, 0.0662, 0.6]], { n: 2, radial: 18, caps: true });
  for (const g of parts(pad)) paint(g, 0x2a1c18, MR.rubber);
  K.add('u', ...parts(pad));
  const metal = (yWorn) => (p) => c.copy(blued).lerp(bare, clamp(nzp(p, 120, 3) * 2 - 0.55, 0, 1) * 0.6 + (yWorn ? yWorn(p) : 0)).multiplyScalar(0.92 + 0.12 * nzp(p, 300, 1));
  const barrel = lath([[0.0001, 0.735], [0.0036, 0.735], [0.0036, 0.75], [0.0083, 0.75], [0.0086, 0.748], [0.0086, 0.6], [0.0102, 0.3], [0.0112, 0.2], [0.0118, 0.172], [0.0001, 0.172]], 22);
  barrel.translate(0, 0, zA);
  paint(barrel, (p) => (Math.hypot(p.x, p.z - zA) < 0.0038 && p.y > 0.73 ? c.setHex(0x050505) : metal((q) => sstep(0.744, 0.75, q.y) * 0.8)(p)), MR.blued);
  const recv = lath([[0.0001, -0.036], [0.008, -0.035], [0.0135, -0.029], [0.0148, -0.02], [0.0148, 0.168], [0.0122, 0.177], [0.0001, 0.178]], 22); recv.translate(0, 0, zA);
  paint(recv, metal(), MR.blued);
  const port = rbox(0.003, 0.05, 0.012, 0.001, 1); port.translate(0.0138, 0.085, zA + 0.004); paint(port, 0x0a0b0c, MR.blued);
  K.add('u', barrel, recv, port);
  // bolt + handle
  const bolt = sweep([[0.012, 0.03, zA + 0.004], [0.028, 0.026, zA - 0.0], [0.038, 0.021, zA - 0.014]], { seg: 8, radial: 8, r: 0.0032, up: [0, 1, 0], caps: [true, false] });
  const knob = ell(0.0078, 0.0078, 0.0078, 14, 10); knob.translate(0.039, 0.02, zA - 0.019);
  for (const g of [...parts(bolt), knob]) paint(g, metal((q) => 0.5), MR.steel);
  const shroud = lath([[0.0001, -0.05], [0.0085, -0.05], [0.0102, -0.044], [0.0102, -0.034], [0.0001, -0.034]], 16); shroud.translate(0, 0, zA); paint(shroud, metal(), MR.blued);
  K.add('u', ...parts(bolt), knob, shroud);
  // trigger guard, trigger, floorplate
  const tg = sweep([[0, -0.045, -0.012], [0, -0.038, -0.033], [0, 0.0, -0.043], [0, 0.036, -0.034], [0, 0.046, -0.011]], { seg: 20, radial: 6, rx: 0.0022, ry: 0.0045, e: 0.6, up: [1, 0, 0] });
  const tr = sweep([[0, 0.012, -0.012], [0, 0.008, -0.024], [0, 0.0, -0.031]], { seg: 6, radial: 6, rx: 0.0014, ry: 0.0032, e: 0.6, up: [1, 0, 0], caps: [false, true] });
  const fp = rbox(0.022, 0.085, 0.004, 0.0015, 2); fp.translate(0, 0.085, -0.0105);
  for (const g of [tg.geo, ...parts(tr), fp]) paint(g, metal(), MR.blued);
  K.add('u', tg.geo, ...parts(tr), fp);
  // scope, rings, turrets, lenses
  const zS = 0.088;
  const sc = lath([[0.0001, -0.116], [0.0158, -0.116], [0.0176, -0.111], [0.0176, -0.086], [0.0124, -0.07], [0.0118, -0.064], [0.0118, 0.158], [0.0135, 0.172], [0.0205, 0.212], [0.0212, 0.268], [0.0198, 0.274], [0.0001, 0.274]], 26);
  sc.translate(0, 0, zS); paint(sc, metal(), [0.6, 0.42, 0.15, 0]);
  const lensO = new THREE.CircleGeometry(0.0185, 24); lensO.rotateX(-Math.PI / 2); lensO.translate(0, 0.2745, zS);
  const lensE = new THREE.CircleGeometry(0.0145, 24); lensE.rotateX(Math.PI / 2); lensE.translate(0, -0.1165, zS);
  for (const l of [lensO, lensE]) paint(l, (p) => c.setRGB(0.05, 0.08, 0.12).lerp(col(0x5a3a6a), sstep(0.01, 0.018, Math.hypot(p.x, p.z - zS)) * 0.5), MR.glass);
  K.add('u', sc, lensO, lensE);
  for (const y of [-0.005, 0.135]) {
    const ringG = lath([[0.0128, y - 0.007], [0.0138, y - 0.006], [0.0138, y + 0.006], [0.0128, y + 0.007]], 22); ringG.translate(0, 0, zS);
    const base = rbox(0.016, 0.013, 0.03, 0.002, 2); base.translate(0, y, (zA + zS) / 2 + 0.002);
    paint(ringG, metal(), MR.blued); paint(base, metal(), MR.blued); K.add('u', ringG, base);
  }
  const tt = cyl(0.0075, 0.0075, 0.016, 18); tt.rotateX(Math.PI / 2); tt.translate(0, 0.055, zS + 0.016);
  const ts = cyl(0.0075, 0.0075, 0.016, 18); ts.rotateZ(Math.PI / 2); ts.translate(0.016, 0.055, zS);
  paint(tt, metal(), MR.blued); paint(ts, metal(), MR.blued); K.add('u', tt, ts);
  // sling swivels
  for (const [y, z] of [[-0.3, -0.066], [0.36, 0.008]]) { const sw = new THREE.TorusGeometry(0.006, 0.0012, 6, 14); sw.rotateY(Math.PI / 2); sw.translate(0, y, z - 0.007); paint(sw, metal(), MR.steel); K.add('u', sw); }
  K.node('tip', [0, 0.75, zA]); K.node('gripL', [0, 0.3, -0.01]);
});

/* ---------- orange flare pistol (grip along Y, barrel toward +Z) */
item('flaregun', { hold: 'right', len: 0.2 }, (K) => {
  const org = col(0xd6561a), c = new THREE.Color();
  const oc = (p) => c.copy(org).multiplyScalar(0.85 + 0.2 * nzp(p, 40, 2)).lerp(col(0x3a2a20), clamp(nzp(p, 25, 4) * 2 - 0.6, 0, 0.5));
  const grip = loftKeys([[-0.07, 0, -0.018, 0.0135, 0.02, 0.6], [-0.03, 0, -0.009, 0.0138, 0.0198, 0.6], [0.02, 0, 0.0, 0.0128, 0.0175, 0.6], [0.045, 0, 0.003, 0.0125, 0.018, 0.6]], { n: 16, radial: 18, caps: true, bulge: [0.004, 0] });
  for (const g of parts(grip)) paint(g, (p) => oc(p).multiplyScalar(0.9 + 0.12 * sstep(0.6, 0.9, Math.sin(p.y * 600) * Math.sin(p.z * 600))), MR.plastic);
  const frame = rbox(0.027, 0.032, 0.056, 0.006, 3); frame.translate(0, 0.05, 0.004); paint(frame, oc, MR.plastic);
  const barrel = lath([[0.0001, 0.0], [0.019, 0.0], [0.0215, 0.006], [0.0215, 0.155], [0.0232, 0.158], [0.0232, 0.17], [0.0178, 0.17], [0.0175, 0.15], [0.0001, 0.15]], 26);
  barrel.rotateX(Math.PI / 2); barrel.translate(0, 0.07, -0.012);
  paint(barrel, (p) => (Math.hypot(p.x, p.y - 0.07) < 0.018 && p.z > 0.14 ? c.setHex(0x0e0c0a) : oc(p)), MR.plastic);
  const hammer = sweep([[0, 0.066, -0.028], [0, 0.08, -0.036], [0, 0.088, -0.034]], { seg: 6, radial: 6, rx: 0.003, ry: 0.0045, up: [1, 0, 0], caps: true });
  const pin = cyl(0.0035, 0.0035, 0.031, 12); pin.rotateZ(Math.PI / 2); pin.translate(0, 0.052, 0.024);
  const tg = sweep([[0, 0.036, 0.004], [0, 0.018, 0.012], [0, 0.012, 0.032], [0, 0.03, 0.04]], { seg: 12, radial: 6, rx: 0.0025, ry: 0.004, up: [1, 0, 0] });
  const tr = sweep([[0, 0.034, 0.016], [0, 0.024, 0.021], [0, 0.017, 0.022]], { seg: 5, radial: 6, rx: 0.0016, ry: 0.003, up: [1, 0, 0], caps: true });
  for (const g of [...parts(hammer), pin, ...parts(tr)]) paint(g, 0x2a2b2d, MR.steelWorn);
  paint(tg.geo, oc, MR.plastic);
  K.add('u', ...parts(grip), frame, barrel, ...parts(hammer), pin, tg.geo, ...parts(tr));
  K.node('tip', [0, 0.07, 0.158]);
});

/* ---------- carved bone horn (relic) */
item('boneHorn', { hold: 'right', len: 0.42 }, (K) => {
  const raw = [[0.0, -0.19, 0.0], [0.03, -0.1, 0.035], [0.035, 0.0, 0.06], [0.0, 0.1, 0.065], [-0.05, 0.17, 0.04], [-0.085, 0.21, -0.005]];
  const cv = new THREE.CatmullRomCurve3(raw.map(v3), false, 'centripetal'), off = cv.getPointAt(0.42);
  const pts = raw.map(p => v3(p).sub(off));
  const rr = t => 0.011 + 0.04 * Math.pow(t, 1.7);
  const hn = sweep(pts, { seg: 50, radial: 18, rx: rr, up: [0, 0, 1], caps: true, bulge: [0, -0.028],
    rmod: (t, a) => 1 - 0.05 * sstep(0.72, 1, Math.cos(a * 2 - t * 44)) * sstep(0.12, 0.2, t) * sstep(0.86, 0.8, t) + 0.035 * gauss(t - 0.9, 0.012) + 0.02 * n3(t * 20, Math.cos(a), Math.sin(a)) });
  const horn = col(0x9a8662), dark = col(0x3a2e22), c = new THREE.Color();
  paint(hn.geo, (p, n, i) => {
    const t = Math.floor(i / 19) / 50, j = (i % 19) / 18 * TAU;
    const groove = sstep(0.72, 1, Math.cos(j * 2 - t * 44)) * sstep(0.12, 0.2, t) * sstep(0.86, 0.8, t);
    return c.copy(horn).lerp(dark, sstep(0.25, 0.0, t) * 0.7 + groove * 0.65).multiplyScalar(0.85 + 0.25 * nzp(p, 50, 2));
  }, MR.horn);
  paint(hn.cap0, 0xd8ccb0, MR.bone); paint(hn.cap1, 0x140f0a, [0, 0.9, 0.3, 0]);
  K.add('u', ...parts(hn));
  const T0 = hn.T[0], P0 = hn.C[0];
  const mp = lath([[0.0001, 0.0], [0.0118, 0.0], [0.0128, 0.012], [0.011, 0.026], [0.0135, 0.034], [0.0125, 0.04], [0.006, 0.041], [0.004, 0.036], [0.0001, 0.036]], 18);
  aim(mp, T0.clone().negate(), P0.clone().addScaledVector(T0, 0.008));
  paint(mp, vary(0xdcd0b4, 0.15, 90, 3), MR.bone); K.add('u', mp);
  const A = hn.curve.getPointAt(0.82), B = hn.curve.getPointAt(0.14);
  const mid = A.clone().lerp(B, 0.5).add(new V3(-0.075, -0.02, -0.01));
  const strap = sweep([A, A.clone().lerp(mid, 0.5).add(new V3(-0.02, 0, 0)), mid, B.clone().lerp(mid, 0.5).add(new V3(-0.02, 0, 0)), B], { seg: 24, radial: 6, rx: 0.0018, ry: 0.0068, e: 0.5, up: [0, 0, 1] });
  paint(strap.geo, vary(0x4a2c1a, 0.25, 60, 4), MR.leather); K.add('u', strap.geo);
  for (const [t, pt] of [[0.82, A], [0.14, B]]) { const T = hn.curve.getTangentAt(t); K.add('u', paint(coil(pt.clone().addScaledVector(T, -0.006), pt.clone().addScaledVector(T, 0.006), rr(t) + 0.0018, 2.5, 0.0017, { flat: 0.004, perTurn: 20 }), 0x3e2416, MR.leather)); }
  K.node('tip', hn.C[hn.C.length - 1].toArray());
});

/* ---------- ember stone (relic) */
item('emberStone', { hold: 'right', len: 0.1 }, (K) => {
  const g = new THREE.SphereGeometry(1, 40, 28);
  lumpy(g, (p) => nzp(p, 1.4, 6) * 0.16 + nzp(p, 4, 2) * 0.05, 1);
  xf(g, { s: [0.049, 0.041, 0.045] }); weldNormals(g);
  const c = new THREE.Color();
  paint(g, (p) => c.setHex(0x221d1b).lerp(col(0x3a1a12), clamp(nzp(p, 30, 2) + 0.3, 0, 1) * 0.6).multiplyScalar(0.8 + 0.4 * nzp(p, 90, 1)), [0, 0.68, 1, 0], -2.6);
  K.add('u', g);
  K.node('tip', [0, 0.042, 0]);
});

/* ---------- ancient obsidian spearhead in rotten leather (relic) */
item('ashSpearhead', { hold: 'right', len: 0.3 }, (K) => {
  const bl = knapBlade(0.29, 0.068, 0.0135, 99, { rings: 32, radial: 24, scars: 8, base: 0.5, c0: 0x141218, c1: 0x403a48, mr: [0, 0.16, 0.12, 0] }); bl.translate(0, -0.08, 0);
  const c = new THREE.Color();
  K.add('u', bl);
  const lc = (p) => c.setHex(0x3b2f24).lerp(col(0x4c4c30), clamp(nzp(p, 50, 7) * 2 - 0.3, 0, 1) * 0.6).multiplyScalar(0.7 + 0.4 * nzp(p, 120, 2));
  K.add('u', paint(coil([0, -0.078, 0], [0, 0.005, 0], [0.0225, 0.0105], 5.5, 0.0017, { flat: 0.0095, perTurn: 20, wobble: 0.12, e1: [1, 0, 0] }), lc, MR.hide));
  const tail = sweep([[0.018, -0.03, 0.006], [0.03, -0.07, 0.012], [0.026, -0.12, 0.004], [0.034, -0.15, 0.01]], { seg: 14, radial: 4, rx: 0.0013, ry: t => 0.0055 * (1 - t * 0.6), e: 0.5, up: [0, 0, 1] });
  paint(tail.geo, lc, MR.hide); K.add('u', tail.geo);
  K.node('tip', [0, 0.21, 0]);
});

/* ---------- paper things */
item('journal', { hold: 'right', len: 0.21 }, (K) => {
  const lth = col(0x4a2c1a), lthL = col(0x7a5a40), c = new THREE.Color();
  const lc = (p) => c.copy(lth).multiplyScalar(0.8 + 0.35 * nzp(p, 40, 2)).lerp(lthL, sstep(0.065, 0.075, Math.abs(p.z - 0.002)) * 0.5 + sstep(0.096, 0.105, Math.abs(p.y)) * 0.4);
  for (const x of [-0.0128, 0.0128]) { const cv = rbox(0.0034, 0.212, 0.149, 0.0015, 1, [1, 4, 3]); lumpy(cv, 0.0004, 60, 1); cv.translate(x, 0, 0.0); paint(cv, lc, MR.leather); K.add('u', cv); }
  const sp = rbox(0.029, 0.212, 0.012, 0.0055, 3, [1, 2, 1]); sp.translate(0, 0, -0.07); paint(sp, lc, MR.leather); K.add('u', sp);
  const pg = rbox(0.0225, 0.202, 0.142, 0.0015, 1, [1, 2, 2]); pg.translate(0, 0, 0.002);
  paint(pg, (p) => c.setHex(0xd8cca8).multiplyScalar(0.85 + 0.15 * nzp(p, 30, 3)).lerp(col(0x8a7450), clamp(nzp(p, 14, 4) * 2 - 0.3, 0, 0.5)), MR.pages); K.add('u', pg);
  for (const x of [-0.0148, 0.0148]) { const st = rbox(0.0012, 0.214, 0.007, 0.0005, 1); st.translate(x, 0, 0.055); paint(st, 0x141414, MR.rubber); K.add('u', st); }
  for (const y of [-0.107, 0.107]) { const st = rbox(0.031, 0.0012, 0.007, 0.0005, 1); st.translate(0, y, 0.055); paint(st, 0x141414, MR.rubber); K.add('u', st); }
  const rib = sweep([[0, -0.1, 0.03], [0.0015, -0.118, 0.034], [0.003, -0.135, 0.04]], { seg: 6, radial: 4, rx: 0.0003, ry: 0.0028, e: 0.5, up: [0, 0, 1] });
  paint(rib.geo, 0x7a1414, MR.cloth); K.add('u', rib.geo);
  K.node('tip', [0, 0.106, 0]);
});
item('note', { hold: 'right', len: 0.14 }, (K) => {
  const leaf = (side) => {
    const g = new THREE.PlaneGeometry(0.1, 0.14, 6, 8); g.translate(0.05, 0, 0);
    const U = g.attributes.uv; for (let i = 0; i < U.count; i++) U.setX(i, side > 0 ? 0.5 + U.getX(i) * 0.5 : 0.5 - U.getX(i) * 0.5);
    warp(g, (p) => { p.z += 0.0025 * n3(p.x * 40 + side, p.y * 40, side) + 0.006 * (p.x / 0.1) ** 2; }, false);
    g.rotateY(side > 0 ? -0.35 : Math.PI + 0.35); return g;
  };
  for (const s of [1, -1]) { const g = leaf(s); paint(g, 0xffffff, MR.paper); K.add('paper', g); }
  K.node('tip', [0, 0.07, 0]);
});
item('photo', { hold: 'right', len: 0.107 }, (K) => {
  const g = rbox(0.088, 0.107, 0.0012, 0.0005, 1, [8, 10, 1]);
  const P = g.attributes.position, N = g.attributes.normal, U = g.attributes.uv;
  for (let i = 0; i < P.count; i++) {
    if (N.getZ(i) > 0.9) U.setXY(i, clamp(P.getX(i) / 0.088 + 0.5, 0, 1), 0.0625 + clamp(P.getY(i) / 0.107 + 0.5, 0, 1) * 0.9375);
    else U.setXY(i, 0.5, 0.02);
  }
  warp(g, (p) => { p.z += 0.004 * (p.x / 0.044) ** 2 - 0.002 * (p.y / 0.053) ** 2; }, false);
  paint(g, 0xffffff, [0, 0.55, 0.1, 0]); K.add('photo', g);
  K.node('tip', [0, 0.053, 0]);
});

/* ---------- radio, batteries, medkit, herbs */
item('radio', { hold: 'right', len: 0.22 }, (K) => {
  const c = new THREE.Color(), pl = (hex) => (p) => c.setHex(hex).multiplyScalar(0.85 + 0.2 * nzp(p, 80, 3));
  const body = rbox(0.058, 0.13, 0.034, 0.008, 2, [1, 2, 1]); paint(body, pl(0x2b2d2f), [0, 0.55, 0.35, 0]);
  const top = rbox(0.0565, 0.014, 0.033, 0.006, 2); top.translate(0, 0.064, 0); paint(top, pl(0xc8651c), MR.plastic);
  const side = rbox(0.061, 0.07, 0.03, 0.006, 2); side.translate(0, -0.01, 0); paint(side, pl(0x1a1b1c), MR.rubber);
  K.add('u', body, top, side);
  const ant = sweep([[0.015, 0.07, 0], [0.015, 0.165, 0]], { seg: 14, radial: 12, rx: t => lerp(0.0058, 0.0036, t), up: [0, 0, 1], caps: true, bulge: [0, 0.003], rmod: (t) => 1 + 0.08 * sstep(0.5, 1, Math.sin(t * 60)) * (t < 0.3 ? 1 : 0) });
  for (const g of parts(ant)) paint(g, pl(0x141516), MR.rubber); K.add('u', ...parts(ant));
  const knob = sweep([[-0.013, 0.07, 0], [-0.013, 0.083, 0]], { seg: 2, radial: 20, r: 0.0058, up: [0, 0, 1], caps: true, bulge: [0, 0.001], rmod: (t, a) => 1 + 0.07 * Math.abs(Math.cos(a * 9)) });
  for (const g of parts(knob)) paint(g, pl(0x1c1c1e), MR.rubber); K.add('u', ...parts(knob));
  const gr = rbox(0.045, 0.042, 0.003, 0.003, 2); gr.translate(0, -0.03, 0.0168); paint(gr, pl(0x202123), MR.plastic); K.add('u', gr);
  for (let i = 0; i < 7; i++) { const s = rbox(0.036, 0.0022, 0.0016, 0.0008, 1); s.translate(0, -0.047 + i * 0.0055, 0.0184); paint(s, 0x050505, [0, 0.9, 0, 0]); K.add('u', s); }
  const lcd = rbox(0.036, 0.017, 0.0016, 0.001, 1); lcd.translate(0, 0.03, 0.0172); paint(lcd, 0x5d6650, [0, 0.12, 0, 0]); K.add('u', lcd);
  const bez = rbox(0.041, 0.022, 0.0012, 0.002, 1); bez.translate(0, 0.03, 0.0166); paint(bez, 0x111111, MR.plastic); K.add('u', bez);
  for (let i = 0; i < 3; i++) { const b = rbox(0.009, 0.005, 0.002, 0.0015, 2); b.translate(-0.012 + i * 0.012, 0.011, 0.0172); paint(b, i === 1 ? 0xc8651c : 0x3a3b3d, MR.rubber); K.add('u', b); }
  const ptt = rbox(0.005, 0.028, 0.014, 0.0022, 2); ptt.translate(-0.031, 0.025, 0); paint(ptt, pl(0x111112), MR.rubber); K.add('u', ptt);
  const clip = rbox(0.03, 0.065, 0.003, 0.0015, 2); clip.translate(0, 0.01, -0.0205); paint(clip, pl(0x1d1e20), MR.plastic); K.add('u', clip);
  K.node('tip', [0.015, 0.168, 0]);
});
item('batteries', { hold: 'right', len: 0.05 }, (K) => {
  const prof = [[0.0001, -0.0255], [0.006, -0.0255], [0.007, -0.0246], [0.007, 0.0236], [0.0062, 0.0246], [0.0026, 0.0246], [0.0026, 0.0257], [0.002, 0.0262], [0.0001, 0.0262]];
  const c = new THREE.Color();
  for (const [x, rot] of [[-0.0072, 0], [0.0072, 0.4]]) {
    const b = lath(prof, 22); b.rotateY(rot); b.translate(x, 0, 0);
    paint(b, (p) => { const r = Math.hypot(p.x - x, p.z); if (p.y > 0.0245 || p.y < -0.025 || r < 0.006 && Math.abs(p.y) > 0.024) return c.setHex(0xb8babc); return p.y > 0.008 ? c.setHex(0xb0662a) : c.setHex(0x161616).lerp(col(0xd8d8d8), sstep(-0.004, -0.002, p.y) * sstep(0.0, -0.002, p.y)); },
      (p) => (p.y > 0.0245 || p.y < -0.025 ? MR.steel : [0.35, 0.28, 0.08, 0]));
    K.add('u', b);
  }
  K.node('tip', [0, 0.026, 0]);
});
item('medkit', { hold: 'right', len: 0.17 }, (K) => {
  const g = rbox(0.17, 0.11, 0.065, 0.02, 3, [4, 3, 2]); lumpy(g, 0.0018, 30, 2);
  const c = new THREE.Color();
  paint(g, (p) => c.setHex(0xa3161a).multiplyScalar(0.8 + 0.25 * nzp(p, 25, 3)).lerp(col(0x3a2a20), clamp(nzp(p, 10, 6) * 2 - 0.5, 0, 0.5)), MR.cloth);
  K.add('u', g);
  for (const [w, h] of [[0.05, 0.016], [0.016, 0.05]]) { const cr = rbox(w, h, 0.003, 0.0012, 1); cr.translate(0, -0.004, 0.0325); paint(cr, vary(0xe8e4dc, 0.06, 40), MR.cloth); K.add('u', cr); }
  const zp = sweep([[-0.086, -0.02, 0], [-0.085, 0.045, 0], [-0.07, 0.055, 0], [0.07, 0.055, 0], [0.085, 0.045, 0], [0.086, -0.02, 0]], { seg: 50, radial: 6, r: 0.0026, up: [0, 0, 1], rmod: (t, a) => 1 + 0.25 * Math.abs(Math.cos(a)) * (Math.sin(t * 900) > 0 ? 1 : 0.5) });
  paint(zp.geo, 0x1c1c1e, MR.plastic); K.add('u', zp.geo);
  const pull = rbox(0.006, 0.003, 0.014, 0.001, 1); pull.rotateX(0.5); pull.translate(0.04, 0.059, 0.007); paint(pull, 0x8a8c90, MR.steel); K.add('u', pull);
  const hd = sweep([[-0.04, 0.05, 0], [-0.03, 0.072, 0], [0.03, 0.072, 0], [0.04, 0.05, 0]], { seg: 14, radial: 4, rx: 0.0016, ry: 0.009, e: 0.5, up: [0, 0, 1] });
  paint(hd.geo, 0x1e1e20, MR.cloth); K.add('u', hd.geo);
  K.node('tip', [0, 0.06, 0]);
});
item('herbs', { hold: 'right', len: 0.22 }, (K) => {
  const R = rng(55), c = new THREE.Color(), greens = [0x4c6e2a, 0x5e7e34, 0x6e8a3a, 0x40602a, 0x7a8a40];
  for (let k = 0; k < 9; k++) {
    const b = new V3(R.range(-0.004, 0.004), -0.09, R.range(-0.004, 0.004)), a = R() * TAU, sp = R.range(0.015, 0.035);
    const top = new V3(Math.cos(a) * sp, R.range(0.09, 0.14), Math.sin(a) * sp), midP = b.clone().lerp(top, 0.5).add(new V3(Math.cos(a) * 0.006, 0, Math.sin(a) * 0.006));
    const st = sweep([b, midP, top], { seg: 7, radial: 4, rx: t => lerp(0.0018, 0.0008, t), up: [1, 0, 0] });
    paint(st.geo, (p) => c.setHex(0x5a6a2a).lerp(col(0x7a5a30), sstep(-0.03, -0.09, p.y)), MR.leaf); K.add('u', st.geo);
    const cv = st.curve, gcol = greens[k % greens.length];
    for (let l = 0; l < 5; l++) {
      const t = 0.45 + l * 0.11, P = cv.getPointAt(Math.min(1, t)), lf = leafGeo(R.range(0.025, 0.042), R.range(0.012, 0.019), { nx: 3, fold: 0.3, curl: -0.25 });
      lf.rotateX(-R.range(0.5, 1.0)); lf.rotateY(R() * TAU); lf.translate(P.x, P.y, P.z);
      paint(lf, (p) => c.setHex(gcol).multiplyScalar(0.8 + 0.35 * nzp(p, 80, k)).lerp(col(0xa09a50), clamp(nzp(p, 40, k + 3) - 0.2, 0, 0.4)), MR.leaf); K.add('u', lf);
    }
    if (k % 3 === 0) for (let f = 0; f < 5; f++) { const fl = ell(0.0035, 0.0025, 0.0035, 6, 4); fl.translate(top.x + R.range(-0.006, 0.006), top.y + 0.002, top.z + R.range(-0.006, 0.006)); paint(fl, 0xe8e4c8, MR.leaf); K.add('u', fl); }
  }
  K.rope([0, -0.045, 0], [0, -0.028, 0], 0.0085, 5, 0.0011, { c: 0xa48a5e, mr: MR.cord, perTurn: 12 });
  K.node('tip', [0, 0.13, 0]);
});

/* ====================================================================== RESOURCES (lying, bottom at y = 0) */
const RES = (len) => ({ hold: 'none', len, kind: 'resource' });
item('log', { hold: 'two', len: 2.4, kind: 'resource' }, (K) => {
  const r = 0.175;
  K.log([-1.2, r + 0.004, 0], [1.2, r + 0.004, 0], r, { seed: 5, chop: 0.28, radial: 18, seg: 18, knots: 5, bend: 0.008, taper: 0.05, amp: 0.04, tint: 0xe8e0d4, endTint: 0xfff2e2, moss: 0.25 });
  K.log([0.35, 2 * r - 0.03, 0.03], [0.4, 2 * r + 0.035, 0.07], 0.03, { seed: 6, radial: 8, seg: 2, capsAt: [false, true], tint: 0xe0d8cc, endTint: 0xfff2e2 });
  K.log([-0.6, r, r - 0.03], [-0.62, r + 0.05, r + 0.05], 0.024, { seed: 7, radial: 8, seg: 2, capsAt: [false, true], tint: 0xe0d8cc, endTint: 0xfff2e2 });
  K.node('tip', [1.2, r, 0]);
});
item('stick', { hold: 'right', len: 1.2, kind: 'resource' }, (K) => {
  K.log([-0.6, 0.02, 0], [0.6, 0.017, 0.02], 0.019, { seed: 15, radial: 8, seg: 12, taper: 0.3, bend: 0.03, amp: 0.07, knots: 3, tint: 0xc0b0a0, chop: 0.3 });
  K.log([-0.1, 0.02, 0.008], [0.08, 0.035, 0.12], 0.0065, { seed: 16, radial: 6, seg: 3, taper: 0.3, capsAt: [false, true], tint: 0xc0b0a0 });
  K.log([0.25, 0.018, 0.012], [0.42, 0.03, -0.1], 0.005, { seed: 17, radial: 6, seg: 3, taper: 0.3, capsAt: [false, true], tint: 0xc0b0a0 });
  K.node('tip', [0.6, 0.02, 0]);
});
item('stone', { hold: 'right', len: 0.13, kind: 'resource' }, (K) => {
  const g = stoneGeo(0.06, [1.2, 0.62, 0.92], 3, 22, 16, 0.08);
  g.computeBoundingBox(); g.translate(0, -g.boundingBox.min.y, 0);
  const c = new THREE.Color();
  paint(g, (p) => c.setHex(0x7c7a74).lerp(col(0x9a948a), sstep(0.3, 0.8, Math.sin(p.y * 160 + p.x * 40 + nzp(p, 20, 2) * 3)) * 0.4).multiplyScalar(0.85 + 0.25 * nzp(p, 60, 1)), MR.river);
  K.add('u', g); K.node('tip', [0, 0.04, 0]);
});
item('rope', RES(0.22), (K) => {
  const pts = [];
  for (let i = 0; i <= 90; i++) { const t = i / 90, a = t * 3.6 * TAU, r = lerp(0.05, 0.1, t); pts.push([Math.cos(a) * r, 0.0068 + 0.002 * Math.sin(a * 3), Math.sin(a) * r]); }
  pts.push([0.13, 0.007, 0.03], [0.17, 0.006, 0.07]);
  const s = sweep(pts, { seg: 170, radial: 5, r: 0.0065, up: [0, 1, 0], caps: true });
  const pts2 = [];
  for (let i = 0; i <= 50; i++) { const t = i / 50, a = t * 2.2 * TAU + 0.6, r = 0.082 + 0.01 * Math.sin(a * 2); pts2.push([Math.cos(a) * r, 0.019 + 0.004 * Math.cos(a), Math.sin(a) * r * 0.92]); }
  const s2 = sweep(pts2, { seg: 100, radial: 5, r: 0.0065, up: [0, 1, 0], caps: true });
  for (const g of [...parts(s), ...parts(s2)]) paint(g, vary(0xa48a5e, 0.15, 25, 1), MR.cord);
  K.add('u', ...parts(s), ...parts(s2)); K.node('tip', [0.17, 0.006, 0.07]);
});
item('cloth', RES(0.25), (K) => {
  const c = new THREE.Color();
  for (let k = 0; k < 3; k++) {
    const g = rbox(0.24 - k * 0.01, 0.01, 0.17 - k * 0.012, 0.005, 1, [8, 1, 6]);
    warp(g, (p) => { p.y += 0.006 * n3(p.x * 20 + k, p.z * 20, k) - 0.01 * sstep(0.06, 0.12, Math.abs(p.x)) * (k === 2 ? 0 : 1); p.x += 0.004 * n3(p.z * 30, k, 1); });
    g.rotateY(k * 0.07 - 0.07); g.translate(k * 0.004, 0.006 + k * 0.011, k * 0.003);
    paint(g, (p) => c.setHex(0x7a2c24).lerp(col(0x2a1c18), sstep(0.6, 0.9, Math.sin(p.x * 140)) * 0.4 + sstep(0.6, 0.9, Math.sin(p.z * 140)) * 0.4).multiplyScalar(0.8 + 0.3 * nzp(p, 30, k)).lerp(col(0x5a4a38), clamp(nzp(p, 9, k + 4) * 2 - 0.4, 0, 0.5)), MR.cloth);
    K.add('u', g);
  }
  K.node('tip', [0.12, 0.03, 0]);
});
item('leaves', RES(0.45), (K) => {
  const R = rng(61), c = new THREE.Color(), pal = [0xa0521c, 0xc08a2a, 0x6e3a1a, 0x8a7a2a, 0x4e5a24, 0xb8642a];
  const base = ell(0.2, 0.065, 0.19, 16, 8); lumpy(base, 0.012, 9, 2); paint(base, vary(0x3a2a18, 0.3, 12), MR.leaf); K.add('u', base);
  for (let k = 0; k < 74; k++) {
    const a = R() * TAU, d = Math.sqrt(R()) * 0.22, h = 0.075 * (1 - (d / 0.23) ** 2) + 0.004;
    const lf = leafGeo(R.range(0.05, 0.08), R.range(0.03, 0.05), { nx: 3, fold: 0.12, curl: R.range(-0.2, 0.25) });
    lf.rotateX(-Math.PI / 2 + R.range(-0.35, 0.35)); lf.rotateY(R() * TAU); lf.translate(Math.cos(a) * d, h, Math.sin(a) * d);
    const hx = pal[k % pal.length]; paint(lf, (p) => c.setHex(hx).multiplyScalar(0.75 + 0.35 * nzp(p, 50, k)), MR.leaf); K.add('u', lf);
  }
  K.node('tip', [0, 0.08, 0]);
});
item('fiber', RES(0.42), (K) => {
  const R = rng(71), c = new THREE.Color();
  for (let k = 0; k < 26; k++) {
    const z0 = R.range(-1, 1), y0 = R.range(0, 1), pts = [];
    for (let i = 0; i <= 6; i++) { const x = lerp(-0.21, 0.21, i / 6), spread = 0.004 + Math.abs(x) * 0.12; pts.push([x + R.range(-0.008, 0.008), 0.0016 + y0 * (0.008 - Math.abs(x) * 0.02) + 0.001, z0 * spread + R.range(-0.002, 0.002)]); }
    const s = sweep(pts, { seg: 10, radial: 3, rx: 0.0016, ry: 0.0008, up: [0, 1, 0] });
    const hx = [0xb8a870, 0xc8b47a, 0xa09a5a, 0xd0c088][k % 4]; paint(s.geo, (p) => c.setHex(hx).multiplyScalar(0.85 + 0.25 * nzp(p, 60, k)), [0, 0.8, 0.5, 2]); K.add('u', s.geo);
  }
  K.rope([-0.012, 0.006, 0], [0.012, 0.006, 0], [0.012, 0.007], 4, 0.0012, { c: 0x8a7048, mr: MR.cord, perTurn: 12, e1: [0, 0, 1] });
  K.node('tip', [0.21, 0.004, 0]);
});
item('berries', RES(0.2), (K) => {
  const R = rng(91), c = new THREE.Color();
  const tw = sweep([[-0.09, 0.006, 0], [0, 0.007, 0.01], [0.09, 0.006, 0.0]], { seg: 10, radial: 6, rx: t => lerp(0.003, 0.0015, t), up: [0, 1, 0], caps: true });
  for (const g of parts(tw)) paint(g, 0x5a4030, MR.bark); K.add('u', ...parts(tw));
  for (let l = 0; l < 4; l++) { const lf = leafGeo(0.05, 0.026, { nx: 4, fold: 0.2, curl: 0.1 }); lf.rotateX(-Math.PI / 2 + 0.2); lf.rotateY(l * 1.6 + 0.4); lf.translate(-0.06 + l * 0.04, 0.008, 0.005); paint(lf, vary(0x3e5a24, 0.25, 60, l), MR.leaf); K.add('u', lf); }
  for (const [cx, cz] of [[-0.03, 0.02], [0.045, -0.01]]) for (let b = 0; b < 8; b++) {
    const br = ell(0.0058, 0.0058, 0.0058, 10, 8), x = cx + R.range(-0.014, 0.014), z = cz + R.range(-0.014, 0.014);
    br.translate(x, 0.0058 + R.range(0, 0.008), z); paint(br, (p) => c.setHex(0x9a0e18).multiplyScalar(0.7 + 0.5 * nzp(p, 200, b)), [0, 0.18, 0.1, 0]); K.add('u', br);
  }
  K.node('tip', [0.09, 0.006, 0]);
});
item('mushroom', RES(0.1), (K) => {
  const c = new THREE.Color();
  const clump = ell(0.05, 0.012, 0.045, 12, 6); lumpy(clump, 0.003, 30, 2); clump.translate(0.01, 0.002, 0.015); paint(clump, vary(0x3a3020, 0.3, 30), MR.hide); K.add('u', clump);
  for (const [x, z, h, R0, k] of [[0, 0, 0.075, 0.034, 0], [0.042, 0.022, 0.05, 0.025, 1], [-0.028, 0.036, 0.034, 0.018, 2]]) {
    const st = lath([[0.0001, 0], [0.009 * R0 / 0.034 + 0.002, 0], [0.008 * R0 / 0.034 + 0.001, 0.012], [0.0062 * R0 / 0.034 + 0.001, h * 0.85], [0.007 * R0 / 0.034 + 0.001, h], [0.0001, h]], 14);
    warp(st, (p) => { p.x += 0.12 * p.y * p.y * (k - 1); });
    paint(st, vary(0xd8ccb0, 0.12, 80, k), MR.leaf);
    const cap = lath([[0.0001, h - 0.001], [R0 * 0.3, h + 0.001], [R0 * 0.95, h + 0.004], [R0 * 1.02, h + 0.008], [R0 * 0.92, h + R0 * 0.45], [R0 * 0.6, h + R0 * 0.75], [0.0001, h + R0 * 0.85]], 22);
    warp(cap, (p) => { p.x += 0.12 * h * h * (k - 1); p.y += 0.003 * n3(p.x * 60, p.z * 60, k); });
    paint(cap, (p, n) => (n.y < -0.2 ? c.setHex(0xc4ac88) : c.setHex(0x7a4a26).lerp(col(0xb08a5a), sstep(R0 * 0.6, R0, Math.hypot(p.x - x, p.z - z)) * 0.5).lerp(col(0xd8c8a8), sstep(0.5, 0.7, nzp(p, 140, k)) * 0.6)), MR.leaf);
    st.translate(x, 0, z); cap.translate(x, 0, z); K.add('u', st, cap);
  }
  K.node('tip', [0, 0.1, 0]);
});
function meatGeo(seed, sc = 1) {
  const g = rbox(0.16 * sc, 0.036 * sc, 0.11 * sc, 0.012 * sc, 3, [12, 1, 8]);
  warp(g, (p) => { const a = Math.atan2(p.z, p.x), s = 1 + 0.1 * n3(Math.cos(a) * 1.5 + seed, Math.sin(a) * 1.5, seed); p.x *= s; p.z *= s; if (p.y > 0) p.y += 0.004 * n3(p.x * 30, p.z * 30, seed); });
  g.translate(0, 0.018 * sc, 0);
  return g;
}
item('meatRaw', RES(0.17), (K) => {
  const g = meatGeo(2), c = new THREE.Color();
  const fat = (p) => p.z > 0.04 + 0.008 * nzp(p, 30, 2) || Math.abs(nzp(p, 45, 5)) < 0.05;
  paint(g, (p, n) => (fat(p) ? c.setHex(0xe6d6bc).multiplyScalar(0.9 + 0.1 * nzp(p, 80, 1)) : c.setHex(0x8e1e1c).multiplyScalar(0.75 + 0.35 * nzp(p, 60, 3)).lerp(col(0x5a1012), Math.abs(n.y) < 0.5 ? 0.5 : 0)), (p) => (fat(p) ? [0, 0.42, 0.3, 0] : MR.flesh));
  K.add('u', g); K.node('tip', [0, 0.04, 0]);
});
item('meatCooked', RES(0.15), (K) => {
  const g = meatGeo(2, 0.9), c = new THREE.Color();
  lumpy(g, 0.0015, 50, 4);
  paint(g, (p, n) => c.setHex(0x6a3818).multiplyScalar(0.7 + 0.4 * nzp(p, 40, 3)).lerp(col(0x1e0e06), clamp(nzp(p, 25, 6) * 2 - 0.3, 0, 1) * 0.7 + (Math.abs(n.y) < 0.5 ? 0.25 : 0)).lerp(col(0xa0662a), p.z > 0.036 ? 0.5 : 0), MR.cooked);
  K.add('u', g); K.node('tip', [0, 0.035, 0]);
});
function finGeo(poly) {
  const sh = new THREE.Shape(poly.map(([y, z]) => new THREE.Vector2(y, z)));
  const g = new THREE.ShapeGeometry(sh, 4);
  warp(g, (p) => { const a = p.x, b = p.y; p.set(0.0006 * Math.sin(a * 300), a, b); }, false);
  const back = g.clone(); const I = back.index.array; for (let i = 0; i < I.length; i += 3) { const s = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = s; } back.computeVertexNormals();
  return merge([g, back]);
}
function fish(K, cooked) {
  const body = loftKeys([[-0.135, 0, 0.002, 0.0035, 0.01], [-0.095, 0, 0.003, 0.009, 0.021], [-0.02, 0, 0.004, 0.019, 0.04], [0.06, 0, 0.003, 0.0225, 0.043], [0.12, 0, 0, 0.019, 0.033], [0.155, 0, -0.004, 0.012, 0.02], [0.172, 0, -0.006, 0.004, 0.007]], { n: 34, radial: 20, caps: true, bulge: [0, 0.004], e: 1 });
  const c = new THREE.Color();
  const raw = (p) => {
    const z = p.z;
    c.setHex(0xe0dcd4).lerp(col(0xb4aaa2), sstep(-0.02, 0.0, z)).lerp(col(0xc27a80), gauss(z - 0.002, 0.006) * 0.7).lerp(col(0x4a5a3a), sstep(0.006, 0.02, z));
    if (nzp(p, 140, 2) > 0.38 && z > -0.005) c.multiplyScalar(0.35);
    if (Math.abs(p.y - 0.118) < 0.0015 && Math.abs(z) < 0.025) c.multiplyScalar(0.5);
    return c.multiplyScalar(0.9 + 0.15 * nzp(p, 300, 1));
  };
  const ck = (p) => c.setHex(0x9a6a32).lerp(col(0x3a2210), clamp(nzp(p, 30, 2) * 2 - 0.2, 0, 1) * 0.7).lerp(col(0x0e0806), clamp(nzp(p, 60, 4) * 2.5 - 0.8, 0, 1)).multiplyScalar(0.85 + 0.2 * nzp(p, 200, 1));
  for (const g of parts(body)) paint(g, cooked ? ck : raw, cooked ? MR.cooked : [0.15, 0.25, 0.3, 0]);
  const fins = [finGeo([[-0.126, 0.008], [-0.165, 0.03], [-0.205, 0.054], [-0.19, 0.0], [-0.205, -0.054], [-0.165, -0.03], [-0.126, -0.008]]),
    finGeo([[-0.03, 0.038], [-0.01, 0.062], [0.03, 0.058], [0.045, 0.041]]), finGeo([[-0.07, -0.022], [-0.08, -0.04], [-0.05, -0.036], [-0.04, -0.03]])];
  const pec = finGeo([[0.1, -0.012], [0.06, -0.02], [0.065, -0.008]]); for (const s of [-1, 1]) { const q = pec.clone(); q.translate(s * 0.016, 0, 0); q.rotateY(s * 0.3); fins.push(q); }
  for (const f of fins) paint(f, (p) => (cooked ? c.setHex(0x2e1a0c) : c.setHex(0x6a6650).lerp(col(0xb0a090), 0.3)).multiplyScalar(0.8 + 0.3 * Math.abs(Math.sin(p.y * 600))), cooked ? MR.cooked : [0, 0.4, 0.4, 0]);
  const eyes = [];
  for (const s of [-1, 1]) { const e = ell(0.0068, 0.0068, 0.0068, 12, 8); e.translate(s * 0.0118, 0.137, 0.006); paint(e, (p) => (Math.abs(p.x) > 0.0158 ? c.setHex(cooked ? 0xd8d0c0 : 0x050505) : c.setHex(cooked ? 0xa09080 : 0xc0b070)), [0, cooked ? 0.6 : 0.05, 0, 0]); eyes.push(e); }
  const all = [...parts(body), ...fins, ...eyes];
  for (const g of all) { g.rotateZ(-Math.PI / 2); g.translate(0, 0.0225, 0); }
  K.add('u', ...all); K.node('tip', [0.172, 0.0225, 0]);
}
item('fishRaw', RES(0.38), (K) => fish(K, false));
item('fishCooked', RES(0.38), (K) => fish(K, true));
item('feather', RES(0.2), (K) => { const f = featherGeo(0.2, 0.05, 9); f.rotateX(-Math.PI / 2); f.translate(0, 0.004, 0.1); K.add('u', f); K.node('tip', [0, 0.004, -0.1]); });
item('bone', RES(0.27), (K) => {
  const b = sweep([[-0.13, 0, 0], [0, 0.002, 0.004], [0.13, 0, 0]], { seg: 30, radial: 14, rx: t => 0.0105 + 0.013 * sstep(0.25, 0.0, t) + 0.016 * sstep(0.75, 1.0, t), up: [0, 1, 0], caps: true, bulge: [0.008, 0.01],
    rmod: (t, a) => 1 + 0.28 * Math.max(0, Math.cos(2 * a)) * sstep(0.8, 1, t) + 0.15 * Math.max(0, Math.cos(a)) * sstep(0.2, 0, t) + 0.04 * n3(t * 10, Math.cos(a), Math.sin(a)) });
  const c = new THREE.Color();
  for (const g of parts(b)) { g.translate(0, 0.026, 0); paint(g, (p) => c.setHex(0xd8cfb8).lerp(col(0x8a6a44), clamp(nzp(p, 25, 3) * 2 - 0.3, 0, 0.6)).multiplyScalar(0.85 + 0.2 * nzp(p, 150, 1)), MR.bone); }
  K.add('u', ...parts(b)); K.node('tip', [0.13, 0.026, 0]);
});
item('hide', RES(0.45), (K) => {
  const c = new THREE.Color();
  const ragged = (g, k) => warp(g, (p) => { const a = Math.atan2(p.z, p.x), s = 1 + 0.12 * n3(Math.cos(a) * 2 + k, Math.sin(a) * 2, k); p.x *= s; p.z *= s; p.y += 0.004 * n3(p.x * 15, p.z * 15, k); });
  const base = rbox(0.44, 0.016, 0.34, 0.007, 2, [10, 1, 8]); ragged(base, 1); base.translate(0, 0.008, 0);
  paint(base, (p, n) => (n.y > 0.5 ? c.setHex(0xb89a72).multiplyScalar(0.8 + 0.3 * nzp(p, 20, 2)) : c.setHex(0x5a3e28)), MR.leather);
  const top = rbox(0.42, 0.03, 0.2, 0.013, 2, [10, 1, 5]); ragged(top, 2); lumpy(top, 0.003, 20, 3); top.translate(0.01, 0.03, -0.055);
  paint(top, (p) => c.setHex(0x6a4a30).lerp(col(0x2e2016), gauss(p.z + 0.055, 0.03) * 0.6).multiplyScalar(0.75 + 0.4 * nzp(p, 70, 4)), MR.fur);
  K.add('u', base, top); K.node('tip', [0.2, 0.03, 0]);
});
item('resin', RES(0.06), (K) => {
  const chip = rbox(0.07, 0.008, 0.05, 0.003, 2, [3, 1, 2]); chip.translate(0, 0.004, 0); paint(chip, vary(0x5a4030, 0.3, 40), MR.bark);
  const c = new THREE.Color(); const blobs = [];
  for (const [x, y, z, r] of [[0, 0.022, 0, 0.018], [0.018, 0.016, 0.008, 0.013], [-0.014, 0.015, 0.012, 0.01]]) { const b = ell(r, r * 0.8, r, 16, 12); lumpy(b, r * 0.12, 60 / r * 0.02, x * 100); b.translate(x, y, z); blobs.push(b); }
  for (const b of blobs) paint(b, (p) => c.setHex(0xa85a10).lerp(col(0x3a1804), clamp(0.6 - p.y * 25, 0, 0.7)).multiplyScalar(0.85 + 0.3 * nzp(p, 120, 2)), MR.resin, 0.06);
  K.add('u', chip, ...blobs); K.node('tip', [0, 0.04, 0]);
});
function dent(p) { // two dents in the food can
  for (const [a, y, d] of [[0.6, 0.07, 0.006], [2.6, 0.03, 0.004]]) { const ang = Math.atan2(p.z, p.x); let da = Math.abs(ang - a); da = Math.min(da, TAU - da); const k = d * gauss(da, 0.35) * gauss(p.y - y, 0.018); const r = Math.hypot(p.x, p.z) || 1; p.x -= (p.x / r) * k; p.z -= (p.z / r) * k; }
}
item('can', RES(0.11), (K) => {
  const b = lath([[0.0001, 0.002], [0.033, 0.002], [0.036, 0.0], [0.0386, 0.003], [0.0376, 0.008], [0.0376, 0.104], [0.0386, 0.108], [0.036, 0.112], [0.0335, 0.1095], [0.03, 0.1088], [0.0295, 0.1092], [0.0001, 0.1092]], 32);
  warp(b, dent); const c = new THREE.Color();
  paint(b, (p) => c.setHex(0xa8a8aa).lerp(col(0x6a3a1c), clamp(nzp(p, 50, 3) * 2 - 0.3 + sstep(0.02, 0, p.y) * 0.5, 0, 1) * 0.8), (p) => (nzp(p, 50, 3) * 2 - 0.3 > 0.3 ? [0.2, 0.85, 0.6, 0] : [0.9, 0.32, 0.15, 0]));
  K.add('u', b);
  const lb = new THREE.CylinderGeometry(0.0379, 0.0379, 0.09, 40, 6, true, 0.3, TAU * 0.92); lb.translate(0, 0.057, 0); warp(lb, dent, false);
  paint(lb, 0xffffff, [0, 0.6, 0.2, 0]); K.add('can', lb);
  K.node('tip', [0, 0.11, 0]);
});
item('waterBottle', RES(0.22), (K) => {
  const prof = [[0.0001, 0.0], [0.026, 0.0], [0.031, 0.004], [0.033, 0.012], [0.033, 0.05], [0.0315, 0.056], [0.033, 0.062], [0.033, 0.12], [0.03, 0.15], [0.02, 0.175], [0.0135, 0.185], [0.0135, 0.196]];
  const b = lath(prof, 32); paint(b, 0xc8dcea, [0, 0.08, 0.05, 0]); K.add('glass', b);
  const w = lath([[0.0001, 0.003], [0.03, 0.004], [0.0315, 0.012], [0.0315, 0.05], [0.03, 0.056], [0.0315, 0.062], [0.0315, 0.118], [0.0001, 0.118]], 32); paint(w, 0x7aa6c8, [0, 0.05, 0, 0]); K.add('glass', w);
  const cap = lath([[0.0144, 0.189], [0.0152, 0.19], [0.0152, 0.21], [0.0135, 0.2135], [0.0001, 0.2135]], 28);
  const c = new THREE.Color();
  paint(cap, (p) => c.setHex(0x2a5aa8).multiplyScalar(Math.abs(Math.sin(Math.atan2(p.z, p.x) * 18)) > 0.5 ? 1 : 0.7), MR.plastic);
  const lb = new THREE.CylinderGeometry(0.0334, 0.0334, 0.05, 32, 1, true); lb.translate(0, 0.088, 0);
  paint(lb, (p) => (p.y > 0.098 || p.y < 0.075 ? c.setHex(0x1c4a8a) : c.setHex(0xe8eef2)), MR.plastic);
  K.add('u', cap, lb); K.node('tip', [0, 0.2135, 0]);
});
item('ammo', RES(0.11), (K) => {
  const box = rbox(0.07, 0.042, 0.11, 0.002, 1); box.translate(0, 0.021, 0); paint(box, vary(0x4e5a3a, 0.12, 40), MR.card);
  const flap = rbox(0.07, 0.002, 0.045, 0.001, 1); flap.translate(0, 0.001, -0.0225); flap.rotateX(-1.9); flap.translate(0, 0.042, -0.055); paint(flap, vary(0x4e5a3a, 0.12, 40), MR.card);
  K.add('u', box, flap);
  const lab = new THREE.PlaneGeometry(0.068, 0.04); lab.translate(0, 0.021, 0.0552); paint(lab, 0xffffff, MR.card); K.add('ammo', lab);
  const cart = () => lath([[0.0001, 0], [0.0058, 0], [0.0058, 0.042], [0.0045, 0.047], [0.0042, 0.052], [0.0039, 0.053], [0.0039, 0.06], [0.0025, 0.068], [0.0001, 0.071]], 14);
  const c = new THREE.Color(), cc = (p) => (p.y > 0.053 ? c.setHex(0xb0683a) : c.setHex(0xc89a48)).multiplyScalar(0.85 + 0.2 * nzp(p, 200, 1));
  for (let i = 0; i < 5; i++) { const g = cart(); g.translate(-0.024 + i * 0.012, -0.012, -0.035); paint(g, cc, MR.brass); K.add('u', g); }
  const lone = cart(); lone.rotateZ(Math.PI / 2); lone.rotateY(0.5); lone.translate(0.07, 0.0058, 0.03); paint(lone, cc, MR.brass); K.add('u', lone);
  K.node('tip', [0, 0.042, 0]);
});
item('flare', RES(0.23), (K) => {
  const s = sweep([[-0.115, 0.0165, 0], [0.115, 0.0165, 0]], { seg: 12, radial: 18, r: 0.0165, up: [0, 1, 0], caps: true, bulge: [0.002, 0.003] });
  const c = new THREE.Color();
  for (const g of parts(s)) paint(g, (p) => (p.x > 0.105 ? c.setHex(0x1a1a1a) : p.x > 0.08 ? c.setHex(0xd8d4c8) : p.x > -0.06 && p.x < -0.04 ? c.setHex(0xd8b020) : c.setHex(0xb8261c)).multiplyScalar(0.85 + 0.2 * nzp(p, 60, 1)), (p) => (p.x > 0.08 ? MR.plastic : MR.paper));
  K.add('u', ...parts(s)); K.node('tip', [0.115, 0.0165, 0]);
});

/* ====================================================================== items API */
export const ITEM_INFO = {};
for (const k in ITEM_INFO_SRC) ITEM_INFO[k] = { kind: 'item', ...ITEM_INFO_SRC[k] };
const ITEM_CACHE = new Map();
/** createItem(name) -> Group in the held frame (resources: resting frame). Named Object3Ds: tip, gripL, fire, beam, string, flame, ember */
export function createItem(name, opts = {}) {
  let t = ITEM_CACHE.get(name);
  if (!t) {
    const fn = ITEMS[name]; if (!fn) throw new Error('ItemArt: unknown item ' + name);
    const K = new Kit(); fn(K);
    t = K.build(); t.name = 'item_' + name; t.userData.item = name;
    ITEM_CACHE.set(name, t);
  }
  const g = t.clone();
  if (opts.shadows === false) g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = false; });
  return g;
}

/* ====================================================================== BUILDING PIECES */
const LOGT = 0xd2c6b4, ENDT = 0xa0927f, PLANK = 0x6e7480;   // cool tint: greys the yellow fresh-wood map into weathered boards
function addStone(K, p, r, seed, o = {}) {
  const g = stoneGeo(r, o.s || [1.15, 0.72, 0.95], seed, o.ws || 12, o.hs || 9, 0.2);
  g.rotateY(o.yaw ?? seed * 1.3); g.translate(p[0], p[1], p[2]);
  const base = col([0x7a766e, 0x8a8478, 0x6a675f, 0x7e7a6a][seed % 4]), c = new THREE.Color(), soot = col(0x141210), lich = col(0x8a8a5a);
  paint(g, (q, n) => {
    c.copy(base).multiplyScalar(0.75 + 0.4 * nzp(q, 10, seed) + 0.1 * nzp(q, 40, seed + 1));
    c.lerp(lich, clamp(nzp(q, 14, seed + 3) * 2 - 0.4, 0, 1) * clamp(n.y, 0, 1) * 0.5);
    if (o.soot) { const l = Math.hypot(q.x, q.z) || 1, inw = clamp(-(n.x * q.x + n.z * q.z) / l * 1.3 + 0.3, 0, 1); c.lerp(soot, inw * sstep(0.3, 0.05, q.y) * 0.85); }
    return c;
  }, MR.stone);
  K.add('u', g);
}
function ashBed(K, R0, seed) {
  const g = lath([[0.0001, 0.03], [R0 * 0.4, 0.026], [R0 * 0.8, 0.014], [R0, 0.002], [R0 * 1.05, -0.01]], 22); lumpy(g, 0.006, 8, seed);
  const c = new THREE.Color();
  paint(g, (p) => { const d = Math.hypot(p.x, p.z) / R0; return c.setHex(0x0e0c0b).lerp(col(0x6a6460), sstep(0.35, 0.9, d + 0.3 * nzp(p, 9, seed))).multiplyScalar(0.8 + 0.3 * nzp(p, 40, seed)); }, [0, 0.97, 0.9, 0]);
  K.add('u', g);
  const R = rng(seed);
  for (let i = 0; i < 7; i++) { const ch = ell(R.range(0.02, 0.035), 0.013, R.range(0.013, 0.02), 7, 5); lumpy(ch, 0.003, 60, i); ch.rotateY(R() * TAU); const a = R() * TAU, d = R() * R0 * 0.6; ch.translate(Math.cos(a) * d, 0.035, Math.sin(a) * d); paint(ch, vary(0x111010, 0.4, 50, i), MR.char); K.add('u', ch); }
}

function wallPiece(K, kind) {
  const R = rng(kind.length * 101 + 7);
  const open = kind === 'wallDoor' ? { x0: -0.5, x1: 0.5, y0: 0, y1: 2.1 } : kind === 'wallWindow' ? { x0: -0.45, x1: 0.45, y0: 0.9, y1: 1.8 } : null;
  const spansAt = (y, incl) => (open && (incl ? y >= open.y0 - 1e-3 && y <= open.y1 + 1e-3 : y > open.y0 && y < open.y1) ? [[-1.02, open.x0], [open.x1, 1.02]] : [[-1.02, 1.02]]);
  for (let i = 0; i < 8; i++) {
    const y = 0.15 + i * 0.3, r = 0.149 + R.range(-0.006, 0.006);
    for (const [x0, x1] of spansAt(y, false)) K.log([x0, y, R.range(-0.01, 0.01)], [x1, y, R.range(-0.01, 0.01)], r, { seed: R() * 100, flip: i % 2, amp: 0.035, bend: 0.005, radial: 10, seg: Math.max(2, Math.round((x1 - x0) / 0.28)), knots: 2, tint: LOGT, endTint: ENDT, moss: 0.35 });
  }
  const chink = col(0x3a3226), chm = col(0x3e4a22), cc = new THREE.Color();   // moss + clay pressed into the seams
  for (let i = 1; i < 8; i++) {
    const y = i * 0.3;
    for (const [x0, x1] of spansAt(y, true)) for (const z of [-0.094, 0.094]) {
      const s = sweep([[x0 + 0.03, y, z], [x1 - 0.03, y, z]], { seg: Math.max(2, Math.round((x1 - x0) / 0.25)), radial: 5, r: 0.03, up: [0, 1, 0], rmod: (t, a, c) => 1 + 0.4 * n3(c.x * 9 + z * 10, Math.cos(a) * 1.5, y * 3) });
      paint(s.geo, (p) => cc.copy(chink).lerp(chm, clamp(nzp(p, 5, 3) + 0.2, 0, 1) * 0.6).multiplyScalar(0.8 + 0.3 * nzp(p, 30, 1)), MR.hide);
      K.add('u', s.geo);
    }
  }
  for (const x of [-0.86, 0.86]) {
    for (const z of [-0.205, 0.205]) K.log([x, 0.0, z], [x + R.range(-0.01, 0.01), 2.36, z], 0.05, { seed: R() * 100, radial: 9, seg: 6, amp: 0.05, tint: LOGT, endTint: ENDT, chop: 0.4, knots: 3 });
    for (const y of [0.55, 1.85]) K.rope([x, y - 0.045, 0], [x, y + 0.045, 0], [0.265, 0.062], 2.5, 0.011, { perTurn: 11, radial: 4, wobble: 0.02 });
  }
  if (kind === 'wallDoor') {
    for (const x of [-0.565, 0.565]) K.log([x, 0, 0], [x, 2.12, 0], 0.07, { seed: x * 10 + 50, radial: 10, seg: 6, tint: LOGT, endTint: ENDT });
  }
  if (kind === 'wallWindow') {
    const sill = plankGeo(1.02, 0.36, 0.05, 7); sill.translate(0, 0.915, 0); paintPlank(sill, PLANK, 7);
    const head = plankGeo(1.0, 0.32, 0.05, 8); head.translate(0, 1.79, 0); paintPlank(head, PLANK, 8);
    K.add('wood', sill, head);
    for (const x of [-0.47, 0.47]) { const j = plankGeo(0.86, 0.3, 0.04, 9 + x); j.rotateZ(Math.PI / 2); j.translate(x, 1.35, 0); paintPlank(j, PLANK, 9, { mr: MR.woodY }); K.add('wood', j); }
    // a plank shutter, swung open on its hinge outside the +X jamb
    const sh = [];
    for (let k = 0; k < 4; k++) { const p = plankGeo(0.86, 0.225, 0.03, 20 + k); p.rotateZ(Math.PI / 2); p.translate(-0.115 - k * 0.23, 1.35, 0); paintPlank(p, PLANK, 20 + k, { mr: MR.woodY }); sh.push(p); }
    for (const y of [1.07, 1.63]) { const b = plankGeo(0.86, 0.1, 0.025, 30 + y); b.translate(-0.46, y, -0.026); paintPlank(b, PLANK, 31); sh.push(b); }
    for (const g of sh) { g.rotateY(1.75); g.translate(0.47, 0, 0.19); K.add('wood', g); }
  }
}
function doorObj() {
  const D = new Kit();
  for (let k = 0; k < 5; k++) { const g = plankGeo(2.06, 0.19, 0.05, k + 1); g.rotateZ(Math.PI / 2); g.translate(0.096 + k * 0.192, 1.05, 0); paintPlank(g, PLANK, k, { mr: MR.woodY }); D.add('wood', g); }
  for (const y of [0.32, 1.75]) { const b = plankGeo(0.86, 0.13, 0.035, 11 + y); b.translate(0.48, y, -0.042); paintPlank(b, PLANK, 12); D.add('wood', b); }
  const br = plankGeo(1.47, 0.12, 0.03, 14); br.rotateZ(Math.atan2(1.28, 0.72)); br.translate(0.48, 1.035, -0.04); paintPlank(br, PLANK, 14); D.add('wood', br);
  const iron = (p) => new THREE.Color(0x1c1a18).multiplyScalar(0.8 + 0.5 * clamp(nzp(p, 40, 2), 0, 1)).lerp(col(0x5a3018), clamp(nzp(p, 25, 5) * 2 - 0.4, 0, 0.6));
  for (const y of [0.32, 1.75]) {
    const s = rbox(0.6, 0.045, 0.006, 0.002, 1, [4, 1, 1]); s.translate(0.29, y, 0.029); paint(s, iron, MR.iron); D.add('wood', s);
    for (const x of [0.06, 0.3, 0.52]) { const b = ell(0.007, 0.007, 0.004, 8, 5); b.translate(x, y, 0.033); paint(b, iron, MR.iron); D.add('wood', b); }
    const kn = cyl(0.012, 0.012, 0.11, 10); kn.translate(0.0, y, 0.02); paint(kn, iron, MR.iron); D.add('wood', kn);
  }
  const pull = sweep([[0.85, 1.13, 0.028], [0.885, 1.06, 0.075], [0.85, 0.99, 0.028]], { seg: 12, radial: 6, r: 0.009, up: [0, 0, 1], caps: true });
  for (const g of parts(pull)) paint(g, 0x9c845c, MR.rope); D.add('wood', ...parts(pull));
  const g = D.build(new THREE.Group(), { groundAO: true }); g.name = 'door'; g.position.set(-0.48, 0, 0);
  return g;
}
const PIECES = {
  wall: (K) => wallPiece(K, 'wall'),
  wallWindow: (K) => wallPiece(K, 'wallWindow'),
  wallDoor: (K) => { wallPiece(K, 'wallDoor'); K.kid(doorObj()); },
  foundation: (K) => {
    const R = rng(501);
    for (const x of [-0.85, 0.85]) for (const z of [-0.85, 0, 0.85]) K.log([x, -1.0, z], [x + R.range(-0.01, 0.01), 0.33, z], 0.12, { seed: R() * 100, radial: 11, seg: 5, tint: LOGT, endTint: ENDT, knots: 2 });
    for (const z of [-0.85, 0, 0.85]) K.log([-1.02, 0.3, z], [1.02, 0.3, z], 0.1, { seed: R() * 100, radial: 11, seg: 7, tint: LOGT, endTint: ENDT, flip: z > 0, moss: 0.3 });
    for (let k = 0; k < 10; k++) { const g = plankGeo(2.0, 0.196, 0.1, 40 + k, { split: true }); g.rotateY(Math.PI / 2); g.translate(-0.9 + k * 0.2, 0.45, R.range(-0.01, 0.01)); paintPlank(g, PLANK, 40 + k, { mr: MR.woodZ }); K.add('wood', g); }
    for (const x of [-0.85, 0.85]) for (const z of [-0.85, 0.85]) K.rope([x, 0.12, z], [x, 0.2, z], 0.137, 3, 0.011, { perTurn: 12, radial: 4 });
  },
  floor: (K) => {
    const R = rng(601);
    for (const z of [-0.8, 0, 0.8]) K.log([-1.0, 0.045, z], [1.0, 0.045, z], 0.045, { seed: R() * 100, radial: 9, seg: 6, tint: LOGT, endTint: ENDT });
    for (let k = 0; k < 10; k++) { const g = plankGeo(2.0, 0.192, 0.06, 60 + k); g.rotateY(Math.PI / 2); g.translate(-0.9 + k * 0.2, 0.12, R.range(-0.015, 0.015)); paintPlank(g, PLANK, 60 + k, { mr: MR.woodZ }); K.add('wood', g); }
  },
  roof: (K) => roofPiece(K),
  roofFlat: (K) => {
    const R = rng(701);
    for (const x of [-0.75, 0.75]) K.log([x, 0.09, -1.0], [x, 0.09, 1.0], 0.09, { seed: R() * 100, radial: 10, seg: 6, tint: LOGT, endTint: ENDT });
    for (let k = 0; k < 7; k++) K.log([-1.02, 0.315, -0.855 + k * 0.285], [1.02, 0.315, -0.855 + k * 0.285], 0.136, { seed: R() * 100, radial: 11, seg: 7, tint: LOGT, endTint: ENDT, moss: 0.6, flip: k % 2 });
    for (const x of [-0.75, 0.75]) K.rope([x - 0.04, 0.3, 0.7], [x + 0.04, 0.3, 0.7], [0.2, 0.23], 2.5, 0.011, { perTurn: 14, e1: [0, 1, 0] });
  },
  stairs: (K) => {
    const R = rng(801);
    for (const x of [-0.6, 0.6]) { K.log([x, -0.08, 1.07], [x, 2.33, -0.95], 0.1, { seed: R() * 100, radial: 11, seg: 10, tint: LOGT, endTint: ENDT }); K.log([x, 0, -0.92], [x, 2.22, -0.92], 0.08, { seed: R() * 100, radial: 10, seg: 6, tint: LOGT, endTint: ENDT }); K.rope([x, 2.05, -0.92], [x, 2.15, -0.92], 0.1, 3, 0.011, { perTurn: 14 }); }
    for (let i = 0; i < 8; i++) { const g = plankGeo(1.36, 0.28, 0.07, 90 + i, { split: true }); g.translate(0, 0.3 * (i + 1) - 0.035, 0.875 - 0.25 * i); paintPlank(g, PLANK, 90 + i); K.add('wood', g); }
  },
  campfire: (K) => {
    const R = rng(901);
    for (let k = 0; k < 11; k++) { const a = (k / 11) * TAU + R.range(-0.1, 0.1), d = 0.42 + R.range(-0.03, 0.03); addStone(K, [Math.cos(a) * d, 0.035, Math.sin(a) * d], R.range(0.085, 0.11), k + 3, { soot: true, yaw: -a, ws: 11, hs: 8 }); }
    ashBed(K, 0.33, 4);
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * TAU + R.range(-0.2, 0.2), b = [Math.cos(a) * 0.25, 0.02, Math.sin(a) * 0.25], top = new V3(R.range(-0.025, 0.025), 0.43, R.range(-0.025, 0.025));
      const end = top.clone().add(top.clone().sub(v3(b)).multiplyScalar(0.12));
      K.log(b, end.toArray(), R.range(0.02, 0.03), { seed: R() * 100, radial: 8, seg: 4, tint: 0xc8b8a4, endTint: 0xd8c8b0, charY: 0.22, knots: 1, chop: 0.3 });
    }
    for (let k = 0; k < 5; k++) { const g = plankGeo(0.26, 0.035, 0.02, 120 + k); const a = R() * TAU; g.rotateZ(1.1); g.rotateY(a); g.translate(Math.cos(a) * 0.08, 0.12, Math.sin(a) * 0.08); paintPlank(g, 0xc8b08a, k); K.add('wood', g); }
    K.node('fire', [0, 0.18, 0]); K.node('light', [0, 0.45, 0]);
  },
  firePit: (K) => {
    const R = rng(1001);
    for (let k = 0; k < 16; k++) { const a = (k / 16) * TAU + R.range(-0.06, 0.06), d = 0.74 + R.range(-0.03, 0.03); addStone(K, [Math.cos(a) * d, 0.05, Math.sin(a) * d], R.range(0.12, 0.15), k + 11, { soot: true, yaw: -a, ws: 10, hs: 7 }); }
    ashBed(K, 0.6, 7);
    for (let k = 0; k < 3; k++) { const a = k * 2.1 + 0.3; K.log([Math.cos(a) * 0.4, 0.07, Math.sin(a) * 0.4], [Math.cos(a + 2.6) * 0.3, 0.1, Math.sin(a + 2.6) * 0.3], 0.06, { seed: k * 7 + 3, radial: 8, seg: 3, tint: 0x3a3028, endTint: 0x2a2018, charY: 0.5 }); }
    for (const s of [-1, 1]) {
      const x = s * 0.92;
      K.log([x, -0.15, 0], [x, 0.74, 0], 0.035, { seed: 20 + s, radial: 8, seg: 4, tint: LOGT, chop: 0.4 });
      K.log([x, 0.62, 0], [x + s * 0.05, 0.86, 0.035], 0.022, { seed: 22 + s, radial: 7, seg: 2, capsAt: [false, true], tint: LOGT });
      K.log([x, 0.64, 0], [x - s * 0.04, 0.86, -0.03], 0.02, { seed: 24 + s, radial: 7, seg: 2, capsAt: [false, true], tint: LOGT });
      K.rope([x, 0.6, 0], [x, 0.66, 0], 0.04, 3, 0.008, { perTurn: 12 });
    }
    K.log([-1.05, 0.79, 0.0], [1.05, 0.79, 0.0], 0.018, { seed: 31, radial: 8, seg: 6, tint: 0xe0d0b8, endTint: 0xe0d0b8, bend: 0.004 });
    for (const x of [-0.3, 0.3]) K.log([x, 0.16, 0.22], [x, 0.16, 0.62], 0.016, { seed: 40 + x, radial: 6, seg: 2, tint: 0x8a9060 });
    for (let k = 0; k < 6; k++) K.log([-0.36, 0.183, 0.27 + k * 0.065], [0.36, 0.183, 0.27 + k * 0.065], 0.008, { seed: 50 + k, radial: 6, seg: 3, tint: 0x8a9060, charY: 0.25 });
    K.node('fire', [0, 0.2, 0]); K.node('light', [0, 0.55, 0]);
  },
  bed: (K) => {
    const R = rng(1101);
    for (const x of [-0.92, 0.92]) for (const z of [-0.42, 0.42]) K.log([x, 0, z], [x, 0.24, z], 0.08, { seed: R() * 100, radial: 10, seg: 2, tint: LOGT, endTint: ENDT });
    for (const z of [-0.45, 0.45]) K.log([-1.0, 0.2, z], [1.0, 0.2, z], 0.085, { seed: R() * 100, radial: 11, seg: 7, tint: LOGT, endTint: ENDT });
    for (const x of [-0.95, 0.95]) K.log([x, 0.3, -0.55], [x, 0.3, 0.55], 0.08, { seed: R() * 100, radial: 10, seg: 4, tint: LOGT, endTint: ENDT });
    const c = new THREE.Color();
    const mat = rbox(1.8, 0.13, 0.84, 0.05, 2, [10, 1, 5]); lumpy(mat, 0.01, 6, 2); mat.translate(0, 0.33, 0);
    paint(mat, (p) => c.setHex(0x8a6a48).lerp(col(0x5a4a30), clamp(nzp(p, 8, 3) + 0.2, 0, 1) * 0.5).multiplyScalar(0.8 + 0.3 * nzp(p, 40, 2)), MR.fur);
    const bl = rbox(0.95, 0.03, 0.92, 0.012, 1, [8, 1, 8]);
    warp(bl, (p) => { const e = Math.max(0, Math.abs(p.z) - 0.4); p.y -= e * 1.6; p.z = Math.sign(p.z) * (Math.min(Math.abs(p.z), 0.4) + e * 0.3); p.y += 0.008 * n3(p.x * 9, p.z * 9, 4); });
    bl.translate(0.38, 0.41, 0);
    paint(bl, (p) => c.setHex(0x5a2420).lerp(col(0x1e1a18), sstep(0.5, 0.8, Math.sin(p.x * 30)) * (Math.abs(p.x - 0.38) > 0.32 ? 1 : 0)).multiplyScalar(0.8 + 0.3 * nzp(p, 30, 5)), MR.cloth);
    const pil = ell(0.13, 0.065, 0.3, 14, 8); lumpy(pil, 0.01, 10, 6); pil.translate(-0.7, 0.44, 0); paint(pil, vary(0x9a8a70, 0.2, 20), MR.cloth);
    K.add('u', mat, bl, pil);
    for (let k = 0; k < 14; k++) { const lf = leafGeo(0.07, 0.04, { nx: 3, fold: 0.1, curl: 0.1 }); const a = R() * TAU; lf.rotateX(-Math.PI / 2 + 0.3); lf.rotateY(a); lf.translate(R.range(-0.85, 0.85), 0.27, (R() < 0.5 ? -1 : 1) * 0.42); paint(lf, vary([0x7a5a24, 0x5a6a2a, 0x8a4a1a][k % 3], 0.2, 40, k), MR.leaf); K.add('u', lf); }
    for (const x of [-0.92, 0.92]) for (const z of [-0.45, 0.45]) K.rope([x, 0.12, z], [x, 0.2, z], 0.1, 2.5, 0.009, { perTurn: 12 });
  },
  storage: (K) => {
    const R = rng(1201);
    for (let k = 0; k < 6; k++) {
      const y = 0.05 + k * 0.1;
      if (k % 2 === 0) for (const z of [-0.27, 0.27]) K.log([-0.54, y, z], [0.54, y, z], 0.05, { seed: R() * 100, radial: 8, seg: 3, tint: LOGT, endTint: ENDT });
      else for (const x of [-0.47, 0.47]) K.log([x, y, -0.34], [x, y, 0.34], 0.05, { seed: R() * 100, radial: 8, seg: 2, tint: LOGT, endTint: ENDT });
    }
    for (const x of [-0.47, 0.47]) K.rope([x, 0.15, 0.27], [x, 0.45, 0.27], 0.075, 5, 0.007, { perTurn: 12 });
    const L = new Kit();
    for (let j = 0; j < 5; j++) { const g = plankGeo(1.08, 0.13, 0.035, 130 + j); g.translate(0, 0.0175, 0.065 + j * 0.13); paintPlank(g, PLANK, 130 + j); L.add('wood', g); }
    for (const x of [-0.38, 0.38]) { const g = plankGeo(0.6, 0.08, 0.03, 140 + x); g.rotateY(Math.PI / 2); g.translate(x, -0.015, 0.33); paintPlank(g, PLANK, 141, { mr: MR.woodZ }); L.add('wood', g); }
    const h = sweep([[-0.08, 0.035, 0.6], [0, 0.07, 0.62], [0.08, 0.035, 0.6]], { seg: 10, radial: 6, r: 0.008, up: [0, 0, 1], caps: true });
    for (const g of parts(h)) paint(g, 0x9c845c, MR.rope); L.add('wood', ...parts(h));
    const lid = L.build(); lid.name = 'lid'; lid.position.set(0, 0.6, -0.32); K.kid(lid);
  },
  workbench: (K) => {
    const R = rng(1301);
    for (let k = 0; k < 3; k++) { const g = plankGeo(1.6, 0.27, 0.08, 150 + k, { split: true }); g.translate(0, 0.86, -0.27 + k * 0.27); paintPlank(g, PLANK, 150 + k); K.add('wood', g); }
    for (const x of [-0.68, 0.68]) for (const z of [-0.3, 0.3]) K.log([x * 1.03, 0, z * 1.05], [x, 0.82, z], 0.06, { seed: R() * 100, radial: 10, seg: 4, tint: LOGT, endTint: ENDT });
    for (const z of [-0.3, 0.3]) { K.log([-0.78, 0.76, z + Math.sign(z) * 0.06], [0.78, 0.76, z + Math.sign(z) * 0.06], 0.045, { seed: R() * 100, radial: 9, seg: 6, tint: LOGT, endTint: ENDT }); K.log([-0.74, 0.25, z], [0.74, 0.25, z], 0.04, { seed: R() * 100, radial: 8, seg: 5, tint: LOGT, endTint: ENDT }); }
    for (const x of [-0.68, 0.68]) { K.log([x, 0.3, -0.36], [x, 0.3, 0.36], 0.04, { seed: R() * 100, radial: 8, seg: 3, tint: LOGT, endTint: ENDT }); for (const z of [-0.3, 0.3]) K.rope([x, 0.72, z], [x, 0.8, z], 0.075, 3, 0.008, { perTurn: 12 }); }
    K.log([0.25, 0, 0.78], [0.26, 0.46, 0.78], 0.17, { seed: 77, radial: 14, seg: 3, tint: LOGT, endTint: 0xd0bea0, taper: 0.02 });
    // tools: hammer, hatchet, knife, a coil of rope
    const c = new THREE.Color(), steel = (p) => c.setHex(0x5a5d61).multiplyScalar(0.8 + 0.4 * nzp(p, 80, 2)).lerp(col(0x6a3a1c), clamp(nzp(p, 30, 4) * 2 - 0.5, 0, 0.6));
    const hh = sweep([[-0.5, 0.915, 0.05], [-0.2, 0.915, 0.1]], { seg: 6, radial: 10, rx: 0.011, ry: 0.014, up: [0, 1, 0], caps: true, bulge: 0.004 });
    for (const g of parts(hh)) paint(g, vary(0x8a6038, 0.2, 30), MR.varnish);
    const hd = rbox(0.03, 0.03, 0.11, 0.005, 2); hd.rotateY(-0.165); hd.translate(-0.21, 0.917, 0.1); paint(hd, steel, MR.steelWorn);
    const kh = sweep([[0.2, 0.912, -0.15], [0.31, 0.912, -0.13]], { seg: 4, radial: 10, rx: 0.011, ry: 0.009, up: [0, 1, 0], caps: true, bulge: 0.004 });
    for (const g of parts(kh)) paint(g, vary(0x3a2a1c, 0.2, 30), MR.leather);
    const kb = knapBlade(0.15, 0.03, 0.003, 4, { rings: 8, radial: 8, scars: 0, base: 0.9, flat: false }); kb.rotateZ(-Math.PI / 2); kb.rotateX(Math.PI / 2); kb.translate(0.31, 0.906, -0.13); paint(kb, (p) => c.setHex(0x9a9ea2).multiplyScalar(0.85 + 0.2 * nzp(p, 90, 1)), MR.steel);
    K.add('u', ...parts(hh), hd, ...parts(kh), kb);
    const coilPts = []; for (let i = 0; i <= 40; i++) { const a = i / 40 * 2.5 * TAU; coilPts.push([0.55 + Math.cos(a) * 0.08, 0.912 + i * 0.0006, 0.15 + Math.sin(a) * 0.08]); }
    const rc = sweep(coilPts, { seg: 70, radial: 6, r: 0.008, up: [0, 1, 0], caps: true }); for (const g of parts(rc)) paint(g, 0x9c845c, MR.rope); K.add('u', ...parts(rc));
  },
  rack: (K) => {
    const R = rng(1401);
    for (const x of [-0.95, 0.95]) {
      K.log([x, -0.1, -0.5], [x, 1.85, 0.09], 0.045, { seed: R() * 100, radial: 9, seg: 6, tint: LOGT, endTint: ENDT });
      K.log([x + 0.03, -0.1, 0.5], [x + 0.03, 1.85, -0.09], 0.045, { seed: R() * 100, radial: 9, seg: 6, tint: LOGT, endTint: ENDT });
      K.rope([x - 0.05, 1.72, 0], [x + 0.08, 1.72, 0], [0.07, 0.08], 3, 0.009, { perTurn: 12, e1: [0, 1, 0] });
    }
    K.log([-1.12, 1.77, 0], [1.12, 1.77, 0], 0.045, { seed: 3, radial: 9, seg: 8, tint: LOGT, endTint: ENDT });
    for (let k = 0; k < 5; k++) {
      const x = -0.6 + k * 0.3, cd = sweep([[x, 1.73, 0], [x + 0.005, 1.55, 0.003], [x, 1.42, 0]], { seg: 6, radial: 4, r: 0.004, up: [0, 0, 1] });
      paint(cd.geo, 0x9c845c, MR.cord); K.add('u', cd.geo);
      K.log([x, 1.43, 0], [x + 0.005, 1.29, 0], 0.011, { seed: 60 + k, radial: 6, seg: 2, tint: 0xb8a890, taper: 0.2 });
      K.log([x + 0.002, 1.33, 0], [x + 0.05, 1.39, 0.004], 0.007, { seed: 70 + k, radial: 6, seg: 2, capsAt: [false, true], tint: 0xb8a890 });
    }
  },
  spikes: (K) => {
    const R = rng(1501);
    for (let k = 0; k < 7; k++) {
      const x = -0.9 + k * 0.3 + R.range(-0.03, 0.03), tilt = 0.61 + R.range(-0.06, 0.06), L = 1.75 + R.range(-0.12, 0.1), b = new V3(x, -0.25, -0.15 + R.range(-0.03, 0.03));
      K.log(b.toArray(), b.clone().add(new V3(R.range(-0.04, 0.04), Math.cos(tilt) * L, Math.sin(tilt) * L)).toArray(), 0.055, { seed: R() * 100, radial: 9, seg: 7, point: 0.12, tint: LOGT, endTint: ENDT, flip: true });
    }
    K.log([-1.05, 0.42, 0.155], [1.05, 0.42, 0.155], 0.08, { seed: 9, radial: 10, seg: 8, tint: LOGT, endTint: ENDT });
    for (const x of [-0.95, 0.95]) K.log([x, 0, 0.155], [x, 0.36, 0.155], 0.06, { seed: 10 + x, radial: 9, seg: 2, tint: LOGT, endTint: ENDT });
    for (const x of [-0.6, 0.0, 0.6]) K.rope([x - 0.05, 0.42, 0.2], [x + 0.05, 0.42, 0.2], [0.13, 0.1], 2.5, 0.009, { perTurn: 12, e1: [0, 1, 0] });
  },
  torchStand: (K) => {
    K.log([0, -0.3, 0], [0.02, 1.48, 0.01], 0.035, { seed: 4, radial: 9, seg: 8, tint: LOGT, endTint: ENDT, taper: 0.1 });
    torchHead(K, 1.4, 1.66, 0.045, 5);
    for (let k = 0; k < 4; k++) addStone(K, [Math.cos(k * 1.7) * 0.12, 0.02, Math.sin(k * 1.7) * 0.12], 0.06, k + 30, {});
    K.node('fire', [0.02, 1.69, 0.01]); K.node('light', [0.02, 1.8, 0.01]);
  },
  logPile: (K) => {
    const R = rng(1601), rows = [[-0.31, 0.15], [0, 0.15], [0.31, 0.15], [-0.155, 0.41], [0.155, 0.41], [0, 0.67]];
    for (const [z, y] of rows) K.log([-1.1 + R.range(-0.05, 0.05), y, z], [1.1 + R.range(-0.05, 0.05), y, z], 0.15, { seed: R() * 100, radial: 12, seg: 8, tint: 0xd8cdbc, endTint: 0xc8b8a0, chop: 0.25 });
    for (const x of [-0.7, 0.7]) for (const s of [-1, 1]) K.log([x, -0.2, s * 0.5], [x, 0.85, s * 0.56], 0.04, { seed: R() * 100, radial: 8, seg: 4, tint: LOGT, endTint: ENDT, chop: 0.4 });
  },
  signal: (K) => {
    const R = rng(1701), apex = new V3(0, 3.2, 0);
    for (let k = 0; k < 10; k++) { const a = (k / 10) * TAU + R.range(-0.1, 0.1), b = new V3(Math.cos(a) * 1.0, -0.05, Math.sin(a) * 1.0); const e = apex.clone().add(new V3(R.range(-0.08, 0.08), 0, R.range(-0.08, 0.08))); K.log(b.toArray(), e.clone().add(e.clone().sub(b).multiplyScalar(0.08)).toArray(), R.range(0.075, 0.1), { seed: R() * 100, radial: 9, seg: 9, tint: LOGT, endTint: ENDT, chop: 0.3 }); }
    for (let k = 0; k < 6; k++) { const a = (k / 6) * TAU + 0.3, b = new V3(Math.cos(a) * 0.55, -0.02, Math.sin(a) * 0.55); K.log(b.toArray(), [0, 1.8, 0], 0.04, { seed: R() * 100, radial: 7, seg: 5, tint: 0xc8b8a4, endTint: ENDT }); }
    K.rope([0, 2.95, 0], [0, 3.1, 0], 0.16, 3, 0.012, { perTurn: 14 });
    const c = new THREE.Color();
    for (let k = 0; k < 6; k++) { const a = k * 1.1, d = 0.3 + R() * 0.2, g = ell(0.22, 0.16, 0.18, 10, 7); lumpy(g, 0.05, 6, k); g.translate(Math.cos(a) * d, 0.12, Math.sin(a) * d); paint(g, (p) => c.setHex(0x5a4a2a).lerp(col(0x3a4a22), clamp(nzp(p, 6, k), 0, 1)).multiplyScalar(0.7 + 0.4 * nzp(p, 30, k)), MR.leaf); K.add('u', g); }
    K.node('fire', [0, 0.6, 0]); K.node('light', [0, 1.6, 0]);
  },
};
function roofPiece(K) {
  const R = rng(1801), n = new V3(0, 2, 1).normalize(), S = new V3(0, 1, -2).normalize();
  const P = (d) => new V3(0, 0, 1).addScaledVector(S, d);   // point on the roof plane at slope distance d from the low edge
  for (const x of [-0.9, 0, 0.9]) K.log(P(-0.04).addScaledVector(n, 0.065).setX(x).toArray(), P(2.27).addScaledVector(n, 0.065).setX(x).toArray(), 0.065, { seed: R() * 100, radial: 10, seg: 8, tint: LOGT, endTint: ENDT });
  for (const d of [0.35, 1.2, 2.05]) K.log(P(d).addScaledVector(n, 0.165).setX(-1.03).toArray(), P(d).addScaledVector(n, 0.165).setX(1.03).toArray(), 0.035, { seed: R() * 100, radial: 7, seg: 6, tint: LOGT, endTint: ENDT });
  const basis = new THREE.Matrix4().makeBasis(new V3(1, 0, 0), n, S.clone().negate()), c = new THREE.Color();
  const rowsN = 6;
  for (let k = 0; k < rowsN; k++) {
    const d0 = k * 0.38, odd = k % 2, xs = odd ? [-0.94, -0.63, -0.21, 0.21, 0.63, 0.94] : [-0.84, -0.42, 0, 0.42, 0.84], ws = odd ? [0.2, 0.42, 0.42, 0.42, 0.42, 0.2] : [0.42, 0.42, 0.42, 0.42, 0.42];
    xs.forEach((x, j) => {
      const w = ws[j] - 0.012, Ls = 0.6, g = new THREE.BoxGeometry(w, 0.018, Ls, 3, 1, 3);
      const sd = k * 13 + j;
      warp(g, (p) => { p.y += -0.025 * (p.x / (w / 2)) ** 2 + 0.006 * n3(p.x * 8 + sd, p.z * 8, sd); p.x += 0.008 * n3(p.z * 5, sd, 1); }, false);
      const U = g.attributes.uv, Pp = g.attributes.position; for (let i = 0; i < Pp.count; i++) U.setXY(i, Pp.getX(i) / 0.45 + sd * 0.3, Pp.getZ(i) / 0.9 + sd * 0.17);
      g.rotateX(-0.04); g.translate(x + R.range(-0.01, 0.01), 0, -Ls / 2);
      g.applyMatrix4(basis); g.translate(...P(d0 - 0.02).addScaledVector(n, 0.215 + k * 0.003).toArray());
      paint(g, (p, nn) => (nn.dot(n) < -0.3 ? c.setHex(0x9a7a5a) : c.setHex(0xc8bca8).lerp(MOSS, clamp(nzp(p, 3, sd) * 1.5, 0, 1) * 0.45)).multiplyScalar(1.5 * (0.8 + 0.3 * nzp(p, 9, sd))), MR.barkTex);
      K.add('bark', g);
    });
  }
}

const PIECE_SNAP = { foundation: 'foundation', floor: 'floor', wall: 'wall', wallWindow: 'wall', wallDoor: 'wall', roof: 'roof', roofFlat: 'roof' };
const box = (x, z, w, d, h, y) => (y === undefined ? { x, z, w, d, h } : { x, z, w, d, h, y });
export const PIECE_INFO = {
  foundation: { size: [2, 0.5, 2], colliders: [box(0, 0, 2, 2, 0.5)] },
  floor: { size: [2, 0.15, 2], colliders: [box(0, 0, 2, 2, 0.15)] },
  wall: { size: [2, 2.4, 0.3], colliders: [box(0, 0, 2, 0.3, 2.4)] },
  wallWindow: { size: [2, 2.4, 0.3], colliders: [box(-0.725, 0, 0.55, 0.3, 2.4), box(0.725, 0, 0.55, 0.3, 2.4), box(0, 0, 0.9, 0.3, 0.9), box(0, 0, 0.9, 0.3, 0.6, 1.8)] },
  wallDoor: { size: [2, 2.4, 0.3], colliders: [box(-0.75, 0, 0.5, 0.3, 2.4), box(0.75, 0, 0.5, 0.3, 2.4), box(0, 0, 1.0, 0.3, 0.3, 2.1)] },
  roof: { size: [2, 1.0, 2], colliders: [0, 1, 2, 3].map(i => box(0, 0.75 - i * 0.5, 2, 0.5, 0.2, 0.2 + i * 0.25)) },
  roofFlat: { size: [2, 0.45, 2], colliders: [box(0, 0, 2, 2, 0.45)] },
  stairs: { size: [1.4, 2.4, 2], colliders: Array.from({ length: 8 }, (_, i) => box(0, 0.875 - i * 0.25, 1.4, 0.25, 0.3 * (i + 1))) },
  campfire: { size: [1.1, 0.45, 1.1], colliders: [box(0, 0, 1.0, 1.0, 0.25)] },
  firePit: { size: [2.1, 0.9, 1.8], colliders: [box(0, 0, 1.7, 1.7, 0.3)] },
  bed: { size: [2, 0.45, 1.1], colliders: [box(0, 0, 2.0, 1.0, 0.45)] },
  storage: { size: [1.1, 0.65, 0.7], colliders: [box(0, 0, 1.1, 0.65, 0.64)] },
  workbench: { size: [1.6, 0.9, 1.2], colliders: [box(0, 0, 1.6, 0.8, 0.9), box(0.25, 0.78, 0.36, 0.36, 0.46)] },
  rack: { size: [2.3, 1.85, 1.1], colliders: [box(-0.95, 0, 0.15, 1.0, 1.85), box(0.95, 0, 0.15, 1.0, 1.85)] },
  spikes: { size: [2.1, 1.2, 1.1], colliders: [box(0, 0.35, 2.0, 0.9, 1.1)] },
  torchStand: { size: [0.3, 1.7, 0.3], colliders: [box(0, 0, 0.15, 0.15, 1.7)] },
  logPile: { size: [2.3, 0.82, 1.2], colliders: [box(0, 0, 2.2, 0.95, 0.8)] },
  signal: { size: [2.2, 3.4, 2.2], colliders: [box(0, 0, 1.8, 1.8, 3.0)] },
};
for (const k in PIECE_INFO) PIECE_INFO[k].snap = PIECE_SNAP[k] || 'free';

const PIECE_CACHE = new Map();
/** createPiece(kind, { ghost }) -> Group. Named Object3Ds: door (wallDoor), lid (storage), fire, light */
export function createPiece(kind, opts = {}) {
  let t = PIECE_CACHE.get(kind);
  if (!t) {
    const fn = PIECES[kind]; if (!fn) throw new Error('ItemArt: unknown piece ' + kind);
    const K = new Kit(); fn(K);
    t = K.build(new THREE.Group(), { groundAO: true }); t.name = 'piece_' + kind;
    PIECE_CACHE.set(kind, t);
  }
  const g = t.clone();
  g.userData.piece = kind; g.userData.colliders = PIECE_INFO[kind].colliders;
  if (opts.ghost) {
    g.userData.ghost = true;
    g.traverse(o => { if (o.isMesh) { o.material = ghostMat(); o.castShadow = o.receiveShadow = false; o.userData.ghost = true; o.renderOrder = 2; } });
  }
  return g;
}
/** 0..1: chars the piece (patchy black) and knocks a few logs loose */
export function setPieceDamage(group, d) {
  d = clamp(d, 0, 1);
  group.userData.damage = d;
  group.traverse(o => {
    if (!o.isMesh || o.userData.ghost) return;
    if (!o.userData.baseMat) o.userData.baseMat = o.material;
    if (d <= 0) { o.material = o.userData.baseMat; return; }
    if (!o.userData.dmgMat) { const m = o.userData.baseMat.clone(); uberize(m); ENV_MATS.push(m); o.userData.dmgMat = m; }
    o.material = o.userData.dmgMat;
    o.material.userData.wd.uDamage.value = d; o.material.userData.wd.uChar.value = d;
  });
}

/* ====================================================================== screenshot viewer */
const HELD = ['axe', 'axeCrafted', 'spear', 'emberSpear', 'club', 'boneClub', 'bow', 'arrow', 'torch', 'lighter', 'flashlight', 'rifle', 'flaregun', 'boneHorn', 'emberStone', 'ashSpearhead', 'journal', 'note', 'photo', 'radio', 'batteries', 'medkit', 'herbs'];
function frame(obj, k = 1.7, dir = [0.55, 0.45, 1]) {
  obj.updateMatrixWorld(true);   // the position was just set: refresh before measuring
  const b = new THREE.Box3().setFromObject(obj), c = b.getCenter(new V3()), r = b.getSize(new V3()).length() / 2;
  const d = new V3(...dir).normalize().multiplyScalar(Math.max(r * k * 2.1, 0.3));
  return { cam: c.clone().add(d).toArray(), look: c.toArray() };
}
function cabin(scene, ghost) {
  const o = { ghost }, add = (k, x, y, z, ry = 0) => { const p = createPiece(k, o); p.position.set(x, y, z); p.rotation.y = ry; scene.add(p); return p; };
  for (const x of [-1, 1]) for (const z of [-1, 1]) add('foundation', x, 0, z);
  add('wallDoor', -1, 0.5, 2); add('wallWindow', 1, 0.5, 2);
  add('wall', -1, 0.5, -2, Math.PI); add('wallWindow', 1, 0.5, -2, Math.PI);
  for (const z of [-1, 1]) { add('wall', 2, 0.5, z, Math.PI / 2); add('wall', -2, 0.5, z, -Math.PI / 2); }
  for (const x of [-1, 1]) { add('roof', x, 2.9, 1); add('roof', x, 2.9, -1, Math.PI); }
}
export async function lineup(ctx) {
  const { scene } = ctx, arg = ctx.arg || '';
  if (arg === 'stats') {
    const lines = [], tri = (g) => { let t = 0, c = 0; g.traverse(o => { if (o.isMesh) { t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; c++; } }); return `${t | 0}/${c}`; };
    lines.push('ITEMS ' + Object.keys(ITEMS).map(k => k + ' ' + tri(createItem(k))).join(', '));
    lines.push('PIECES ' + Object.keys(PIECES).map(k => k + ' ' + tri(createPiece(k))).join(', '));
    for (const l of lines) window.__log?.(l);
    const g = createItem('axe'); scene.add(g);
    return { cam: [0.5, 0.5, 0.8], look: [0, 0, 0] };
  }
  if (arg === 'held') {
    let x = 0;
    for (const k of HELD) {
      const g = createItem(k); const b = new THREE.Box3().setFromObject(g), w = Math.max(0.12, b.max.x - b.min.x, b.max.z - b.min.z);
      x += w / 2 + 0.06; g.position.set(x, 1.15, 0); scene.add(g);
      const s0 = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0xff2020, depthTest: false })); s0.renderOrder = 9; g.add(s0);
      const tp = g.getObjectByName('tip'); if (tp) { const s1 = new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), new THREE.MeshBasicMaterial({ color: 0x2060ff, depthTest: false })); s1.renderOrder = 9; s1.position.copy(tp.position); g.add(s1); }
      const gl = g.getObjectByName('gripL'); if (gl) { const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.01, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffd020, depthTest: false })); s2.renderOrder = 9; s2.position.copy(gl.position); g.add(s2); }
      x += w / 2;
    }
    return { cam: [x / 2, 1.3, 3.6], look: [x / 2, 1.15, 0] };
  }
  if (arg === 'pieces' || arg === 'ghost') {
    cabin(scene, arg === 'ghost');
    const place = (k, x, z, ry = 0) => { const p = createPiece(k, { ghost: arg === 'ghost' }); p.position.set(x, 0, z); p.rotation.y = ry; scene.add(p); return p; };
    place('campfire', 0.5, 4.6); place('firePit', 4.4, 4.6); place('bed', -4.6, 0.2, Math.PI / 2); place('storage', -3.4, 3.0);
    place('workbench', 4.6, 0.6, -Math.PI / 2); place('rack', 4.3, -3.2, 0.3); place('spikes', -1, -5.4, Math.PI); place('torchStand', -2.6, 3.2); place('torchStand', 2.6, 3.2);
    place('logPile', -4.6, -3.2, 0.2); place('signal', 8.5, -5.5); place('stairs', 8.2, 1.5, -Math.PI / 2); place('floor', -3.8, 6.2); place('roofFlat', 8.2, 5.5);
    const dmg = place('wall', -7.2, 4.2, 0.6); setPieceDamage(dmg, 0.8);
    return { cam: [9.5, 6.2, 13.5], look: [0.5, 1.4, 0] };
  }
  if (arg === 'damage') {   // the same wall at damage 0, 0.35, 0.7, 1
    [0, 0.35, 0.7, 1].forEach((d, i) => { const p = createPiece('wall'); p.position.set((i - 1.5) * 2.3, 0, 0); setPieceDamage(p, d); scene.add(p); });
    return { cam: [0, 2.2, 7.5], look: [0, 1.2, 0] };
  }
  if (arg === '' || arg === 'items') {
    // shelf packing: items laid flat (held items rotated so +Y runs along +X), rows up to 3.2 m wide
    const names = Object.keys(ITEMS).sort((a, b) => ITEM_INFO[b].len - ITEM_INFO[a].len);
    const W = 3.2, gap = 0.12; let x = -W / 2, z = 0, rowD = 0;
    for (const k of names) {
      const g = createItem(k); if (ITEM_INFO[k].kind !== 'resource') g.rotation.z = -Math.PI / 2;
      g.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(g), c = b.getCenter(new V3()), s = b.getSize(new V3());
      if (x + s.x > W / 2 && x > -W / 2) { x = -W / 2; z += rowD + gap; rowD = 0; }
      g.position.set(x + s.x / 2 - c.x, -b.min.y, z + s.z / 2 - c.z); scene.add(g);
      x += s.x + gap; rowD = Math.max(rowD, s.z);
    }
    z += rowD;
    return { cam: [0, 3.6, z / 2 + 2.6], look: [0, 0, z / 2] };
  }
  // close-up of one item or piece
  if (ITEMS[arg]) { const g = createItem(arg); scene.add(g); if (ITEM_INFO[arg].kind !== 'resource') { g.position.y = 1.2; return frame(g, 1.0, [1, 0.35, 0.45]); } return frame(g, 1.0); }
  const pk = arg.replace(/^ghost:/, '');
  if (PIECES[pk]) { const g = createPiece(pk, { ghost: arg.startsWith('ghost:') }); scene.add(g); return frame(g, 1.2); }
  return { cam: [0, 2, 5], look: [0, 1, 0] };
}
