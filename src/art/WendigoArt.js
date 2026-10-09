/* WendigoArt.js - THE WENDIGO: procedural model, skeleton rig and animation.

   Everything is generated in code (no assets). The creature is modelled in
   "reference units" (skull top = 2.5 when upright) and the model group is
   scaled by K so the skull top sits at WENDIGO_HEIGHT metres. All animation
   inputs/outputs that the game sees (speed, stride, foot events, anchors) are
   in real metres.

   RIG (one THREE.Skeleton, bind pose = upright, every bone's bind rotation is
   identity so local axes are model axes: +X = creature's left, +Y up, +Z fwd)

     hips â”€â”¬â”€ spine1 â”€ spine2 â”€â”¬â”€ chest â”€â”¬â”€ neck1 â”€ neck2 â”€ head â”€ jaw
           â”‚                   â”‚         â”œâ”€ clavL â”€ upperL â”€ foreL â”€ handL â”€ f0..f4 (a,b)
           â”‚                   â”‚         â””â”€ clavR â”€ ...
           â”‚                   â””â”€ ribs          (breathing helper, scaled)
           â”œâ”€ thighL â”€ shinL â”€ metaL â”€ toeL     (digitigrade: knee fwd, hock back)
           â”œâ”€ thighR â”€ ...
           â””â”€ tail0 â”€ tail1 â”€ ... â”€ tail10

   MESHES (3 skinned draw calls sharing the skeleton)
     skin : torso, neck, limbs, hands, feet, tail, tongue, tar drips
            (MeshPhysical, wet clearcoat, triplanar skin texture in bind space,
             emissive heart glow seen through the rib gaps)
     bone : skull, mandible, teeth, eyes, antlers, claws, spikes, tail barbs
            (vertex attribute aEmis drives eyes + ember antler tips)
     fur  : ~2000 three-sided quills on the mane, back, arms, loin (sway in VS)
   All three use a shared dissolve (noise threshold in bind space, hot edge)
   and a matching custom depth material so shadows dissolve too.

   ANIMATION
     Pose = flat object of named channels (hips offset/rotation, spine, neck,
     head, jaw, per-side arm angles, foot targets in model space, tail...).
     Each mode produces a target pose (procedural loops or keyframed one-shots);
     mode switches cross-fade over BLEND seconds. Legs are solved by a small
     digitigrade IK (foot target + metatarsus tilt -> hock -> two-bone IK with
     the knee bending forward) and adapted to the terrain via s.ground.
     Additive layers on top: look-at, head twitches, breathing, finger fidget,
     roar shake. */
import * as THREE from '../../lib/three.module.js';
import { noisify } from '../core/Geo.js';
import { Noise, rng, clamp, lerp, sstep, damp, TAU } from '../core/Util.js';
import { GU } from '../core/Shading.js';

export const WENDIGO_HEIGHT = 20;
export const ANIMS = {
  swipe: { dur: 1.7, hit: 0.95 }, stomp: { dur: 1.6, hit: 0.9 }, grab: { dur: 2.2, hit: 0.8 },
  throw: { dur: 2.4, hit: 1.5 }, roar: { dur: 3.0 }, hurt: { dur: 1.0 }, death: { dur: 6.0 },
  lookDown: { dur: 4.0 }, emerge: { dur: 2.0 },
};

let K = 8;                    // reference units -> metres (calibrated from the skull in buildGeometry)
const BLEND = 0.25;           // cross-fade between modes, seconds

/* ================================================================ helpers */
const V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new V3(x, y, z);
const C = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mixc = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const scalec = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const gauss = (x) => Math.exp(-x * x);
const NZ = new Noise(6101);

/** smooth 1D lookup through [[x, v], ...] (Catmull-Rom between keys) */
function table(pts) {
  const n = pts.length;
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1];
    if (x >= pts[n - 1][0]) return pts[n - 1][1];
    let i = 0; while (x > pts[i + 1][0]) i++;
    const u = (x - pts[i][0]) / (pts[i + 1][0] - pts[i][0]), u2 = u * u, u3 = u2 * u;
    const p0 = pts[Math.max(0, i - 1)][1], p1 = pts[i][1], p2 = pts[i + 1][1], p3 = pts[Math.min(n - 1, i + 2)][1];
    return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
  };
}

/* palette (sRGB hex -> linear) */
const PAL = {
  skin: C(0x3b322d), skinHi: C(0x5a4d44), skinDark: C(0x16110f), rib: C(0x7a6a5c), gap: C(0x2a0c0a),
  raw: C(0x7a1a12), blood: C(0x3e0a07), tar: C(0x060404), mouth: C(0x3a0d0b), tongue: C(0x5a1410),
  bone: C(0xd8ccb0), boneDirt: C(0x7a6650), socket: C(0x0a0605), tooth: C(0xd2c29a),
  antBase: C(0x3a2418), antRed: C(0x9a3214), claw: C(0x1e1915), clawTip: C(0x8f8472),
  furRoot: C(0x0c0908), furTip: C(0x3a312b), furTip2: C(0x4a3a30), hoof: C(0x14100e),
};
const EMBER = [1.0, 0.085, 0.012], EYE = [1.0, 0.62, 0.32];

/* ================================================================ textures */
const TN = new Noise(9071);
let TEX = null;
function canvasTex(c, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4; t.needsUpdate = true; return t;
}
/** paints a colour map and a height map; fn(u, v, outRGB) returns height 0..1 */
function paintTex(size, fn) {
  const mk = () => { const c = document.createElement('canvas'); c.width = c.height = size; return c; };
  const cc = mk(), hc = mk(), cg = cc.getContext('2d'), hg = hc.getContext('2d');
  const ci = cg.createImageData(size, size), hi = hg.createImageData(size, size), out = [0, 0, 0];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const h = fn(x / size, y / size, out), k = (y * size + x) * 4;
    ci.data[k] = clamp(out[0], 0, 255); ci.data[k + 1] = clamp(out[1], 0, 255); ci.data[k + 2] = clamp(out[2], 0, 255); ci.data[k + 3] = 255;
    hi.data[k] = hi.data[k + 1] = hi.data[k + 2] = clamp(h * 255, 0, 255); hi.data[k + 3] = 255;
  }
  cg.putImageData(ci, 0, 0); hg.putImageData(hi, 0, 0);
  return { map: canvasTex(cc, true), height: canvasTex(hc, false) };
}
/** wet, wrinkled skin with a vein network and sores */
function paintSkin(u, v, o) {
  const m = TN.fbm2(u * 5, v * 5, 4), fine = TN.fbm2(u * 40 + 3.1, v * 40, 2);
  const wr = 1 - Math.abs(TN.fbm2(u * 16 + 9, v * 5 + 2, 3));
  const vein = sstep(0.9, 0.975, 1 - Math.abs(TN.fbm2(u * 4 + 11, v * 4 + 7, 4)));
  const sv = TN.fbm2(u * 3 + 40, v * 3 + 40, 3), sore = sstep(0.28, 0.46, sv), core = sstep(0.46, 0.6, sv);
  const pit = sstep(0.45, 0.7, TN.fbm2(u * 28 + 5, v * 28 + 5, 2));
  let r = 200 + 40 * m + 14 * fine, g = 192 + 34 * m + 12 * fine, b = 186 + 30 * m + 12 * fine;
  r = lerp(r, 150, vein * 0.7); g = lerp(g, 70, vein * 0.7); b = lerp(b, 90, vein * 0.7);
  r = lerp(r, 255, sore * 0.6); g = lerp(g, 120, sore * 0.6); b = lerp(b, 100, sore * 0.6);
  r = lerp(r, 90, core); g = lerp(g, 30, core); b = lerp(b, 26, core);
  const ao = 1 - pit * 0.25; o[0] = r * ao; o[1] = g * ao; o[2] = b * ao;
  return 0.5 + 0.14 * m + 0.1 * fine + 0.2 * wr * wr * wr + 0.22 * vein - 0.3 * sore + 0.15 * core - 0.15 * pit;
}
/** dirty cracked bone */
function paintBone(u, v, o) {
  const dirt = TN.fbm2(u * 4 + 50, v * 4, 4), grain = TN.fbm2(u * 3, v * 36, 2);
  const crack = sstep(0.94, 0.985, 1 - Math.abs(TN.fbm2(u * 6 + 3, v * 6 + 3, 4)));
  const crack2 = 0.6 * sstep(0.95, 0.99, 1 - Math.abs(TN.fbm2(u * 17 + 7, v * 17, 3)));
  const pore = sstep(0.5, 0.8, TN.fbm2(u * 64, v * 64, 1));
  let r = 232 + 20 * dirt + 8 * grain, g = 224 + 18 * dirt + 8 * grain, b = 205 + 14 * dirt + 6 * grain;
  const d = sstep(0.05, 0.55, dirt) * 0.55;
  r = lerp(r, 150, d); g = lerp(g, 128, d); b = lerp(b, 100, d);
  const c = Math.max(crack, crack2);
  r = lerp(r, 55, c); g = lerp(g, 42, c); b = lerp(b, 34, c);
  const pk = 1 - 0.18 * pore; o[0] = r * pk; o[1] = g * pk; o[2] = b * pk;
  return 0.6 + 0.12 * dirt + 0.06 * grain - 0.5 * crack - 0.3 * crack2 - 0.1 * pore;
}
function textures() {
  if (!TEX) TEX = { skin: paintTex(512, paintSkin), bone: paintTex(256, paintBone) };
  return TEX;
}

/* ================================================================ materials */
const GLSL_COMMON = /* glsl */`
uniform float uTime; uniform float uGlow; uniform float uHeart; uniform float uDissolve;
varying vec3 vBind; varying vec3 vBindN;
float wdH(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float wdN(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(wdH(i), wdH(i + vec3(1, 0, 0)), f.x), mix(wdH(i + vec3(0, 1, 0)), wdH(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(wdH(i + vec3(0, 0, 1)), wdH(i + vec3(1, 0, 1)), f.x), mix(wdH(i + vec3(0, 1, 1)), wdH(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float wdFbm(vec3 p) { return 0.55 * wdN(p) + 0.3 * wdN(p * 2.03 + 7.1) + 0.15 * wdN(p * 4.1 + 3.3); }
// supernatural disintegration: extremities go first, the eaten border burns
float wdDissolve(vec3 bp) {
  if (uDissolve <= 0.0) return 0.0;
  float d = length((bp - vec3(0.0, 1.6, 0.0)) * vec3(1.0, 0.8, 1.0)) / 1.6;
  float n = wdFbm(bp * 11.0) * 0.62 + clamp(1.0 - d, 0.0, 1.0) * 0.38;
  float thr = uDissolve * 1.08 - 0.03;
  if (n < thr) discard;
  return 1.0 - smoothstep(0.0, 0.045, n - thr);
}`;
const GLSL_TRI = /* glsl */`
uniform sampler2D uTexC; uniform sampler2D uTexH; uniform float uTexS; uniform float uBump;
vec3 wdTriW() { vec3 w = pow(abs(normalize(vBindN)), vec3(4.0)); return w / (w.x + w.y + w.z); }
vec4 wdTri(sampler2D t, vec3 p, vec3 w) { return texture2D(t, p.yz) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z; }
vec3 wdPerturb(vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDir) {
  vec3 vSigmaX = dFdx(surf_pos), vSigmaY = dFdy(surf_pos), vN = surf_norm;
  vec3 R1 = cross(vSigmaY, vN), R2 = cross(vN, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDir;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  return normalize(abs(fDet) * surf_norm - vGrad);
}`;
const GLSL_HEART = /* glsl */`
vec3 wdHeart() {
  if (uHeart <= 0.001) return vec3(0.0);
  vec3 q = (vBind - vec3(0.025, 1.68, 0.05)) * vec3(1.0, 0.75, 1.3);
  float m = 1.0 - smoothstep(0.02, 0.2, length(q));
  float f = 1.0 - abs(atan(vBind.x, vBind.z)) / 3.14159;
  float rc = (vBind.y + 0.13 * pow(f, 1.3) - 1.40) / 0.058;
  float gap = smoothstep(-0.25, -0.85, cos(6.28318 * rc));
  float crack = 1.0 - smoothstep(0.0, 0.08, abs(wdN(vBind * 28.0) - 0.5));
  float beat = pow(max(sin(uTime * 3.4), 0.0), 10.0) + 0.6 * pow(max(sin(uTime * 3.4 - 0.8), 0.0), 10.0);
  return vec3(1.0, 0.12, 0.02) * uHeart * (m * m * 1.5 + m * (gap * 0.7 + crack * 1.6)) * (1.4 + 2.4 * beat);
}`;
const GLSL_FUR_SWAY = /* glsl */`
transformed += uFurAmp * aFur * aFur * 0.014 * vec3(
  sin(uTime * 1.9 + position.y * 23.0 + position.x * 11.0),
  0.35 * sin(uTime * 2.6 + position.z * 19.0),
  cos(uTime * 1.6 + position.x * 17.0 + position.y * 7.0));`;

/** inject the Wendigo shader features; kind = skin | bone | fur | depth */
function patchMat(mat, U, kind, tex = null, texScale = 1, bump = 1) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    Object.assign(sh.uniforms, { uTime: GU.uTime, uGlow: U.uGlow, uHeart: U.uHeart, uDissolve: U.uDissolve, uFurAmp: U.uFurAmp });
    if (tex) Object.assign(sh.uniforms, { uTexC: { value: tex.map }, uTexH: { value: tex.height }, uTexS: { value: texScale }, uBump: { value: bump } });
    let vs = sh.vertexShader, fs = sh.fragmentShader;
    vs = vs.replace('#include <common>', `#include <common>
uniform float uTime; uniform float uFurAmp; varying vec3 vBind; varying vec3 vBindN;
${kind === 'bone' ? 'attribute vec3 aEmis; varying vec3 vEmis;' : ''}
${kind === 'fur' ? 'attribute float aFur;' : ''}`);
    vs = vs.replace('#include <begin_vertex>', `#include <begin_vertex>
vBind = position; vBindN = normal;
${kind === 'bone' ? 'vEmis = aEmis;' : ''}
${kind === 'fur' ? GLSL_FUR_SWAY : ''}`);
    fs = fs.replace('#include <common>', `#include <common>
${GLSL_COMMON}
${kind === 'bone' ? 'varying vec3 vEmis;' : ''}
${tex ? GLSL_TRI : ''}
${kind === 'skin' ? GLSL_HEART : ''}`);
    fs = fs.replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nfloat wdEdge = wdDissolve(vBind);');
    if (kind !== 'depth') {
      if (tex) {
        fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
vec3 wdW = wdTriW(); vec3 wdP = vBind * uTexS;
diffuseColor.rgb *= wdTri(uTexC, wdP, wdW).rgb;
float wdHt = wdTri(uTexH, wdP, wdW).r;`);
        fs = fs.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = wdPerturb(-vViewPosition, normal, vec2(dFdx(wdHt), dFdy(wdHt)) * uBump, faceDirection);`);
      }
      fs = fs.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += wdEdge * vec3(3.2, 0.55, 0.06);
${kind === 'bone' ? 'totalEmissiveRadiance += vEmis * uGlow;' : ''}
${kind === 'skin' ? 'totalEmissiveRadiance += wdHeart();' : ''}`);
    }
    sh.vertexShader = vs; sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => 'wendigo-' + kind;
  return mat;
}
function makeMaterials() {
  const T = textures();
  const U = { uGlow: { value: 1 }, uHeart: { value: 0 }, uDissolve: { value: 0 }, uFurAmp: { value: 1 } };
  const skin = patchMat(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.38 }), U, 'skin', T.skin, 3.2, 0.035);
  const bone = patchMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0 }), U, 'bone', T.bone, 5.0, 0.02);
  const fur = patchMat(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, metalness: 0 }), U, 'fur');
  const depth = patchMat(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), U, 'depth');
  return { skin, bone, fur, depth, U };
}

/* ================================================================ skeleton definition */
const SKULL_PITCH = 0.62;                     // skull hangs nose-down from the neck
const HEAD_POS = V(0, 2.40, 0.10);            // occipital joint (bind)
const SKQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(SKULL_PITCH, 0, 0));
const SKM = new THREE.Matrix4().compose(HEAD_POS, SKQ, V(1.18, 1.18, 1.18));
/** skull frame (origin at the occipital, +Z along the skull) -> model space */
const sk = (x, y, z) => V(x, y, z).applyMatrix4(SKM);
const skDir = (x, y, z) => V(x, y, z).applyQuaternion(SKQ);

const SIDES = [['L', 1], ['R', -1]];
const FINGER_Z = [-0.05, -0.017, 0.017, 0.05];
const FINGER_LEN = [[0.13, 0.11], [0.14, 0.12], [0.14, 0.12], [0.12, 0.1]];
const THUMB_LEN = [0.09, 0.08];
const TAIL_PTS = [V(0, 1.06, -0.12), V(0, 0.98, -0.34), V(0, 0.84, -0.53), V(0, 0.64, -0.7), V(0, 0.43, -0.83), V(0, 0.25, -0.95),
  V(0, 0.13, -1.12), V(0, 0.09, -1.32), V(0, 0.11, -1.52), V(0, 0.18, -1.69), V(0, 0.27, -1.82), V(0, 0.37, -1.9)];

function fingerDir(s, i) { return i < 4 ? V(s * 0.06, -1, FINGER_Z[i] * 1.6).normalize() : V(-s * 0.15, -1, 0.45).normalize(); }
function fingerBase(s, i) { return i < 4 ? V(s * 0.458, 0.715, FINGER_Z[i]) : V(s * 0.435, 0.775, 0.06); }

const JT = new Map();              // name -> { name, parent, pos (bind, model space) }
const BI = {};                     // name -> bone index
(function jointTable() {
  const add = (name, parent, pos) => { BI[name] = JT.size; JT.set(name, { name, parent, pos }); };
  add('hips', null, V(0, 1.10, 0));
  add('spine1', 'hips', V(0, 1.30, -0.01));
  add('spine2', 'spine1', V(0, 1.52, 0));
  add('chest', 'spine2', V(0, 1.76, 0));
  add('ribs', 'spine2', V(0, 1.66, 0.04));
  add('neck1', 'chest', V(0, 2.04, 0.0));
  add('neck2', 'neck1', V(0, 2.22, 0.04));
  add('head', 'neck2', HEAD_POS.clone());
  add('jaw', 'head', sk(0, -0.035, 0.0));
  for (const [S, s] of SIDES) {
    add('clav' + S, 'chest', V(s * 0.05, 1.98, 0));
    add('upper' + S, 'clav' + S, V(s * 0.29, 1.99, -0.01));
    add('fore' + S, 'upper' + S, V(s * 0.39, 1.42, -0.06));
    add('hand' + S, 'fore' + S, V(s * 0.445, 0.87, 0.01));
    for (let i = 0; i < 5; i++) {
      const b = fingerBase(s, i), d = fingerDir(s, i), len = i < 4 ? FINGER_LEN[i] : THUMB_LEN;
      add(`f${i}a${S}`, 'hand' + S, b);
      add(`f${i}b${S}`, `f${i}a${S}`, b.clone().addScaledVector(d, len[0]));
    }
  }
  for (const [S, s] of SIDES) {
    add('thigh' + S, 'hips', V(s * 0.15, 1.04, 0));
    add('shin' + S, 'thigh' + S, V(s * 0.18, 0.64, 0.20));
    add('meta' + S, 'shin' + S, V(s * 0.18, 0.30, -0.10));
    add('toe' + S, 'meta' + S, V(s * 0.18, 0.06, 0.04));
  }
  for (let i = 0; i < TAIL_PTS.length - 1; i++) add('tail' + i, i ? 'tail' + (i - 1) : 'hips', TAIL_PTS[i]);
})();
const JP = (name) => JT.get(name).pos;
const fingerTip = (s, i) => { const S = s > 0 ? 'L' : 'R', len = i < 4 ? FINGER_LEN[i] : THUMB_LEN; return JP(`f${i}b${S}`).clone().addScaledVector(fingerDir(s, i), len[1]); };
const toeTip = (s) => V(s * 0.18, 0.02, 0.2);
const BIND_TILT = Math.atan2(JP('metaL').z - JP('toeL').z, JP('metaL').y - JP('toeL').y) * -1; // ball->hock leans back

/* ---- skin weights: closest segment of a joint chain, blended across joints */
function chain(names, end) {
  return names.map((n, i) => {
    const a = JP(n), b = i + 1 < names.length ? JP(names[i + 1]) : end;
    return { a, b, bone: BI[n], len: a.distanceTo(b) };
  });
}
const _cw = new V3();
function chainWeights(p, segs, blend = 0.05) {
  let best = 0, bs = 0, bd = Infinity;
  for (let i = 0; i < segs.length; i++) {
    const { a, b } = segs[i];
    _cw.subVectors(b, a); const l2 = _cw.lengthSq();
    const s = clamp((p.x - a.x) * _cw.x / l2 + (p.y - a.y) * _cw.y / l2 + (p.z - a.z) * _cw.z / l2, 0, 1);
    const d = p.distanceToSquared(_cw.multiplyScalar(s).add(a));
    if (d < bd) { bd = d; best = i; bs = s; }
  }
  const g = segs[best], B = Math.min(0.5, blend / g.len);
  if (bs < B && best > 0) { const w = 0.5 + 0.5 * bs / B; return [[g.bone, w], [segs[best - 1].bone, 1 - w]]; }
  if (bs > 1 - B && best < segs.length - 1) { const w = 0.5 + 0.5 * (1 - bs) / B; return [[g.bone, w], [segs[best + 1].bone, 1 - w]]; }
  return [[g.bone, 1]];
}
/** blend weight list a toward b by t */
function blendW(a, b, t) {
  const m = new Map();
  for (const [i, w] of a) m.set(i, (m.get(i) || 0) + w * (1 - t));
  for (const [i, w] of b) m.set(i, (m.get(i) || 0) + w * t);
  return [...m.entries()];
}
function normW(ws) {
  ws = ws.filter(w => w[1] > 1e-4).sort((x, y) => y[1] - x[1]).slice(0, 4);
  let s = 0; for (const w of ws) s += w[1];
  return ws.map(([i, w]) => [i, w / (s || 1)]);
}
const CH = {
  spine: chain(['hips', 'spine1', 'spine2', 'chest', 'neck1', 'neck2', 'head'], sk(0, 0, 0.15)),
  tail: chain(['hips', ...TAIL_PTS.slice(0, -1).map((_, i) => 'tail' + i)], TAIL_PTS[TAIL_PTS.length - 1]),
};
for (const [S, s] of SIDES) {
  CH['arm' + S] = chain(['chest', 'clav' + S, 'upper' + S, 'fore' + S, 'hand' + S], V(s * 0.456, 0.712, 0));
  CH['leg' + S] = [{ a: JP('hips'), b: JP('thigh' + S), bone: BI.hips, len: JP('hips').distanceTo(JP('thigh' + S)) },
    ...chain(['thigh' + S, 'shin' + S, 'meta' + S, 'toe' + S], toeTip(s))];
  for (let i = 0; i < 5; i++) CH[`f${i}${S}`] = chain(['hand' + S, `f${i}a${S}`, `f${i}b${S}`], fingerTip(s, i));
}
CH.armL[0] = { ...CH.armL[0], a: V(0, 1.98, 0) }; CH.armR[0] = { ...CH.armR[0], a: V(0, 1.98, 0) };

/* ================================================================ geometry primitives */
/** closed grid: rows+1 rings of `cols` vertices; fn(u, v, out) places a vertex */
function grid(rows, cols, fn, caps = [true, true]) {
  const P = [], T = [], A = [], I = [], v = new V3();
  for (let i = 0; i <= rows; i++) for (let j = 0; j < cols; j++) { fn(i / rows, j / cols, v); P.push(v.x, v.y, v.z); T.push(i / rows); A.push(j / cols); }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = i * cols + j, b = i * cols + (j + 1) % cols, c = a + cols, d = b + cols;
    I.push(a, c, b, b, c, d);
  }
  const cap = (ring, end) => {
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < cols; j++) { const k = (ring * cols + j) * 3; x += P[k]; y += P[k + 1]; z += P[k + 2]; }
    const ci = P.length / 3; P.push(x / cols, y / cols, z / cols); T.push(end ? 1 : 0); A.push(0);
    for (let j = 0; j < cols; j++) { const a = ring * cols + j, b = ring * cols + (j + 1) % cols; if (end) I.push(ci, b, a); else I.push(ci, a, b); }
  };
  if (caps[0]) cap(0, false);
  if (caps[1]) cap(rows, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setIndex(I);
  orientOutward(g); g.computeVertexNormals();
  g.userData.t = T; g.userData.a = A;
  return g;
}
/** flip the winding if the closed mesh has negative signed volume */
function orientOutward(g) {
  const p = g.attributes.position, I = g.index.array, cen = new V3(), a = new V3(), b = new V3(), c = new V3();
  for (let i = 0; i < p.count; i++) cen.add(a.fromBufferAttribute(p, i)); cen.divideScalar(p.count);
  let vol = 0;
  for (let k = 0; k < I.length; k += 3) {
    a.fromBufferAttribute(p, I[k]).sub(cen); b.fromBufferAttribute(p, I[k + 1]).sub(cen); c.fromBufferAttribute(p, I[k + 2]).sub(cen);
    vol += a.dot(b.cross(c));
  }
  if (vol < 0) for (let k = 0; k < I.length; k += 3) { const t = I[k + 1]; I[k + 1] = I[k + 2]; I[k + 2] = t; }
}
/** a smooth tube with parallel-transport frames; rfn(t, radialDir, centre) -> radius */
class Tube {
  constructor(pts, rfn, { seg = 24, up = null } = {}) {
    this.seg = seg; this.rfn = rfn;
    this.curve = new THREE.CatmullRomCurve3(pts.map(p => p.clone()), false, 'centripetal');
    this.C = []; this.T = []; this.N = []; this.B = [];
    for (let i = 0; i <= seg; i++) { this.C.push(this.curve.getPointAt(i / seg)); this.T.push(this.curve.getTangentAt(i / seg).normalize()); }
    let n = up ? up.clone() : (Math.abs(this.T[0].y) < 0.9 ? V(0, 1, 0) : V(0, 0, 1));
    for (let i = 0; i <= seg; i++) {
      const T = this.T[i]; n = n.clone().addScaledVector(T, -n.dot(T)).normalize();
      this.N.push(n); this.B.push(T.clone().cross(n));
    }
  }
  dir(i, ang, out) { return out.copy(this.N[i]).multiplyScalar(Math.cos(ang)).addScaledVector(this.B[i], Math.sin(ang)); }
  /** surface sample: { p, d (outward), c (centre), T (tangent), r } */
  at(t, ang) {
    const i = Math.round(clamp(t, 0, 1) * this.seg), d = this.dir(i, ang, new V3()), r = this.rfn(i / this.seg, d, this.C[i]);
    return { p: this.C[i].clone().addScaledVector(d, r), d, c: this.C[i], T: this.T[i], r };
  }
  mesh(radial = 10, caps = [true, true]) {
    const d = new V3(), seg = this.seg;
    return grid(seg, radial, (t, a, out) => { const i = Math.round(t * seg); this.dir(i, a * TAU, d); out.copy(this.C[i]).addScaledVector(d, this.rfn(t, d, this.C[i])); }, caps);
  }
}
/** a simple curved tapering horn/spike/claw from base along dir */
function hornGeo(base, dir, len, r0, bend = null, { seg = 6, radial = 6, pow = 1.1 } = {}) {
  const d = dir.clone().normalize(), b = bend || V();
  const pts = [base.clone().addScaledVector(d, -r0 * 0.8), base.clone(), base.clone().addScaledVector(d, len * 0.5).addScaledVector(b, len * 0.12), base.clone().addScaledVector(d, len).addScaledVector(b, len * 0.45)];
  return new Tube(pts, (t) => r0 * Math.pow(1 - t, pow) + r0 * 0.02, { seg }).mesh(radial);
}

/* ---- geometry buckets: one per material, with skin weights and colours */
const WHITE = [1, 1, 1], ZERO3 = [0, 0, 0];
class Bucket {
  constructor({ emis = false, fur = false } = {}) {
    this.P = []; this.N = []; this.C = []; this.SI = []; this.SW = []; this.I = []; this.n = 0;
    this.E = emis ? [] : null; this.F = fur ? [] : null;
  }
  vert(p, n, c, ws, e = null, f = 0) {
    this.P.push(p.x, p.y, p.z); this.N.push(n.x, n.y, n.z); this.C.push(c[0], c[1], c[2]);
    for (let k = 0; k < 4; k++) { const w = ws[k]; this.SI.push(w ? w[0] : 0); this.SW.push(w ? w[1] : 0); }
    if (this.E) { const ee = e || ZERO3; this.E.push(ee[0], ee[1], ee[2]); }
    if (this.F) this.F.push(f);
    return this.n++;
  }
  /** w: bone index, a weight list [[bone, weight], ...] or fn(p, i) -> list; col/emis: fn(p, n, i) -> rgb */
  add(geo, { w, col = null, emis = null }) {
    const pos = geo.attributes.position, nor = geo.attributes.normal, base = this.n, p = new V3(), n = new V3();
    for (let i = 0; i < pos.count; i++) if (!Number.isFinite(pos.array[i * 3] + pos.array[i * 3 + 1] + pos.array[i * 3 + 2])) { console.error('NaN part ' + new Error().stack.split('\n').slice(2, 4).join(' ')); break; }
    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i); n.fromBufferAttribute(nor, i);
      const ws = typeof w === 'number' ? [[w, 1]] : normW(Array.isArray(w) ? w : w(p, i));
      this.vert(p, n, col ? col(p, n, i) : WHITE, ws, emis ? emis(p, n, i) : null, 0);
    }
    if (geo.index) for (const k of geo.index.array) this.I.push(base + k);
    else for (let k = 0; k < pos.count; k++) this.I.push(base + k);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.SW, 4));
    if (this.E) g.setAttribute('aEmis', new THREE.Float32BufferAttribute(this.E, 3));
    if (this.F) g.setAttribute('aFur', new THREE.Float32BufferAttribute(this.F, 1));
    g.setIndex(this.I);
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}

/* ================================================================ body: torso */
const TW = table([[0.90, 0.03], [0.95, 0.12], [1.02, 0.165], [1.10, 0.172], [1.2, 0.148], [1.3, 0.118], [1.4, 0.13], [1.52, 0.165], [1.65, 0.195], [1.78, 0.21], [1.88, 0.222], [1.96, 0.25], [2.02, 0.255], [2.08, 0.19], [2.13, 0.12], [2.17, 0.085]]);
const TDF = table([[0.90, 0.03], [0.95, 0.08], [1.05, 0.1], [1.15, 0.092], [1.28, 0.072], [1.4, 0.09], [1.52, 0.12], [1.65, 0.145], [1.78, 0.15], [1.9, 0.13], [2.0, 0.11], [2.1, 0.08], [2.17, 0.07]]);
const TDB = table([[0.90, 0.03], [0.95, 0.09], [1.05, 0.12], [1.15, 0.1], [1.3, 0.075], [1.45, 0.09], [1.6, 0.11], [1.75, 0.125], [1.9, 0.135], [2.0, 0.135], [2.1, 0.1], [2.17, 0.08]]);
const TZC = table([[0.9, 0], [1.3, 0], [1.7, 0.01], [2.0, -0.01], [2.17, 0.02]]);
const TORSO_Y0 = 0.90, TORSO_Y1 = 2.17;
/** rib pattern: ridge 0..1 on a rib, m = where ribs show; f: 0 spine .. 1 sternum */
function ribField(y, f) {
  const rc = (y + 0.13 * Math.pow(f, 1.3) - 1.40) / 0.058;
  const ridge = Math.pow(0.5 + 0.5 * Math.cos(TAU * rc), 4);
  let m = sstep(0.12, 0.3, f) * (1 - sstep(0.86, 0.97, f));
  m *= sstep(0, 0.04, y - (1.42 + 0.16 * sstep(0.55, 0.95, f))) * (1 - sstep(1.9, 1.99, y + 0.13 * Math.pow(f, 1.3)));
  return { ridge, m, rc };
}
const wrapAng = (a) => (a > Math.PI ? a - TAU : a);
function torsoPoint(y, th, out) {
  if (th > Math.PI) th -= TAU; else if (th < -Math.PI) th += TAU;
  const W = TW(y), zc = TZC(y), sa = Math.sin(th), ca = Math.cos(th), D = ca >= 0 ? TDF(y) : TDB(y);
  const x = W * Math.sign(sa) * Math.pow(Math.abs(sa), 0.85), z = D * Math.sign(ca) * Math.pow(Math.abs(ca), 0.85);
  const f = 1 - Math.abs(th) / Math.PI, back = Math.PI - Math.abs(th);
  let disp = 0;
  const { ridge, m } = ribField(y, f);
  disp += m * (0.017 * ridge - 0.007);                                                         // ribs
  disp += 0.008 * gauss(th / 0.18) * sstep(1.55, 1.65, y) * (1 - sstep(1.92, 2.0, y));        // sternum
  const vert = Math.pow(0.5 + 0.5 * Math.cos(TAU * y / 0.048), 2);
  disp += (0.008 + 0.013 * vert) * gauss(back / 0.12) * sstep(1.0, 1.15, y) * (1 - sstep(2.06, 2.15, y)); // vertebrae
  disp -= 0.01 * gauss((back - 0.32) / 0.12) * sstep(1.15, 1.3, y);                           // paraspinal furrows
  disp += 0.028 * gauss((back - 0.62) / 0.28) * gauss((y - 1.86) / 0.08);                     // shoulder blades
  disp += 0.012 * gauss((y - (2.0 - 0.025 * Math.abs(sa))) / 0.016) * (1 - sstep(0.9, 1.3, Math.abs(th))); // collarbones
  disp += 0.022 * gauss((Math.abs(th) - 1.05) / 0.32) * gauss((y - 1.14) / 0.045);             // hip bones
  disp -= 0.012 * gauss(th / 0.9) * gauss((y - 1.33) / 0.08);                                  // sunken belly
  const rl = Math.hypot(x, z) || 1;
  return out.set(x + x / rl * disp, y, zc + z + z / rl * disp);
}
function torsoW(p) {
  let ws = chainWeights(p, CH.spine, 0.08);
  const kc = sstep(0.13, 0.26, Math.abs(p.x)) * sstep(1.83, 1.97, p.y);
  if (kc > 0) ws = blendW(ws, [[BI[p.x > 0 ? 'clavL' : 'clavR'], 1]], kc);
  const kr = sstep(1.45, 1.55, p.y) * (1 - sstep(1.8, 1.9, p.y)) * sstep(-0.06, 0.04, p.z);
  if (kr > 0) ws = blendW(ws, [[BI.ribs, 1]], kr * 0.85);
  return ws;
}
/** large-scale skin colouring shared by all skin parts */
function skinBase(p) {
  const nz = NZ.fbm3(p.x * 7, p.y * 7, p.z * 7, 3);
  let c = mixc(PAL.skin, PAL.skinHi, clamp(0.5 + nz, 0, 1));
  const so = sstep(0.3, 0.55, NZ.fbm3(p.x * 4 + 20, p.y * 4, p.z * 4, 3));
  c = mixc(c, PAL.raw, so * 0.75);
  const st = sstep(0.45, 0.75, NZ.n3(p.x * 30, p.y * 2.2, p.z * 30));
  return mixc(c, PAL.tar, st * 0.75);
}
function torsoColor(p) {
  const y = p.y, th = Math.atan2(p.x, p.z - TZC(y)), f = 1 - Math.abs(th) / Math.PI, back = Math.PI - Math.abs(th);
  let c = skinBase(p);
  const { ridge, m } = ribField(y, f);
  c = mixc(c, PAL.rib, ridge * m * 0.8);
  c = mixc(c, PAL.gap, (1 - ridge) * m * 0.55);
  c = mixc(c, PAL.rib, gauss(back / 0.1) * 0.5 * sstep(1.0, 1.2, y));                       // spine knuckles
  c = mixc(c, PAL.skinDark, gauss((back - 0.32) / 0.12) * 0.6);                              // furrows
  // raw open chest and blood running down the belly
  const wound = gauss(th / 0.42) * gauss((y - 1.62) / 0.12) * sstep(-0.2, 0.25, NZ.fbm3(p.x * 9, p.y * 9, p.z * 9, 3));
  c = mixc(c, PAL.raw, clamp(wound * 1.6, 0, 1));
  const streak = gauss(th / 0.5) * sstep(1.0, 1.25, y) * (1 - sstep(1.5, 1.6, y)) * sstep(0.2, 0.7, NZ.n3(p.x * 40, y * 3, 1.7));
  c = mixc(c, PAL.blood, streak);
  c = mixc(c, PAL.skinDark, (1 - sstep(0.94, 1.0, y)) * 0.7);
  return c;
}

/* ================================================================ body: skull */
const SK_Z0 = -0.075, SK_Z1 = 0.41;
const SK_HW = table([[-0.075, 0.0], [-0.066, 0.045], [-0.05, 0.068], [-0.02, 0.08], [0.03, 0.084], [0.08, 0.083], [0.125, 0.1], [0.15, 0.096], [0.18, 0.07], [0.22, 0.057], [0.3, 0.049], [0.36, 0.041], [0.395, 0.03], [0.41, 0.0]]);
const SK_TOP = table([[-0.075, 0.0], [-0.066, 0.05], [-0.045, 0.085], [0.0, 0.098], [0.05, 0.096], [0.1, 0.086], [0.15, 0.072], [0.25, 0.057], [0.33, 0.045], [0.39, 0.03], [0.41, 0.0]]);
const SK_BOT = table([[-0.075, 0.0], [-0.066, 0.04], [-0.04, 0.058], [0.02, 0.064], [0.08, 0.062], [0.15, 0.055], [0.25, 0.045], [0.33, 0.036], [0.39, 0.026], [0.41, 0.0]]);
const EYE_Z = 0.13, EYE_A = 1.0;
/** feature mask helpers (z along skull, ang: 0 top, + toward +X) */
const eyeDist = (z, ang) => Math.hypot((z - EYE_Z) / 0.047, (Math.abs(ang) - EYE_A) / 0.48);
/** skull surface point in skull frame */
function skullLocal(z, ang, out) {
  const sa = Math.sin(ang), ca = Math.cos(ang), hw = SK_HW(z), tp = SK_TOP(z), bt = SK_BOT(z);
  const x = hw * Math.sign(sa) * Math.pow(Math.abs(sa), 0.8);
  const y = ca >= 0 ? tp * Math.pow(ca, 0.9) : -bt * Math.pow(-ca, 0.55);
  const aa = Math.abs(ang);
  let disp = 0;
  const de = eyeDist(z, ang);
  if (de < 1) disp -= 0.036 * Math.pow(1 - de * de, 1.3);                                     // orbit
  disp += 0.008 * gauss((de - 1.12) / 0.2);                                                      // orbit rim
  disp += 0.01 * gauss((aa - 0.62) / 0.2) * gauss((z - 0.11) / 0.035);                          // brow ridge
  disp -= 0.012 * gauss((aa - 1.25) / 0.35) * gauss((z - 0.03) / 0.04);                          // temporal fossa
  disp += 0.006 * gauss(ang / 0.18) * (1 - sstep(0.1, 0.2, z));                                  // sagittal crest
  disp -= 0.014 * gauss(ang / 0.42) * sstep(0.27, 0.34, z);                                      // nasal aperture
  disp += 0.009 * gauss((aa - 1.95) / 0.3) * gauss((z - 0.2) / 0.05);                            // facial tuberosity
  const rl = Math.hypot(x, y) || 1;
  return out.set(x + x / rl * disp, y + y / rl * disp, z);
}
function skullColor(z, ang, p) {
  const aa = Math.abs(ang), de = eyeDist(z, ang);
  const dirt = 0.5 + 0.5 * NZ.fbm3(p.x * 14, p.y * 14, p.z * 14, 3);
  let c = mixc(PAL.bone, PAL.boneDirt, dirt * 0.45);
  c = mixc(c, PAL.boneDirt, 0.5 * gauss((aa - 1.25) / 0.35) * gauss((z - 0.03) / 0.05));
  c = mixc(c, PAL.socket, sstep(1.05, 0.5, de));
  c = mixc(c, PAL.socket, gauss(ang / 0.36) * sstep(0.28, 0.35, z) * 0.9);
  c = mixc(c, PAL.mouth, sstep(2.3, 2.75, aa));
  c = mixc(c, PAL.blood, sstep(1.9, 2.4, aa) * sstep(0.1, 0.3, z) * sstep(-0.1, 0.3, NZ.fbm3(p.x * 20, p.y * 20, p.z * 20, 2)));
  c = mixc(c, PAL.skinDark, sstep(0.0, -0.06, z) * 0.85);
  return c;
}
/* mandible (skull frame) */
const JW_HW = table([[-0.012, 0.0], [0.0, 0.05], [0.06, 0.062], [0.15, 0.055], [0.25, 0.045], [0.33, 0.037], [0.385, 0.027], [0.405, 0.0]]);
const JW_DEPTH = table([[-0.012, 0.02], [0.0, 0.035], [0.04, 0.06], [0.1, 0.048], [0.2, 0.04], [0.3, 0.034], [0.4, 0.024]]);
const jawTop = (z) => (z < 0.07 ? lerp(-0.03, -SK_BOT(0.07) + 0.004, sstep(0, 0.07, z)) : -SK_BOT(z) + 0.004);
const JW_Z0 = -0.012, JW_Z1 = 0.405;
function jawLocal(z, ang, out) {
  const sa = Math.sin(ang), ca = Math.cos(ang), hw = JW_HW(z), top = jawTop(z), dep = JW_DEPTH(z);
  const x = hw * Math.sign(sa) * Math.pow(Math.abs(sa), 0.6);
  const y = top - dep * 0.5 + dep * 0.5 * Math.sign(ca) * Math.pow(Math.abs(ca), 0.6);
  return out.set(x, y, z);
}

/* ================================================================ geometry build (cached) */
let GEO = null;
function buildGeometry() {
  if (GEO) return GEO;
  const R = rng(4471);
  const skinB = new Bucket(), boneB = new Bucket({ emis: true }), furB = new Bucket({ fur: true });
  const tmp = new V3();

  /* ---- torso */
  {
    const g = grid(70, 44, (u, a, out) => torsoPoint(lerp(TORSO_Y0, TORSO_Y1, u), wrapAng(a * TAU), out));
    noisify(g, 0.004, 9, 3);
    skinB.add(g, { w: torsoW, col: torsoColor });
  }
  /* ---- neck */
  const neck = new Tube([V(0, 1.94, -0.02), V(0, 2.06, -0.005), V(0, 2.2, 0.03), V(0, 2.33, 0.07), sk(0, 0.0, 0.0), sk(0, -0.005, 0.04)],
    (t, d) => lerp(0.115, 0.06, sstep(0, 0.85, t)) * (1 + 0.18 * Math.max(0, -d.z)) + 0.012 * gauss(d.z / 0.4) * gauss((t - 0.5) / 0.25), { seg: 24, up: V(0, 0, 1) });
  {
    const g = neck.mesh(22); noisify(g, 0.003, 12, 5);
    skinB.add(g, { w: (p) => chainWeights(p, CH.spine, 0.06), col: (p) => mixc(skinBase(p), PAL.skinDark, 0.3) });
  }
  /* ---- skull */
  let skullTop = 0;
  {
    const g = grid(60, 40, (u, a, out) => { const z = lerp(SK_Z0, SK_Z1, 0.5 - 0.5 * Math.cos(Math.PI * u)); skullLocal(z, wrapAng(a * TAU), out); out.applyMatrix4(SKM); });
    noisify(g, 0.0025, 30, 7);
    const T = g.userData.t, A = g.userData.a;
    boneB.add(g, { w: BI.head, col: (p, n, i) => skullColor(lerp(SK_Z0, SK_Z1, 0.5 - 0.5 * Math.cos(Math.PI * T[i])), wrapAng(A[i] * TAU), p) });
    const pos = g.attributes.position; for (let i = 0; i < pos.count; i++) skullTop = Math.max(skullTop, pos.getY(i));
  }
  /* ---- eyes: small glowing pupils deep in the orbits */
  for (const s of [1, -1]) {
    const c = skullLocal(EYE_Z, s * EYE_A, new V3()); c.multiplyScalar(0.985);
    const e = new THREE.SphereGeometry(0.017, 10, 8); e.deleteAttribute('uv');
    const cm = c.applyMatrix4(SKM); e.translate(cm.x, cm.y, cm.z);
    boneB.add(e, { w: BI.head, col: () => [0.9, 0.5, 0.3], emis: () => scalec(EYE, 4) });
  }
  /* ---- mandible */
  {
    const g = grid(40, 24, (u, a, out) => { const z = lerp(JW_Z0, JW_Z1, 0.5 - 0.5 * Math.cos(Math.PI * u)); jawLocal(z, wrapAng(a * TAU), out); out.applyMatrix4(SKM); });
    noisify(g, 0.002, 30, 9);
    const T = g.userData.t, A = g.userData.a;
    boneB.add(g, {
      w: BI.jaw, col: (p, n, i) => {
        const ang = Math.abs(wrapAng(A[i] * TAU)), z = lerp(JW_Z0, JW_Z1, 0.5 - 0.5 * Math.cos(Math.PI * T[i]));
        let c = mixc(PAL.bone, PAL.boneDirt, 0.3 + 0.4 * (0.5 + 0.5 * NZ.fbm3(p.x * 14, p.y * 14, p.z * 14, 3)));
        c = mixc(c, PAL.mouth, sstep(0.75, 0.35, ang));
        c = mixc(c, PAL.blood, sstep(0.4, 1.2, ang) * sstep(1.9, 1.2, ang) * 0.7);
        return mixc(c, PAL.skinDark, sstep(0.05, -0.01, z) * 0.6);
      },
    });
  }
  /* ---- teeth: many thin needles along both jaws */
  {
    const toothCol = (p, n, i, g) => mixc(PAL.blood, PAL.tooth, sstep(0, 0.35, g.userData.t[i]));
    const addTooth = (baseL, dirL, len, r0, bone) => {
      const g = hornGeo(baseL.applyMatrix4(SKM), dirL.applyQuaternion(SKQ), len, r0, V(0, 0, 0), { seg: 4, radial: 5, pow: 1.3 });
      boneB.add(g, { w: bone, col: (p, n, i) => toothCol(p, n, i, g) });
    };
    for (const s of [1, -1]) {
      for (let k = 0; k < 15; k++) {
        const z = 0.12 + 0.27 * k / 14, b = skullLocal(z, s * (Math.PI - 0.62), new V3());
        b.x *= 1.02;
        const len = 0.022 + 0.018 * R() + 0.04 * gauss((z - 0.34) / 0.03) + 0.01 * (k % 2);
        addTooth(b, V(s * 0.12, -1, 0.25 + 0.15 * R()), len, 0.0055 + 0.002 * R(), BI.head);
      }
      for (let k = 0; k < 13; k++) {
        const z = 0.14 + 0.25 * k / 12, b = jawLocal(z, s * 0.62, new V3());
        b.x *= 1.03;
        const len = 0.02 + 0.016 * R() + 0.035 * gauss((z - 0.36) / 0.03);
        addTooth(b, V(s * 0.1, 1, 0.2 + 0.15 * R()), len, 0.005 + 0.002 * R(), BI.jaw);
      }
    }
  }
  /* ---- tongue: long, flat, hanging out of the mouth */
  {
    const M = sk(0, -0.07, 0.385);
    const pts = [sk(0, -0.06, 0.18), sk(0, -0.065, 0.3), M, M.clone().add(V(0.01, -0.09, 0.02)), M.clone().add(V(-0.005, -0.2, 0.0)), M.clone().add(V(0.012, -0.31, -0.02)), M.clone().add(V(0.0, -0.4, -0.015))];
    const tg = new Tube(pts, (t, d) => (1 / Math.hypot(d.x / 0.026, Math.hypot(d.y, d.z) / 0.009)) * (1 - 0.55 * t) * Math.sqrt(1 - Math.pow(t, 6)), { seg: 30 });
    const g = tg.mesh(10);
    skinB.add(g, { w: BI.jaw, col: (p, n, i) => mixc(PAL.tongue, PAL.tar, sstep(0.6, 1.0, g.userData.t[i]) * 0.8) });
  }
  /* ---- antlers */
  for (const s of [1, -1]) buildAntler(boneB, s, R);

  /* ---- arms, hands, claws */
  for (const [S, s] of SIDES) buildArm(skinB, boneB, S, s, R);
  /* ---- legs, feet */
  for (const [S, s] of SIDES) buildLeg(skinB, boneB, S, s, R);
  /* ---- tail with barbs */
  buildTail(skinB, boneB, R);
  /* ---- spine & shoulder spikes */
  {
    for (let y = 1.16; y <= 2.12; y += 0.055) {
      const b = torsoPoint(y, Math.PI, new V3()), len = 0.035 + 0.075 * gauss((y - 1.92) / 0.18) + 0.015 * R();
      const g = hornGeo(b, V(0, 0.55, -1), len, 0.012 + len * 0.12, V(0, 0.5, 0), { seg: 5, radial: 6 });
      boneB.add(g, { w: (p) => torsoW(b), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g.userData.t[i]) });
    }
    for (const s of [1, -1]) for (let k = 0; k < 3; k++) {
      const b = torsoPoint(1.97 - k * 0.04, s * (Math.PI * 0.62 + k * 0.18), new V3());
      const g = hornGeo(b, V(s * 0.5, 1, -0.45 - k * 0.2), 0.16 + 0.05 * R(), 0.017, V(s * 0.3, 0, -0.4), { seg: 6, radial: 6 });
      boneB.add(g, { w: (p) => torsoW(b), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g.userData.t[i]) });
    }
  }
  /* ---- tar drips: jaw, chest, groin */
  {
    const drips = [];
    for (let k = 0; k < 5; k++) { const z = 0.2 + 0.18 * R(), s = R() < 0.5 ? 1 : -1; drips.push([jawLocal(z, s * (Math.PI - 0.3), new V3()).applyMatrix4(SKM), 0.08 + 0.3 * R(), 0.006, BI.jaw]); }
    for (let k = 0; k < 4; k++) { const b = torsoPoint(1.5 + 0.06 * R(), (R() - 0.5) * 1.6, new V3()); drips.push([b, 0.06 + 0.12 * R(), 0.007, null]); }
    drips.push([torsoPoint(0.96, 0.15, new V3()), 0.55, 0.01, BI.hips]);
    drips.push([torsoPoint(1.02, -0.5, new V3()), 0.3, 0.008, BI.hips]);
    for (const [b, len, r0, bone] of drips) addDrip(skinB, b, len, r0, bone === null ? torsoW(b) : bone, R);
  }

  /* ---- fur */
  buildFur(furB, neck, R);

  GEO = { skin: skinB.build(), bone: boneB.build(), fur: furB.build() };
  K = WENDIGO_HEIGHT / skullTop;
  return GEO;
}

/** a tapered hanging tar drip ending in a droplet */
function addDrip(bucket, top, len, r0, w, R) {
  const wob = () => (R() - 0.5) * 0.012;
  const pts = [top.clone().add(V(0, 0.01, 0)), top.clone().add(V(wob(), -len * 0.4, wob())), top.clone().add(V(wob(), -len * 0.8, wob())), top.clone().add(V(0, -len, 0))];
  const g = new Tube(pts, (t) => (r0 * (1 - 0.7 * t) + r0 * 0.9 * gauss((t - 0.86) / 0.07)) * Math.sqrt(1 - Math.pow(t, 10)), { seg: 12 }).mesh(6);
  bucket.add(g, { w: typeof w === 'number' ? w : () => w, col: () => PAL.tar });
}

function buildAntler(bucket, s, R) {
  const B0 = sk(s * 0.05, 0.08, 0.045);
  const P = (x, y, z) => B0.clone().add(V(s * x, y, z));
  const beamPts = [P(0, -0.03, 0.01), P(0.05, 0.05, -0.04), P(0.15, 0.12, -0.12), P(0.28, 0.2, -0.17), P(0.39, 0.3, -0.17), P(0.47, 0.43, -0.12), P(0.5, 0.56, -0.05), P(0.46, 0.68, 0.02)];
  const beamR = (t) => lerp(0.036, 0.008, Math.pow(t, 0.85)) + 0.01 * gauss(t / 0.04);
  const knob = (d, c) => 1 + 0.08 * NZ.n3(c.x * 30 + d.x * 3, c.y * 30 + d.y * 3, c.z * 30);
  const beam = new Tube(beamPts, (t, d, c) => beamR(t) * knob(d, c) * Math.sqrt(1 - Math.pow(t, 12)), { seg: 44 });
  const glowAt = (p) => Math.pow(sstep(0.16, 0.7, (p.y - B0.y) / 0.68 + Math.abs(p.x - B0.x) * 0.25), 1.4);
  const add = (g) => bucket.add(g, {
    w: BI.head,
    col: (p) => { const k = glowAt(p); return mixc(mixc(PAL.antBase, PAL.boneDirt, 0.25 * (0.5 + NZ.n3(p.x * 20, p.y * 20, p.z * 20))), PAL.antRed, k); },
    emis: (p) => scalec(EMBER, 1.3 * glowAt(p)),
  });
  add(beam.mesh(10));
  // tines: [u along beam, direction, length, bend]
  const tines = [
    [0.12, V(s * 0.3, 0.45, 1.0), 0.2, V(0, 1, 0.2)],
    [0.3, V(-s * 0.1, 1.0, 0.25), 0.27, V(0, 0, 0.6)],
    [0.47, V(-s * 0.15, 1.0, -0.1), 0.27, V(-s * 0.2, 0, 0.5)],
    [0.63, V(-s * 0.35, 1.0, 0.1), 0.22, V(0, 0.1, 0.5)],
    [0.78, V(s * 0.45, 1.0, -0.25), 0.16, V(s * 0.2, 0, 0.3)],
    [0.22, V(s * 0.25, 0.9, -0.5), 0.13, V(0, 1, 0)],
    [0.88, V(-s * 0.2, 1.0, 0.3), 0.12, V(0, 0, 0.4)],
  ];
  for (const [u, dir, len, bend] of tines) {
    const base = beam.curve.getPointAt(u), d = dir.normalize(), r0 = beamR(u) * 0.78;
    const pts = [base.clone().addScaledVector(d, -r0), base, base.clone().addScaledVector(d, len * 0.4).addScaledVector(bend, len * 0.05), base.clone().addScaledVector(d, len * 0.75).addScaledVector(bend, len * 0.2), base.clone().addScaledVector(d, len).addScaledVector(bend, len * 0.42)];
    const tine = new Tube(pts, (t, dd, c) => (r0 * Math.pow(1 - t, 0.9) + 0.0015) * knob(dd, c), { seg: 14 });
    add(tine.mesh(7));
    if (len > 0.24) {    // a fork near the top of the long tines
      const fb = tine.curve.getPointAt(0.55), fd = d.clone().add(V(s * 0.6, 0.2, -0.3)).normalize();
      add(hornGeo(fb, fd, len * 0.38, r0 * 0.45, V(0, 1, 0), { seg: 8, radial: 6, pow: 0.9 }));
    }
  }
}

function buildArm(skinB, boneB, S, s, R) {
  const armR = table([[2.02, 0.06], [1.99, 0.085], [1.9, 0.075], [1.75, 0.056], [1.6, 0.048], [1.47, 0.044], [1.42, 0.047], [1.36, 0.05], [1.25, 0.044], [1.1, 0.035], [0.95, 0.029], [0.87, 0.028], [0.83, 0.028]]);
  const pts = [V(s * 0.17, 1.99, 0), JP('upper' + S), V(s * 0.345, 1.71, -0.04), JP('fore' + S), V(s * 0.42, 1.14, -0.03), JP('hand' + S), V(s * 0.448, 0.83, 0.01)];
  const arm = new Tube(pts, (t, d, c) => {
    const back = -d.z, out = s * d.x;
    let r = armR(c.y);
    r += 0.03 * gauss((c.y - 1.43) / 0.035) * Math.pow(Math.max(0, back), 2);                // elbow point
    r += 0.012 * gauss((c.y - 1.74) / 0.12) * Math.pow(Math.max(0, d.z), 2);                 // biceps
    r += 0.01 * gauss((c.y - 1.12) / 0.2) * Math.pow(Math.max(0, back * 0.7 + out * 0.7), 3); // ulna ridge
    return r * Math.sqrt(1 - Math.pow(sstep(0.86, 1, t), 2) * 0.85);
  }, { seg: 56, up: V(0, 0, 1) });
  const armW = (p) => chainWeights(p, CH['arm' + S], 0.06);
  const g = arm.mesh(18); noisify(g, 0.003, 14, s * 3);
  skinB.add(g, { w: armW, col: (p) => mixc(skinBase(p), PAL.skinDark, 0.3 * gauss((p.y - 1.42) / 0.05)) });
  // palm
  const palm = new Tube([V(s * 0.445, 0.91, 0.01), JP('hand' + S), V(s * 0.452, 0.79, 0.004), V(s * 0.456, 0.712, 0)], (t, d) => {
    const rz = lerp(0.036, 0.066, sstep(0, 0.75, t)), rx = lerp(0.03, 0.024, t);
    return 1 / Math.hypot(d.x / rx, d.z / rz);
  }, { seg: 12, up: V(0, 0, 1) });
  const pg = palm.mesh(14); noisify(pg, 0.002, 30, s);
  skinB.add(pg, { w: armW, col: (p) => mixc(skinBase(p), PAL.skinDark, 0.4) });
  // fingers + claws
  for (let i = 0; i < 5; i++) {
    const d = fingerDir(s, i), a = JP(`f${i}a${S}`), b = JP(`f${i}b${S}`), tip = fingerTip(s, i), thumb = i === 4;
    const r0 = thumb ? 0.02 : 0.017;
    const fp = [a.clone().addScaledVector(d, -0.03), a, a.clone().lerp(b, 0.5), b, b.clone().lerp(tip, 0.5), tip];
    const fw = (p) => chainWeights(p, CH[`f${i}${S}`], 0.02);
    const finger = new Tube(fp, (t, dd, c) => lerp(r0, r0 * 0.68, t) + 0.0045 * (gauss(c.distanceTo(a) / 0.016) + gauss(c.distanceTo(b) / 0.014)) * Math.max(0.2, s * dd.x), { seg: 20 });
    const fg = finger.mesh(8);
    skinB.add(fg, { w: fw, col: (p) => mixc(skinBase(p), PAL.skinDark, 0.35) });
    const med = V(-s, 0, 0);
    const cp = [tip.clone().addScaledVector(d, -0.03), tip.clone(), tip.clone().addScaledVector(d, 0.07).addScaledVector(med, 0.01), tip.clone().addScaledVector(d, 0.13).addScaledVector(med, 0.035), tip.clone().addScaledVector(d, 0.165).addScaledVector(med, 0.075)];
    const cr = r0 * 0.78;
    const claw = new Tube(cp, (t) => cr * Math.pow(1 - t, 0.85) + 0.0008, { seg: 14 });
    const cg = claw.mesh(7);
    boneB.add(cg, { w: BI[`f${i}b${S}`], col: (p, n, k) => mixc(PAL.claw, PAL.clawTip, sstep(0.3, 1, cg.userData.t[k])) });
    if (i === 1 || i === 3) addDrip(skinB, cp[3].clone(), 0.08 + 0.12 * R(), 0.004, BI[`f${i}b${S}`], R);
  }
  // forearm blades + elbow spike
  const ys = [1.34, 1.23, 1.12, 1.01, 0.92];
  ys.forEach((y, k) => {
    const c = V(lerp(JP('fore' + S).x, JP('hand' + S).x, (1.42 - y) / 0.55), y, lerp(JP('fore' + S).z, JP('hand' + S).z, (1.42 - y) / 0.55));
    const out = V(s * 0.7, 0, -0.7).normalize(), base = c.clone().addScaledVector(out, armR(y) * 0.8);
    const len = 0.13 - k * 0.018 + 0.02 * R();
    const g = hornGeo(base, V(s * 0.55, 0.8, -0.65), len, 0.011, V(0, 0.6, 0.2), { seg: 6, radial: 5 });
    boneB.add(g, { w: armW(base), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g.userData.t[i]) });
  });
  {
    const base = JP('fore' + S).clone().add(V(0, 0.01, -0.06));
    const g = hornGeo(base, V(s * 0.2, 0.45, -1), 0.17, 0.016, V(0, 1, 0), { seg: 7, radial: 6 });
    boneB.add(g, { w: armW(base), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g.userData.t[i]) });
  }
  void R;
}

function buildLeg(skinB, boneB, S, s, R) {
  const sock = JP('thigh' + S), knee = JP('shin' + S), hock = JP('meta' + S), ball = JP('toe' + S);
  const pts = [V(s * 0.08, 1.12, 0), sock, V(s * 0.17, 0.86, 0.12), knee, V(s * 0.18, 0.47, 0.06), hock, V(s * 0.18, 0.18, -0.03), ball, V(s * 0.18, 0.05, 0.075)];
  const leg = new Tube(pts, (t, d, c) => {
    const dk = c.distanceTo(knee), dh = c.distanceTo(hock), dsk = c.distanceTo(sock), db = c.distanceTo(ball);
    // base radius by which bone we are on
    let r;
    if (c.y > knee.y + 0.02 && dsk < 0.47) r = lerp(0.1, 0.06, sstep(0.05, 0.4, dsk));                 // thigh
    else if (c.y > hock.y) r = lerp(0.058, 0.036, sstep(0.03, 0.4, dk));                               // shin
    else r = lerp(0.034, 0.03, sstep(0.03, 0.2, dh));                                                    // metatarsus
    r += 0.02 * gauss((c.y - 0.86) / 0.13) * Math.max(0, d.z) * sstep(0.6, 0.8, c.y);                  // quads
    r += 0.016 * gauss(dk / 0.03) * Math.pow(Math.max(0, d.z), 2);                                      // kneecap
    r += 0.022 * gauss((c.y - 0.55) / 0.06) * Math.max(0, -d.z) * sstep(0.62, 0.5, c.y);              // calf
    r += 0.026 * gauss(dh / 0.03) * Math.pow(Math.max(0, -d.z), 2);                                     // hock point
    r += 0.006 * gauss(db / 0.02);
    return r;
  }, { seg: 64, up: V(0, 0, 1) });
  const legW = (p) => chainWeights(p, CH['leg' + S], 0.06);
  const g = leg.mesh(18); noisify(g, 0.003, 14, s * 5);
  skinB.add(g, { w: legW, col: (p) => mixc(skinBase(p), PAL.skinDark, 0.25 + 0.4 * sstep(0.3, 0.1, p.y)) });
  // toes: three forward, one back
  const toeDirs = [[-0.42, 0.13], [0, 0.15], [0.42, 0.13], [Math.PI, 0.06]];
  for (const [yaw, len] of toeDirs) {
    const d = V(Math.sin(yaw * s) * 1, 0, Math.cos(yaw * s)).normalize();
    const b0 = ball.clone().add(V(0, -0.01, 0)), tip = b0.clone().addScaledVector(d, len).add(V(0, -0.03, 0));
    const tp = [b0.clone().addScaledVector(d, -0.02), b0, b0.clone().addScaledVector(d, len * 0.5).add(V(0, 0.005, 0)), tip];
    const tw = (p) => chainWeights(p, CH['leg' + S], 0.03);
    const tg = new Tube(tp, (t) => lerp(0.026, 0.014, t) * (yaw === Math.PI ? 0.7 : 1), { seg: 10 }).mesh(8);
    skinB.add(tg, { w: tw, col: () => PAL.hoof });
    const cp = [tip.clone().addScaledVector(d, -0.015), tip.clone(), tip.clone().addScaledVector(d, 0.04).add(V(0, -0.004, 0)), tip.clone().addScaledVector(d, 0.07).add(V(0, -0.035, 0))];
    const cg = new Tube(cp, (t) => 0.014 * (yaw === Math.PI ? 0.7 : 1) * Math.pow(1 - t, 0.8) + 0.0008, { seg: 10 }).mesh(7);
    boneB.add(cg, { w: BI['toe' + S], col: (p, n, k) => mixc(PAL.claw, PAL.clawTip, sstep(0.3, 1, cg.userData.t[k])) });
  }
  void R;
}

function buildTail(skinB, boneB, R) {
  const tail = new Tube(TAIL_PTS, (t, d) => lerp(0.068, 0.011, Math.pow(t, 0.75)) * (1 + 0.1 * Math.max(0, d.y)) * Math.sqrt(1 - Math.pow(t, 16)), { seg: 80, up: V(0, 1, 0) });
  const tw = (p) => chainWeights(p, CH.tail, 0.05);
  const g = tail.mesh(12); noisify(g, 0.002, 18, 11);
  skinB.add(g, { w: tw, col: (p) => mixc(skinBase(p), PAL.skinDark, 0.25) });
  // dorsal spikes, then paired barbs toward the tip (fishbone like the reference)
  const X = V(1, 0, 0);
  for (let t = 0.04; t < 0.98; t += 0.032) {
    const c = tail.curve.getPointAt(t), T = tail.curve.getTangentAt(t).normalize();
    const dors = X.clone().cross(T).normalize(), side = T.clone().cross(dors).normalize();
    const r = lerp(0.068, 0.011, Math.pow(t, 0.75));
    if (t < 0.45) {
      const base = c.clone().addScaledVector(dors, r * 0.8);
      const g2 = hornGeo(base, dors.clone().addScaledVector(T, 0.9), 0.04 + 0.03 * R(), 0.009, T, { seg: 4, radial: 5 });
      boneB.add(g2, { w: tw(base), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g2.userData.t[i]) });
    } else {
      const len = (0.05 + 0.1 * sstep(0.45, 0.85, t)) * (1 - 0.5 * sstep(0.9, 0.98, t));
      for (const sd of [1, -1]) {
        const dir = dors.clone().multiplyScalar(0.35).addScaledVector(side, sd * 0.9).addScaledVector(T, 0.75);
        const base = c.clone().addScaledVector(dir.clone().normalize(), r * 0.7);
        const g2 = hornGeo(base, dir, len * (0.85 + 0.3 * R()), 0.008, T.clone().addScaledVector(dors, -0.3), { seg: 5, radial: 5 });
        boneB.add(g2, { w: tw(base), col: (p, n, i) => mixc(PAL.boneDirt, PAL.bone, g2.userData.t[i]) });
      }
    }
  }
}

/* ---- fur: three-sided quills written straight into the fur bucket */
function quill(B, root, n, dir, len, ws, colRoot, colTip, droop = 0.2) {
  if (!Number.isFinite(root.x + root.y + root.z + dir.x + dir.y + dir.z + n.x + n.y + n.z + len)) { console.error('NaN quill', root.toArray(), dir.toArray(), n.toArray(), len); return; }
  const T = dir.clone().normalize();
  const U =(Math.abs(T.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0)).cross(T).normalize(), W = T.clone().cross(U);
  const r0 = len * 0.045 + 0.0025, g = V(0, -droop * len, 0);
  const mid = root.clone().addScaledVector(T, len * 0.5).addScaledVector(g, 0.25), tip = root.clone().addScaledVector(T, len).add(g);
  const nn = new V3(), pp = new V3(), base = B.n, colMid = mixc(colRoot, colTip, 0.5);
  for (const [c, r, col, f] of [[root, r0, colRoot, 0], [mid, r0 * 0.55, colMid, 0.5]]) {
    for (let k = 0; k < 3; k++) {
      const a = k / 3 * TAU, rad = U.clone().multiplyScalar(Math.cos(a)).addScaledVector(W, Math.sin(a));
      pp.copy(c).addScaledVector(rad, r); nn.copy(n).multiplyScalar(0.8).addScaledVector(rad, 0.45).normalize();
      B.vert(pp, nn, col, ws, null, f);
    }
  }
  B.vert(tip, n, colTip, ws, null, 1);
  for (let k = 0; k < 3; k++) {
    const k1 = (k + 1) % 3, a0 = base + k, a1 = base + k1, b0 = base + 3 + k, b1 = base + 3 + k1;
    B.I.push(a0, a1, b0, a1, b1, b0, b0, b1, base + 6);
  }
}
function buildFur(B, neck, R) {
  const up = V(0, 1, 0), back = V(0, 0, -1), down = V(0, -1, 0);
  const rnd3 = (k) => V((R() - 0.5) * k, (R() - 0.5) * k, (R() - 0.5) * k);
  const tipCol = () => mixc(PAL.furTip, PAL.furTip2, R());
  const p = new V3(), p2 = new V3(), p3 = new V3();
  // torso: mane, back, loin fringe
  let placed = 0;
  for (let tries = 0; tries < 30000 && placed < 1250; tries++) {
    const y = lerp(1.0, 2.15, R()), th = (R() * 2 - 1) * Math.PI;
    const f = 1 - Math.abs(th) / Math.PI;
    const mane = sstep(1.74, 1.9, y) * (f < 0.62 ? 1 : 0.4 * sstep(1.97, 2.06, y));
    const backD = sstep(1.25, 1.75, y) * (1 - sstep(0.22, 0.42, f)) * 0.7;
    const loin = gauss((y - 1.07) / 0.07) * (Math.abs(th) > 0.35 ? 0.9 : 0.45);
    const dens = Math.max(mane, backD, loin);
    if (R() > dens) continue;
    torsoPoint(y, th, p); torsoPoint(y + 0.01, th, p2); torsoPoint(y, th + 0.01, p3);
    const n = p3.clone().sub(p).cross(p2.clone().sub(p)).normalize();
    if (n.dot(V(p.x, 0, p.z - TZC(y))) < 0) n.negate();
    let dir, len, droop = 0.15;
    if (mane >= backD && mane >= loin) {
      dir = n.clone().multiplyScalar(0.75).addScaledVector(up, 0.45).addScaledVector(back, 0.5).add(rnd3(0.5));
      len = (0.1 + 0.14 * R()) * (1 + 0.8 * gauss((y - 1.98) / 0.1));
    } else if (backD >= loin) {
      dir = n.clone().multiplyScalar(0.6).addScaledVector(down, 0.35).addScaledVector(back, 0.3).add(rnd3(0.4));
      len = 0.05 + 0.07 * R();
    } else {
      dir = n.clone().multiplyScalar(0.3).addScaledVector(down, 1).add(rnd3(0.3));
      len = 0.12 + 0.2 * R(); droop = 0.05;
    }
    quill(B, p.clone().addScaledVector(n, -0.004), n, dir, len, normW(torsoW(p)), PAL.furRoot, tipCol(), droop);
    placed++;
  }
  // neck
  for (let k = 0; k < 280; k++) {
    const t = R() * 0.82, ang = R() * TAU, s = neck.at(t, ang);
    if (s.d.z > 0.55 && R() < 0.8) continue;
    const dir = s.d.clone().multiplyScalar(0.7).addScaledVector(up, 0.3).addScaledVector(back, 0.5).add(rnd3(0.4));
    quill(B, s.p.clone().addScaledVector(s.d, -0.004), s.d, dir, 0.11 + 0.13 * R(), normW(chainWeights(s.p, CH.spine, 0.06)), PAL.furRoot, tipCol(), 0.15);
  }
  // arms: shaggy upper arms and a spiky fringe behind the forearms
  for (const [S, s] of SIDES) {
    const armW = (q) => normW(chainWeights(q, CH['arm' + S], 0.06));
    for (let k = 0; k < 170; k++) {
      const y = lerp(1.97, 1.5, R()), ang = R() * TAU;
      const c = JP('upper' + S).clone().lerp(JP('fore' + S), (1.99 - y) / 0.57);
      const d = V(Math.sin(ang), 0, Math.cos(ang)), o = s * d.x - d.z;
      if (o < -0.3) continue;
      const root = c.clone().addScaledVector(d, 0.05);
      const dir = d.clone().multiplyScalar(0.6).addScaledVector(down, 0.6).addScaledVector(back, 0.3).add(rnd3(0.4));
      quill(B, root, d, dir, 0.07 + 0.09 * R(), armW(root), PAL.furRoot, tipCol(), 0.2);
    }
    for (let k = 0; k < 150; k++) {
      const y = lerp(1.38, 0.98, R()), ang = R() * TAU;
      const c = JP('fore' + S).clone().lerp(JP('hand' + S), (1.42 - y) / 0.55);
      const d = V(Math.sin(ang), 0, Math.cos(ang)), o = s * d.x * 0.7 - d.z * 0.7;
      if (o < 0.1) continue;
      const root = c.clone().addScaledVector(d, 0.04);
      const dir = d.clone().multiplyScalar(0.8).addScaledVector(back, 0.4).addScaledVector(up, 0.25).add(rnd3(0.4));
      quill(B, root, d, dir, 0.06 + 0.08 * R(), armW(root), PAL.furRoot, tipCol(), 0.1);
    }
    // thighs: ragged strands hanging from the hips
    for (let k = 0; k < 90; k++) {
      const y = lerp(1.04, 0.8, R()), ang = R() * TAU;
      const c = JP('thigh' + S).clone().lerp(JP('shin' + S), (1.04 - y) / 0.4);
      const d = V(Math.sin(ang), 0, Math.cos(ang)), o = s * d.x - d.z * 0.6;
      if (o < 0) continue;
      const root = c.clone().addScaledVector(d, 0.07);
      const dir = d.clone().multiplyScalar(0.3).addScaledVector(down, 1).add(rnd3(0.3));
      quill(B, root, d, dir, 0.1 + 0.12 * R(), normW(chainWeights(root, CH['leg' + S], 0.06)), PAL.furRoot, tipCol(), 0.05);
    }
  }
}

/* ================================================================ poses */
const SIDE_CH = ['clz', 'cly', 'shx', 'shy', 'shz', 'el', 'wrx', 'wrz', 'curl', 'fx', 'fy', 'fz', 'tilt', 'toe'];
const BASE_CH = ['hx', 'hy', 'hz', 'hrx', 'hry', 'hrz', 's1x', 's1y', 's1z', 's2x', 's2y', 's2z', 'chx', 'chy', 'chz',
  'n1x', 'n1y', 'n1z', 'n2x', 'n2y', 'n2z', 'hdx', 'hdy', 'hdz', 'jaw', 'breath', 'twitch', 'fidget', 'lookW', 'ground',
  'furAmp', 'tp', 'ty', 'tamp', 'tfreq', 'tcurl', 'shake'];
const CHANNELS = [...BASE_CH, ...SIDE_CH.flatMap(c => [c + 'L', c + 'R'])];
/** expand side-less keys ({shx: 1}) to both sides; keep the rest */
function sym(o) {
  const r = {};
  for (const k in o) { if (SIDE_CH.includes(k)) { r[k + 'L'] = o[k]; r[k + 'R'] = o[k]; } else r[k] = o[k]; }
  return r;
}
const pose = (base, o) => Object.assign({}, base, sym(o));
const STAND = (() => {
  const p = {}; for (const c of CHANNELS) p[c] = 0;
  return Object.assign(p, sym({ breath: 0.35, twitch: 0.12, fidget: 0.3, lookW: 1, ground: 1, furAmp: 0.6, tamp: 0.05, tfreq: 0.6, tp: 0.05, curl: 0.3, shz: 0.06, fy: 0.06, fz: 0.04, tilt: BIND_TILT }), { fxL: 0.18, fxR: -0.18 });
})();
const IDLE = pose(STAND, {
  hy: -0.07, hrx: 0.12, s1x: 0.1, s2x: 0.12, chx: 0.16, n1x: -0.06, n2x: -0.12, hdx: -0.14,
  shx: 0.12, el: 0.32, shz: 0.13, curl: 0.35, wrx: 0.1, jaw: 0.06,
  twitch: 1, fidget: 1, breath: 1, tp: 0.12, tamp: 0.1, furAmp: 0.8,
  fxL: 0.2, fzL: 0.1, fxR: -0.2, fzR: -0.06, tilt: BIND_TILT + 0.12,
});
const CROUCH = pose(IDLE, {
  hy: -0.42, hrx: 0.55, s1x: 0.22, s2x: 0.22, chx: 0.22, n1x: -0.45, n2x: -0.35, hdx: -0.22,
  shx: 0.5, el: 0.45, shz: 0.2, curl: 0.45, tilt: 1.0, fxL: 0.23, fzL: 0.14, fxR: -0.23, fzR: -0.02,
  tp: 0.0, tamp: 0.06, breath: 0.8, twitch: 1.2, jaw: 0.1,
});
const STAND_STILL = pose(STAND, { breath: 0.4, twitch: 0.08, fidget: 0.15, jaw: 0.03, hdx: -0.05, curl: 0.4, el: 0.1, shz: 0.08 });

const EASE = {
  io: (u) => u * u * (3 - 2 * u), in: (u) => u * u * u, out: (u) => 1 - Math.pow(1 - u, 3), lin: (u) => u,
};
/** keyframed one-shot: keys = [[time, channels, ease], ...]; missing channels fall back to base */
function keyed(t, base, keys) {
  const K0 = keys[0];
  if (t <= K0[0]) return pose(base, K0[1]);
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b, ease] = keys[i + 1];
    if (t < t1) {
      const u = (EASE[ease] || EASE.io)((t - t0) / (t1 - t0)), A = sym(a), B = sym(b), out = Object.assign({}, base);
      const keysU = new Set([...Object.keys(A), ...Object.keys(B)]);
      for (const k of keysU) out[k] = lerp(A[k] ?? base[k], B[k] ?? base[k], u);
      return out;
    }
  }
  return pose(base, keys[keys.length - 1][1]);
}

/* one-shot animations, authored as keyframes over IDLE */
const SEQ = {
  swipe: { base: IDLE, keys: [
    [0, {}],
    [0.55, { hy: -0.14, s1y: -0.18, s2y: -0.2, chy: -0.28, chx: 0.08, hdy: 0.2, shzR: 1.35, shyR: -0.7, shxR: 0.1, elR: 0.5, curlR: 0.05, wrxR: -0.2, shxL: 0.3, shzL: 0.45, elL: 0.5, fxL: 0.26, fzL: 0.22, fxR: -0.27, fzR: -0.16, jaw: 0.35 }, 'io'],
    [0.95, { hy: -0.26, hrx: 0.3, s1x: 0.25, s2x: 0.25, s1y: 0.12, s2y: 0.18, chy: 0.26, chx: 0.25, hdy: -0.2, shzR: 0.85, shyR: 1.0, shxR: 0.55, elR: 0.08, curlR: 0.1, wrxR: 0.2, shxL: -0.1, shzL: 0.5, elL: 0.6, fxL: 0.26, fzL: 0.22, fxR: -0.27, fzR: -0.16, jaw: 0.6 }, 'in'],
    [1.2, { hy: -0.24, hrx: 0.28, s1x: 0.22, s2x: 0.22, s1y: 0.2, s2y: 0.25, chy: 0.35, chx: 0.22, shzR: 0.75, shyR: 1.55, shxR: 0.6, elR: 0.25, curlR: 0.5, shzL: 0.45, elL: 0.6, fxL: 0.26, fzL: 0.22, fxR: -0.27, fzR: -0.16, jaw: 0.4 }, 'out'],
    [1.7, {}, 'io'],
  ] },
  stomp: { base: IDLE, keys: [
    [0, {}],
    [0.62, { hy: -0.02, hx: 0.06, hrz: -0.08, hrx: 0.02, s1x: 0.02, chx: 0.04, hdx: 0.25, jaw: 0.35, shz: 0.75, shx: 0.25, el: 0.6, curl: 0.05, fxR: -0.2, fyR: 0.72, fzR: 0.36, tiltR: 1.3, toeR: 0.5, fxL: 0.2, fzL: 0.02 }, 'io'],
    [0.9, { hy: -0.2, hx: 0.03, hrx: 0.28, s1x: 0.2, chx: 0.26, hdx: 0.25, jaw: 0.6, shz: 0.35, shx: 0.35, el: 0.4, curl: 0.2, fxR: -0.2, fyR: 0.06, fzR: 0.42, tiltR: 0.55, toeR: 0, fxL: 0.2, fzL: 0.02 }, 'in'],
    [1.06, { hy: -0.25, hrx: 0.3, s1x: 0.24, chx: 0.3, hdx: 0.3, jaw: 0.5, shz: 0.3, shx: 0.3, el: 0.5, fxR: -0.2, fyR: 0.06, fzR: 0.42, tiltR: 0.6, fxL: 0.2, fzL: 0.02 }, 'out'],
    [1.32, { fxR: -0.2, fyR: 0.16, fzR: 0.2, tiltR: 0.9 }, 'io'],
    [1.6, {}, 'io'],
  ] },
  grab: { base: IDLE, keys: [
    [0, {}],
    [0.35, { hy: -0.13, chx: 0.06, hrx: 0.06, shxR: 0.35, shzR: 0.35, elR: 1.0, curlR: 0, jaw: 0.35, hdx: -0.2, n2x: -0.2, fzL: 0.0 }, 'io'],
    [0.8, { hz: 0.28, hy: -0.32, hrx: 0.5, s1x: 0.25, s2x: 0.3, chx: 0.3, n1x: -0.35, n2x: -0.25, hdx: -0.1, shxR: 0.45, shzR: 0.12, shyR: 0.3, elR: 0.0, wrxR: 0.4, curlR: 0.05, shzL: 0.55, shxL: -0.2, elL: 0.6, jaw: 0.7, fxL: 0.2, fzL: -0.3, fxR: -0.22, fzR: 0.5, tiltL: 1.0 }, 'in'],
    [1.0, { hz: 0.28, hy: -0.32, hrx: 0.5, s1x: 0.25, s2x: 0.3, chx: 0.3, n1x: -0.35, n2x: -0.25, shxR: 0.45, shzR: 0.12, shyR: 0.3, elR: 0.08, wrxR: 0.4, curlR: 1.0, shzL: 0.55, shxL: -0.2, elL: 0.6, jaw: 0.45, fxL: 0.2, fzL: -0.3, fxR: -0.22, fzR: 0.5, tiltL: 1.0 }, 'out'],
    [1.55, { hz: 0.1, hy: -0.12, hrx: 0.15, s1x: 0.1, chx: 0.12, shxR: 1.2, shzR: 0.25, shyR: 0.2, elR: 1.3, curlR: 1.0, wrxR: 0.2, jaw: 0.3, fxL: 0.2, fzL: -0.1, fxR: -0.2, fzR: 0.25 }, 'io'],
    [2.2, { shxR: 0.75, shzR: 0.25, elR: 1.6, curlR: 1.0, jaw: 0.15, fzR: 0.1 }, 'io'],
  ] },
  throw: { base: IDLE, keys: [
    [0, {}],
    [0.6, { hy: -0.36, hrx: 0.45, s1x: 0.25, s2x: 0.25, chx: 0.28, n1x: -0.2, shx: 0.55, shz: 0.22, el: 0.15, curl: 0.1, jaw: 0.25, fxL: 0.24, fzL: 0.12, fxR: -0.24, fzR: 0.0, tilt: 0.9 }, 'io'],
    [0.82, { hy: -0.38, hrx: 0.45, s1x: 0.25, s2x: 0.25, chx: 0.28, n1x: -0.2, shx: 0.55, shz: 0.22, el: 0.2, curl: 0.95, jaw: 0.25, fxL: 0.24, fzL: 0.12, fxR: -0.24, fzR: 0.0, tilt: 0.9 }, 'io'],
    [1.25, { hy: 0.0, hrx: -0.08, s1x: -0.1, s2x: -0.15, chx: -0.2, n1x: -0.1, n2x: -0.15, hdx: -0.3, shx: 2.85, shz: 0.28, el: 0.55, curl: 0.95, jaw: 0.55, fxL: 0.22, fzL: 0.1, fxR: -0.22, fzR: -0.12 }, 'io'],
    [1.5, { hz: 0.16, hy: -0.16, hrx: 0.38, s1x: 0.3, s2x: 0.3, chx: 0.32, hdx: 0.0, shx: 1.25, shz: 0.2, el: 0.1, curl: 0.0, jaw: 0.85, fxL: 0.22, fzL: 0.1, fxR: -0.22, fzR: 0.38 }, 'in'],
    [1.85, { hz: 0.12, hy: -0.18, hrx: 0.38, s1x: 0.3, chx: 0.42, shx: 0.55, shz: 0.25, el: 0.3, curl: 0.2, jaw: 0.5, fxL: 0.22, fzL: 0.1, fxR: -0.22, fzR: 0.38 }, 'out'],
    [2.4, { fzR: 0.1 }, 'io'],
  ] },
  roar: { base: IDLE, keys: [
    [0, {}],
    [0.55, { hy: -0.03, hrx: 0.0, s1x: -0.02, s2x: -0.1, chx: -0.18, n1x: -0.45, n2x: -0.45, hdx: -0.5, jaw: 0.55, shz: 1.1, shy: -0.35, shx: 0.15, el: 0.45, curl: 0.0, tp: 0.4, fxL: 0.24, fzL: 0.14, fxR: -0.24, fzR: -0.08 }, 'io'],
    [0.9, { hy: -0.16, hrx: 0.28, s1x: 0.16, s2x: 0.25, chx: 0.32, n1x: 0.08, n2x: 0.05, hdx: -0.05, jaw: 0.9, shz: 1.2, shy: 0.35, shx: 0.55, el: 0.35, curl: 0.0, wrx: -0.3, tp: 0.5, tamp: 0.4, tfreq: 3, shake: 1, furAmp: 3, fxL: 0.24, fzL: 0.14, fxR: -0.24, fzR: -0.08 }, 'out'],
    [2.3, { hy: -0.18, hrx: 0.3, s1x: 0.18, s2x: 0.26, chx: 0.34, n1x: 0.1, n2x: 0.06, hdx: -0.02, jaw: 0.85, shz: 1.15, shy: 0.4, shx: 0.6, el: 0.4, curl: 0.05, wrx: -0.3, tp: 0.5, tamp: 0.4, tfreq: 3, shake: 1, furAmp: 3, fxL: 0.24, fzL: 0.14, fxR: -0.24, fzR: -0.08 }, 'lin'],
    [3.0, {}, 'io'],
  ] },
  hurt: { base: IDLE, keys: [
    [0, {}],
    [0.12, { hz: -0.1, hy: -0.1, hrx: -0.04, s2x: -0.08, chx: -0.25, n2y: 0.3, hdx: -0.45, hdz: 0.35, jaw: 0.65, shx: 0.6, el: 1.2, curl: 0.85, shz: 0.0, lookW: 0.2, twitch: 0, tp: 0.4 }, 'out'],
    [0.45, { hz: -0.06, hy: -0.12, chx: 0.0, n2y: 0.15, hdx: -0.15, hdz: 0.15, jaw: 0.35, shx: 0.25, el: 0.8, curl: 0.6, lookW: 0.5, twitch: 0 }, 'io'],
    [1.0, {}, 'io'],
  ] },
  death: { base: IDLE, keys: [
    [0, {}],
    [0.35, { hz: -0.08, chx: -0.22, hdx: -0.5, hdz: 0.3, jaw: 0.85, shz: 0.6, el: 0.9, curl: 0.8, lookW: 0, twitch: 0, fidget: 0, breath: 0.3 }, 'out'],
    [1.0, { hx: 0.12, hrz: 0.14, hy: -0.12, s1z: -0.2, chz: -0.15, chx: 0.1, hdx: 0.3, hdz: -0.3, jaw: 0.5, shz: 0.35, shx: 0.1, el: 0.4, curl: 0.5, fxL: 0.34, fzL: 0.05, lookW: 0, twitch: 0, fidget: 0, breath: 0.3 }, 'io'],
    [1.5, { hx: -0.06, hrz: -0.1, hy: -0.16, s1z: 0.15, chz: 0.12, chx: 0.18, hdx: 0.4, hdz: 0.25, jaw: 0.45, shz: 0.2, shx: 0.0, el: 0.3, curl: 0.4, fxL: 0.3, fzL: -0.06, fxR: -0.3, fzR: 0.12, lookW: 0, twitch: 0, fidget: 0, breath: 0.2 }, 'io'],
    [2.3, { hy: -0.64, hrx: 0.18, s1x: 0.22, s2x: 0.1, chx: 0.18, hdx: 0.5, jaw: 0.4, shz: 0.15, shx: 0.1, el: 0.1, curl: 0.3, fxL: 0.2, fyL: 0.06, fzL: -0.55, tiltL: -1.42, toeL: -0.2, fxR: -0.2, fyR: 0.06, fzR: -0.55, tiltR: -1.42, toeR: -0.2, ground: 0.4, lookW: 0, twitch: 0, fidget: 0, breath: 0.2, tp: 0, tamp: 0.02 }, 'in'],
    [3.0, { hy: -0.62, hrx: 0.24, s1x: 0.26, s2x: 0.12, chx: 0.2, hdx: 0.6, hdz: 0.2, jaw: 0.3, shz: 0.1, shx: 0.12, el: 0.1, curl: 0.3, fxL: 0.2, fyL: 0.06, fzL: -0.55, tiltL: -1.42, toeL: -0.2, fxR: -0.2, fyR: 0.06, fzR: -0.55, tiltR: -1.42, toeR: -0.2, ground: 0.4, lookW: 0, twitch: 0, fidget: 0, breath: 0.1, tp: 0, tamp: 0.02 }, 'io'],
    [3.8, DEAD_KEY(), 'in'],
    [4.2, DEAD_KEY({ hy: -0.86 }), 'out'],
    [6.0, DEAD_KEY(), 'io'],
  ] },
  lookDown: { base: STAND_STILL, keys: [
    [0, {}],
    [1.5, { hy: -0.06, hrx: 0.06, s2x: 0.1, chx: 0.22, n1x: 0.5, n2x: 0.45, hdx: 0.45, shx: 0.05, el: 0.15, lookW: 0, twitch: 0.5 }, 'io'],
    [2.6, { hy: -0.07, hrx: 0.06, s2x: 0.12, chx: 0.24, n1x: 0.52, n2x: 0.48, hdx: 0.5, hdz: 0.35, shx: 0.05, el: 0.2, lookW: 0, twitch: 0.6 }, 'io'],
    [3.3, { hy: -0.08, hrx: 0.08, s2x: 0.14, chx: 0.26, n1x: 0.55, n2x: 0.5, hdx: 0.55, hdz: -0.12, shx: 0.08, el: 0.25, lookW: 0, twitch: 0.8, jaw: 0.15 }, 'io'],
    [4.0, { hy: -0.08, hrx: 0.08, s2x: 0.14, chx: 0.26, n1x: 0.55, n2x: 0.5, hdx: 0.55, hdz: -0.05, shx: 0.08, el: 0.25, lookW: 0, twitch: 0.8, jaw: 0.1 }, 'io'],
  ] },
  emerge: { base: STAND_STILL, keys: [
    [0, diffFrom(CROUCH, STAND_STILL)],
    [1.2, { hy: -0.12, hrx: 0.15, s1x: 0.05, s2x: 0.0, chx: -0.05, n1x: -0.2, n2x: -0.15, hdx: -0.2, shz: 0.35, shx: -0.05, el: 0.35, curl: 0.1, jaw: 0.3 }, 'io'],
    [2.0, {}, 'io'],
  ] },
};
/** the face-down end pose of the death */
function DEAD_KEY(o = {}) {
  return Object.assign({
    hz: 0.32, hy: -0.84, hrx: 1.38, hrz: 0.12, s1x: 0.08, s2x: 0.06, chx: 0.06, n1x: -0.3, n2x: -0.1, hdx: 0.0, hdy: 0.7, hdz: 0.4, jaw: 0.35,
    shxL: 1.3, shzL: 0.35, elL: 0.5, shxR: 0.5, shzR: 0.45, elR: 0.3, curl: 0.55,
    fxL: 0.26, fyL: 0.12, fzL: -0.6, tiltL: -1.3, fxR: -0.2, fyR: 0.1, fzR: -0.68, tiltR: -1.35, toe: 0.4,
    ground: 0, lookW: 0, twitch: 0, fidget: 0, breath: 0, tp: -1.15, tamp: 0, furAmp: 0.2,
  }, o);
}
/** keyframe channels that turn `base` into `target` */
function diffFrom(target, base) { const o = {}; for (const k of CHANNELS) if (target[k] !== base[k]) o[k] = target[k]; return o; }

/* events that one-shots emit: [time, foot, force] (foot 'B' = body hits the ground, reported as 'R' at the chest) */
const SEQ_EVENTS = { stomp: [[0.9, 'R', 1]], death: [[2.3, 'L', 0.6], [2.32, 'R', 0.6], [3.8, 'B', 1]], throw: [[1.5, 'R', 0.5]], grab: [[0.8, 'R', 0.5]] };

/* gaits share one phase so walk/run/stalk blend without foot sliding */
const GAIT = {
  walk: { duty: 0.6, lift: 0.17, tuck: 0.55, bob: 0.025, width: 0.17, zc: 0.03, arm: 0.35, base: pose(IDLE, { hy: -0.06, twitch: 0.4, fidget: 0.3, tamp: 0.12, tfreq: 1.2 }) },
  run: { duty: 0.36, lift: 0.3, tuck: 1.1, bob: 0.05, width: 0.14, zc: 0.12, arm: 0.95, base: pose(IDLE, { hy: -0.12, hrx: 0.38, s1x: 0.16, s2x: 0.18, chx: 0.16, n1x: -0.3, n2x: -0.25, hdx: -0.26, jaw: 0.25, tp: 0.55, tamp: 0.15, tfreq: 2.5, furAmp: 2.2, shx: -0.45, el: 0.75, curl: 0.5, twitch: 0, fidget: 0, breath: 0.5 }) },
  stalk: { duty: 0.74, lift: 0.1, tuck: 0.4, bob: 0.012, width: 0.2, zc: 0.02, arm: 0.2, base: pose(CROUCH, { hy: -0.34, hrx: 0.48, n1x: -0.42, n2x: -0.32, hdx: -0.2, shx: 0.35, el: 0.5, tilt: 0.85, twitch: 0.8, tamp: 0.1, tfreq: 0.7 }) },
};
const strideLen = (speed) => clamp(8 + speed * 0.7, 8, 24);       // metres per full gait cycle

/* ================================================================ runtime */
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _f = new V3(), _g = new V3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion(), _qh = new THREE.Quaternion(), _qhi = new THREE.Quaternion();
const _eu = new THREE.Euler(), _hp = new V3();

class Wendigo {
  constructor(opts = {}) {
    const G = buildGeometry();
    this.mats = makeMaterials();
    this.root = new THREE.Group(); this.root.name = 'Wendigo';
    this.model = new THREE.Group(); this.model.scale.setScalar(K); this.root.add(this.model);
    // bones
    this.bone = {}; const bones = [];
    for (const [name, j] of JT) {
      const b = new THREE.Bone(); b.name = name;
      b.position.copy(j.pos).sub(j.parent ? JT.get(j.parent).pos : V());
      b.rotation.order = name === 'hips' ? 'YZX' : 'YXZ';
      if (j.parent) this.bone[j.parent].add(b); else this.model.add(b);
      this.bone[name] = b; bones.push(b);
    }
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(bones);
    this.meshes = [];
    for (const [geo, mat] of [[G.skin, this.mats.skin], [G.bone, this.mats.bone], [G.fur, this.mats.fur]]) {
      const m = new THREE.SkinnedMesh(geo, mat);
      this.model.add(m); m.updateMatrixWorld(true);
      m.bind(this.skeleton, m.matrixWorld);          // bind space = model space (scaled by K), like the bones
      m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      m.customDepthMaterial = this.mats.depth;
      this.meshes.push(m);
    }
    // anchors (unit world scale so the game can parent things to them)
    const anchor = (bone, p) => { const o = new THREE.Object3D(); o.position.copy(p).sub(JP(bone)); o.scale.setScalar(1 / K); this.bone[bone].add(o); return o; };
    this.handR = anchor('handR', V(-0.42, 0.79, 0.0));
    this.handL = anchor('handL', V(0.42, 0.79, 0.0));
    this.head = anchor('head', sk(0, 0.0, 0.16));
    this.chest = anchor('spine2', V(0.02, 1.68, 0.08));
    // leg IK data (hips-local)
    this.leg = {};
    for (const [S] of SIDES) {
      const sock = JP('thigh' + S), knee = JP('shin' + S), hock = JP('meta' + S), ball = JP('toe' + S);
      this.leg[S] = {
        thigh: this.bone['thigh' + S], shin: this.bone['shin' + S], meta: this.bone['meta' + S], toe: this.bone['toe' + S],
        socket: sock.clone().sub(JP('hips')), l1: sock.distanceTo(knee), l2: knee.distanceTo(hock), l3: hock.distanceTo(ball),
        d1: knee.clone().sub(sock).normalize(), d2: hock.clone().sub(knee).normalize(), d3: ball.clone().sub(hock).normalize(),
      };
    }
    // state
    this.footEvents = [];
    this.mode = 'idle'; this.modeT = 0; this.time = Math.random() * 100; this.phase = 0;
    this.blendW = 1; this.fromMode = null; this.fromT = 0; this.fromSnap = null;
    this.pose = Object.assign({}, IDLE);
    this.look = { y: 0, x: 0 };
    this.tw = { cur: V(), target: V(), timer: 2, holding: false, rnd: rng((Math.random() * 1e9) | 0) };
    this.footWorld = { L: V(), R: V() };
    this.embers = makeEmbers(); this.root.add(this.embers.points);
    this.setGlow(0.5);
  }

  setGlow(v) { this.mats.U.uGlow.value = 0.05 + 1.05 * Math.pow(clamp(v, 0, 1), 1.4); }
  setHeart(v) { this.mats.U.uHeart.value = clamp(v, 0, 1); }
  setDissolve(v) {
    v = clamp(v, 0, 1); this.mats.U.uDissolve.value = v; this.dissolve = v;
    for (const m of this.meshes) m.visible = v < 1;
  }
  setVisible(b) { this.root.visible = !!b; }
  dispose() {
    for (const k of ['skin', 'bone', 'fur', 'depth']) this.mats[k].dispose();
    this.embers.points.geometry.dispose(); this.embers.points.material.dispose();
    this.root.removeFromParent();
  }

  /* ---------------- pose evaluation */
  evalMode(mode, t, s) {
    if (GAIT[mode]) return this.gaitPose(mode, s);
    if (mode === 'idle') return this.idlePose();
    if (mode === 'crouch') return pose(CROUCH, { hdz: 0.08 * Math.sin(this.time * 0.31), n2y: 0.08 * Math.sin(this.time * 0.17) });
    if (mode === 'stand') return STAND_STILL;
    if (mode === 'pinned') return this.pinnedPose();
    const sq = SEQ[mode];
    if (sq) {
      const p = keyed(t, sq.base, sq.keys);
      if (mode === 'death' && t > 4.4 && t < 5.4) { const k = Math.sin((t - 4.4) * Math.PI) * 0.5; p.curlL += k; p.elL += k * 0.3; p.hdz += 0.05 * Math.sin(t * 30) * k; }
      return p;
    }
    return this.idlePose();
  }
  idlePose() {
    const T = this.time;
    return pose(IDLE, { hdz: 0.12 * Math.sin(T * 0.37), hdy: 0.1 * Math.sin(T * 0.23 + 1), n1y: 0.05 * Math.sin(T * 0.19), hx: 0.01 * Math.sin(T * 0.4) });
  }
  pinnedPose() {
    const T = this.time, a = Math.sin(T * 2.3), b = Math.sin(T * 2.3 + 1.6), th = Math.sin(T * 6.1) * 0.6 + Math.sin(T * 3.7 + 1) * 0.4;
    return pose(IDLE, {
      hz: 0.25, hy: -0.85, hrx: 1.42, hrz: -1.95 + 0.06 * Math.sin(T * 1.7), hry: 0,
      s1x: 0.08, s2x: 0.12 + 0.06 * a, chx: 0.1 + 0.05 * b, s2z: 0.1 * a, chz: -0.1,
      n1x: -0.2, n1y: 0.25 * th, n2y: 0.3 * th, hdy: 0.35 * th, hdx: -0.3 + 0.2 * Math.sin(T * 4.3), hdz: 0.4 * Math.sin(T * 3.1), jaw: 0.45 + 0.35 * Math.sin(T * 5.3),
      shxL: 1.9 + 0.7 * a, shzL: 0.5 + 0.2 * b, elL: 0.7 + 0.5 * b, curlL: 0.5 + 0.4 * a,
      shxR: 1.5 + 0.6 * b, shzR: 0.15, elR: 0.6 + 0.5 * a, curlR: 0.5 + 0.4 * b,
      fxL: -0.5, fyL: 0.4 + 0.08 * a, fzL: -0.75 + 0.12 * b, tiltL: 0.2, fxR: -0.45, fyR: 0.12, fzR: -0.95 + 0.1 * a, tiltR: -0.3, toe: 0.3,
      ground: 0, lookW: 0, twitch: 0, fidget: 0.6, breath: 1.4, tp: -0.3, ty: 0.3 * a, tamp: 0.25, tfreq: 3, furAmp: 1.5,
    });
  }
  gaitPose(kind, s) {
    const P = GAIT[kind], speed = Math.max(0, s.speed ?? (kind === 'run' ? 18 : kind === 'walk' ? 5 : 2));
    const g = sstep(0.2, 1.2, speed), L = strideLen(speed), A = P.duty * L / 2 / K * g, ph = this.phase;
    const p = Object.assign({}, P.base), c2 = Math.cos(TAU * ph);
    for (const [S, sd, off] of [['L', 1, 0], ['R', -1, 0.5]]) {
      const f = (ph + off) % 1;
      let z, y = 0, tuck = 0;
      if (f < P.duty) z = A - 2 * A * (f / P.duty);
      else { const u = (f - P.duty) / (1 - P.duty), e = 0.5 - 0.5 * Math.cos(Math.PI * u); z = -A + 2 * A * e; y = P.lift * g * Math.pow(Math.sin(Math.PI * u), 0.9) * (1 + 0.4 * (1 - u)); tuck = Math.sin(Math.PI * Math.min(1, u * 1.2)); }
      p['fx' + S] = sd * P.width; p['fy' + S] = 0.06 + y; p['fz' + S] = P.zc * g + z;
      p['tilt' + S] = P.base['tilt' + S] + P.tuck * g * tuck; p['toe' + S] = 0.5 * g * tuck;
    }
    p.hy += -P.bob * g * Math.cos(4 * Math.PI * ph);
    p.hry = -0.07 * g * c2; p.chy = 0.09 * g * c2; p.hx = 0.015 * g * Math.sin(TAU * ph);
    p.shxL -= P.arm * g * c2; p.shxR += P.arm * g * c2;
    p.elL += 0.25 * g * Math.max(0, -c2); p.elR += 0.25 * g * Math.max(0, c2);
    p.ty = 0.12 * g * Math.sin(TAU * ph);
    p.hdy -= p.chy * 0.8;
    return p;
  }

  /* ---------------- main update */
  animate(dt, s = {}) {
    dt = Math.min(Math.max(dt, 0), 0.1);
    const mode = s.mode || 'idle';
    if (mode !== this.mode) {
      if (this.blendW < 1) { this.fromSnap = Object.assign({}, this.pose); this.fromMode = null; }
      else { this.fromMode = this.mode; this.fromT = this.modeT; this.fromSnap = null; }
      this.mode = mode; this.blendW = 0; this.modeT = 0; this.evDone = 0;
    }
    const prevT = this.modeT;
    this.modeT = s.t ?? this.modeT + dt;
    this.time += dt;
    // gait phase (speed is in m/s; stride in metres)
    const speed = Math.max(0, s.speed || 0), prevPh = this.phase;
    if (GAIT[mode] || GAIT[this.fromMode]) this.phase = (this.phase + speed * dt / strideLen(speed)) % 1;
    // target pose + cross-fade
    let p = this.evalMode(mode, this.modeT, s);
    if (this.blendW < 1) {
      this.blendW = Math.min(1, this.blendW + dt / BLEND);
      const from = this.fromSnap || this.evalMode(this.fromMode, (this.fromT += dt), s);
      const w = EASE.io(this.blendW), o = {};
      for (const k of CHANNELS) o[k] = lerp(from[k], p[k], w);
      p = o;
    }
    this.pose = p;
    this.applyPose(Object.assign({}, p), s, dt);
    // foot plant events
    if (GAIT[mode] && speed > 0.5) {
      const force = clamp(0.3 + speed / 26, 0, 1);
      if (this.phase < prevPh) this.footEvents.push({ foot: 'L', pos: this.footWorld.L.clone(), force });          // wrapped past 0
      if (prevPh < 0.5 && this.phase >= 0.5) this.footEvents.push({ foot: 'R', pos: this.footWorld.R.clone(), force });
    }
    const evs = SEQ_EVENTS[mode];
    if (evs) for (const [et, foot, force] of evs) if (prevT < et && this.modeT >= et) {
      if (foot === 'B') this.footEvents.push({ foot: 'R', pos: this.chest.getWorldPosition(new V3()), force });
      else this.footEvents.push({ foot, pos: this.footWorld[foot].clone(), force });
    }
    if (this.footEvents.length > 32) this.footEvents.splice(0, this.footEvents.length - 32);
    this.embers.update(dt, this.dissolve || 0, this);
  }

  applyPose(p, s, dt) {
    const B = this.bone, T = this.time;
    this.model.updateWorldMatrix(true, false);
    // --- additive layers: look-at, twitches, shake, breathing
    let ly = 0, lx = 0;
    if (s.lookAt && p.lookW > 0.01) {
      this.head.getWorldPosition(_a);
      _b.copy(s.lookAt).sub(_a);
      this.root.getWorldQuaternion(_q1); _b.applyQuaternion(_q1.invert());
      ly = clamp(Math.atan2(_b.x, _b.z), -1.2, 1.2) * p.lookW;
      lx = clamp(Math.atan2(-_b.y, Math.hypot(_b.x, _b.z)), -0.6, 0.9) * p.lookW;
    }
    this.look.y = damp(this.look.y, ly, 4, dt); this.look.x = damp(this.look.x, lx, 4, dt);
    p.n1y += 0.25 * this.look.y; p.n2y += 0.3 * this.look.y; p.hdy += 0.45 * this.look.y;
    p.n2x += 0.4 * this.look.x; p.hdx += 0.6 * this.look.x;
    const tw = this.tw; tw.timer -= dt;
    if (tw.timer <= 0) {
      if (tw.holding) { tw.target.set(0, 0, 0); tw.timer = 1.5 + 4 * tw.rnd(); tw.holding = false; }
      else { tw.target.set((tw.rnd() - 0.5) * 0.5, (tw.rnd() - 0.5) * 0.7, (tw.rnd() - 0.5) * 0.8); tw.timer = 0.3 + 1.2 * tw.rnd(); tw.holding = true; }
    }
    tw.cur.x = damp(tw.cur.x, tw.target.x, tw.holding ? 28 : 3, dt); tw.cur.y = damp(tw.cur.y, tw.target.y, tw.holding ? 28 : 3, dt); tw.cur.z = damp(tw.cur.z, tw.target.z, tw.holding ? 28 : 3, dt);
    p.hdx += tw.cur.x * p.twitch * 0.6; p.hdy += tw.cur.y * p.twitch * 0.6; p.hdz += tw.cur.z * p.twitch * 0.6;
    if (p.shake > 0) {
      const k = p.shake;
      p.hdx += 0.05 * Math.sin(T * 37) * k; p.hdy += 0.04 * Math.sin(T * 29 + 1) * k; p.jaw += 0.06 * Math.sin(T * 23) * k;
      p.chx += 0.015 * Math.sin(T * 31) * k; p.shzL += 0.04 * Math.sin(T * 27) * k; p.shzR += 0.04 * Math.sin(T * 25 + 2) * k;
    }
    const br = Math.sin(T * TAU / 4.2) * p.breath;
    p.chx -= 0.012 * br; p.clzL += 0.02 * br; p.clzR += 0.02 * br;
    B.ribs.scale.set(1 + 0.03 * br, 1 + 0.01 * br, 1 + 0.045 * br);
    this.mats.U.uFurAmp.value = p.furAmp;

    // --- hips (+ terrain adaptation)
    const hipsPos = _hp.copy(JP('hips')).add(_d.set(p.hx, p.hy, p.hz));
    _eu.set(p.hrx, p.hry, p.hrz, 'YZX'); _qh.setFromEuler(_eu); _qhi.copy(_qh).invert();
    const feet = { L: V(p.fxL, p.fyL, p.fzL), R: V(p.fxR, p.fyR, p.fzR) };
    if (s.ground && p.ground > 0) {
      const d = {};
      for (const S of ['L', 'R']) {
        _a.copy(feet[S]).applyMatrix4(this.model.matrixWorld);
        const flat = _b.set(0, 0, 0).applyMatrix4(this.model.matrixWorld).y;
        d[S] = (s.ground(_a.x, _a.z) - flat) / K;
        if (!Number.isFinite(d[S])) d[S] = 0;
      }
      hipsPos.y += Math.min(d.L, d.R) * p.ground;
      feet.L.y += d.L * p.ground; feet.R.y += d.R * p.ground;
    }
    B.hips.position.copy(hipsPos); B.hips.quaternion.copy(_qh);
    // --- spine, neck, head, jaw
    B.spine1.rotation.set(p.s1x, p.s1y, p.s1z); B.spine2.rotation.set(p.s2x, p.s2y, p.s2z); B.chest.rotation.set(p.chx, p.chy, p.chz);
    B.neck1.rotation.set(p.n1x, p.n1y, p.n1z); B.neck2.rotation.set(p.n2x, p.n2y, p.n2z); B.head.rotation.set(p.hdx, p.hdy, p.hdz);
    B.jaw.rotation.set(Math.max(-0.02, p.jaw), 0, 0);
    // --- arms and fingers (arm swing is authored relative to the world vertical)
    const bodyPitch = p.hrx + p.s1x + p.s2x + p.chx;
    for (const [S, sd] of SIDES) {
      B['clav' + S].rotation.set(0, -sd * p['cly' + S], sd * p['clz' + S]);
      B['upper' + S].rotation.set(-bodyPitch - p['shx' + S], -sd * p['shy' + S], sd * p['shz' + S]);   // shx is relative to gravity
      B['fore' + S].rotation.set(-p['el' + S], 0, 0);
      B['hand' + S].rotation.set(-p['wrx' + S], 0, sd * p['wrz' + S]);
      const curl = p['curl' + S];
      for (let i = 0; i < 5; i++) {
        const fid = 0.16 * Math.sin(T * (0.8 + 0.13 * i) + i * 1.9 + sd * 2) * p.fidget;
        const c = clamp(curl + fid, -0.2, 1.2);
        if (i < 4) {
          B[`f${i}a${S}`].rotation.set((i - 1.5) * 0.06 * (1 - c), 0, -sd * c * 1.05);
          B[`f${i}b${S}`].rotation.set(0, 0, -sd * c * 1.3);
        } else {
          B[`f${i}a${S}`].rotation.set(-c * 0.5, 0, -sd * c * 0.5);
          B[`f${i}b${S}`].rotation.set(0, 0, -sd * c * 0.9);
        }
      }
    }
    // --- legs (IK)
    for (const S of ['L', 'R']) {
      this.solveLeg(S, feet[S], p['tilt' + S], p['toe' + S], hipsPos);
      this.footWorld[S].copy(feet[S]).applyMatrix4(this.model.matrixWorld);
    }
    // --- tail
    for (let i = 0; i < TAIL_PTS.length - 1; i++) {
      const k = i / (TAIL_PTS.length - 2);
      const x = (i === 0 ? p.tp : 0) + p.tcurl * 0.12 * k + 0.03 * Math.sin(T * p.tfreq * 0.7 - i * 0.5) * p.tamp * 3;
      const y = (i === 0 ? p.ty : p.ty * 0.12) + p.tamp * Math.sin(T * p.tfreq - i * 0.55) * (0.25 + 0.75 * k) * 0.5;
      B['tail' + i].rotation.set(x, y, 0);
    }
  }

  /** digitigrade leg: foot (model space) + metatarsus tilt -> hock -> 2-bone IK (knee forward) */
  solveLeg(S, foot, tilt, toe, hipsPos) {
    const L = this.leg[S];
    const F = _a.copy(foot).sub(hipsPos).applyQuaternion(_qhi);
    const md = _b.set(0, Math.cos(tilt), -Math.sin(tilt)).applyQuaternion(_qhi);
    const H = _c.copy(F).addScaledVector(md, L.l3);
    const S0 = L.socket, axis = _d.copy(H).sub(S0);
    let d = axis.length(); axis.divideScalar(d || 1);
    d = clamp(d, Math.abs(L.l1 - L.l2) + 1e-3, (L.l1 + L.l2) * 0.999);
    H.copy(S0).addScaledVector(axis, d);
    const a = Math.acos(clamp((L.l1 * L.l1 + d * d - L.l2 * L.l2) / (2 * L.l1 * d), -1, 1));
    const hint = _e.set(S === 'L' ? 0.12 : -0.12, 0, 1); hint.addScaledVector(axis, -hint.dot(axis)).normalize();
    const Kn = _f.copy(S0).addScaledVector(axis, L.l1 * Math.cos(a)).addScaledVector(hint, L.l1 * Math.sin(a));
    _q1.setFromUnitVectors(L.d1, _g.copy(Kn).sub(S0).normalize());
    _q2.setFromUnitVectors(L.d2, _g.copy(H).sub(Kn).normalize());
    _g.copy(F).sub(H); if (_g.lengthSq() < 1e-8) _g.copy(md).negate();
    _q3.setFromUnitVectors(L.d3, _g.normalize());
    L.thigh.quaternion.copy(_q1);
    L.shin.quaternion.copy(_q1).invert().multiply(_q2);
    L.meta.quaternion.copy(_q2).invert().multiply(_q3);
    _q4.setFromEuler(_eu.set(toe, 0, 0, 'XYZ')).premultiply(_qhi);
    L.toe.quaternion.copy(_q3).invert().multiply(_q4);
  }
}

/** soft round sprite for the embers */
function emberSprite() {
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
/* ---- embers for the dissolve: additive points rising off the body (root-local) */
function makeEmbers(n = 360) {
  const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), vel = new Float32Array(n * 3), life = new Float32Array(n);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size: 0.5, map: emberSprite(), alphaTest: 0.01, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
  const points = new THREE.Points(geo, mat); points.frustumCulled = false; points.visible = false;
  const boneNames = [...JT.keys()];
  let acc = 0, next = 0;
  const tmp = new V3();
  return {
    points,
    update(dt, dissolve, W) {
      const rate = dissolve > 0 && dissolve < 1 ? 160 * (0.4 + Math.sin(Math.PI * dissolve)) : 0;
      acc += rate * dt;
      while (acc >= 1) {
        acc -= 1; const i = next; next = (next + 1) % n;
        W.bone[boneNames[(Math.random() * boneNames.length) | 0]].getWorldPosition(tmp); W.root.worldToLocal(tmp);
        pos[i * 3] = tmp.x + (Math.random() - 0.5) * 1.6; pos[i * 3 + 1] = tmp.y + (Math.random() - 0.5) * 1.6; pos[i * 3 + 2] = tmp.z + (Math.random() - 0.5) * 1.6;
        vel[i * 3] = (Math.random() - 0.5) * 2; vel[i * 3 + 1] = 1.5 + Math.random() * 4; vel[i * 3 + 2] = (Math.random() - 0.5) * 2;
        life[i] = 1.5 + Math.random() * 2;
      }
      let alive = 0;
      for (let i = 0; i < n; i++) {
        if (life[i] <= 0) { col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0; continue; }
        life[i] -= dt; alive++;
        pos[i * 3] += vel[i * 3] * dt + Math.sin(life[i] * 3 + i) * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        const k = clamp(life[i] / 1.5, 0, 1);
        col[i * 3] = 1.0 * k; col[i * 3 + 1] = 0.28 * k * k; col[i * 3 + 2] = 0.04 * k * k * k;
      }
      points.visible = alive > 0;
      geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true;
    },
  };
}

/* ================================================================ public API */
export function createWendigo(opts = {}) {
  const w = new Wendigo(opts);
  if (opts.glow !== undefined) w.setGlow(opts.glow);
  return w;
}

/* ================================================================ screenshot lineup (_view.html) */
export function lineup(ctx) {
  const { scene } = ctx;
  // arg = 'mode' or 'mode@seconds' (freeze the animation at that time, for deterministic screenshots)
  const [arg, freezeStr] = (ctx.arg || '').split('@');
  const freeze = freezeStr ? +freezeStr : Infinity;
  const ground = ctx.ground || (() => 0);
  const make = (x, z, ry) => { const W = createWendigo(); W.root.position.set(x, 0, z); W.root.rotation.y = ry; scene.add(W.root); return W; };
  const list = [];
  let cam = [30, 13, 42], look = [0, 10, 0];
  const ONE = ['walk', 'run', 'stalk', 'idle', 'crouch', 'stand', 'pinned', ...Object.keys(ANIMS)];
  if (arg === '' || arg === 'turn') {
    [[-36, 0], [-12, Math.PI / 2], [12, Math.PI], [36, -Math.PI / 2]].forEach(([x, ry]) => list.push({ W: make(x, 0, ry), mode: 'idle' }));
    cam = [0, 12, 78]; look = [0, 11, 0];
  } else if (arg === 'scale') {
    list.push({ W: make(0, 0, 0.35), mode: 'idle' });
    for (let i = 0; i < 6; i++) {
      const h = 25, tr = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.6, h, 10), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 }));
      tr.position.set(-30 + i * 12, h / 2, -14); tr.castShadow = true; scene.add(tr);
    }
    const man = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.2, 6, 10), new THREE.MeshStandardMaterial({ color: 0x2a6fd0 }));
    man.position.set(5, 0.9, 7); man.castShadow = true; scene.add(man);
    cam = [10, 9, 62]; look = [0, 11, 0];
  } else if (arg === 'glow' || arg === 'dissolve') {
    const W = make(0, 0, 0.3); list.push({ W, mode: 'idle' });
    if (arg === 'glow') { W.setGlow(1); W.setHeart(1); } else W.setDissolve(0.5);
    cam = [10, 14, 34]; look = [0, 12, 0];
  } else if (arg === 'lineup') {
    ['idle', 'walk', 'swipe', 'roar', 'pinned'].forEach((m, i) => list.push({ W: make(-48 + i * 24, 0, 0.5), mode: m }));
    cam = [0, 14, 95]; look = [0, 9, 0];
  } else {
    const mode = ONE.includes(arg) ? arg : 'idle';
    list.push({ W: make(0, 0, 0.6), mode });
    if (mode === 'pinned' || mode === 'death') { cam = [26, 14, 40]; look = [0, 4, 4]; }
    if (mode === 'lookDown') { cam = [22, 8, 30]; look = [0, 12, 2]; }
  }
  const speedOf = { walk: 5, run: 20, stalk: 2 };
  return {
    cam, look,
    update(dt, t) {
      if (t > freeze) { t = freeze; dt = 0; }
      for (const it of list) {
        if (arg === 'bind') continue;                 // raw bind pose (rig debugging)
        const a = ANIMS[it.mode];
        const hold = it.mode === 'death' ? 2 : 0.8;
        const tt = a ? t % (a.dur + hold) : t;
        const done = a && tt > a.dur && it.mode !== 'death';
        it.W.animate(dt, { mode: done ? 'idle' : it.mode, t: Math.min(tt, a ? a.dur : tt), speed: speedOf[it.mode] || 0, lookAt: null, ground });
        it.W.footEvents.length = 0;
      }
    },
  };
}
