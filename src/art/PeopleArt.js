/* PeopleArt.js - every human in THE WENDIGO, built entirely in code.

   createPerson(kind, opts)  'survivor' (look 0..3) | 'pilot' | 'cannibal' (variant scout|brute|elder|skulker)
   createFPArms(look)        first-person forearms + hands for the overlay camera
   lineup(ctx)               screenshot viewer entry (see _view.html)

   How it is made
   - One shared humanoid RIG (bones: hips > spine > chest > neck > head, clavicle > arm > fore > hand >
     3-segment fingers + thumb, thigh > shin > foot > toe). Every character is a few SkinnedMeshes
     (skin / cloth / hair / hide = <= 4 draw calls) bound to it, so clothing bends smoothly at joints.
   - Heads are sculpted as a signed-distance field (cranium, brow, cheekbones, jaw, chin, nose,
     lips, eye sockets with lids, neck) and a direction-warped sphere is shrink-wrapped onto it, with
     SDF ambient occlusion baked into vertex colour. A per-character skin texture is painted in the
     same parameter space (lips, brows, lash line, stubble, freckles, war paint).
   - Clothing is lofted along the bones (superelliptic cross sections) with folds, quilting,
     pockets, cuffs and seams pushed into the surface; vertex colour carries garment colour x AO and
     vertex alpha carries roughness (patched into MeshStandardMaterial), so one material serves
     nylon, cotton, rubber and leather. Tileable fabric / hide / hair textures add weave and normals.
   - Animation: a pose is a flat set of joint channels. Each mode is a function producing a pose
     (gait with foot-planting leg IK, two-bone arm IK with hand orientation, keyframed one-shots);
     modes are cross-faded by damped weights (~0.2 s), then look-at / aim and two-handed grips are
     layered on top.
   Conventions: metres, +Y up, characters face +Z, origin on the ground between the feet,
   the character's LEFT is +X. Pose channels are written for the left side ("canonical") and
   mirrored for the right side when applied. */
import * as THREE from '../../lib/three.module.js';
import { Noise, clamp, lerp, sstep, damp } from '../core/Util.js';
import { makeCanvas, toTex } from '../core/Textures.js';

const TAU = Math.PI * 2, PI = Math.PI;
const V3 = THREE.Vector3;
const NZ = new Noise(9071), NZ2 = new Noise(313);
const lin = (r, g, b) => [r ** 2.2, g ** 2.2, b ** 2.2];
const hexc = h => lin(((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255);
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const mul3 = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const smin = (a, b, k) => { const h = clamp(0.5 + 0.5 * (b - a) / k, 0, 1); return lerp(b, a, h) - k * h * (1 - h); };
const smax = (a, b, k) => -smin(-a, -b, k);
const hash1 = (i, s = 0) => { let h = Math.imul(i | 0, 374761393) ^ Math.imul(s | 0, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/* =====================================================================================
   GEOMETRY CORE
   ===================================================================================== */
function makeGeo(P, U, C, I) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4));
  g.setIndex(I);
  g.computeVertexNormals();
  return g;
}
/** parametric grid: fn(u, v, out, i, j) sets out.x/y/z, out.u/v (uv), out.r/g/b (colour), out.a (roughness) */
function grid(nu, nv, fn) {
  const P = [], U = [], C = [], I = [], o = {};
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    o.x = o.y = o.z = 0; o.u = i / nu; o.v = j / nv; o.r = o.g = o.b = 1; o.a = 0.8;
    fn(i / nu, j / nv, o, i, j);
    P.push(o.x, o.y, o.z); U.push(o.u, o.v); C.push(o.r, o.g, o.b, o.a);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = j * (nu + 1) + i, b = a + nu + 1; I.push(a, a + 1, b, a + 1, b + 1, b); }
  return makeGeo(P, U, C, I);
}
/** average the normals of coincident vertices (seams, poles, caps) */
function weldNormals(g) {
  const p = g.attributes.position, n = g.attributes.normal, m = new Map(), keys = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) * 2e4) + ',' + Math.round(p.getY(i) * 2e4) + ',' + Math.round(p.getZ(i) * 2e4);
    keys[i] = k; let a = m.get(k); if (!a) m.set(k, a = [0, 0, 0]);
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
  }
  for (let i = 0; i < p.count; i++) { const a = m.get(keys[i]), l = Math.hypot(a[0], a[1], a[2]) || 1; n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
  n.needsUpdate = true; return g;
}
function flipGeo(g) { const ix = g.index.array; for (let i = 0; i < ix.length; i += 3) { const t = ix[i + 1]; ix[i + 1] = ix[i + 2]; ix[i + 2] = t; } g.index.needsUpdate = true; g.computeVertexNormals(); return g; }
const _a = new V3(), _b = new V3(), _c = new V3(), _n = new V3(), _m = new V3();
/** make the triangles face away from ref (bbox centre by default) */
function orient(g, ref) {
  const p = g.attributes.position, ix = g.index.array; let s = 0;
  if (!ref) { g.computeBoundingBox(); ref = g.boundingBox.getCenter(new V3()); }
  for (let i = 0; i < ix.length; i += 3) {
    _a.fromBufferAttribute(p, ix[i]); _b.fromBufferAttribute(p, ix[i + 1]); _c.fromBufferAttribute(p, ix[i + 2]);
    _n.subVectors(_b, _a).cross(_m.subVectors(_c, _a));
    _m.copy(_a).add(_b).add(_c).multiplyScalar(1 / 3).sub(ref); s += _n.dot(_m);
  }
  if (s < 0) flipGeo(g);
  return g;
}
const finish = (g, ref) => weldNormals(orient(g, ref));
function mirrorGeo(g) { const m = g.clone(); m.index = g.index.clone(); const p = m.attributes.position; for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i)); flipGeo(m); return weldNormals(m); }
function mergeSimple(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2), C = new Float32Array(n * 4), I = [];
  let o = 0;
  for (const g of list) {
    const c = g.attributes.position.count;
    P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); U.set(g.attributes.uv.array, o * 2); C.set(g.attributes.color.array, o * 4);
    for (const i of g.index.array) I.push(i + o);
    o += c;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(U, 2)); g.setAttribute('color', new THREE.BufferAttribute(C, 4));
  g.setIndex(I); return g;
}
/** thin cloth seen from both sides: a second, inward-offset, flipped layer */
function twoSided(g, th = 0.003, dark = 0.55) {
  const b = g.clone(); b.index = g.index.clone();
  const p = b.attributes.position, n = b.attributes.normal, c = b.attributes.color;
  for (let i = 0; i < p.count; i++) { p.setXYZ(i, p.getX(i) - n.getX(i) * th, p.getY(i) - n.getY(i) * th, p.getZ(i) - n.getZ(i) * th); c.setXYZ(i, c.getX(i) * dark, c.getY(i) * dark, c.getZ(i) * dark); }
  flipGeo(b); weldNormals(b);
  return mergeSimple([g, b]);
}
/** recolour every vertex: fn(x,y,z,[r,g,b,a]) mutates */
function paintGeo(g, fn) {
  const p = g.attributes.position, c = g.attributes.color, q = [0, 0, 0, 0];
  for (let i = 0; i < p.count; i++) { q[0] = c.getX(i); q[1] = c.getY(i); q[2] = c.getZ(i); q[3] = c.getW(i); fn(p.getX(i), p.getY(i), p.getZ(i), q); c.setXYZW(i, q[0], q[1], q[2], q[3]); }
  return g;
}
const tf = (g, m) => { g.applyMatrix4(m); return g; };

/**
 * loft: a smooth tube through stations [{p:[x,y,z], r | rx, rf, rb, fw?}], superelliptic sections.
 *   rx = half width along the side axis S, rf/rb = half depth toward the front / back axis F.
 *   The frame: T along the curve, S = fw x T, F = T x S (fw = "front" reference, default +Z).
 *   o.vert(t, dir, a, out, ring): out.m (radius multiplier), out.off (metres along dir), out.dt
 *   (metres along T), out.r/g/b/a colour + roughness. o.cap0/cap1 close the ends (o.dome).
 *   uv: metric (o.ts metres per repeat) or packed into o.uvRect [u0,v0,u1,v1].
 */
function loft(st, o = {}) {
  st = st.map(s => ({ p: s.p, rx: s.rx ?? s.r, rf: s.rf ?? s.r ?? s.rx, rb: s.rb ?? s.r ?? s.rx, fw: s.fw }));
  const n = st.length, sub = o.sub ?? 3, rad = o.radial ?? 16, ex = 2 / (o.sq ?? 2);
  const curve = new THREE.CatmullRomCurve3(st.map(s => new V3(s.p[0], s.p[1], s.p[2])), false, 'centripetal');
  const rows = (n - 1) * sub, fw0 = new V3(...(o.fw || [0, 0, 1]));
  const cr = (key, s) => {
    const i = Math.min(Math.floor(s), n - 2), f = s - i, g = k => st[clamp(k, 0, n - 1)][key];
    const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
    return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
  };
  const rings = []; let arc = 0, prev = null;
  for (let j = 0; j <= rows; j++) {
    const t = j / rows, s = t * (n - 1);
    const c = curve.getPoint(t), T = curve.getTangent(t).normalize();
    let fw = fw0;
    if (st[0].fw) { const i = Math.min(Math.floor(s), n - 2), f = s - i; fw = new V3(...st[i].fw).lerp(new V3(...(st[i + 1].fw || st[i].fw)), f); }
    const S = new V3().crossVectors(fw, T); if (S.lengthSq() < 1e-8) S.set(1, 0, 0); S.normalize();
    const F = new V3().crossVectors(T, S).normalize();
    if (prev) arc += c.distanceTo(prev); prev = c;
    rings.push({ c, T, S, F, t, s, rx: Math.max(1e-4, cr('rx', s)), rf: Math.max(1e-4, cr('rf', s)), rb: Math.max(1e-4, cr('rb', s)), arc });
  }
  let per = 0; for (const r of rings) per += Math.PI * (r.rx + (r.rf + r.rb) / 2); per /= rings.length;
  const dome = o.dome ?? 0.6;
  if (o.cap0) { const r = rings[0]; rings.unshift({ ...r, cap: true, c: r.c.clone().addScaledVector(r.T, -dome * Math.min(r.rx, r.rf)) }); }
  if (o.cap1) { const r = rings[rings.length - 1]; rings.push({ ...r, cap: true, c: r.c.clone().addScaledVector(r.T, dome * Math.min(r.rx, r.rf)) }); }
  const ts = o.ts ?? 0.25, a0 = o.a0 ?? PI, base = o.color || [1, 1, 1], rough = o.rough ?? 0.85;
  const P = [], U = [], C = [], I = [], dir = new V3(), pos = new V3(), out = {};
  const R = rings.length;
  for (let j = 0; j < R; j++) {
    const rg = rings[j];
    for (let i = 0; i <= rad; i++) {
      const a = a0 + (i / rad) * TAU, sa = Math.sin(a), ca = Math.cos(a);
      dir.copy(rg.S).multiplyScalar(sa).addScaledVector(rg.F, ca);
      out.m = 1; out.off = 0; out.dt = 0; out.r = base[0]; out.g = base[1]; out.b = base[2]; out.a = rough;
      if (o.vert) o.vert(rg.t, dir, a, out, rg);
      if (rg.cap) pos.copy(rg.c);
      else {
        const xs = Math.sign(sa) * Math.abs(sa) ** ex, zs = Math.sign(ca) * Math.abs(ca) ** ex, rz = ca >= 0 ? rg.rf : rg.rb;
        pos.copy(rg.c).addScaledVector(rg.S, xs * rg.rx * out.m).addScaledVector(rg.F, zs * rz * out.m).addScaledVector(dir, out.off).addScaledVector(rg.T, out.dt);
      }
      P.push(pos.x, pos.y, pos.z);
      if (o.uvRect) { const q = o.uvRect; U.push(q[0] + (q[2] - q[0]) * i / rad, q[1] + (q[3] - q[1]) * clamp(rg.t, 0, 1)); }
      else U.push(i / rad * per / ts, rg.arc / ts);
      C.push(out.r, out.g, out.b, out.a);
    }
  }
  for (let j = 0; j < R - 1; j++) for (let i = 0; i < rad; i++) { const a = j * (rad + 1) + i, b = a + rad + 1; I.push(a, a + 1, b, a + 1, b + 1, b); }
  const g = makeGeo(P, U, C, I);
  // outward test against each row's own centre
  let s = 0; const pa = g.attributes.position;
  for (let j = 1; j < R - 2; j++) for (let i = 0; i < rad; i += 2) {
    const a = j * (rad + 1) + i, b = a + rad + 1;
    _a.fromBufferAttribute(pa, a); _b.fromBufferAttribute(pa, a + 1); _c.fromBufferAttribute(pa, b);
    _n.subVectors(_b, _a).cross(_m.subVectors(_c, _a)); s += _n.dot(_m.copy(_a).sub(rings[j].c));
  }
  if (s < 0) flipGeo(g);
  return weldNormals(g);
}
/** rounded box / superellipsoid blob: centre c, half sizes r, exponent e (1 = ellipsoid, 0.2 = boxy) */
function blob(c, r, e, nu, nv, vert, o = {}) {
  const pw = (x, k) => Math.sign(x) * Math.abs(x) ** k;
  const g = grid(nu, nv, (u, v, out) => {
    const th = (u - 0.5) * TAU, ph = (v - 0.5) * PI;
    const cp = Math.cos(ph), sp = Math.sin(ph);
    let x = pw(cp, e) * pw(Math.sin(th), e), y = pw(sp, e), z = pw(cp, e) * pw(Math.cos(th), e);
    out.x = c[0] + x * r[0]; out.y = c[1] + y * r[1]; out.z = c[2] + z * r[2];
    out.u = u * (o.us ?? 2); out.v = v * (o.vs ?? 2);
    if (vert) vert(x, y, z, out, u, v);
  });
  return finish(g, new V3(...c));
}

/* =====================================================================================
   HEAD: a signed distance field sculpt, shrink-wrapped by a warped sphere
   Head-local space: origin between the eyes' centres at eye height, z forward.
   ===================================================================================== */
function sdEll(x, y, z, c, r) {
  const px = (x - c[0]) / r[0], py = (y - c[1]) / r[1], pz = (z - c[2]) / r[2];
  const k0 = Math.sqrt(px * px + py * py + pz * pz), qx = px / r[0], qy = py / r[1], qz = pz / r[2];
  const k1 = Math.sqrt(qx * qx + qy * qy + qz * qz);
  return k1 < 1e-9 ? -Math.min(r[0], r[1], r[2]) : k0 * (k0 - 1) / k1;
}
function sdCap(x, y, z, a, b, ra, rb) {
  const pax = x - a[0], pay = y - a[1], paz = z - a[2], bax = b[0] - a[0], bay = b[1] - a[1], baz = b[2] - a[2];
  const h = clamp((pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - lerp(ra, rb, h);
}
/* head parameters: w (width), jaw, chin, brow, nose (length), noseW, lips, cheek, gaunt, neck, fem */
function headSDF(h) {
  const w = h.w ?? 1, jw = h.jaw ?? 1, br = h.brow ?? 1, ns = h.nose ?? 1, nw = h.noseW ?? 1, lp = h.lips ?? 1, ck = h.cheek ?? 1, gaunt = h.gaunt ?? 0;
  const CR = [0, 0.024, -0.016], CRr = [0.0735 * w, 0.097, 0.1];
  const FH = [0, 0.032, 0.03], FHr = [0.063 * w, 0.066, 0.066];
  const FA = [0, -0.034, 0.036], FAr = [0.054 * w * (0.92 + 0.08 * jw), 0.064, 0.06];
  const CB = [0.047 * w, -0.012, 0.054], CBr = [0.02 * ck, 0.0155 * ck, 0.03];
  const JA = [0.05 * w * jw, -0.056, -0.014], JB = [0.02 * jw, -0.103, 0.068], jr = 0.0165 * jw;
  const CH = [0, -0.1, 0.077], CHr = [0.022 * (h.chin ?? 1), 0.02, 0.019];
  const MZ = [0, -0.064, 0.067], MZr = [0.032, 0.029, 0.031];
  const UL = [0, -0.0585, 0.0935 + 0.0015 * (lp - 1)], ULr = [0.021, 0.0066 * lp, 0.0095 * lp];
  const LL = [0, -0.0705, 0.0905 + 0.0015 * (lp - 1)], LLr = [0.0185, 0.0078 * lp, 0.0098 * lp];
  const SL = [0, -0.0643, 0.1], SLr = [0.0205, 0.0011, 0.016];
  const BR = [0.029, 0.021, 0.0795], BRr = [0.027, 0.0105 * br, 0.016 * br];
  const NB0 = [0, 0.006, 0.0905], NB1 = [0, -0.027, 0.111 + 0.005 * (ns - 1)];
  const NT = [0, -0.033, 0.1105 + 0.006 * (ns - 1)], NTr = [0.0112 * nw, 0.0102, 0.0108];
  const NA = [0.0122 * nw, -0.0385, 0.1005], NAr = [0.0078 * nw, 0.0068, 0.0085];
  const ES = [0.031, 0.001, 0.0855], ESr = [0.0158, 0.0092, 0.0135];
  const UD = [0.031, 0.0036, 0.0752], UDr = [0.0143, 0.0094, 0.0118];
  const LD = [0.031, -0.0047, 0.0762], LDr = [0.0132, 0.0064, 0.0106];
  const NK0 = [0, -0.06, -0.03], NK1 = [0, -0.27, -0.028], nkr = 0.052 * (h.neck ?? 1);
  const HL = [0.05, -0.054, 0.046], HLr = [0.016 * gaunt + 1e-4, 0.022 * gaunt + 1e-4, 0.024 * gaunt + 1e-4];
  return (x, y, z) => {
    const ax = Math.abs(x);
    let d = sdEll(x, y, z, CR, CRr);
    d = smin(d, sdEll(x, y, z, FH, FHr), 0.02);
    d = smin(d, sdEll(x, y, z, FA, FAr), 0.022);
    d = smin(d, sdEll(ax, y, z, CB, CBr), 0.016);
    d = smin(d, sdCap(ax, y, z, JA, JB, jr, jr * 0.85), 0.02);
    d = smin(d, sdEll(x, y, z, CH, CHr), 0.012);
    d = smin(d, sdEll(x, y, z, MZ, MZr), 0.016);
    d = smin(d, sdEll(ax, y, z, BR, BRr), 0.012);
    d = smin(d, sdCap(x, y, z, NB0, NB1, 0.0072, 0.0095 * nw), 0.008);
    d = smin(d, sdEll(x, y, z, NT, NTr), 0.006);
    d = smin(d, sdEll(ax, y, z, NA, NAr), 0.005);
    d = smin(d, sdCap(x, y, z, NK0, NK1, nkr, nkr * 1.06), 0.03);
    if (gaunt > 0) d = smax(d, -sdEll(ax, y, z, HL, HLr), 0.012);
    d = smin(d, sdEll(x, y, z, UL, ULr), 0.005);
    d = smin(d, sdEll(x, y, z, LL, LLr), 0.005);
    d = smax(d, -sdEll(x, y, z, SL, SLr), 0.0025);
    d = smax(d, -sdEll(ax, y, z, ES, ESr), 0.006);
    d = smin(d, sdEll(ax, y, z, UD, UDr), 0.003);
    d = smin(d, sdEll(ax, y, z, LD, LDr), 0.003);
    return d;
  };
}
const HC = new V3(0, -0.012, 0);            // ray origin for the shrink-wrap
const HV0 = 0.52, HV1 = 0.995;              // head rows of the skin atlas (v)
const EYE = [0.031, 0.0, 0.0718], EYE_R = 0.0122;
/** march from outside toward c along d and return the outermost surface distance of F - off */
function march(F, c, d, off = 0, tmax = 0.42) {
  let t = tmax, tp = t, f = F(c.x + d.x * t, c.y + d.y * t, c.z + d.z * t) - off;
  for (let i = 0; i < 120 && f >= 0; i++) {
    tp = t; t -= Math.max(f * 0.7, 0.0012);
    if (t <= 0) { t = 0; break; }
    f = F(c.x + d.x * t, c.y + d.y * t, c.z + d.z * t) - off;
  }
  let lo = t, hi = tp;
  for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; if (F(c.x + d.x * m, c.y + d.y * m, c.z + d.z * m) - off < 0) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
function sdfNormal(F, p, out) { const e = 0.0006; return out.set(F(p.x + e, p.y, p.z) - F(p.x - e, p.y, p.z), F(p.x, p.y + e, p.z) - F(p.x, p.y - e, p.z), F(p.x, p.y, p.z + e) - F(p.x, p.y, p.z - e)).normalize(); }
function sdfAO(F, p, n, k = 1) {
  let occ = 0, ws = 0;
  for (let i = 1; i <= 4; i++) { const h = 0.0045 * i * k, d = F(p.x + n.x * h, p.y + n.y * h, p.z + n.z * h); occ += clamp((h - d) / h, 0, 1) / i; ws += 1 / i; }
  return 1 - 0.8 * occ / ws;
}
/** sphere direction for head grid (u around, v bottom->top), denser at the face */
function headDir(u, v, d) {
  const x = 2 * u - 1, phi = PI * (0.55 * x + 0.45 * x * Math.abs(x));
  const psi = PI * (v + 0.42 * Math.sin(TAU * v) / TAU);
  return d.set(Math.sin(psi) * Math.sin(phi), -Math.cos(psi), Math.sin(psi) * Math.cos(phi));
}

/* =====================================================================================
   TEXTURES
   ===================================================================================== */
function tnoise(n, u, v, fx, fy, oct = 3) { // tileable fbm on the unit square
  const f = (a, b) => n.fbm2(a * fx, b * fy, oct);
  return lerp(lerp(f(u, v), f(u - 1, v), u), lerp(f(u, v - 1), f(u - 1, v - 1), u), v) * 1.4;
}
function normalCanvas(hf, w, h, strength) {
  const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const H = (x, y) => hf[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * w + x) * 4; d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}
/** tileable detail set: fn(u,v,x,y) -> [grey 0..1, height]; map is linear (multiplies vertex colour) */
function detailTex(N, fn, strength) {
  const c = makeCanvas(N, N), g = c.getContext('2d'), img = g.createImageData(N, N), d = img.data, hf = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const [k, h] = fn(x / N, y / N, x, y), i = (y * N + x) * 4, kk = clamp(k, 0, 1) * 255;
    d[i] = kk; d[i + 1] = kk; d[i + 2] = kk; d[i + 3] = 255; hf[y * N + x] = h;
  }
  g.putImageData(img, 0, 0);
  return { map: toTex(c, { srgb: false }), normalMap: toTex(normalCanvas(hf, N, N, strength), { srgb: false }) };
}
const TEXC = {};
function clothTex() {
  return TEXC.cloth || (TEXC.cloth = detailTex(256, (u, v, x, y) => {
    const tw = ((x + y) % 4 < 2) ? 1 : 0, thread = Math.sin(x * PI * 0.5) * 0.5 + 0.5;
    const slub = tnoise(NZ, u, v, 3, 60, 2), n = tnoise(NZ2, u, v, 5, 5, 4), crease = 1 - Math.abs(tnoise(NZ, u + 0.7, v, 4, 9, 3)), wear = sstep(0.25, 0.7, tnoise(NZ, u + 0.3, v, 3, 3, 3));
    return [0.9 + tw * 0.018 + thread * 0.012 + slub * 0.02 + n * 0.04 + wear * 0.05 - crease ** 8 * 0.08, tw * 0.12 + thread * 0.06 + slub * 0.1 + n * 0.5 - crease ** 8 * 0.6];
  }, 1.0));
}
function hideTex() {
  return TEXC.hide || (TEXC.hide = detailTex(256, (u, v) => {
    const n = tnoise(NZ, u, v, 4, 4, 4), wr = 1 - Math.abs(tnoise(NZ2, u, v, 9, 6, 3)), bl = tnoise(NZ2, u + 0.5, v, 2, 2, 3);
    const hair = tnoise(NZ, u, v, 90, 9, 2);
    return [0.72 + n * 0.12 + bl * 0.14 - wr ** 6 * 0.18 + hair * 0.05, n * 0.5 - wr ** 6 * 0.9 + hair * 0.15];
  }, 2.5));
}
function hairTex() {
  return TEXC.hair || (TEXC.hair = detailTex(256, (u, v, x) => {
    const s = tnoise(NZ, u, v, 80, 3, 2), s2 = tnoise(NZ2, u, v, 30, 1, 2), cl = tnoise(NZ, u + 0.2, v, 6, 1, 2);
    const k = 0.62 + s * 0.28 + s2 * 0.15 + cl * 0.1 + (hash1(x, 7) - 0.5) * 0.12;
    return [k, s * 0.7 + s2 * 0.4];
  }, 2.0));
}
function poreTex() {
  return TEXC.pore || (TEXC.pore = detailTex(256, (u, v, x, y) => {
    const n = tnoise(NZ, u, v, 24, 24, 2), p = hash1(x * 977 + y, 3) > 0.93 ? 1 : 0, wr = tnoise(NZ2, u, v, 6, 40, 2);
    return [1, n * 0.35 - p * 0.35 + wr * 0.15];
  }, 1.0));
}

/* --------------- per-character skin atlas: face (top half, warped sphere space) + body ---------------
   u in [0,0.45] torso, [0.45,0.5] white patch (eyes/teeth/neutral), [0.5,0.75] arms, [0.75,1] legs.
   Loft angle a0 = PI puts every body seam at the back (s = 0.5 is the front). */
const UV_TORSO = [0, 0.0, 0.45, 0.48], UV_ARM = [0.5, 0.0, 0.75, 0.48], UV_LEG = [0.75, 0.0, 1.0, 0.48];
const UV_WHITE = [0.475, 0.25], UV_HAND = [0.62, 0.02], UV_EAR = [0.62, 0.035];
const prj = (x, y, z) => new V3(x, y, z).sub(HC).normalize().multiplyScalar(0.1).add(HC);
const LM = {
  ul: prj(0, -0.0585, 0.095), ll: prj(0, -0.0705, 0.092), mouth: prj(0, -0.0645, 0.1),
  eye: prj(0.031, 0.0, 0.086), browIn: prj(0.013, 0.019, 0.094), browPk: prj(0.034, 0.025, 0.09), browOut: prj(0.054, 0.019, 0.072),
  cheek: prj(0.046, -0.03, 0.074), noseTip: prj(0, -0.033, 0.114), chin: prj(0, -0.104, 0.09), nose: prj(0, -0.01, 0.105),
  under: prj(0.032, -0.014, 0.084), lid: prj(0.031, 0.011, 0.085),
};
const ell = (P, ax, L, rx, ry, rz = Math.max(rx, ry)) => Math.hypot((ax - L.x) / rx, (P.y - L.y) / ry, (P.z - L.z) / rz);
function segDist(px, py, pz, A, B) {
  const bx = B.x - A.x, by = B.y - A.y, bz = B.z - A.z, h = clamp(((px - A.x) * bx + (py - A.y) * by + (pz - A.z) * bz) / (bx * bx + by * by + bz * bz), 0, 1);
  return [Math.hypot(px - A.x - bx * h, py - A.y - by * h, pz - A.z - bz * h), h];
}
function paintFace(sk, P, c) {
  const ax = Math.abs(P.x), tone = sk.tone;
  const mot = NZ.n3(P.x * 110, P.y * 110, P.z * 110) * 0.03 + NZ2.n3(P.x * 30, P.y * 30, P.z * 30) * 0.045;
  c[0] = tone[0] * (1 + mot); c[1] = tone[1] * (1 + mot * 1.1); c[2] = tone[2] * (1 + mot * 1.2);
  const tint = (col, k) => { c[0] = lerp(c[0], col[0], k); c[1] = lerp(c[1], col[1], k); c[2] = lerp(c[2], col[2], k); };
  const scale = k => { c[0] *= k; c[1] *= k; c[2] *= k; };
  // warm flush on cheeks, nose and chin, darker around the jaw/neck
  const red = Math.exp(-(ell(P, ax, LM.cheek, 0.03, 0.022) ** 2)) * 0.6 + Math.exp(-(ell(P, 0, LM.noseTip, 0.017, 0.016) ** 2)) * 0.45 + Math.exp(-(ell(P, 0, LM.chin, 0.02, 0.014) ** 2)) * 0.2;
  tint([c[0] * 1.05, c[1] * 0.8, c[2] * 0.78], red * (sk.blush ?? 0.5));
  if (P.y < -0.11) scale(1 - 0.12 * sstep(-0.11, -0.15, P.y));
  // eye area: lid crease shadow, under-eye, lash line, socket
  const ue = Math.exp(-(ell(P, ax, LM.under, 0.017, 0.0075) ** 2));
  tint([c[0] * 0.8, c[1] * 0.74, c[2] * 0.8], ue * 0.35 * (sk.tired ?? 1));
  const crease = Math.exp(-(ell(P, ax, LM.lid, 0.016, 0.0045) ** 2));
  scale(1 - crease * 0.12);
  const ee = ell(P, ax, LM.eye, 0.0148, 0.0082);
  const ring = Math.exp(-(((ee - 1) / 0.16) ** 2)) * (P.y > LM.eye.y - 0.003 ? 1 : 0.45);
  tint(mul3(sk.hair, 0.5), ring * 0.8);
  if (ee < 1) tint([0.18, 0.1, 0.09], 0.75);
  // eyebrows: a tapered stroke of short hairs
  const [bd, bh] = segDist(ax, P.y, P.z, LM.browIn, LM.browPk), [bd2, bh2] = segDist(ax, P.y, P.z, LM.browPk, LM.browOut);
  const bw = bd < bd2 ? lerp(0.0048, 0.0042, bh) * (sk.browW ?? 1) : lerp(0.0042, 0.0018, bh2) * (sk.browW ?? 1);
  const bdist = Math.min(bd, bd2), strokes = 0.6 + 0.4 * NZ.n3(P.x * 900, P.y * 260, P.z * 300);
  tint(sk.brow || sk.hair, sstep(bw, bw * 0.45, bdist) * 0.88 * strokes);
  // lips
  const lu = ell(P, 0, LM.ul, 0.0225, 0.0068), ll = ell(P, 0, LM.ll, 0.02, 0.0078);
  const lipK = Math.max(sstep(1.15, 0.75, lu), sstep(1.15, 0.75, ll));
  tint(sk.lip || [c[0] * 0.82, c[1] * 0.55, c[2] * 0.55], lipK * 0.75);
  const ml = Math.abs(P.y - LM.mouth.y) < 0.0016 && ax < 0.021 ? 1 : 0;
  tint([0.2, 0.08, 0.07], ml * 0.6);
  // stubble / beard shadow
  const yb = -0.044 + 0.012 * sstep(0.012, 0.035, ax) + Math.max(0, ax - 0.042);
  const bm = sstep(yb, yb - 0.01, P.y) * sstep(-0.035, 0.0, P.z + 0.02) * sstep(-0.19, -0.13, P.y) * (1 - lipK);
  if (sk.stubble) tint(mul3(sk.hair, 0.8), bm * sk.stubble * (0.55 + 0.45 * NZ.n3(P.x * 700, P.y * 700, P.z * 700)));
  // scalp under hair / hats
  const yh = 0.052 - 0.06 * sstep(0.05, -0.04, P.z) - 0.03 * sstep(0.055, 0.075, ax) * sstep(-0.01, 0.05, P.z);
  if (sk.scalp) tint(mul3(sk.hair, 0.85), sstep(yh - 0.004, yh + 0.006, P.y) * sk.scalp);
  // freckles over the nose and cheeks
  if (sk.freckles) {
    const area = Math.exp(-(((ax - 0.028) / 0.035) ** 2 + ((P.y + 0.018) / 0.025) ** 2)) * sstep(0.04, 0.08, P.z);
    const f = NZ.n3(P.x * 1400, P.y * 1400, P.z * 1400);
    if (f > 0.42) tint([c[0] * 0.72, c[1] * 0.55, c[2] * 0.42], area * sk.freckles * sstep(0.42, 0.55, f));
  }
  if (sk.wrinkles) { // forehead lines and crow's feet
    const fl = Math.abs(Math.sin(P.y * 900 + NZ.n3(P.x * 40, 0, 0) * 2)) < 0.12 && P.y > 0.03 && P.y < 0.06 && P.z > 0.05 ? 1 : 0;
    scale(1 - fl * 0.12 * sk.wrinkles);
    const cf = Math.exp(-(((ax - 0.05) / 0.01) ** 2 + (P.y / 0.012) ** 2)) * (Math.abs(Math.sin(Math.atan2(P.y, ax - 0.05) * 9)) < 0.3 ? 1 : 0);
    scale(1 - cf * 0.2 * sk.wrinkles);
  }
  if (sk.facePaint) sk.facePaint(P, ax, c, tint);
  if (sk.dirt) { const dn = sstep(0.1, 0.6, NZ2.n3(P.x * 50 + 3, P.y * 50, P.z * 50)); tint([0.25, 0.19, 0.13], dn * sk.dirt); }
}
function paintBody(sk, uu, vv, c) {
  const tone = sk.tone;
  let region = 'torso', s = uu / 0.45, t = vv / 0.48;
  if (uu >= 0.45 && uu < 0.5) { c[0] = 0.98; c[1] = 0.98; c[2] = 0.98; return; }
  if (uu >= 0.5 && uu < 0.75) { region = 'arm'; s = (uu - 0.5) / 0.25; }
  else if (uu >= 0.75) { region = 'leg'; s = (uu - 0.75) / 0.25; }
  const cs = Math.cos(s * TAU), sn = Math.sin(s * TAU);
  const mot = NZ.n3(cs * 9, sn * 9, t * 30) * 0.04 + NZ2.n3(cs * 2.5, sn * 2.5, t * 6) * 0.05;
  c[0] = tone[0] * (1 + mot); c[1] = tone[1] * (1 + mot * 1.1); c[2] = tone[2] * (1 + mot * 1.2);
  const tint = (col, k) => { c[0] = lerp(c[0], col[0], k); c[1] = lerp(c[1], col[1], k); c[2] = lerp(c[2], col[2], k); };
  if (sk.bodyPaint) sk.bodyPaint(region, s, t, cs, sn, c, tint);
  if (sk.dirt) {
    const lowK = region === 'leg' ? sstep(0.6, 0.0, t) : region === 'arm' ? sstep(0.5, 1, t) : 0.3;
    const dn = sstep(0.15, 0.7, NZ2.n3(cs * 6 + 7, sn * 6, t * 14) + lowK * 0.5);
    tint([0.24, 0.18, 0.12], dn * sk.dirt);
  }
}
function skinTexture(sk) {
  const W = 512, H = 512, cv = makeCanvas(W, H), g = cv.getContext('2d'), img = g.createImageData(W, H), D = img.data;
  const d = new V3(), P = new V3(), c = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const vv = 1 - (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const uu = (x + 0.5) / W;
      if (vv >= HV0 - 0.012) { headDir(uu, clamp((vv - HV0) / (HV1 - HV0), 0, 1), d); P.copy(HC).addScaledVector(d, 0.1); paintFace(sk, P, c); }
      else paintBody(sk, uu, vv, c);
      const i = (y * W + x) * 4; D[i] = clamp(c[0], 0, 1) * 255; D[i + 1] = clamp(c[1], 0, 1) * 255; D[i + 2] = clamp(c[2], 0, 1) * 255; D[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = toTex(cv, { repeat: false }); t.wrapS = THREE.RepeatWrapping; return t;
}

/* --------------- materials: vertex alpha = roughness --------------- */
function roughFromAlpha(m, key) {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n#ifdef USE_COLOR_ALPHA\n  roughnessFactor = clamp(roughnessFactor * vColor.a, 0.04, 1.0);\n#endif');
    if (key === 'skin') { // soft wrap lighting: a little light bleeds past the terminator, warm (cheap subsurface)
      sh.fragmentShader = sh.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n  reflectedLight.indirectDiffuse += diffuseColor.rgb * vec3(0.10, 0.035, 0.02) * (1.0 - clamp(dot(normal, vec3(0.0,0.0,1.0)), 0.0, 1.0));');
    }
  };
  m.customProgramCacheKey = () => 'ppl-' + key;
  return m;
}
let MATS = null;
function sharedMats() {
  if (MATS) return MATS;
  const cl = clothTex(), hd = hideTex(), hr = hairTex();
  const mk = (t, key, ns) => { const m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, vertexColors: true, roughness: 1, metalness: 0 }); m.normalScale.set(ns, ns); return roughFromAlpha(m, key); };
  MATS = { cloth: mk(cl, 'cloth', 0.7), hide: mk(hd, 'hide', 0.9), hair: mk(hr, 'hair', 1.0) };
  return MATS;
}
function skinMat(tex) {
  const p = poreTex();
  const m = new THREE.MeshStandardMaterial({ map: tex, normalMap: p.normalMap, vertexColors: true, roughness: 1, metalness: 0 });
  m.normalMap.repeat.set(5, 5); m.normalScale.set(0.2, 0.2);
  return roughFromAlpha(m, 'skin');
}

/* =====================================================================================
   RIG: skeleton definition from body proportions (bind pose: arms slightly abducted)
   ===================================================================================== */
const ABD = 0.2;
const FING = [ // hand-local (left hand: fingers -Y, palm -X, thumb +Z), metres
  { k: [0.0, -0.090, 0.0285], L: [0.043, 0.025, 0.021], r: 0.0094 },
  { k: [0.0, -0.095, 0.0095], L: [0.047, 0.029, 0.022], r: 0.0097 },
  { k: [0.0, -0.092, -0.0095], L: [0.044, 0.027, 0.021], r: 0.0092 },
  { k: [0.001, -0.084, -0.027], L: [0.035, 0.021, 0.019], r: 0.0082 },
];
const THUMB = { k: [-0.008, -0.021, 0.019], L: [0.042, 0.032, 0.027], r: 0.0112, d: [[-0.36, -0.68, 0.64], [-0.3, -0.8, 0.52], [-0.26, -0.86, 0.44]] };
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vadd = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mx = (v, g) => [v[0] * g, v[1], v[2]];
const mAxis = (a, g) => (g > 0 ? [a.x, a.y, a.z] : [a.x, -a.y, -a.z]);
function fingerJoints(hs) {
  const f = FING.map(F => {
    const dir = new V3(0, -1, F.k[2] * 0.5).normalize();
    const j = [new V3(...F.k).multiplyScalar(hs)];
    for (let s = 0; s < 3; s++) j.push(j[s].clone().addScaledVector(dir, F.L[s] * hs));
    return { j, dir, r: F.r * hs, axis: new V3().crossVectors(dir, new V3(-1, 0, 0)).normalize() };
  });
  const d = THUMB.d.map(v => new V3(...v).normalize());
  const j = [new V3(...THUMB.k).multiplyScalar(hs)];
  for (let s = 0; s < 3; s++) j.push(j[s].clone().addScaledVector(d[s], THUMB.L[s] * hs));
  const flex = new V3(-0.62, -0.12, -0.78).normalize();
  return { f, t: { j, d, r: THUMB.r * hs, axis: new V3().crossVectors(d[0], flex).normalize() } };
}
/** finger + thumb bone defs under parent hand bone */
function handBoneDefs(defs, S, g, FJ) {
  const arr = v => [v.x * g, v.y, v.z];
  FJ.f.forEach((f, i) => { for (let k = 0; k < 3; k++) defs.push({ name: `f${i}${k}${S}`, parent: k ? `f${i}${k - 1}${S}` : 'hand' + S, l: arr(k ? f.j[k].clone().sub(f.j[k - 1]) : f.j[0]), tl: arr(f.j[k + 1].clone().sub(f.j[k])), axis: mAxis(f.axis, g) }); });
  const t = FJ.t; for (let k = 0; k < 3; k++) defs.push({ name: `t${k}${S}`, parent: k ? `t${k - 1}${S}` : 'hand' + S, l: arr(k ? t.j[k].clone().sub(t.j[k - 1]) : t.j[0]), tl: arr(t.j[k + 1].clone().sub(t.j[k])), axis: mAxis(t.axis, g) });
}
function buildRig(defs) {
  const bones = [], index = {}, root = new THREE.Object3D(), out = [];
  for (const d of defs) {
    const b = new THREE.Bone(); b.name = d.name;
    const parent = d.parent ? bones[index[d.parent]] : root;
    if (d.r) b.rotation.set(d.r[0], d.r[1], d.r[2]);
    parent.add(b);
    if (d.l) b.position.set(...d.l);
    else { parent.updateMatrixWorld(true); b.position.copy(new V3(...d.w).applyMatrix4(parent.matrixWorld.clone().invert())); }
    b.updateMatrixWorld(true);
    index[d.name] = bones.length; bones.push(b);
  }
  root.updateMatrixWorld(true);
  const segs = {}, world = {};
  defs.forEach((d, i) => {
    const b = bones[i]; world[d.name] = b.matrixWorld.clone();
    const a = new V3().setFromMatrixPosition(b.matrixWorld);
    const t = d.tw ? new V3(...d.tw) : d.tl ? new V3(...d.tl).applyMatrix4(b.matrixWorld) : a.clone().add(new V3(0, 0.02, 0));
    segs[d.name] = { a, b: t, i };
    out.push({ name: d.name, parent: d.parent ? index[d.parent] : -1, pos: b.position.clone(), quat: b.quaternion.clone(), axis: d.axis ? new V3(...d.axis) : null });
  });
  return { defs: out, index, segs, world };
}
/** body proportions -> joints + rig.  o: H height, sw shoulder width, hw hip width, hs hand, ks head scale */
function makeBody(o = {}) {
  const H = o.H ?? 1.8, s = H / 1.8, sw = o.sw ?? 1, hw = o.hw ?? 1, hs = (o.hs ?? 1) * s, ks = o.ks ?? 1;
  const J = {
    hips: [0, 0.975 * s, 0], spine: [0, 1.09 * s, -0.01], chest: [0, 1.27 * s, -0.015], neck: [0, 1.495 * s, -0.03], head: [0, 1.595 * s, -0.012], headTop: [0, 1.8 * s, -0.01],
    clav: [0.022 * sw, 1.455 * s, 0.0], shoulder: [0.185 * sw, 1.445 * s, -0.025],
    hip: [0.092 * hw, 0.925 * s, 0], knee: [0.092 * hw, 0.505 * s, 0], ankle: [0.092 * hw, 0.085 * s, 0],
  };
  J.ball = [J.hip[0] + 0.006, 0.025, 0.125 * s]; J.toe = [J.hip[0] + 0.008, 0.02, 0.19 * s];
  const Lu = 0.29 * s * (o.arm ?? 1), Lf = 0.255 * s * (o.arm ?? 1), ad = [Math.sin(ABD), -Math.cos(ABD), 0];
  J.elbow = vadd(J.shoulder, ad, Lu); J.wrist = vadd(J.elbow, ad, Lf);
  const defs = [], D = (name, parent, w, r, tw) => defs.push({ name, parent, w, r, tw });
  D('hips', null, J.hips, 0, J.spine); D('spine', 'hips', J.spine, 0, J.chest); D('chest', 'spine', J.chest, 0, J.neck);
  D('neck', 'chest', J.neck, 0, J.head); D('head', 'neck', J.head, 0, J.headTop);
  const FJ = fingerJoints(hs);
  for (const [S, g] of [['L', 1], ['R', -1]]) {
    D('clav' + S, 'chest', mx(J.clav, g), 0, mx(J.shoulder, g));
    D('arm' + S, 'clav' + S, mx(J.shoulder, g), [0, 0, g * ABD], mx(J.elbow, g));
    D('fore' + S, 'arm' + S, mx(J.elbow, g), 0, mx(J.wrist, g));
    defs.push({ name: 'hand' + S, parent: 'fore' + S, w: mx(J.wrist, g), tl: [0, -0.095 * hs, 0.005] });
    handBoneDefs(defs, S, g, FJ);
    D('thigh' + S, 'hips', mx(J.hip, g), 0, mx(J.knee, g)); D('shin' + S, 'thigh' + S, mx(J.knee, g), 0, mx(J.ankle, g));
    D('foot' + S, 'shin' + S, mx(J.ankle, g), 0, mx(J.ball, g)); D('toe' + S, 'foot' + S, mx(J.ball, g), 0, mx(J.toe, g));
  }
  const rig = buildRig(defs);
  return { o, s, sw, hw, hs, ks, J, Lu, Lf, Lt: J.hip[1] - J.knee[1], Ls: J.knee[1] - J.ankle[1], headO: [0, J.head[1] + 0.105 * ks, 0.0], rig, FJ };
}

/* =====================================================================================
   SKINNING + KIT (collects parts per material, bakes skinned geometry)
   ===================================================================================== */
function segDistV(p, a, b) {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z, l2 = bx * bx + by * by + bz * bz;
  const h = l2 > 0 ? clamp(((p.x - a.x) * bx + (p.y - a.y) * by + (p.z - a.z) * bz) / l2, 0, 1) : 0;
  return Math.hypot(p.x - a.x - bx * h, p.y - a.y - by * h, p.z - a.z - bz * h);
}
const swapName = n => (n.endsWith('L') ? n.slice(0, -1) + 'R' : n);
function swapSkin(skin) {
  if (typeof skin === 'function') { const q = new V3(); return v => skin(q.set(-v.x, v.y, v.z)).map(([n, w]) => [swapName(n), w]); }
  return skin.map(e => (typeof e === 'string' ? swapName(e) : [swapName(e[0]), e[1]]));
}
function skinWeights(g, skin, rig) {
  const p = g.attributes.position, n = p.count, SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4), v = new V3();
  const spec = typeof skin === 'function' ? null : skin.map(e => (typeof e === 'string' ? [e, 1] : e));
  const L = [];
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(p, i); L.length = 0;
    if (spec) for (const [name, f] of spec) { const sg = rig.segs[name]; if (!sg) throw new Error('no bone ' + name); const d = Math.max(segDistV(v, sg.a, sg.b), 0.004); L.push([sg.i, f / d ** 6]); }
    else for (const [name, w] of skin(v)) { if (w > 0) { if (rig.index[name] === undefined) throw new Error('no bone ' + name); L.push([rig.index[name], w]); } }
    L.sort((x, y) => y[1] - x[1]);
    let tot = 0; for (let k = 0; k < 4 && k < L.length; k++) tot += L[k][1];
    for (let k = 0; k < 4; k++) { if (k < L.length && tot > 0) { SI[i * 4 + k] = L[k][0]; SW[i * 4 + k] = L[k][1] / tot; } }
    if (!L.length) SW[i * 4] = 1;
  }
  return { SI, SW };
}
function mergeSkinned(list) {
  const g = mergeSimple(list.map(e => e.geo)), n = g.attributes.position.count;
  const SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4); let o = 0;
  for (const e of list) { SI.set(e.SI, o * 4); SW.set(e.SW, o * 4); o += e.geo.attributes.position.count; }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(SI, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(SW, 4));
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
class Kit {
  constructor(B) { this.B = B; this.parts = { skin: [], cloth: [], hair: [], hide: [] }; }
  add(mat, geo, skin, mirror = false) {
    this.parts[mat].push({ geo, skin });
    if (mirror) this.parts[mat].push({ geo: mirrorGeo(geo), skin: swapSkin(skin) });
    return geo;
  }
  bake(rig) {
    const out = {};
    for (const k in this.parts) {
      const list = this.parts[k]; if (!list.length) continue;
      out[k] = mergeSkinned(list.map(e => ({ geo: e.geo, ...skinWeights(e.geo, e.skin, rig) })));
    }
    return out;
  }
}
const triCount = g => (g.index ? g.index.count : g.attributes.position.count) / 3;

/* =====================================================================================
   ANATOMY PIECES
   ===================================================================================== */
const P3 = a => new V3(a[0], a[1], a[2]);
/** head skin weights: face follows the head bone, the neck blends to the chest */
function headSkin(B) {
  const yN = B.J.neck[1], yH = B.J.head[1];
  return v => {
    const wH = sstep(yN + 0.03 * B.s, yH + 0.005, v.y + 0.35 * Math.max(0, v.z)), wC = sstep(yN, yN - 0.07, v.y);
    return [['head', wH], ['neck', (1 - wH) * (1 - wC)], ['chest', (1 - wH) * wC]];
  };
}
function addHead(K, hp) {
  const B = K.B, F = headSDF(hp), O = P3(B.headO), ks = B.ks, d = new V3(), p = new V3(), nn = new V3();
  K.F = F;
  const g = grid(hp.nu ?? 42, hp.nv ?? 36, (u, v, o) => {
    headDir(u, v, d); const t = march(F, HC, d); p.copy(HC).addScaledVector(d, t);
    sdfNormal(F, p, nn); const ao = sdfAO(F, p, nn);
    o.x = O.x + p.x * ks; o.y = O.y + p.y * ks; o.z = O.z + p.z * ks;
    o.u = u; o.v = HV0 + (HV1 - HV0) * v;
    o.r = o.g = o.b = ao;
    const ax = Math.abs(p.x);
    o.a = (p.y < -0.054 && p.y > -0.08 && ax < 0.022 && p.z > 0.08) ? 0.38 : (ax < 0.02 && p.y < 0.0 && p.y > -0.045 && p.z > 0.09) ? 0.45 : 0.6;
  });
  K.add('skin', finish(g, O.clone().addScaledVector(HC, ks)), headSkin(B));
  // eyeballs: sclera, limbal ring, iris with radial fibres, pupil; glossy
  const iris = hp.iris || hexc(0x5a4632);
  for (const sg of [1, -1]) {
    const c = new V3(EYE[0] * sg, EYE[1], EYE[2]).multiplyScalar(ks).add(O), fw = new V3(0.07 * sg, -0.02, 1).normalize();
    const S = new V3(0, 1, 0).cross(fw).normalize(), U = fw.clone().cross(S);
    const eg = grid(14, 9, (u, v, o) => {
      const th = u * TAU, ph = v * PI, sp = Math.sin(ph);
      const dd = fw.clone().multiplyScalar(Math.cos(ph)).addScaledVector(S, sp * Math.cos(th)).addScaledVector(U, sp * Math.sin(th));
      o.x = c.x + dd.x * EYE_R * ks; o.y = c.y + dd.y * EYE_R * ks; o.z = c.z + dd.z * EYE_R * ks;
      o.u = UV_WHITE[0]; o.v = UV_WHITE[1]; o.a = 0.06;
      let col;
      if (ph < 0.17) col = [0.01, 0.01, 0.01];
      else if (ph < 0.5) { const fib = 0.75 + 0.25 * Math.sin(th * 23) * Math.sin(th * 7); col = mul3(iris, fib * lerp(0.7, 1.15, (ph - 0.17) / 0.33)); }
      else if (ph < 0.56) col = mul3(iris, 0.3);
      else col = mix3([0.78, 0.72, 0.66], [0.62, 0.42, 0.4], sstep(1.2, 2.2, ph));
      o.r = col[0]; o.g = col[1]; o.b = col[2];
    });
    K.add('skin', finish(eg, c), [['head', 1]]);
  }
  // ears: a flattened shell with a helix rim, concha bowl and lobe
  const eo = new V3(0.0735, -0.008, -0.014);
  const ear = grid(12, 10, (u, v, o) => {
    const th = (u - 0.5) * TAU, ph = (v - 0.5) * PI, cp = Math.cos(ph);
    let x = cp * Math.cos(th), y = Math.sin(ph), z = cp * Math.sin(th);
    const r2 = y * y + z * z;
    let rx = 0.0105, ry = 0.031, rz = 0.019;
    if (y < -0.45) rz *= lerp(1, 0.65, (-0.45 - y) / 0.55);               // lobe narrows
    let X = x * rx, Y = y * ry, Z = z * rz;
    if (x > 0) X -= 0.0075 * Math.max(0, 1 - r2 * 1.25) * sstep(-0.9, -0.2, y);   // concha bowl
    X += 0.003 * sstep(0.6, 0.95, r2) * (x > 0 ? 1 : 0);                   // helix rim curls out
    // rotate: flare back from the head, tilt
    const a = 0.32, b = -0.15;
    let X2 = X * Math.cos(a) - Z * Math.sin(a) * 0.3, Z2 = Z * Math.cos(a) + X * Math.sin(a);
    const Y2 = Y * Math.cos(b) - Z2 * Math.sin(b), Z3 = Z2 * Math.cos(b) + Y * Math.sin(b);
    o.x = O.x + (eo.x + X2) * ks; o.y = O.y + (eo.y + Y2) * ks; o.z = O.z + (eo.z + Z3) * ks;
    o.u = UV_EAR[0]; o.v = UV_EAR[1];
    const ao = x > 0 ? lerp(0.55, 1, sstep(0.2, 0.9, r2)) : 0.85;
    o.r = ao * 1.03; o.g = ao * 0.93; o.b = ao * 0.92; o.a = 0.55;
  });
  K.add('skin', finish(ear, O.clone().add(new V3(0.065 * ks, -0.008 * ks, -0.01 * ks))), [['head', 1]], true);
}
/** shell hugging the head SDF (hats, hair, beards, masks). dirFn(u,v,d,j,nv); offFn(u,v,d,j) -> metres; vert(u,v,p,d,o) colours */
function headShell(K, nu, nv, dirFn, offFn, vert) {
  const B = K.B, F = K.F, O = P3(B.headO), ks = B.ks, d = new V3(), p = new V3();
  const g = grid(nu, nv, (u, v, o, i, j) => {
    dirFn(u, v, d, j, nv, i, nu);
    const t = march(F, HC, d, offFn(u, v, d, j, nv, i, nu), 0.5);
    p.copy(HC).addScaledVector(d, t);
    if (vert) vert(u, v, p, d, o, j, i);
    o.x = O.x + p.x * ks; o.y = O.y + p.y * ks; o.z = O.z + p.z * ks;
  });
  return finish(g, O.clone().addScaledVector(HC, ks));
}
/** cap-shaped direction field from the crown; psiMax(phi) = edge angle from the top (phi 0 = front) */
const capDir = psiMax => (u, v, d, j, nv) => {
  const phi = TAU * (u - 0.5), psi = Math.min(1, j / (nv - 1)) * psiMax(phi);
  d.set(Math.sin(psi) * Math.sin(phi), Math.cos(psi), Math.sin(psi) * Math.cos(phi));
};

/* ---------- hands: palm, 4 fingers x 3 phalanges, thumb; nails, knuckle creases ---------- */
function handGeos(B, o = {}) {
  const FJ = B.FJ, hs = B.hs, det = o.detail ?? 0, rad = det ? 10 : 6, sub = det ? 3 : 1;
  const out = [], tone = [1, 1, 1];
  // palm
  const pst = [
    { p: [0.0, 0.012, 0.002], rx: 0.019, rf: 0.026, rb: 0.026 },
    { p: [-0.001, -0.015, 0.003], rx: 0.0178, rf: 0.034, rb: 0.033 },
    { p: [-0.002, -0.045, 0.002], rx: 0.0168, rf: 0.041, rb: 0.037 },
    { p: [-0.002, -0.074, 0.001], rx: 0.0152, rf: 0.042, rb: 0.037 },
    { p: [-0.0005, -0.092, 0.001], rx: 0.0128, rf: 0.04, rb: 0.035 },
  ].map(s => ({ p: s.p.map(x => x * hs / B.s * B.s), rx: s.rx * hs, rf: s.rf * hs, rb: s.rb * hs }));
  const palmVert = (t, dir, a, oo) => {
    if (dir.x < 0) oo.m = 1 + 0.12 * (-dir.x) * Math.sin(t * PI);            // padded palm side
    if (dir.x > 0.4 && t > 0.75) oo.m *= 1 + 0.06 * Math.abs(Math.sin(dir.z * 9));   // knuckle row
    const ao = dir.x < -0.6 ? 0.85 : 1; oo.r = ao * tone[0]; oo.g = ao * tone[1]; oo.b = ao * tone[2]; oo.a = 0.55;
  };
  out.push({ g: loft(pst, { radial: det ? 16 : 10, sub: det ? 3 : 2, sq: 2.6, cap1: true, dome: 0.5, vert: palmVert, uvRect: [UV_HAND[0], UV_HAND[1], UV_HAND[0] + 0.01, UV_HAND[1] + 0.01] }), skin: [['handL', 1], ['foreL', 0.15], ['f00L', 0.12], ['f10L', 0.12], ['f20L', 0.12], ['f30L', 0.12], ['t0L', 0.35]] });
  // fingers: q runs 0 (inside the palm) .. 1 MCP .. 3 PIP .. 5 DIP .. 7 tip
  const gl = o.glove, uvH = [UV_HAND[0], UV_HAND[1], UV_HAND[0] + 0.01, UV_HAND[1] + 0.01];
  const digit = (j, dir, r, names, nailDir, rrK, thumb) => {
    const back = thumb ? 0.018 * hs : 0.009 * hs, tipIn = r * 0.55;
    const P = q => q <= 1 ? j[0].clone().addScaledVector(dir, -back * (1 - q)) : q <= 3 ? j[0].clone().lerp(j[1], (q - 1) / 2) : q <= 5 ? j[1].clone().lerp(j[2], (q - 3) / 2) : j[2].clone().lerp(j[3], (q - 5) / 2).addScaledVector(dir, -tipIn * (q - 5) / 2);
    const R = q => { const i = Math.min(6, Math.floor(q)), f = q - i; return lerp(rrK[i], rrK[i + 1], f) * r; };
    const skin = [[names[0], 1], [names[1], 1], [names[2], 1], ['handL', thumb ? 0.8 : 0.5]];
    const part = (qs, grow, mat, cap) => {
      const st = qs.map(q => { const p = P(q), rr = R(q) * grow + (grow > 1 ? 0.0006 : 0); return { p: [p.x, p.y, p.z], rx: rr * (thumb ? 0.9 : 0.86), rf: rr, rb: rr }; });
      return { g: loft(st, {
        radial: rad, sub, cap1: cap, dome: 0.9, fw: [0, 0, 1], uvRect: mat === 'skin' ? uvH : null, ts: 0.18,
        vert: (t, d, a, oo, rg) => {
          const q = interpK(qs, rg.s), dors = d.dot(nailDir);
          let ao = 1, m = 1;
          if (dors < -0.3 && q > 1) m += 0.06 * Math.max(0, Math.sin(((q - 1) % 2) * PI)) * (-dors);          // pads
          for (const jq of [3, 5]) { const e = Math.exp(-(((q - jq) / 0.16) ** 2)); if (dors > 0.2) { m += e * 0.05; ao -= e * 0.22 * (0.6 + 0.4 * Math.abs(Math.sin(a * 5))); } else ao -= e * 0.32; }
          if (q < 1.3) ao *= 0.78 + 0.22 * sstep(0.3, 1.3, q);
          oo.m = m;
          if (mat === 'cloth') {                                   // leather finger sleeve with a rolled, stitched hem
            const hem = sstep(qs[qs.length - 1] - 0.35, qs[qs.length - 1], q), seam = Math.abs(d.z) > 0.94 ? 0.7 : 1;
            const wear = dors > 0.5 && q < 1.6 ? 1.35 : 1;
            oo.m = m * (1 + hem * 0.06); ao *= seam * (1 - hem * 0.35) * wear;
            oo.r = gl[0] * ao; oo.g = gl[1] * ao; oo.b = gl[2] * ao; oo.a = dors > 0.5 && q < 1.6 ? 0.45 : 0.62;
            return;
          }
          oo.r = ao; oo.g = ao * 0.97; oo.b = ao * 0.96; oo.a = 0.55;
          if (q > 5.55 && dors > 0.42) {                           // fingernail with a pale free edge
            const edge = q > 6.7 ? 1.14 : 1, k = sstep(0.42, 0.58, dors);
            oo.m *= 1 - 0.05 * k; oo.r = lerp(oo.r, 1.06 * edge, k); oo.g = lerp(oo.g, 0.88 * edge, k); oo.b = lerp(oo.b, 0.86 * edge, k); oo.a = lerp(0.55, 0.25, k);
            if (Math.abs(dors - 0.5) < 0.06) { oo.r *= 0.8; oo.g *= 0.75; oo.b *= 0.75; }  // cuticle line
          }
        },
      }), skin, mat };
    };
    if (!gl) return [part([0, 1, 2, 3, 4, 5, 6, 7], 1, 'skin', true)];
    return [part([0, 1, 2, 3, thumb ? 3.9 : 3.7], 1.1, 'cloth', false), part([3.3, 4, 5, 6, 7], 1, 'skin', true)];
  };
  FJ.f.forEach((f, i) => out.push(...digit(f.j, f.dir, f.r * 0.94, [`f${i}0L`, `f${i}1L`, `f${i}2L`], new V3(1, 0, 0), [0.95, 1.08, 0.97, 1.02, 0.92, 0.93, 0.86, 0.7], false)));
  { const t = FJ.t; out.push(...digit(t.j, t.d[0], t.r, ['t0L', 't1L', 't2L'], new V3(0.62, 0.15, 0.77).normalize(), [1.45, 1.55, 1.38, 1.08, 1.02, 0.98, 0.92, 0.72], true)); }
  if (gl) { // glove body over the palm + a velcro wrist strap
    out[0].mat = 'cloth';
    out[0].g = loft(pst.map(s => ({ ...s, rx: s.rx + 0.0013, rf: s.rf + 0.0013, rb: s.rb + 0.0013 })), { radial: det ? 16 : 10, sub: det ? 3 : 2, sq: 2.6, cap1: true, dome: 0.5, ts: 0.18,
      vert: (t, d, a, oo) => {
        palmVert(t, d, a, oo);
        let ao = dir2ao(d), r = 0.6;
        if (Math.abs(d.z) > 0.93) ao *= 0.65;                                         // side seams
        if (d.x > 0.3 && Math.abs(t - 0.45) < 0.03) ao *= 0.7;                        // stitched panel across the back
        if (d.x < -0.3 && t > 0.15 && t < 0.8) { ao *= 0.8; r = 0.75; }               // suede palm patch
        if (d.x > 0.4 && t > 0.8) { ao *= 1.3; r = 0.45; }                            // worn shiny knuckles
        oo.r = gl[0] * ao; oo.g = gl[1] * ao; oo.b = gl[2] * ao; oo.a = r;
      } });
    out.push({ g: loft([0.045, 0.03, 0.012, 0.0].map((y, i) => ({ p: [0, y * hs, 0.002], rx: [0.0255, 0.0262, 0.0255, 0.0225][i] * hs, rf: [0.0335, 0.0345, 0.0335, 0.031][i] * hs, rb: [0.0335, 0.0345, 0.0335, 0.031][i] * hs })), {
      radial: det ? 18 : 10, sub: 2, ts: 0.06, vert: (t, d, a, oo) => {
        const tab = d.x > 0.35 && d.z > -0.5 ? 1 : 0, rib = 0.9 + 0.1 * Math.abs(Math.sin(t * 40));
        oo.m = 1 + tab * 0.08; const k = (tab ? 0.55 : 1) * rib * (t < 0.08 || t > 0.92 ? 0.7 : 1);
        oo.r = (tab ? 0.12 : gl[0]) * k + (tab ? 0 : 0); oo.g = (tab ? 0.12 : gl[1]) * k; oo.b = (tab ? 0.12 : gl[2]) * k; oo.a = tab ? 0.9 : 0.6;
      } }), skin: [['handL', 1], ['foreL', 0.8]], mat: 'cloth' });
  }
  return out;
}
const dir2ao = d => (d.x < -0.6 ? 0.88 : 1);
function addHands(K, o = {}) {
  const B = K.B, M = B.rig.world.handL;
  for (const h of handGeos(B, o)) K.add(h.mat || 'skin', tf(h.g, M), h.skin, true);
}

/* ---------- garment lofts along the skeleton ---------- */
/** torso weights by height + shoulder blend (explicit so long hems stay with the hips) */
function torsoSkin(B, thigh = 0.05) {
  const s = B.s, sw = B.sw;
  return v => {
    const y = v.y / s, wH = sstep(1.17, 0.98, y), wC = sstep(1.12, 1.32, y), wS = Math.max(0, 1 - wH - wC);
    const out = [['hips', wH], ['spine', wS], ['chest', wC * (1 - sstep(1.47, 1.55, y) * 0.6)], ['neck', wC * sstep(1.47, 1.55, y) * 0.6]];
    for (const [S, g] of [['L', 1], ['R', -1]]) {
      const xs = v.x * g, k = sstep(0.08 * sw, 0.19 * sw, xs) * sstep(1.28, 1.42, y);
      out.push(['clav' + S, k * 0.6], ['arm' + S, k * 0.5 * sstep(0.14 * sw, 0.21 * sw, xs)]);
      if (thigh) out.push(['thigh' + S, thigh * sstep(0.95, 0.75, y) * sstep(-0.02, 0.1, xs) * 3]);
    }
    return out;
  };
}
/** torso stations [y, rx, rf, rb, z] (1.8 m units) -> loft stations scaled to the body */
function torsoStations(B, rows, grow = 0) {
  return rows.map(([y, rx, rf, rb, z]) => {
    const w = lerp(B.hw, B.sw, sstep(1.0, 1.35, y));
    return { p: [0, y * B.s, (z ?? 0) * B.s], rx: rx * w + grow, rf: rf * w + grow, rb: rb * w + grow };
  });
}
/** points along the left arm chain: k in [-0.12 .. 1.05], 0 = shoulder, 0.5 = elbow, 1 = wrist */
function armPoint(B, k) {
  const sh = P3(B.J.shoulder), el = P3(B.J.elbow), wr = P3(B.J.wrist);
  if (k < 0) return sh.clone().add(new V3(-0.06 * -k / 0.12 * B.sw, 0.03 * -k / 0.12, 0));
  return k <= 0.5 ? sh.lerp(el, k * 2) : el.lerp(wr, (k - 0.5) * 2);
}
function legPoint(B, k) { // 0 hip joint, 0.5 knee, 1 ankle; negative goes up into the pelvis
  const hp = P3(B.J.hip), kn = P3(B.J.knee), an = P3(B.J.ankle);
  if (k < 0) return hp.clone().add(new V3(-0.012, -k * 0.6, 0));
  return k <= 0.5 ? hp.lerp(kn, k * 2) : kn.lerp(an, (k - 0.5) * 2);
}
/** a garment tube along a chain: pts [[k, rx, rf, rb]], pointFn = armPoint|legPoint */
function chainLoft(B, pointFn, rows, o) {
  const st = rows.map(([k, rx, rf, rb]) => { const p = pointFn(B, k); return { p: [p.x, p.y, p.z], rx: rx * (o.bulk ?? 1), rf: (rf ?? rx) * (o.bulk ?? 1), rb: (rb ?? rf ?? rx) * (o.bulk ?? 1) }; });
  return loft(st, o);
}
/** folds: ring wrinkles around a station with a wobble; returns -1..1 */
function foldWave(t, a, c, w, freq, seed = 0) {
  const env = Math.exp(-(((t - c) / w) ** 2));
  return env * Math.sin((t - c) * freq + 1.3 * Math.sin(a * 2 + seed) + 0.8 * Math.sin(a * 3.7 + seed * 2));
}
/** generic garment vertex shader: colour, roughness, folds, noise, AO from folds */
function garment(col, rough, o = {}) {
  return (t, dir, a, out, rg) => {
    let m = 1, ao = 1, cc = col;
    if (o.color) cc = o.color(t, dir, a, rg) || col;
    if (o.folds) for (const f of o.folds) { const w = foldWave(t, a, f[0], f[1], f[2], f[4] ?? 0) * (f[5] ? Math.max(0, f[5] === 'front' ? dir.z : -dir.z) * 1.4 : 1); m += w * f[3]; ao -= Math.max(0, -w) * f[3] * 9; }
    const nz = NZ.n3(rg.c.x * 6 + dir.x * 2, rg.c.y * 6 + t * 3, rg.c.z * 6 + dir.z * 2);
    m += nz * (o.noise ?? 0.02);
    ao -= Math.max(0, -nz) * 0.12;
    if (o.shape) m *= o.shape(t, dir, a, rg);
    let rr = rough;
    if (o.mod) { const r = o.mod(t, dir, a, rg, out); if (r) { if (r.col) cc = r.col; if (r.ao) ao *= r.ao; if (r.rough) rr = r.rough; if (r.off) out.off += r.off; } }
    if (o.endsDark) ao *= lerp(0.72, 1, sstep(0, o.endsDark, t)) * lerp(0.72, 1, sstep(1, 1 - o.endsDark, t));
    out.m = m; ao = clamp(ao, 0.35, 1.1);
    out.r = cc[0] * ao; out.g = cc[1] * ao; out.b = cc[2] * ao; out.a = rr;
  };
}

/* @@PART3 */

/* =====================================================================================
   LOOKS (survivors): skin/hair in sRGB for the painted atlas, garments as hex
   ===================================================================================== */
const LOOKS = [
  { body: { H: 1.83, sw: 1.04 }, head: { jaw: 1.12, brow: 1.15, chin: 1.05, nose: 1.05 }, sk: { tone: [0.8, 0.6, 0.48], hair: [0.3, 0.2, 0.13], stubble: 0.6, blush: 0.45, scalp: 1 }, iris: 0x4f6f8f,
    style: 'shell', jacket: 0xb3401e, panel: 0x2c2e31, under: 0x5b5e63, glove: 0x2b2826, trousers: 0x2d2c29, boots: 0x5e4129, pack: 0x323d35, hat: 0x6e6c69, watch: true },
  { body: { H: 1.70, sw: 0.9, hw: 1.04, hs: 0.92 }, head: { jaw: 0.86, brow: 0.72, chin: 0.9, nose: 0.9, noseW: 0.88, lips: 1.15, w: 0.96, neck: 0.88, cheek: 1.06 }, ks: 0.95, sk: { tone: [0.87, 0.68, 0.58], hair: [0.24, 0.14, 0.08], blush: 0.75, lip: [0.66, 0.36, 0.36], browW: 0.8, scalp: 1 }, iris: 0x5c3f2a,
    style: 'parka', jacket: 0x4f5536, panel: 0x3e4229, under: 0x7a2430, fur: 0x8a7a64, trousers: 0x262c3d, boots: 0x6b4a2e, pack: 0x5a4632 },
  { body: { H: 1.80, sw: 1.0 }, head: { noseW: 1.22, lips: 1.22, nose: 0.98, jaw: 1.02, brow: 1.02 }, sk: { tone: [0.45, 0.3, 0.22], hair: [0.07, 0.05, 0.045], blush: 0.2, lip: [0.36, 0.2, 0.18], scalp: 1, stubble: 0.25 }, iris: 0x3a2416,
    style: 'puffer', jacket: 0x1d2a4c, panel: 0x141c33, under: 0x3a3d42, trousers: 0x8a7a58, boots: 0x1e1e1e, pack: 0x4a4d52, glasses: 0x141414 },
  { body: { H: 1.76, sw: 0.97 }, head: { jaw: 0.95, nose: 0.95, w: 0.98, lips: 1.05 }, sk: { tone: [0.95, 0.78, 0.68], hair: [0.62, 0.3, 0.13], freckles: 1, blush: 0.85, browW: 0.85, scalp: 1 }, iris: 0x5d7a52,
    style: 'rain', jacket: 0xe8b416, panel: 0xc99a10, under: 0x3c4252, trousers: 0x3a4250, boots: 0x2f4a35, pack: 0x1f4f86, pad: 0xd8641e, hat: 0xa31c18 },
];

/* =====================================================================================
   IK (shared by the body animator and the first-person arms)
   ===================================================================================== */
const _M4 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
/** two-bone chain hanging along local -Y. Returns the bend angle; outQ = upper bone rotation in the root's frame.
    zSign -1: the lower bone bends toward local +Z (elbow), +1: toward -Z (knee); the joint points toward pole. */
function twoBone(root, target, a, b, pole, zSign, outQ) {
  const D = new V3().subVectors(target, root), dl = D.length(), n = D.clone().divideScalar(dl || 1);
  const d = clamp(dl, Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), A = Math.acos(cosA);
  const perp = pole.clone().addScaledVector(n, -n.dot(pole));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, 1).addScaledVector(n, -n.z);
  perp.normalize();
  const U = n.clone().multiplyScalar(cosA).addScaledVector(perp, Math.sin(A));
  const bend = PI - Math.acos(clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1));
  const Y = U.clone().negate(), Z = perp.clone().multiplyScalar(zSign);
  Z.addScaledVector(Y, -Y.dot(Z)).normalize();
  const X = new V3().crossVectors(Y, Z);
  outQ.setFromRotationMatrix(_M4.makeBasis(X, Y, Z));
  return bend;
}
/** hand orientation from thumb direction (= item handle, anchor +Y) and palm normal, canonical LEFT hand */
function handQuat(thumb, palm, out) {
  const Z = thumb.clone().normalize(), X = palm.clone().negate();
  X.addScaledVector(Z, -Z.dot(X)); if (X.lengthSq() < 1e-6) X.set(1, 0, 0).addScaledVector(Z, -Z.x); X.normalize();
  const Y = new V3().crossVectors(Z, X);
  return out.setFromRotationMatrix(_M4.makeBasis(X, Y, Z));
}
/** split q into twist about Y (returned angle) and the remaining swing: q = twist * swing */
function twistY(q, swing) {
  const tw = _q3.set(0, q.y, 0, q.w); if (tw.lengthSq() < 1e-9) tw.set(0, 0, 0, 1); tw.normalize();
  swing.copy(tw).invert().multiply(q);
  return 2 * Math.atan2(tw.y, tw.w);
}
const ANCH = new V3(-0.031, -0.086, 0.004);   // grip point in the LEFT hand (palm side) at hand scale 1
const mirQ = q => q.set(q.x, -q.y, -q.z, q.w);  // canonical-left rotation -> right side
/** finger curl: cu 0 (open) .. 1 (fist), th thumb 0..1 */
function curlFingers(bones, S, cu, th) {
  const rng = [1.45, 1.65, 1.05];
  for (let i = 0; i < 4; i++) {
    const mf = [0.94, 1, 1.05, 1.12][i];
    for (let k = 0; k < 3; k++) { const b = bones[`f${i}${k}${S}`]; if (b) b.quaternion.setFromAxisAngle(b.userData.axis, 0.06 + cu * rng[k] * mf); }
  }
  const tr = [0.42, 0.55, 0.75];
  for (let k = 0; k < 3; k++) { const b = bones[`t${k}${S}`]; if (b) b.quaternion.setFromAxisAngle(b.userData.axis, 0.08 + th * tr[k]); }
}

/* =====================================================================================
   FIRST-PERSON ARMS
   Camera at the origin looking down -Z. Each arm: pivot (F.armL/R, camera frame, at the shoulder)
   > base bone (turned 180 deg so the arm uses the body's canonical frame) > arm > fore > hand > fingers.
   ===================================================================================== */
const FP_PIVOT = { L: new V3(-0.2, -0.25, 0.05), R: new V3(0.2, -0.25, 0.05) };
const fpPoint = (B, k) => new V3(0, k < 0 ? -k * 0.4 : -(k <= 0.5 ? k * 2 * B.Lu : B.Lu + (k - 0.5) * 2 * B.Lf), 0);
const interpK = (ks, s) => { const i = Math.min(Math.floor(s), ks.length - 2), f = s - i; return lerp(ks[i], ks[i + 1], f); };
/** sleeve / forearm geometry in canonical-left base space, by style */
function fpArmGeos(B, look) {
  const L = LOOKS[look], out = [], st = L.style;
  const jc = hexc(L.jacket), pc = hexc(L.panel), uc = hexc(L.under);
  const rough = st === 'rain' ? 0.34 : st === 'puffer' ? 0.5 : st === 'shell' ? 0.62 : 0.85;
  const kEnd = { shell: 0.8, parka: 0.95, puffer: 0.955, rain: 0.965 }[st];
  const bulk = { shell: 1, parka: 1.1, puffer: 1.28, rain: 1.04 }[st];
  const rows = [[-0.06, 0.07], [0.0, 0.069], [0.12, 0.066], [0.3, 0.06], [0.45, 0.056], [0.55, 0.055], [0.68, 0.052], [0.8, 0.049], [0.9, 0.046], [0.97, 0.044]].filter(r => r[0] < kEnd - 0.07);
  const rEnd = rows[rows.length - 1][1] * 0.97;
  rows.push([kEnd - 0.05, rEnd * 1.01], [kEnd - 0.042, rEnd * 1.02], [kEnd - 0.006, rEnd * 1.02], [kEnd, rEnd * 0.985]);   // a sharp cuff band
  const ks = rows.map(r => r[0]);
  const vert = (t, dir, a, o, rg) => {
    const k = interpK(ks, rg.s);
    let m = 1, ao = 1, c = jc, rr = rough;
    const f1 = foldWave(k, a, 0.5, 0.1, 55, 1), f2 = foldWave(k, a, kEnd - 0.07, 0.07, 75, 2), f3 = foldWave(k, a, 0.68, 0.1, 40, 3);
    m += f1 * 0.05 + f2 * 0.04 + f3 * 0.025; ao -= Math.max(0, -f1) * 0.45 + Math.max(0, -f2) * 0.35 + Math.max(0, -f3) * 0.2;
    const nz = NZ.n3(rg.c.y * 9 + dir.x * 3, dir.z * 3, a * 0.3); m += nz * 0.02; ao -= Math.max(0, -nz) * 0.15;
    if (st === 'puffer') { const q = Math.abs(Math.sin(PI * (k + 0.05) * 9)); m *= 1 + 0.09 * (q ** 0.6 - 0.62); ao *= lerp(0.5, 1, q ** 0.5); }
    if (st === 'shell' && k > 0.36 && k < 0.6 && dir.z < -0.2) c = pc;                               // elbow patch
    if (st === 'shell' && dir.x > 0.96) ao *= 0.85;                                                  // seam
    if (k > kEnd - 0.045) { c = st === 'parka' ? mul3(jc, 0.85) : st === 'shell' ? pc : c; m *= 1.025; if (k > kEnd - 0.006) ao *= 0.6; }
    const g = sstep(0.2, 0.7, NZ2.n3(rg.c.y * 14 + 3, dir.x * 4, dir.z * 4));                       // grime
    c = mix3(c, mul3(c, 0.7), g * 0.4); rr = lerp(rr, 0.9, g * 0.5);
    ao = clamp(ao, 0.3, 1.05); o.m = m; o.r = c[0] * ao; o.g = c[1] * ao; o.b = c[2] * ao; o.a = rr;
  };
  const sl = loft(rows.map(([k, r]) => { const p = fpPoint(B, k); return { p: [p.x, p.y, p.z], rx: r * bulk * 0.95, rf: r * bulk, rb: r * bulk * 1.02 }; }), { radial: 22, sub: 4, vert, ts: 0.13 });
  out.push({ g: twoSided(sl, 0.004, 0.18), mat: 'cloth', skin: [['armL', 1], ['foreL', 1], ['handL', 0.15]] });
  // bare forearm under the sleeve
  const fr = [[0.62, 0.036, 0.04], [0.75, 0.033, 0.037], [0.88, 0.027, 0.032], [0.97, 0.0205, 0.029], [1.01, 0.0195, 0.0275]];
  out.push({ g: loft(fr.map(([k, rx, rz]) => { const p = fpPoint(B, k); return { p: [p.x, p.y, p.z], rx: rx * B.hs, rf: rz * B.hs, rb: rz * B.hs }; }), {
    radial: 16, sub: 3, uvRect: [0.52, 0.05, 0.73, 0.45], vert: (t, dir, a, o) => { const ao = dir.x < -0.5 ? 0.95 : 1; o.r = ao; o.g = ao; o.b = ao; o.a = 0.55; },
  }), mat: 'skin', skin: [['foreL', 1], ['handL', 0.5]] });
  // inner layer cuff peeking out (hoodie / fleece / knit)
  if (st !== 'rain') {
    const k0 = kEnd - 0.03, k1 = st === 'shell' ? kEnd + 0.045 : kEnd + 0.03, r = st === 'shell' ? 0.036 : 0.034;
    out.push({ g: loft([k0, (k0 + k1) / 2, k1].map((k, i) => { const p = fpPoint(B, k); return { p: [p.x, p.y, p.z], r: r * [1.05, 1, 0.92][i] }; }), {
      radial: 20, sub: 3, vert: (t, dir, a, o) => { const q = Math.abs(Math.sin(a * 18)), rib = 0.82 + 0.18 * q; o.m = 1 + 0.03 * q; o.r = uc[0] * rib; o.g = uc[1] * rib; o.b = uc[2] * rib; o.a = 0.95; },
    }), mat: 'cloth', skin: [['foreL', 1], ['handL', 0.3]] });
  }
  return out;
}
function watchGeos(B) {
  const w = fpPoint(B, 1).add(new V3(0, 0.072, 0)), out = [];
  out.push({ g: loft([-0.011, 0, 0.011].map(dy => ({ p: [0, w.y + dy, 0], rx: 0.0305 * B.hs, rf: 0.0352 * B.hs, rb: 0.0352 * B.hs })), { radial: 22, sub: 2, vert: (t, d, a, o) => { const k = 0.9 + 0.1 * Math.abs(Math.sin(t * PI)); o.r = 0.03 * k; o.g = 0.03 * k; o.b = 0.028 * k; o.a = 0.7; } }), mat: 'cloth', skin: [['foreL', 1]] });
  const x0 = 0.029 * B.hs;
  out.push({ g: loft([[x0, 0.0175], [x0 + 0.004, 0.019], [x0 + 0.0085, 0.0185], [x0 + 0.01, 0.0165]].map(([x, r]) => ({ p: [x, w.y, 0], r })), {
    radial: 24, sub: 1, cap1: true, dome: 0.05, fw: [0, 1, 0],
    vert: (t, d, a, o, rg) => {
      if (rg.cap || t > 0.99) { o.r = 0.01; o.g = 0.012; o.b = 0.014; o.a = 0.08; }
      else { const k = 0.35 + 0.1 * Math.sin(a * 30); o.r = k; o.g = k; o.b = k * 1.02; o.a = 0.25; }
    },
  }), mat: 'cloth', skin: [['foreL', 1]] });
  return out;
}
function buildFP(look) {
  const L = LOOKS[look], Bt = makeBody(L.body), defs = [];
  for (const [S, g] of [['L', 1], ['R', -1]]) {
    const pv = FP_PIVOT[S];
    defs.push({ name: 'base' + S, parent: null, w: [pv.x, pv.y, pv.z], r: [0, PI, 0], tl: [0, -0.05, 0] });
    defs.push({ name: 'arm' + S, parent: 'base' + S, l: [0, 0, 0], tl: [0, -Bt.Lu, 0] });
    defs.push({ name: 'fore' + S, parent: 'arm' + S, l: [0, -Bt.Lu, 0], tl: [0, -Bt.Lf, 0] });
    defs.push({ name: 'hand' + S, parent: 'fore' + S, l: [0, -Bt.Lf, 0], tl: [0, -0.095 * Bt.hs, 0.005] });
    handBoneDefs(defs, S, g, Bt.FJ);
  }
  const rig = buildRig(defs), B = { ...Bt, rig }, K = new Kit(B);
  /* every piece is generated twice: as-is for the left arm, mirrored for the right */
  const both = (mat, mk, space, skin) => {
    K.add(mat, tf(mk(), rig.world[space + 'L']), skin);
    K.add(mat, tf(mirrorGeo(mk()), rig.world[space + 'R']), swapSkin(skin));
  };
  fpArmGeos(B, look).forEach((p, i) => both(p.mat, () => fpArmGeos(B, look)[i].g, 'base', p.skin));
  if (L.watch) watchGeos(B).forEach(p => K.add(p.mat, tf(p.g, rig.world.baseL), p.skin));
  const ho = { detail: 1, glove: L.glove ? hexc(L.glove) : null };
  handGeos(B, ho).forEach((p, i) => both(p.mat || 'skin', () => handGeos(B, ho)[i].g, 'hand', p.skin));
  return { B, rig, geos: K.bake(rig), tex: skinTexture(L.sk) };
}
const FP_CACHE = new Map();
/* hand targets in camera space: grip point p, thumb direction th (= item handle, anchor +Y), finger direction fi
   (= where the knuckles point = item front / axe blade, anchor +Z), finger curl cu, thumb curl tc.
   two: this hand holds the right hand's handle `two` metres further toward the butt (same grip frame). */
const FP_POSES = {
  none: { L: { p: [-0.26, -0.8, -0.05], th: [0, 0, -1], fi: [0, -1, 0], cu: 0.35, tc: 0.3 }, R: { p: [0.26, -0.8, -0.05], th: [0, 0, -1], fi: [0, -1, 0], cu: 0.35, tc: 0.3 } },
  grip: { R: { p: [0.095, -0.125, -0.36], th: [-0.85, 0.33, -0.41], fi: [-0.3, -0.1, -1], cu: 0.86, tc: 0.85 }, L: { two: -0.125, cu: 0.88, tc: 0.85 } },
  gripR: { R: { p: [0.14, -0.15, -0.42], th: [-0.12, 0.6, -0.79], fi: [-0.2, -0.75, -0.45], cu: 0.86, tc: 0.85 }, L: { p: [-0.25, -0.5, -0.3], th: [0.2, 0.3, -0.9], fi: [0.1, -0.9, -0.3], cu: 0.4, tc: 0.3 } },
  open: { R: { p: [0.14, -0.19, -0.42], th: [-0.9, 0.1, -0.3], fi: [0.05, 0.3, -1], cu: 0.07, tc: 0.05 }, L: { p: [-0.14, -0.19, -0.42], th: [0.9, 0.1, -0.3], fi: [-0.05, 0.3, -1], cu: 0.07, tc: 0.05 } },
  reach: { L: { p: [-0.05, -0.26, -0.55], th: [0.7, 0.0, -0.7], fi: [0.05, -0.35, -1], cu: 0.3, tc: 0.15 }, R: { p: [0.26, -0.5, -0.28], th: [-0.2, 0.3, -0.9], fi: [-0.1, -0.9, -0.3], cu: 0.4, tc: 0.3 } },
  torch: { L: { p: [-0.15, -0.13, -0.42], th: [0.05, 1, -0.1], fi: [0.55, 0, -0.85], cu: 0.86, tc: 0.8 }, R: { p: [0.26, -0.5, -0.28], th: [-0.2, 0.3, -0.9], fi: [-0.1, -0.9, -0.3], cu: 0.42, tc: 0.3 } },
  bow: { L: { p: [-0.05, -0.07, -0.56], th: [0, 1, 0], fi: [0.3, 0, -0.95], cu: 0.86, tc: 0.8 }, R: { p: [0.09, -0.1, -0.21], th: [-0.3, 0.15, -0.9], fi: [-0.95, 0, 0.2], cu: 0.55, tc: 0.35 } },
};
export function createFPArms(look = 0) {
  const F = { root: new THREE.Group(), armL: new THREE.Object3D(), armR: new THREE.Object3D(), handL: new THREE.Object3D(), handR: new THREE.Object3D(), meshes: [] };
  F.root.name = 'FPArms';
  F.armL.position.copy(FP_PIVOT.L); F.armR.position.copy(FP_PIVOT.R); F.root.add(F.armL, F.armR);
  F.handL.rotation.x = F.handR.rotation.x = PI / 2;
  const M = sharedMats(), pivots = { L: F.armL, R: F.armR };
  let D, by, smat, bases = [];
  const cur = {}; for (const S of ['L', 'R']) { const p = FP_POSES.none[S]; cur[S] = { p: new V3(...p.p), th: new V3(...p.th), fi: new V3(...p.fi), cu: p.cu, tc: p.tc }; }
  const build = l => {
    l = ((l % 4) + 4) % 4; F.look = l;
    if (!FP_CACHE.has(l)) FP_CACHE.set(l, buildFP(l));
    D = FP_CACHE.get(l);
    for (const m of F.meshes) F.root.remove(m); for (const b of bases) b.parent.remove(b); smat?.dispose();
    const bones = D.rig.defs.map(d => { const b = new THREE.Bone(); b.name = d.name; b.position.copy(d.pos); b.quaternion.copy(d.quat); if (d.axis) b.userData.axis = d.axis; return b; });
    by = {}; bones.forEach(b => (by[b.name] = b)); bases = [];
    D.rig.defs.forEach((d, i) => { if (d.parent >= 0) bones[d.parent].add(bones[i]); else { bones[i].position.set(0, 0, 0); pivots[d.name.slice(-1)].add(bones[i]); bases.push(bones[i]); } });
    const hs = D.B.hs;
    for (const [S, g] of [['L', 1], ['R', -1]]) { const h = S === 'L' ? F.handL : F.handR; h.position.set(ANCH.x * g * hs, ANCH.y * hs, ANCH.z * hs); by['hand' + S].add(h); }
    F.root.updateMatrixWorld(true);
    const save = [F.armL.quaternion.clone(), F.armR.quaternion.clone()]; F.armL.quaternion.identity(); F.armR.quaternion.identity(); F.root.updateMatrixWorld(true);
    const rootInv = F.root.matrixWorld.clone().invert();
    const skel = new THREE.Skeleton(bones, bones.map((b, i) => new THREE.Matrix4().multiplyMatrices(D.rig.world[D.rig.defs[i].name], new THREE.Matrix4()).invert()));
    smat = skinMat(D.tex);
    F.meshes = [];
    for (const k in D.geos) {
      const mesh = new THREE.SkinnedMesh(D.geos[k], k === 'skin' ? smat : M[k]);
      F.root.add(mesh); mesh.bind(skel, new THREE.Matrix4()); mesh.frustumCulled = false; mesh.castShadow = false; mesh.receiveShadow = false;
      F.meshes.push(mesh);
    }
    void rootInv; F.armL.quaternion.copy(save[0]); F.armR.quaternion.copy(save[1]);
  };
  const pole = { L: new V3(-0.7, -1, 0.35), R: new V3(0.7, -1, 0.35) };
  const qa = new THREE.Quaternion(), qh = new THREE.Quaternion(), qf = new THREE.Quaternion(), sw = new THREE.Quaternion();
  const toBase = (v, S, isDir) => { const q = isDir ? v.clone() : v.clone().sub(FP_PIVOT[S]); q.z = -q.z; if (S === 'L') q.x = -q.x; return q; };
  const solve = S => {
    const c = cur[S], hs = D.B.hs;
    const th = toBase(c.th, S, true), fi = toBase(c.fi, S, true);
    handQuat(th, new V3().crossVectors(fi, th), qh);       // canonical palm = fingers x thumb
    const wrist = toBase(c.p, S, false).sub(ANCH.clone().multiplyScalar(hs).applyQuaternion(qh));
    const bend = twoBone(new V3(), wrist, D.B.Lu, D.B.Lf, toBase(pole[S], S, true), -1, qa);
    qf.setFromAxisAngle(new V3(1, 0, 0), -bend);
    const local = _q1.copy(qa).multiply(qf).invert().multiply(qh);      // hand relative to the bent forearm
    const tw = twistY(local, sw);
    const fore = qf.clone().multiply(_q2.setFromAxisAngle(new V3(0, 1, 0), tw));
    by['arm' + S].quaternion.copy(S === 'R' ? mirQ(qa.clone()) : qa);
    by['fore' + S].quaternion.copy(S === 'R' ? mirQ(fore) : fore);
    by['hand' + S].quaternion.copy(S === 'R' ? mirQ(sw.clone()) : sw);
    curlFingers(by, S, c.cu, c.tc);
  };
  /** blend the current hand targets toward pose `name` by k (1 = snap; call every frame with 1-exp(-dt*rate) to ease) */
  F.pose = (name, k = 1) => {
    const P = FP_POSES[name] || FP_POSES.none;
    for (const S of ['R', 'L']) {
      const t = P[S], c = cur[S];
      if (t.two !== undefined) {
        const o = cur.R, th = o.th.clone().normalize();
        c.p.lerp(o.p.clone().addScaledVector(th, -t.two), k); c.th.lerp(th, k).normalize(); c.fi.lerp(o.fi, k).normalize();
      } else { c.p.lerp(_a.set(...t.p), k); c.th.lerp(_b.set(...t.th).normalize(), k).normalize(); c.fi.lerp(_c.set(...t.fi).normalize(), k).normalize(); }
      c.cu = lerp(c.cu, t.cu, k); c.tc = lerp(c.tc, t.tc, k);
    }
    solve('L'); solve('R');
  };
  F.setLook = l => { if (((l % 4) + 4) % 4 !== F.look) { build(l); solve('L'); solve('R'); } };
  F.dispose = () => { for (const m of F.meshes) F.root.remove(m); smat?.dispose(); };
  build(look);
  F.pose('none', 1);
  return F;
}

/* =====================================================================================
   OUTFIT PIECES (third person)
   ===================================================================================== */
const HEAD_ONLY = [['head', 1]];
const toBody = (K, x, y, z) => P3(K.B.headO).add(new V3(x, y, z).multiplyScalar(K.B.ks));
/** knit beanie hugging the skull, folded cuff, slouch at the back, optional pompom */
function beanie(K, col, o = {}) {
  const nu = 44, nv = 12, pm = phi => (o.psi ?? 1.47) - 0.42 * Math.cos(phi);
  const g = headShell(K, nu, nv, capDir(pm), (u, v, d, j, nv2) => {
    if (j === nv2) return -0.003;
    const phi = TAU * (u - 0.5), vv = j / (nv2 - 1), psi = vv * pm(phi);
    let off = 0.0068 + 0.0012 * (0.5 + 0.5 * Math.cos(phi * 22)) * sstep(0.08, 0.3, vv);
    if (vv > 0.72) off += 0.0055;
    off += 0.014 * Math.max(0, Math.cos(psi)) * (0.55 - 0.45 * Math.cos(phi)) * (o.slouch ?? 1);
    return off;
  }, (u, v, p, d, out, j) => {
    const vv = j / (nv - 1), phi = TAU * (u - 0.5);
    let k = 0.8 + 0.2 * (0.5 + 0.5 * Math.cos(phi * 22));
    if (vv > 0.69 && vv < 0.75) k *= 0.55;
    if (j === nv) k *= 0.45;
    k *= 0.92 + 0.12 * NZ.n3(d.x * 30, d.y * 30, d.z * 30);
    out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = 0.95; out.u = u * 6; out.v = vv * 1.5;
  });
  K.add('cloth', g, HEAD_ONLY);
  if (o.pompom) {
    const c = toBody(K, 0, 0.14, -0.035);
    K.add('cloth', blob([c.x, c.y, c.z], [0.034, 0.03, 0.034], 1, 14, 10, (x, y, z, out) => {
      const n = NZ.n3(x * 7 + 3, y * 7, z * 7) * 0.5 + 0.5, f = 0.75 + 0.5 * n;
      out.x = c.x + (out.x - c.x) * f; out.y = c.y + (out.y - c.y) * f; out.z = c.z + (out.z - c.z) * f;
      const k = 0.6 + 0.5 * n; out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = 1;
    }), HEAD_ONLY);
  }
}
/** scalp hair: o.pm hairline, o.off thickness, o.curl/curlF bumps, o.matted lumps */
function hairCap(K, col, o) {
  const nu = o.nu ?? 32, nv = o.nv ?? 12;
  const cf = o.curlF ?? 60, bump = d => NZ.n3(d.x * cf, d.y * cf, d.z * cf) * 0.5 + 0.5;
  K.add('hair', headShell(K, nu, nv, capDir(o.pm), (u, v, d, j, nv2) => {
    if (j === nv2) return -0.003;
    const vv = j / (nv2 - 1);
    let off = o.off * lerp(1, o.edge ?? 0.5, sstep(0.55, 1, vv));
    if (o.curl) off += bump(d) * o.curl;
    if (o.matted) off += (NZ2.n3(d.x * 7, d.y * 7, d.z * 7) * 0.5 + 0.5) * o.matted;
    return off;
  }, (u, v, p, d, out, j) => {
    const vv = Math.min(1, j / (nv - 1)), n = NZ.n3(d.x * 30, d.y * 30, d.z * 30);
    const k = (0.82 + 0.2 * n) * (j === nv ? 0.4 : 1) * lerp(1, 0.82, vv) * (o.curl ? 0.65 + 0.45 * bump(d) : 1);
    out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = o.rough ?? 0.5; out.u = u * 10; out.v = vv * 2;
  }), HEAD_ONLY);
}
/** beard / stubble shell over the jaw; o.len grows it downward, lips stay clear */
function beard(K, col, o = {}) {
  const nu = o.nu ?? 24, nv = o.nv ?? 12, PH = 1.55;
  const eTop = ap => (ap < 0.28 ? -0.27 : ap < 0.75 ? lerp(-0.27, -0.5, sstep(0.28, 0.75, ap)) : lerp(-0.5, 0.06, sstep(0.75, 1.5, ap)));
  K.add('hair', headShell(K, nu, nv, (u, v, d) => {
    const phi = (u - 0.5) * 2 * PH, e = lerp(o.e0 ?? -1.32, eTop(Math.abs(phi)), v);
    d.set(Math.cos(e) * Math.sin(phi), Math.sin(e), Math.cos(e) * Math.cos(phi));
  }, (u, v, d, j, nv2, i, nu2) => {
    if (j === 0 || j === nv2 || i === 0 || i === nu2) return -0.002;
    const phi = (u - 0.5) * 2 * PH, e = Math.asin(clamp(d.y, -1, 1));
    if (Math.abs(phi) < 0.3 && e > -0.66 && e < -0.4) return -0.003;
    let off = (o.off ?? 0.0035) + (o.len ?? 0) * sstep(-0.55, -1.25, e) * (1 - Math.abs(phi) / 1.8);
    off += NZ.n3(d.x * 70, d.y * 70, d.z * 70) * (o.fuzz ?? 0.0012) + (NZ2.n3(d.x * 12, d.y * 12, d.z * 12) * 0.5 + 0.5) * (o.matted ?? 0);
    return off;
  }, (u, v, p, d, out) => { const k = 0.72 + 0.28 * (NZ.n3(d.x * 40, d.y * 40, d.z * 40) * 0.5 + 0.5); out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = 0.62; out.u = u * 6; out.v = v * 2; }), HEAD_ONLY);
}
const neckWeights = B => v => { const y = v.y, yN = B.J.neck[1], wH = sstep(yN + 0.02, yN + 0.12, y), wC = sstep(yN, yN - 0.12, y); return [['head', wH], ['neck', (1 - wH) * (1 - wC)], ['chest', (1 - wH) * wC]]; };
function ponytail(K, col) {
  const pts = [[0, 0.04, -0.085], [0, 0.012, -0.112], [0, -0.04, -0.13], [0, -0.12, -0.133], [0.006, -0.2, -0.12], [0.012, -0.27, -0.106]].map(p => toBody(K, ...p));
  const rr = [0.022, 0.021, 0.026, 0.022, 0.015, 0.005];
  K.add('hair', loft(pts.map((p, i) => ({ p: [p.x, p.y, p.z], rx: rr[i], rf: rr[i] * 0.8, rb: rr[i] })), {
    radial: 10, sub: 3, cap1: true, cap0: true, dome: 0.8, ts: 0.15,
    vert: (t, d, a, out) => { const tie = Math.abs(t - 0.17) < 0.03; out.m = (tie ? 0.82 : 1) * (1 + 0.06 * Math.sin(a * 5 + t * 9)); const k = tie ? 0.2 : 0.85 + 0.15 * Math.sin(a * 7); out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = 0.5; },
  }), neckWeights(K.B));
}
function glasses(K, col) {
  const parts = [];
  for (const g of [1, -1]) {
    const loop = []; for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU, cx = Math.cos(a), sy = Math.sin(a); const x = 0.031 + 0.0215 * Math.sign(cx) * Math.abs(cx) ** 0.75, y = 0.0005 + 0.0158 * Math.sign(sy) * Math.abs(sy) ** 0.8; loop.push([x * g, y, 0.1045 - 3.2 * (x - 0.02) ** 2]); }
    loop.push(loop[1]);
    parts.push(loft(loop.map(p => { const q = toBody(K, ...p); return { p: [q.x, q.y, q.z], r: 0.0019 }; }), { radial: 5, sub: 1, color: col, rough: 0.25 }));
    parts.push(loft([[0.052 * g, 0.006, 0.1], [0.068 * g, 0.008, 0.075], [0.078 * g, 0.006, 0.02], [0.078 * g, 0.0, -0.01], [0.072 * g, -0.012, -0.03]].map(p => { const q = toBody(K, ...p); return { p: [q.x, q.y, q.z], r: 0.0016 }; }), { radial: 5, sub: 2, color: col, rough: 0.25 }));
  }
  parts.push(loft([[0.0105, 0.006, 0.1055], [0, 0.009, 0.108], [-0.0105, 0.006, 0.1055]].map(p => { const q = toBody(K, ...p); return { p: [q.x, q.y, q.z], r: 0.0016 }; }), { radial: 5, sub: 2, color: col, rough: 0.25 }));
  for (const p of parts) K.add('cloth', p, HEAD_ONLY);
}
function headset(K, col) {
  for (const g of [1, -1]) {
    const c = toBody(K, 0.085 * g, -0.006, -0.012);
    K.add('cloth', blob([c.x, c.y, c.z], [0.024, 0.042, 0.035], 0.55, 14, 10, (x, y, z, out) => { const rim = x * g < -0.5 ? 0.35 : 1; const k = rim * (0.85 + 0.15 * y); out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = x * g < -0.5 ? 0.9 : 0.45; }), HEAD_ONLY);
  }
  const arc = []; for (let i = 0; i <= 8; i++) { const a = PI * i / 8; arc.push(toBody(K, Math.cos(a) * 0.088, -0.0 + Math.sin(a) * 0.14 + 0.015, -0.014)); }
  K.add('cloth', loft(arc.map(p => ({ p: [p.x, p.y, p.z], rx: 0.006, rf: 0.016, rb: 0.016 })), { radial: 8, sub: 2, color: mul3(col, 0.8), rough: 0.5, fw: [0, 0, 1] }), HEAD_ONLY);
  const mic = [[0.09, -0.03, 0.01], [0.085, -0.055, 0.05], [0.06, -0.07, 0.09], [0.03, -0.072, 0.108]].map(p => toBody(K, ...p));
  K.add('cloth', loft(mic.map(p => ({ p: [p.x, p.y, p.z], r: 0.0028 })), { radial: 6, sub: 3, color: [0.02, 0.02, 0.02], rough: 0.4 }), HEAD_ONLY);
  const m = toBody(K, 0.024, -0.071, 0.111);
  K.add('cloth', blob([m.x, m.y, m.z], [0.011, 0.009, 0.009], 1, 10, 8, (x, y, z, out) => { out.r = out.g = out.b = 0.015; out.a = 1; }), HEAD_ONLY);
}
/** hiking boot: shaft + lofted foot with sole, welt, laces and a scuffed toe */
function boots(K, col, o = {}) {
  const B = K.B, an = P3(B.J.ankle), s = B.s, sole = o.sole ?? hexc(0x171513), rough = o.rough ?? 0.55, top = o.top ?? 0.25;
  K.add('cloth', loft([[top, 0.055, 0.059, 0.061], [top - 0.025, 0.053, 0.057, 0.059], [0.15, 0.05, 0.056, 0.054], [0.11, 0.049, 0.062, 0.052], [0.075, 0.047, 0.07, 0.05]].map(([y, rx, rf, rb]) => ({ p: [an.x, y * s, an.z], rx, rf, rb })), {
    radial: 16, sub: 2, ts: 0.15, vert: garment(col, rough, { noise: 0.008, mod: t => (t < 0.12 ? { ao: 0.62 } : null) }),
  }), [['shinL', 1], ['footL', 0.5]], true);
  const rows = [[-0.075, 0.05, 0.033, 0.032, 0.045], [-0.055, 0.06, 0.044, 0.05, 0.058], [-0.01, 0.065, 0.047, 0.058, 0.064], [0.05, 0.056, 0.051, 0.044, 0.055], [0.11, 0.045, 0.053, 0.032, 0.044], [0.16, 0.039, 0.05, 0.026, 0.038], [0.2, 0.035, 0.042, 0.022, 0.033], [0.222, 0.034, 0.025, 0.016, 0.028]];
  const lace = hexc(o.lace ?? 0x2a241e);
  K.add('cloth', loft(rows.map(([z, yc, rx, rf, rb]) => ({ p: [an.x + 0.004, yc, an.z + z * s], rx: rx * (o.w ?? 1), rf, rb })), {
    radial: 16, sub: 2, sq: 2.6, fw: [0, 1, 0], cap0: true, cap1: true, dome: 0.4, ts: 0.15,
    vert: (t, d, a, out, rg) => {
      let c = col, ao = 1, r = rough; const z = (rg.c.z - an.z) / s;
      if (d.y < -0.5) { c = sole; r = 0.9; ao = 0.8; }
      else if (d.y < -0.32) { c = mix3(col, sole, 0.6); ao = 0.7; }
      else if (d.y > 0.6 && z > -0.02 && z < 0.12 && !o.noLace) { if (Math.abs(Math.sin(z * 170)) > 0.55) { c = lace; ao = 0.85; } if (Math.abs(d.x) < 0.2) ao *= 0.7; }
      if (z > 0.15 && d.y > -0.32) { ao *= 0.82 + 0.3 * (NZ.n3(rg.c.x * 80, z * 80, d.y * 3) * 0.5 + 0.5); r = rough * 0.8; }
      out.r = c[0] * ao; out.g = c[1] * ao; out.b = c[2] * ao; out.a = r;
    },
  }), [['footL', 1], ['toeL', 1], ['shinL', 0.05]], true);
}
/** front-surface height helper for zips and pockets */
function frontAt(st, y) {
  for (let i = 0; i < st.length - 1; i++) { const a = st[i], b = st[i + 1]; if ((y - a.p[1]) * (y - b.p[1]) <= 0) { const f = (y - a.p[1]) / ((b.p[1] - a.p[1]) || 1); return lerp(a.p[2] + a.rf, b.p[2] + b.rf, f); } }
  return st[st.length - 1].p[2] + st[st.length - 1].rf;
}
function torsoLoft(K, rows, o) {
  const B = K.B, st = torsoStations(B, rows, o.grow ?? 0);
  const g = loft(st, { radial: o.radial ?? 26, sub: o.sub ?? 3, sq: o.sq ?? 2.3, vert: o.vert, ts: o.ts ?? 0.25, uvRect: o.uvRect, cap0: o.cap0, cap1: o.cap1, dome: o.dome });
  K.add(o.mat ?? 'cloth', o.two ? twoSided(g, 0.004, 0.3) : g, o.skin ?? torsoSkin(B, o.thigh ?? 0.05));
  return st;
}
function zipper(K, st, y0, y1, col) {
  const B = K.B, pts = []; for (let i = 0; i <= 10; i++) { const y = lerp(y0, y1, i / 10) * B.s; pts.push({ p: [0, y, frontAt(st, y) + 0.002], rx: 0.0075, rf: 0.0028, rb: 0.0028 }); }
  K.add('cloth', loft(pts, { radial: 6, sub: 2, vert: (t, d, a, out) => { const teeth = Math.abs(d.x) < 0.5 && d.z > 0 ? 0.45 : 1; out.r = col[0] * teeth; out.g = col[1] * teeth; out.b = col[2] * teeth; out.a = 0.4; } }), torsoSkin(B));
}
function collar(K, col, o = {}) {
  const B = K.B, s = B.s, r = o.r ?? 0.078, h = o.h ?? 1.6;
  const st = [[1.49, r, r * 0.93, r * 1.06, -0.022], [(1.49 + h) / 2, r * 1.03, r * 0.95, r * 1.08, -0.025], [h, r * 1.05, r * 0.97, r * 1.1, -0.028]].map(([y, rx, rf, rb, z]) => ({ p: [0, y * s, z], rx, rf, rb }));
  const g = loft(st, { radial: 22, sub: 3, ts: 0.2, vert: (t, d, a, out) => {
    out.dt = -(o.open ?? 0.05) * Math.max(0, d.z) ** 2 * t;
    const k = (t > 0.85 ? 0.75 : 1) * (0.92 + 0.08 * NZ.n3(d.x * 9, t * 3, d.z * 9)) * (o.baffle ? lerp(0.6, 1, Math.abs(Math.sin(t * PI * 2))) : 1);
    if (o.baffle) out.m = 1 + 0.06 * Math.abs(Math.sin(t * PI * 2));
    out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = o.rough ?? 0.7;
  } });
  K.add('cloth', twoSided(g, 0.004, 0.35), neckWeights(B));
}
function sleeves(K, col, o = {}) {
  const B = K.B, rows = o.rows ?? [[-0.12, 0.062, 0.064, 0.066], [0.0, 0.066, 0.068, 0.066], [0.15, 0.063], [0.32, 0.058], [0.5, 0.054], [0.66, 0.053], [0.84, 0.049], [0.93, 0.046], [0.94, 0.047], [0.99, 0.047], [1.0, 0.045]];
  const ks = rows.map(r => r[0]), cuff = o.cuff ?? 0.935, rough = o.rough ?? 0.7;
  const g = chainLoft(B, armPoint, rows, { bulk: o.bulk ?? 1, radial: o.radial ?? 14, sub: o.sub ?? 2, ts: 0.25, uvRect: o.uvRect, vert: (t, d, a, out, rg) => {
    const k = interpK(ks, rg.s); let m = 1, ao = 1, c = col, rr = rough;
    if (!o.skin) {
      const f1 = foldWave(k, a, 0.5, 0.09, 55, 1), f2 = foldWave(k, a, 0.9, 0.06, 70, 2);
      m += f1 * 0.045 + f2 * 0.03; ao -= Math.max(0, -f1) * 0.4 + Math.max(0, -f2) * 0.3;
      const nz = NZ.n3(rg.c.x * 10 + d.x * 2, rg.c.y * 10, rg.c.z * 10 + d.z * 2); m += nz * 0.02; ao -= Math.max(0, -nz) * 0.15;
      if (o.baffle) { const q = Math.abs(Math.sin(PI * (k + 0.05) * 9)); m *= 1 + 0.09 * (q ** 0.6 - 0.62); ao *= lerp(0.5, 1, q ** 0.5); }
      if (o.panel && ((k < 0.16 && d.y > 0.2) || (k > 0.38 && k < 0.6 && d.z < -0.25))) c = o.panel;
      if (k > cuff) { c = o.cuffCol ?? mul3(c, 0.8); if (k > 0.995) ao *= 0.6; }
      if (k < 0.04 && d.x < 0) ao *= 0.75;
    } else if (o.skinVert) { const r = o.skinVert(k, d); m = r[0]; ao = r[1]; }
    out.m = m; ao = clamp(ao, 0.3, 1.05); out.r = c[0] * ao; out.g = c[1] * ao; out.b = c[2] * ao; out.a = rr;
  } });
  K.add(o.skin ? 'skin' : (o.mat ?? 'cloth'), g, [['clavL', 0.3], ['armL', 1], ['foreL', 1], ['handL', 0.3]], true);
}
function trousers(K, col, o = {}) {
  const B = K.B, rough = o.rough ?? 0.88;
  torsoLoft(K, [[1.07, 0.163, 0.108, 0.112], [1.0, 0.168, 0.11, 0.122], [0.93, 0.165, 0.105, 0.125], [0.87, 0.135, 0.088, 0.105], [0.83, 0.075, 0.052, 0.062]], { cap1: true, dome: 0.3, radial: 20, sub: 2, thigh: 0.4, vert: garment(col, rough, { noise: 0.01 }) });
  const rows = o.rows ?? [[-0.12, 0.09, 0.092, 0.1], [0, 0.094, 0.096, 0.106], [0.16, 0.087, 0.09, 0.09], [0.34, 0.077, 0.08, 0.075], [0.5, 0.064, 0.068, 0.064], [0.6, 0.063, 0.06, 0.068], [0.74, 0.059, 0.056, 0.06], [0.84, 0.062, 0.062, 0.064], [0.88, 0.064, 0.064, 0.066]];
  const ks = rows.map(r => r[0]);
  const g = chainLoft(B, legPoint, rows, { bulk: o.bulk ?? 1, radial: 16, sub: 3, ts: 0.25, uvRect: o.uvRect, vert: (t, d, a, out, rg) => {
    const k = interpK(ks, rg.s); let m = 1, ao = 1, c = col, rr = rough;
    if (o.skinVert) { const r = o.skinVert(k, d); m = r[0]; ao = r[1]; }
    else {
      const fk = foldWave(k, a, 0.5, 0.07, 55, 4) * (d.z < 0 ? 1.4 : 0.7), fb = foldWave(k, a, 0.82, 0.06, 80, 5);
      m += fk * 0.035 + fb * 0.04; ao -= Math.max(0, -fk) * 0.4 + Math.max(0, -fb) * 0.4;
      const nz = NZ.n3(rg.c.x * 9 + d.x * 2, rg.c.y * 9, rg.c.z * 9 + d.z * 2); m += nz * 0.018; ao -= Math.max(0, -nz) * 0.15;
      if (d.x > 0.965) { ao *= o.seamLight ? 1.25 : 0.75; }
      if (o.cargo && d.x > 0.5 && k > 0.18 && k < 0.36) { out.off = 0.011 * sstep(0.5, 0.65, d.x) * sstep(0.18, 0.2, k) * sstep(0.36, 0.34, k); if (k < 0.21) ao *= 0.7; else ao *= 0.95; }
      if (o.kneeWear && d.z > 0.5 && Math.abs(k - 0.5) < 0.07) c = mix3(col, [1, 1, 1].map((x, i) => col[i] * 1.6), 0.4);
      if (k > 0.86) ao *= 0.7;
      const mud = sstep(0.6, 0.88, k) * (NZ2.n3(rg.c.x * 20, rg.c.y * 20, rg.c.z * 20) * 0.5 + 0.5);
      c = mix3(c, hexc(0x3a2f22), mud * 0.5);
    }
    out.m = m; ao = clamp(ao, 0.3, 1.1); out.r = c[0] * ao; out.g = c[1] * ao; out.b = c[2] * ao; out.a = rr;
  } });
  K.add(o.skinVert ? 'skin' : 'cloth', g, [['hips', 0.35], ['thighL', 1], ['shinL', 1], ['footL', 0.25]], true);
}
/** day pack (or a big trekking pack) with straps, sternum strap and a rolled pad */
function backpack(K, col, o = {}) {
  const B = K.B, s = B.s, g0 = o.grow ?? 0, big = !!o.big;
  const zb = -(0.116 + g0) * B.sw, size = big ? [0.17, 0.28, 0.11] : [0.145, 0.2, 0.075];
  const c = [0, (big ? 1.18 : 1.25) * s, zb - size[2] * 0.82];
  const sk = v => { const w = sstep(0.95 * s, 1.3 * s, v.y); return [['chest', w], ['spine', 1 - w]]; };
  K.add('cloth', blob(c, size, 0.32, 20, 16, (x, y, z, out) => {
    let ao = 1;
    if (z > 0.3) ao *= 0.55;                                        // against the back
    if (Math.abs(y - 0.62) < 0.05) ao *= 0.6;                       // lid seam
    if (Math.abs(x) > 0.9 && (Math.abs(y - 0.25) < 0.04 || Math.abs(y + 0.35) < 0.04)) ao *= 0.5;   // compression straps
    if (z < -0.2 && Math.abs(Math.hypot(x * 1.1, y - 0.1) - 0.62) < 0.035) ao *= 0.5;      // zip arc
    if (y < -0.8) ao *= 0.7;
    ao *= 0.92 + 0.12 * NZ.n3(x * 4, y * 4, z * 4);
    out.r = col[0] * ao; out.g = col[1] * ao; out.b = col[2] * ao; out.a = 0.75;
  }, { us: 3, vs: 3 }), sk);
  // front pocket
  K.add('cloth', blob([0, c[1] - size[1] * 0.35, c[2] - size[2] * 0.95], [size[0] * 0.72, size[1] * 0.38, size[2] * 0.3], 0.3, 14, 10, (x, y, z, out) => { const ao = (Math.abs(y - 0.7) < 0.08 ? 0.55 : 0.95) * (z > 0.2 ? 0.6 : 1); out.r = col[0] * ao * 0.9; out.g = col[1] * ao * 0.9; out.b = col[2] * ao * 0.9; out.a = 0.75; }), sk);
  if (o.pad) { // rolled sleeping pad strapped under the pack
    const y = c[1] - size[1] - 0.05, z = c[2] - 0.01, pc = o.pad;
    K.add('cloth', loft([-0.2, -0.1, 0, 0.1, 0.2].map(x => ({ p: [x, y, z], r: 0.062 })), { radial: 16, sub: 2, fw: [0, 1, 0], cap0: true, cap1: true, dome: 0.15, vert: (t, d, a, out) => { const strap = Math.abs(Math.abs(t - 0.5) - 0.3) < 0.03; const k = strap ? 0.15 : 0.85 + 0.15 * Math.sin(a * 3 + t * 2); out.m = strap ? 1.04 : 1; out.r = (strap ? 0.1 : pc[0]) * k; out.g = (strap ? 0.1 : pc[1]) * k; out.b = (strap ? 0.1 : pc[2]) * k; out.a = 0.7; } }), sk);
  }
  const sc = mul3(col, 0.45);
  const fz = (0.128 + g0) * B.sw;
  const path = [[0.072, 1.43, zb - 0.02, [0, 0.6, -1]], [0.105, 1.505, zb * 0.45, [0.1, 1, -0.3]], [0.115, 1.497, 0.03, [0.2, 1, 0.6]], [0.12, 1.4, fz, [0, 0.2, 1]], [0.13, 1.26, fz + 0.004, [0, 0, 1]], [0.155, 1.12, fz - 0.008, [0.3, 0, 1]], [0.185 + g0, 1.06, 0.0, [1, 0, 0]], [0.13, 1.09, zb - 0.01, [0.3, 0, -1]]];
  const strap = loft(path.map(([x, y, z, n]) => ({ p: [x * B.sw, y * s, z], rx: 0.022, rf: 0.0055, rb: 0.0055, fw: n })), { radial: 8, sq: 4, sub: 4, vert: (t, d, a, out) => { const pad = t < 0.55 ? 1.0 : 0.6; out.r = sc[0] * pad; out.g = sc[1] * pad; out.b = sc[2] * pad; out.a = 0.8; } });
  K.add('cloth', strap, torsoSkin(B, 0), true);
  K.add('cloth', loft([-0.12, 0, 0.12].map(x => ({ p: [x * B.sw, 1.36 * s, fz + 0.006], rx: 0.008, rf: 0.003, rb: 0.003 })), { radial: 6, sub: 3, fw: [0, 0, 1], color: [0.02, 0.02, 0.02], rough: 0.5 }), torsoSkin(B, 0));
  return { back: new V3(0, c[1], c[2] - size[2]) };
}

/* ---------- jackets ---------- */
const JK_SHELL = [[0.8, 0.182, 0.128, 0.136, 0], [0.88, 0.18, 0.122, 0.13, 0], [0.98, 0.174, 0.116, 0.12, 0], [1.08, 0.17, 0.115, 0.114, 0], [1.18, 0.176, 0.124, 0.112, 0.004], [1.28, 0.186, 0.13, 0.114, 0.004], [1.37, 0.194, 0.124, 0.114, 0], [1.43, 0.192, 0.106, 0.104, -0.008], [1.475, 0.16, 0.086, 0.09, -0.016], [1.505, 0.105, 0.074, 0.078, -0.022], [1.53, 0.078, 0.07, 0.072, -0.025]];
const JK_PARKA = [[0.66, 0.205, 0.152, 0.162, 0], [0.76, 0.192, 0.142, 0.152, 0], [0.88, 0.18, 0.128, 0.135, 0], [0.99, 0.168, 0.116, 0.12, 0], [1.08, 0.162, 0.113, 0.113, 0], [1.18, 0.168, 0.124, 0.112, 0.004], [1.28, 0.178, 0.134, 0.114, 0.006], [1.37, 0.188, 0.124, 0.114, 0], [1.43, 0.187, 0.106, 0.104, -0.008], [1.475, 0.157, 0.087, 0.09, -0.016], [1.505, 0.103, 0.075, 0.079, -0.022], [1.53, 0.078, 0.07, 0.072, -0.025]];
const JK_RAIN = [[0.74, 0.192, 0.138, 0.146, 0], ...JK_SHELL.slice(1)];
function jacketVert(B, L, st) {
  const col = hexc(L.jacket), pan = hexc(L.panel), rough = { shell: 0.62, parka: 0.85, puffer: 0.5, rain: 0.33 }[st];
  return (t, d, a, out, rg) => {
    const y = rg.c.y / B.s; let m = 1, ao = 1, c = col, rr = rough;
    const fw = foldWave(t, a, 0.3, 0.1, 45, 1) * (1 - Math.abs(d.z)), fa = foldWave(t, a, 0.72, 0.08, 50, 2) * Math.abs(d.x);
    m += fw * 0.02 + fa * 0.025; ao -= Math.max(0, -fw) * 0.3 + Math.max(0, -fa) * 0.35;
    const nz = NZ.n3(rg.c.x * 7 + d.x * 2, rg.c.y * 7, rg.c.z * 7 + d.z * 2); m += nz * 0.015; ao -= Math.max(0, -nz) * 0.12;
    if (t < 0.035) ao *= 0.72;
    if (Math.abs(d.x) > 0.75 && y > 1.3 && y < 1.43) ao *= 0.82;                                  // armpits
    if (st === 'shell') {
      if (y > 1.39) c = pan;                                                                   // shoulder yoke
      if (d.z > 0.2 && Math.abs(Math.abs(d.x) - 0.5) < 0.05 && y > 1.16 && y < 1.34) ao *= 0.55;   // chest pocket zips
      if (d.z > 0.3 && y > 0.9 && y < 0.93) ao *= 0.8;                                         // hand-warmer welt
    } else if (st === 'parka') {
      if (Math.abs(y - 1.07) < 0.012) ao *= 0.65;                                              // waist drawcord
      if (d.z > 0.45 && Math.abs(d.x) > 0.25 && Math.abs(d.x) < 0.75 && y > 0.78 && y < 0.95) { out.off = 0.008; if (y > 0.92) ao *= 0.7; }   // bellows pockets
      if (d.z > 0.96) ao *= 0.75;                                                              // placket
    } else if (st === 'puffer') {
      const q = Math.abs(Math.sin(PI * (y - 0.8) / 0.075)); m *= 1 + 0.07 * (q ** 0.6 - 0.62); ao *= lerp(0.45, 1, q ** 0.5);
      if (t < 0.04) { c = pan; m *= 0.97; }
    } else if (st === 'rain') {
      if (d.z > 0.95) ao *= 0.8;
      if (d.z > 0.94 && Math.abs(Math.sin(y * 42)) > 0.96) { c = [0.6, 0.6, 0.6]; rr = 0.2; }        // snaps
      if (d.z > 0.3 && Math.abs(d.x) > 0.3 && Math.abs(d.x) < 0.7 && Math.abs(y - 0.92) < 0.012) ao *= 0.6;   // pocket flaps
    }
    const g = sstep(0.25, 0.75, NZ2.n3(rg.c.x * 9 + 3, rg.c.y * 9, rg.c.z * 9)); c = mix3(c, mul3(c, 0.72), g * 0.35);
    out.m = m; ao = clamp(ao, 0.3, 1.05); out.r = c[0] * ao; out.g = c[1] * ao; out.b = c[2] * ao; out.a = rr;
  };
}

/* ---------- survivors ---------- */
function buildSurvivor(look) {
  const L = LOOKS[look], B = makeBody({ ...L.body, ks: L.ks ?? 1 }), K = new Kit(B), st = L.style;
  const jc = hexc(L.jacket), pc = hexc(L.panel), uc = hexc(L.under), hair = lin(...L.sk.hair);
  addHead(K, { ...L.head, iris: hexc(L.iris) });
  addHands(K, { glove: L.glove ? hexc(L.glove) : null });
  const grow = st === 'puffer' ? 0.024 : st === 'parka' ? 0.008 : 0;
  const rows = st === 'parka' ? JK_PARKA : st === 'rain' ? JK_RAIN : JK_SHELL;
  const jst = torsoLoft(K, rows, { grow, vert: jacketVert(B, L, st), sub: st === 'puffer' ? 5 : 3, thigh: st === 'parka' ? 0.35 : 0.08 });
  zipper(K, jst, rows[0][0] + 0.005, 1.54, st === 'rain' ? mul3(jc, 0.7) : [0.02, 0.02, 0.022]);
  collar(K, st === 'shell' ? pc : jc, { r: st === 'puffer' ? 0.092 : st === 'rain' ? 0.086 : 0.079, h: st === 'puffer' ? 1.625 : 1.595, baffle: st === 'puffer', rough: st === 'rain' ? 0.35 : 0.7 });
  sleeves(K, jc, { bulk: st === 'puffer' ? 1.3 : st === 'parka' ? 1.1 : 1.02, baffle: st === 'puffer', panel: st === 'shell' ? pc : null, cuffCol: st === 'shell' ? pc : st === 'parka' ? mul3(jc, 0.85) : null, rough: { shell: 0.62, parka: 0.85, puffer: 0.5, rain: 0.33 }[st], sub: st === 'puffer' ? 4 : 2 });
  trousers(K, hexc(L.trousers), { cargo: look === 0 || look === 3, seamLight: look === 1, kneeWear: look === 1, rough: look === 3 ? 0.7 : 0.9 });
  boots(K, hexc(L.boots), { rough: look === 3 ? 0.4 : 0.55, top: look === 3 ? 0.3 : 0.25, noLace: look === 3 });
  let back;
  if (st === 'shell') {   // hoodie under the shell: hood on the back, ribbed hem
    const hb = blob([0, 1.47 * B.s, -0.118 * B.sw], [0.112, 0.068, 0.052], 0.8, 16, 10, (x, y, z, out) => { const ao = (y > 0.4 && z > -0.2 ? 0.45 : 1) * (0.85 + 0.15 * NZ.n3(x * 5, y * 5, z * 5)); out.r = uc[0] * ao; out.g = uc[1] * ao; out.b = uc[2] * ao; out.a = 0.95; });
    K.add('cloth', hb, [['chest', 1], ['neck', 0.3]]);
    torsoLoft(K, [[0.81, 0.174, 0.12, 0.128], [0.785, 0.172, 0.118, 0.126], [0.765, 0.17, 0.116, 0.124]], { radial: 26, sub: 1, vert: (t, d, a, out) => { const k = 0.8 + 0.2 * (0.5 + 0.5 * Math.cos(a * 26)); out.r = uc[0] * k; out.g = uc[1] * k; out.b = uc[2] * k; out.a = 0.95; } });
  }
  if (st === 'parka') {   // fur-trimmed hood lying on the back + knit scarf
    const s = B.s, fur = hexc(L.fur);
    K.add('cloth', blob([0, 1.47 * s, -0.13 * B.sw], [0.135, 0.08, 0.06], 0.8, 18, 12, (x, y, z, out) => { const ao = (y > 0.3 && z > -0.3 ? 0.4 : 1) * (0.85 + 0.15 * NZ.n3(x * 6, y * 6, z * 6)); out.r = jc[0] * ao; out.g = jc[1] * ao; out.b = jc[2] * ao; out.a = 0.85; }), [['chest', 1], ['neck', 0.3]]);
    const ring = []; for (let i = 0; i <= 14; i++) { const a = i / 14 * TAU; ring.push([Math.cos(a) * 0.132 * B.sw, (1.528 + 0.012 * Math.sin(a)) * s, -0.128 + Math.sin(a) * 0.058]); }
    K.add('hair', loft(ring.map(p => ({ p, r: 0.024 })), { radial: 10, sub: 3, vert: (t, d, a, out, rg) => { const n = NZ.n3(rg.c.x * 60 + d.x * 4, rg.c.y * 60 + d.y * 4, rg.c.z * 60 + d.z * 4); out.off = n * 0.012; const k = 0.75 + 0.35 * n; out.r = fur[0] * k; out.g = fur[1] * k; out.b = fur[2] * k; out.a = 0.8; } }), [['chest', 1], ['neck', 0.3]]);
    const sc = uc;
    K.add('cloth', loft([[1.47, 0.09, 0.092, 0.09, -0.02], [1.51, 0.097, 0.1, 0.095, -0.022], [1.55, 0.092, 0.095, 0.09, -0.025], [1.59, 0.08, 0.082, 0.08, -0.028]].map(([y, rx, rf, rb, z]) => ({ p: [0, y * s, z], rx, rf, rb })), { radial: 22, sub: 3, vert: (t, d, a, out, rg) => { const w = Math.sin(a * 1 + t * 9) * 0.5 + 0.5; out.m = 1 + 0.07 * w + 0.03 * NZ.n3(rg.c.x * 30, t * 4, rg.c.z * 30); const k = (0.6 + 0.4 * w) * (0.85 + 0.15 * Math.abs(Math.sin(a * 20))); out.r = sc[0] * k; out.g = sc[1] * k; out.b = sc[2] * k; out.a = 0.95; } }), neckWeights(B));
    const fz = (0.135) * B.sw + 0.012;
    K.add('cloth', twoSided(loft([[0.035, 1.5, fz - 0.02], [0.05, 1.42, fz + 0.005], [0.058, 1.32, fz + 0.012], [0.06, 1.22, fz + 0.01]].map(([x, y, z]) => ({ p: [x, y * s, z], rx: 0.04, rf: 0.006, rb: 0.006, fw: [0, 0, 1] })), { radial: 8, sq: 4, sub: 3, vert: (t, d, a, out) => { const k = (t > 0.92 ? 0.5 : 1) * (0.8 + 0.2 * Math.abs(Math.sin(a * 6 + t * 30))); out.r = sc[0] * k; out.g = sc[1] * k; out.b = sc[2] * k; out.a = 0.95; } }), 0.003, 0.5), torsoSkin(B, 0));
  }
  if (st === 'rain') { // hood rolled into the collar
    const ring = []; for (let i = 0; i <= 14; i++) { const a = i / 14 * TAU; ring.push([Math.cos(a) * 0.095 * B.sw, (1.555 + 0.02 * Math.max(0, -Math.sin(a))) * B.s, -0.03 + Math.sin(a) * 0.075 - 0.02]); }
    K.add('cloth', loft(ring.map(p => ({ p, r: 0.018 })), { radial: 10, sub: 2, vert: (t, d, a, out) => { const k = 0.8 + 0.2 * Math.sin(a * 2 + t * 30); out.r = jc[0] * k; out.g = jc[1] * k; out.b = jc[2] * k; out.a = 0.35; } }), neckWeights(B));
  }
  back = backpack(K, hexc(L.pack), { grow: grow + (st === 'rain' ? 0.006 : 0), big: st === 'rain', pad: L.pad ? hexc(L.pad) : null }).back;
  // heads
  if (look === 0) { beanie(K, hexc(L.hat), { slouch: 0.7 }); beard(K, mul3(hair, 0.9), { off: 0.0042, fuzz: 0.0015 }); }
  if (look === 1) { hairCap(K, hair, { pm: phi => 1.43 - 0.45 * Math.cos(phi), off: 0.0045, edge: 0.6, rough: 0.42 }); ponytail(K, hair); }
  if (look === 2) { hairCap(K, hair, { pm: phi => 1.36 - 0.42 * Math.cos(phi) + 0.06 * Math.cos(2 * phi), off: 0.007, curl: 0.006, curlF: 95, rough: 0.7, nu: 36, nv: 14 }); glasses(K, hexc(L.glasses)); }
  if (look === 3) { hairCap(K, hair, { pm: phi => 1.62 - 0.5 * Math.cos(phi), off: 0.006, matted: 0.004, rough: 0.5 }); beanie(K, hexc(L.hat), { slouch: 0.35, pompom: true, psi: 1.42 }); }
  return { B, K, sk: { ...L.sk }, style: { hunch: 0 }, back };
}

/* ---------- pilot ---------- */
function buildPilot() {
  const B = makeBody({ H: 1.81, sw: 1.03 }), K = new Kit(B), s = B.s;
  const olive = hexc(0x535838), vest = hexc(0xb8962a), black = hexc(0x161616), hair = lin(0.42, 0.36, 0.3);
  addHead(K, { jaw: 1.08, brow: 1.1, nose: 1.1, iris: hexc(0x5a6a5a) });
  addHands(K, {});
  const rows = [[0.86, 0.17, 0.112, 0.122, 0], [0.98, 0.168, 0.112, 0.12, 0], [1.08, 0.164, 0.11, 0.112, 0], [1.18, 0.172, 0.12, 0.11, 0.004], [1.28, 0.182, 0.126, 0.112, 0.004], [1.37, 0.19, 0.12, 0.112, 0], [1.43, 0.188, 0.104, 0.102, -0.008], [1.475, 0.157, 0.085, 0.088, -0.016], [1.505, 0.103, 0.073, 0.077, -0.022], [1.53, 0.077, 0.069, 0.071, -0.025]];
  const L = { jacket: 0x535838, panel: 0x464a2f };
  const st = torsoLoft(K, rows, { vert: (t, d, a, out, rg) => {
    jacketVert(B, L, 'parka')(t, d, a, out, rg);
    const y = rg.c.y / s;
    if (Math.abs(y - 1.035) < 0.018) { out.r *= 0.35; out.g *= 0.35; out.b *= 0.35; }                // belt
    if (d.z > 0.3 && Math.abs(d.x) > 0.25 && Math.abs(d.x) < 0.7 && y > 1.24 && y < 1.36) { out.off = 0.006; if (y > 1.335) { out.r *= 0.7; out.g *= 0.7; out.b *= 0.7; } }   // chest pockets
  } });
  zipper(K, st, 0.88, 1.53, [0.03, 0.03, 0.025]);
  collar(K, olive, { r: 0.08, h: 1.585, open: 0.06 });
  sleeves(K, olive, { bulk: 1.02, rough: 0.85, cuff: 0.95 });
  trousers(K, olive, { cargo: true, rough: 0.85 });
  boots(K, black, { rough: 0.35, top: 0.27 });
  // life vest: padded shell with a horseshoe collar bladder and buckles
  torsoLoft(K, [[1.12, 0.18, 0.13, 0.122], [1.22, 0.186, 0.138, 0.124], [1.32, 0.196, 0.142, 0.126], [1.4, 0.2, 0.13, 0.122], [1.45, 0.19, 0.11, 0.108]], { radial: 24, sub: 2, vert: (t, d, a, out, rg) => {
    const y = rg.c.y / s, q = Math.abs(Math.sin(PI * (y - 1.12) / 0.08)); out.m = 1 + 0.05 * (q ** 0.5 - 0.6) + (Math.abs(d.x) > 0.8 ? -0.04 : 0);
    let ao = lerp(0.6, 1, q ** 0.5); if (d.z > 0.97) ao *= 0.4; if (Math.abs(y - 1.18) < 0.012) ao *= 0.3; if (t < 0.06 || t > 0.94) ao *= 0.7;
    out.r = vest[0] * ao; out.g = vest[1] * ao; out.b = vest[2] * ao; out.a = 0.55;
  } });
  const hs = []; for (let i = 0; i <= 12; i++) { const a = -PI * 0.92 + i / 12 * PI * 1.84; hs.push([Math.sin(a) * 0.105 * B.sw, (1.5 - 0.035 * Math.max(0, Math.cos(a))) * s, Math.cos(a) * -0.095 + 0.005]); }
  K.add('cloth', loft(hs.map(p => ({ p, r: 0.03 })), { radial: 12, sub: 2, cap0: true, cap1: true, vert: (t, d, a, out) => { const k = 0.85 + 0.15 * Math.sin(t * 40); out.r = vest[0] * k; out.g = vest[1] * k; out.b = vest[2] * k; out.a = 0.5; } }), neckWeights(B));
  hairCap(K, hair, { pm: phi => 1.45 - 0.45 * Math.cos(phi), off: 0.004, rough: 0.6 });
  headset(K, hexc(0x2b2f22));
  return { B, K, sk: { tone: [0.78, 0.58, 0.46], hair: [0.42, 0.36, 0.3], stubble: 0.4, blush: 0.5, scalp: 1, wrinkles: 0.6 }, style: {}, back: new V3(0, 1.3 * s, -0.16) };
}

/* ---------- the island's people ---------- */
const OCHRE = [0.55, 0.21, 0.1], CLAY = [0.84, 0.81, 0.74], CHAR = [0.08, 0.07, 0.06];
const CAN_T = [[0.86, 0.15, 0.095, 0.105], [0.94, 0.158, 0.098, 0.112], [1.02, 0.14, 0.082, 0.096], [1.1, 0.134, 0.074, 0.094], [1.18, 0.148, 0.098, 0.1], [1.27, 0.158, 0.108, 0.1], [1.35, 0.168, 0.104, 0.098], [1.42, 0.172, 0.088, 0.09], [1.475, 0.135, 0.068, 0.078], [1.51, 0.075, 0.056, 0.062]];
const CAN = {
  scout: { body: { H: 1.76, sw: 0.95, hw: 0.95 }, head: { gaunt: 0.8, cheek: 1.12, brow: 1.2 }, tone: [0.6, 0.45, 0.35], hair: [0.13, 0.1, 0.08], bulk: 0.95, style: { hunch: 0.35, crouch: 0.25 } },
  brute: { body: { H: 1.92, sw: 1.18, hw: 1.1, hs: 1.12 }, head: { w: 1.06, jaw: 1.25, brow: 1.35, nose: 1.1, noseW: 1.15, neck: 1.28, gaunt: 0.3 }, tone: [0.56, 0.42, 0.33], hair: [0.16, 0.12, 0.09], bulk: 1.3, style: { hunch: 0.15, heavy: 1 } },
  elder: { body: { H: 1.72, sw: 0.9, hw: 0.92 }, head: { gaunt: 1.25, cheek: 1.15, brow: 1.1, jaw: 0.95, nose: 1.12 }, tone: [0.62, 0.48, 0.38], hair: [0.78, 0.76, 0.72], bulk: 0.85, style: { hunch: 0.55, slow: 1 } },
  skulker: { body: { H: 1.78, sw: 0.97 }, head: { gaunt: 0.9 }, tone: [0.58, 0.44, 0.34], hair: [0.12, 0.1, 0.08], bulk: 0.95, style: { hunch: 0.3, crouch: 0.15 } },
};
function canTorsoVert(B) {
  return (t, d, a, out, rg) => {
    const y = rg.c.y / B.s, side = Math.abs(d.x), front = d.z; let m = 1, ao = 1;
    if (y > 1.1 && y < 1.37 && (side > 0.3 || front > 0.3)) { const rib = Math.sin((y - 1.1) / 0.027 * TAU - side * 2.2), k = sstep(1.1, 1.17, y) * sstep(1.37, 1.3, y) * (1 - clamp((front - 0.82) * 5, 0, 1)); m += rib * 0.016 * k; ao -= Math.max(0, -rib) * 0.3 * k; }
    if (front > 0.92 && y > 1.15 && y < 1.43) { m -= 0.02; ao -= 0.15; }
    if (front < -0.93) { m -= 0.025; ao -= 0.12; }
    if (y > 1.43 && y < 1.47 && front > 0.35) m += 0.025;
    if (y > 0.98 && y < 1.12 && front > 0.5) ao -= 0.1;
    if (side > 0.75 && y > 1.3 && y < 1.43) ao -= 0.15;
    out.m = m; ao = clamp(ao, 0.4, 1); out.r = out.g = out.b = ao; out.a = 0.62;
  };
}
function dreads(K, col, n, len, seed, rough = 0.75) {
  const B = K.B, F = K.F, yN = B.J.neck[1];
  const sk = v => { const wH = sstep(yN - 0.02, yN + 0.1, v.y), wC = sstep(yN, yN - 0.15, v.y); return [['head', wH], ['neck', (1 - wH) * (1 - wC)], ['chest', (1 - wH) * wC]]; };
  const d = new V3();
  for (let i = 0; i < n; i++) {
    let phi = (hash1(i, seed) * 2 - 1) * PI; if (Math.abs(phi) < 0.75) phi = Math.sign(phi || 1) * (0.75 + Math.abs(phi) * 0.6);
    const psi = 0.55 + hash1(i, seed + 1) * 0.95;
    d.set(Math.sin(psi) * Math.sin(phi), Math.cos(psi), Math.sin(psi) * Math.cos(phi));
    const root = HC.clone().addScaledVector(d, march(F, HC, d, 0.004)), o = new V3(d.x, 0, d.z).normalize();
    const L = len * (0.65 + 0.5 * hash1(i, seed + 2)), sway = (hash1(i, seed + 3) - 0.5) * 0.04;
    const pts = [root.clone().addScaledVector(d, -0.004), root.clone().addScaledVector(d, 0.012), root.clone().add(new V3(o.x * 0.03, -0.03, o.z * 0.025)), root.clone().add(new V3(o.x * 0.045 + sway, -L * 0.4, o.z * 0.035 - 0.02)), root.clone().add(new V3(o.x * 0.055 + sway * 1.5, -L * 0.75, o.z * 0.03 - 0.035)), root.clone().add(new V3(o.x * 0.06 + sway * 2, -L, o.z * 0.03 - 0.045))];
    const r0 = 0.0085 + hash1(i, seed + 4) * 0.004;
    K.add('hair', loft(pts.map((p, k) => { const q = toBody(K, p.x, p.y, p.z); const r = r0 * [1, 1, 0.95, 0.9, 0.8, 0.55][k]; return { p: [q.x, q.y, q.z], r }; }), {
      radial: 5, sub: 2, cap1: true, dome: 0.8, ts: 0.12, vert: (t, dd, a, out, rg) => { const n2 = NZ.n3(rg.c.x * 90, rg.c.y * 90, rg.c.z * 90); out.m = 1 + 0.25 * n2; const k = (0.7 + 0.3 * n2) * lerp(1, 0.75, t); out.r = col[0] * k; out.g = col[1] * k; out.b = col[2] * k; out.a = rough; },
    }), sk);
  }
}
function boneNecklace(K, n, seed) {
  const B = K.B, s = B.s, bone = hexc(0xcbbfa6);
  const P = a => [Math.sin(a) * 0.112 * B.sw, (1.475 - 0.11 * Math.max(0, Math.cos(a)) ** 2) * s, Math.cos(a) * (Math.cos(a) > 0 ? 0.105 : 0.085) - 0.02];
  const cord = []; for (let i = 0; i <= 16; i++) cord.push(P(i / 16 * TAU));
  K.add('hide', loft(cord.map(p => ({ p, r: 0.0022 })), { radial: 4, sub: 2, color: [0.06, 0.045, 0.03], rough: 0.8 }), torsoSkin(B, 0));
  for (let i = 0; i < n; i++) {
    const a = (i / (n - 1) - 0.5) * 1.9, p = P(a), L = 0.03 + 0.025 * hash1(i, seed), out = [Math.sin(a) * 0.3, 0, 1];
    const pts = [p, [p[0] + out[0] * 0.006, p[1] - L * 0.5, p[2] + 0.008], [p[0] + out[0] * 0.01, p[1] - L, p[2] + 0.012]];
    K.add('hide', loft(pts.map((q, k) => ({ p: q, r: [0.0045, 0.0055, 0.0025][k] })), { radial: 5, sub: 2, cap0: true, cap1: true, vert: (t, d, aa, o) => { const k = 0.8 + 0.2 * Math.sin(t * 9 + i); o.r = bone[0] * k; o.g = bone[1] * k; o.b = bone[2] * k; o.a = 0.5; } }), torsoSkin(B, 0));
  }
}
function antlers(K) {
  const col = hexc(0x8a7558);
  const beam = [[0.05, 0.07, 0.03], [0.085, 0.13, 0.005], [0.115, 0.205, -0.025], [0.13, 0.28, -0.02], [0.12, 0.35, 0.02]];
  const tines = [[[0.09, 0.14, 0.0], [0.1, 0.2, 0.06]], [[0.12, 0.22, -0.02], [0.17, 0.27, 0.02]], [[0.128, 0.28, -0.02], [0.11, 0.33, -0.07]]];
  for (const g of [1, -1]) {
    const add = (pts, r0, r1) => K.add('hide', loft(pts.map((p, i) => { const q = toBody(K, p[0] * g, p[1], p[2]); return { p: [q.x, q.y, q.z], r: lerp(r0, r1, i / (pts.length - 1)) }; }), { radial: 7, sub: 3, cap1: true, dome: 0.9, vert: (t, d, a, o, rg) => { const n = NZ.n3(rg.c.x * 120, rg.c.y * 120, rg.c.z * 120); o.m = 1 + 0.12 * n * (1 - t); const k = lerp(0.75, 1.15, t) * (0.85 + 0.15 * n); o.r = col[0] * k; o.g = col[1] * k; o.b = col[2] * k; o.a = 0.55; } }), HEAD_ONLY);
    add(beam, 0.014, 0.004);
    for (const tn of tines) add([tn[0], [(tn[0][0] + tn[1][0]) / 2, (tn[0][1] + tn[1][1]) / 2 + 0.01, (tn[0][2] + tn[1][2]) / 2], tn[1]], 0.007, 0.0025);
  }
}
function buildCannibal(variant) {
  const V = CAN[variant] || CAN.scout, B = makeBody(V.body), K = new Kit(B), s = B.s, bulk = V.bulk;
  const hair = lin(...V.hair), hideC = hexc(0x5e4630), hideD = hexc(0x3a2a1c), fur = hexc(variant === 'brute' ? 0x4a3a2c : 0x6b5a46);
  addHead(K, { ...V.head, iris: hexc(variant === 'elder' ? 0x8a8a7a : 0x4a3a2a) });
  addHands(K, {});
  const tRows = CAN_T.map(([y, rx, rf, rb]) => [y, rx * (variant === 'brute' ? 1.12 : bulk * 1.02), rf * (variant === 'brute' ? 1.18 : bulk), rb * (variant === 'brute' ? 1.12 : bulk), 0]);
  torsoLoft(K, tRows, { mat: 'skin', uvRect: UV_TORSO, vert: canTorsoVert(B), radial: 26, sub: 3, thigh: 0.1 });
  const armK = variant === 'brute' ? 1.32 : bulk;
  sleeves(K, [1, 1, 1], { skin: true, uvRect: UV_ARM, bulk: armK, radial: 14, sub: 2,
    rows: [[-0.12, 0.05, 0.052, 0.054], [0.0, 0.052, 0.054, 0.05], [0.12, 0.047, 0.05, 0.045], [0.3, 0.041, 0.046, 0.038], [0.45, 0.036], [0.5, 0.034, 0.033, 0.036], [0.62, 0.037, 0.036, 0.035], [0.8, 0.031], [0.95, 0.025, 0.027, 0.027], [1.02, 0.023]],
    skinVert: (k, d) => { let m = 1, ao = 1; if (Math.abs(k - 0.5) < 0.05 && d.z < -0.4) m += 0.1; if (k > 0.15 && k < 0.35 && d.z > 0.3) m += 0.05 * Math.sin((k - 0.15) / 0.2 * PI); if (Math.abs(k - 0.48) < 0.04 && d.z > 0.5) ao -= 0.25; if (k < 0.03) ao -= 0.15; return [m, ao]; } });
  trousers(K, [1, 1, 1], { uvRect: UV_LEG, bulk: variant === 'brute' ? 1.18 : bulk,
    rows: [[-0.12, 0.085, 0.087, 0.092], [0, 0.083, 0.085, 0.09], [0.15, 0.075, 0.078, 0.076], [0.35, 0.062, 0.065, 0.06], [0.48, 0.05, 0.052, 0.05], [0.52, 0.049, 0.052, 0.05], [0.62, 0.051, 0.046, 0.058], [0.75, 0.044, 0.04, 0.048], [0.92, 0.032], [1.02, 0.031]],
    skinVert: (k, d) => { let m = 1, ao = 1; if (Math.abs(k - 0.5) < 0.04 && d.z > 0.5) m += 0.12; if (d.z > 0.85 && k > 0.55 && k < 0.9) m += 0.02; if (Math.abs(k - 0.46) < 0.03 && d.z < -0.5) ao -= 0.25; return [m, ao]; } });
  // pelvis wrap, loincloth / fur kilt with a rope belt
  torsoLoft(K, [[1.05, 0.152, 0.098, 0.108], [0.98, 0.158, 0.1, 0.115], [0.9, 0.15, 0.094, 0.112], [0.85, 0.11, 0.07, 0.085], [0.82, 0.06, 0.045, 0.05]].map(r => [r[0], r[1] * bulk, r[2] * bulk, r[3] * bulk]), { mat: 'hide', cap1: true, radial: 18, sub: 2, thigh: 0.4, vert: garment(hideD, 0.8, { noise: 0.02 }) });
  const kiltMat = variant === 'brute' ? 'hair' : 'hide', kc = variant === 'brute' ? fur : hideC;
  const kilt = loft(torsoStations(B, [[1.04, 0.163, 0.106, 0.116], [0.96, 0.172, 0.116, 0.13], [0.86, 0.18, 0.126, 0.138], [0.74, 0.19, 0.142, 0.148]].map(r => [r[0], r[1] * bulk, r[2] * bulk, r[3] * bulk])), {
    radial: 26, sub: 3, vert: (t, d, a, out, rg) => {
      const side = 1 - Math.abs(d.z), strip = Math.floor((a / TAU) * 13 + 100) % 2;
      out.dt = -(side ** 1.5) * 0.14 * t - (0.5 + 0.5 * NZ.n3(a * 2, 3, 1)) * 0.04 * t - strip * 0.025 * t;
      const n = NZ.n3(rg.c.x * 30, rg.c.y * 30, rg.c.z * 30); out.m = 1 + n * (kiltMat === 'hair' ? 0.06 : 0.02);
      const k = (0.8 + 0.25 * n) * (t > 0.9 ? 0.7 : 1); out.r = kc[0] * k; out.g = kc[1] * k; out.b = kc[2] * k; out.a = 0.8;
    },
  });
  K.add(kiltMat, twoSided(kilt, 0.004, 0.4), torsoSkin(B, 0.45));
  torsoLoft(K, [[1.05, 0.168, 0.11, 0.12], [1.03, 0.17, 0.112, 0.122], [1.01, 0.168, 0.11, 0.12]].map(r => [r[0], r[1] * bulk, r[2] * bulk, r[3] * bulk]), { mat: 'hide', radial: 20, sub: 1, vert: (t, d, a, out) => { const k = 0.5 + 0.3 * Math.abs(Math.sin(a * 12 + t * 3)); out.r = 0.16 * k; out.g = 0.12 * k; out.b = 0.08 * k; out.a = 0.9; } });
  // shin wraps + wrapped feet
  K.add('hide', chainLoft(B, legPoint, [[0.7, 0.052, 0.05, 0.06], [0.8, 0.047, 0.045, 0.052], [0.92, 0.037], [0.99, 0.036]], { bulk: variant === 'brute' ? 1.18 : bulk, radial: 12, sub: 3, vert: (t, d, a, out) => { const band = Math.abs(Math.sin(t * 22 + a * 0.5)); out.m = 1 + band * 0.05; const k = 0.55 + 0.45 * band; out.r = hideC[0] * k; out.g = hideC[1] * k; out.b = hideC[2] * k; out.a = 0.85; } }), [['shinL', 1], ['footL', 0.4]], true);
  boots(K, mul3(hideC, 1.15), { sole: hideD, rough: 0.85, top: 0.12, noLace: true, w: 0.92 });
  // hair
  const longHair = variant !== 'skulker';
  hairCap(K, hair, { pm: phi => 1.5 - 0.5 * Math.cos(phi), off: 0.009, matted: 0.007, rough: 0.8 });
  if (longHair) dreads(K, hair, variant === 'brute' ? 16 : variant === 'elder' ? 18 : 12, variant === 'elder' ? 0.42 : variant === 'brute' ? 0.36 : 0.28, variant.length * 7);
  let sk = { tone: V.tone, hair: V.hair, dirt: 0.35, blush: 0.15, tired: 1.6, stubble: 0.6, scalp: 1 };
  if (variant === 'scout') {
    boneNecklace(K, 9, 3);
    K.add('hide', loft([[0.15, 1.44, -0.06], [0.12, 1.45, 0.08], [0.0, 1.3, 0.115], [-0.12, 1.12, 0.1], [-0.16, 1.02, 0.0]].map(([x, y, z]) => ({ p: [x * B.sw, y * s, z * bulk], rx: 0.022, rf: 0.004, rb: 0.004, fw: [Math.sign(x) * 0.3 || 0, 0.3, Math.sign(z) || 1] })), { radial: 6, sq: 4, sub: 3, color: hideD, rough: 0.7 }), torsoSkin(B, 0));
    beard(K, hair, { off: 0.005, fuzz: 0.002, matted: 0.003 });
    sk.facePaint = (P, ax, c, tint) => {
      const band = sstep(-0.024, -0.016, P.y) * sstep(0.022, 0.014, P.y) * sstep(0.03, 0.06, P.z) * (0.75 + 0.25 * NZ.n3(P.x * 300, P.y * 300, 1));
      tint(OCHRE, band * 0.8);
      if (ax > 0.02 && ax < 0.045 && P.y < -0.025 && P.y > -0.075 && P.z > 0.05 && Math.sin(ax * 520) > 0.2) tint(CHAR, 0.7);
    };
    sk.bodyPaint = (region, s0, t, cs, sn, c, tint) => {
      if (region === 'torso' && t > 0.5 && t < 0.78 && Math.abs(s0 - 0.5) < 0.22 && Math.abs(Math.sin(t * 60)) > 0.7) tint(OCHRE, 0.75);
      if (region === 'arm' && t > 0.18 && t < 0.24) tint(OCHRE, 0.7);
    };
  } else if (variant === 'brute') {
    // heavy fur mantle over the shoulders + fur on the forearms
    const mant = loft(torsoStations(B, [[1.2, 0.27, 0.19, 0.2], [1.3, 0.27, 0.19, 0.2], [1.4, 0.26, 0.18, 0.19], [1.48, 0.21, 0.15, 0.16], [1.54, 0.14, 0.12, 0.125], [1.58, 0.1, 0.1, 0.105]].map(r => [r[0], r[1], r[2], r[3], -0.01])), {
      radial: 26, sub: 3, vert: (t, d, a, out, rg) => { const n = NZ.n3(rg.c.x * 40, rg.c.y * 40, rg.c.z * 40), n2 = NZ2.n3(rg.c.x * 9, rg.c.y * 9, rg.c.z * 9); out.m = 1 + 0.05 * n + 0.04 * n2; out.dt = t < 0.1 ? -0.05 * (0.5 + 0.5 * NZ.n3(a * 4, 0, 0)) : 0; const k = (0.65 + 0.35 * n) * (t < 0.08 ? 0.6 : 1) * (d.z > 0.9 ? 0.6 : 1); out.r = fur[0] * k; out.g = fur[1] * k; out.b = fur[2] * k; out.a = 0.85; },
    });
    K.add('hair', twoSided(mant, 0.006, 0.4), torsoSkin(B, 0));
    K.add('hair', chainLoft(B, armPoint, [[0.6, 0.05], [0.75, 0.046], [0.92, 0.04]], { bulk: 1.32, radial: 12, sub: 3, vert: (t, d, a, out, rg) => { const n = NZ.n3(rg.c.x * 50, rg.c.y * 50, rg.c.z * 50); out.m = 1 + 0.12 * n; const k = 0.7 + 0.3 * n; out.r = fur[0] * k; out.g = fur[1] * k; out.b = fur[2] * k; out.a = 0.85; } }), [['foreL', 1], ['armL', 0.2]], true);
    beard(K, hair, { off: 0.008, len: 0.05, fuzz: 0.003, matted: 0.008 });
    sk.facePaint = (P, ax, c, tint) => {
      if (P.y < -0.04 && P.z > 0.03) tint(CLAY, 0.55 * (0.7 + 0.3 * NZ.n3(P.x * 200, P.y * 200, 2)));
      if (P.y > 0.035 && P.y < 0.075 && P.z > 0.04 && Math.abs(Math.sin(P.y * 260)) > 0.75) tint(OCHRE, 0.8);
    };
    sk.bodyPaint = (region, s0, t, cs, sn, c, tint) => {
      if (region === 'torso' && t > 0.45 && Math.abs(s0 - 0.5) < 0.25 && NZ.n3(cs * 4, sn * 4, t * 6) > 0.25) tint(CLAY, 0.6);
      if (region === 'arm' && Math.abs(Math.sin(s0 * TAU * 3)) > 0.92 && t < 0.6) tint(OCHRE, 0.7);
    };
  } else if (variant === 'elder') {
    boneNecklace(K, 11, 9);
    antlers(K);
    { // headband under the antlers
      const pm = phi => 0.98 + 0.28 * (1 - Math.cos(phi)) * 0.5;
      K.add('hide', headShell(K, 30, 3, (u, v, d, j, nv) => { const phi = TAU * (u - 0.5), psi = pm(phi) + (j / nv - 0.5) * 0.16; d.set(Math.sin(psi) * Math.sin(phi), Math.cos(psi), Math.sin(psi) * Math.cos(phi)); }, (u, v, d, j, nv) => (j === 0 || j === nv ? 0.006 : 0.016), (u, v, p, d, o) => { const k = 0.5 + 0.2 * Math.sin(u * 60); o.r = hideD[0] * k * 2; o.g = hideD[1] * k * 2; o.b = hideD[2] * k * 2; o.a = 0.85; }), HEAD_ONLY);
    }
    beard(K, hair, { off: 0.006, len: 0.09, fuzz: 0.0025, matted: 0.004 });
    sk = { ...sk, wrinkles: 1, stubble: 0.2 };
    sk.facePaint = (P, ax, c, tint) => {
      if (P.z > 0.02) tint(CLAY, 0.5 * (0.8 + 0.2 * NZ.n3(P.x * 150, P.y * 150, 3)));
      if (ax > 0.024 && ax < 0.038 && P.y < -0.008 && P.y > -0.09 && P.z > 0.05 && Math.abs(Math.sin(ax * 700)) > 0.6) tint(OCHRE, 0.85);
    };
    sk.bodyPaint = (region, s0, t, cs, sn, c, tint) => {
      tint(OCHRE, 0.35);
      const dots = Math.abs(Math.sin(s0 * TAU * 9)) > 0.93 && Math.abs(Math.sin(t * 70)) > 0.85;
      if (dots && region !== 'leg') tint(CLAY, 0.85);
      if (region === 'leg' && Math.abs(Math.sin(t * 25)) > 0.9) tint(CLAY, 0.6);
    };
  } else if (variant === 'skulker') {
    // rag cloak, hood and a bark mask
    const rag = hexc(0x4a4034), rag2 = hexc(0x3a3229);
    const cloak = loft(torsoStations(B, [[0.56, 0.23, 0.18, 0.2], [0.75, 0.22, 0.165, 0.185], [0.95, 0.205, 0.152, 0.168], [1.15, 0.205, 0.152, 0.152], [1.3, 0.216, 0.15, 0.142], [1.42, 0.226, 0.124, 0.132], [1.49, 0.17, 0.102, 0.112], [1.54, 0.1, 0.086, 0.092], [1.58, 0.085, 0.08, 0.085]].map(r => [r[0], r[1], r[2], r[3], 0])), {
      radial: 28, sub: 3, vert: (t, d, a, out, rg) => {
        const strip = Math.floor((a / TAU) * 17 + 100) % 3, n = NZ.n3(rg.c.x * 12, rg.c.y * 12, rg.c.z * 12);
        if (t < 0.2) out.dt = (1 - t / 0.2) * (strip * 0.03 + (0.5 + 0.5 * NZ.n3(a * 5, 1, 2)) * 0.05);
        out.m = 1 + 0.03 * n + 0.02 * Math.sin(a * 17);
        const c = strip === 1 ? hideC : strip === 2 ? rag2 : rag, k = (0.75 + 0.3 * n) * (t < 0.06 ? 0.6 : 1);
        out.r = c[0] * k; out.g = c[1] * k; out.b = c[2] * k; out.a = 0.9;
      },
    });
    K.add('cloth', twoSided(cloak, 0.005, 0.35), torsoSkin(B, 0.4));
    K.add('cloth', headShell(K, 30, 12, capDir(phi => 2.2 - 0.85 * Math.cos(phi) * 0.5 - 0.42 * Math.cos(phi)), (u, v, d, j, nv) => (j === nv ? 0.006 : 0.024 + NZ.n3(d.x * 8, d.y * 8, d.z * 8) * 0.008), (u, v, p, d, o, j) => { const k = (0.7 + 0.3 * NZ.n3(d.x * 20, d.y * 20, d.z * 20)) * (j === 12 ? 0.5 : 1); o.r = rag[0] * k; o.g = rag[1] * k; o.b = rag[2] * k; o.a = 0.95; }), neckWeights(B));
    const bark = hexc(0x5a4632);
    K.add('hide', headShell(K, 22, 18, (u, v, d) => { const phi = (u - 0.5) * 2.5, e = lerp(-0.95, 0.55, v); d.set(Math.cos(e) * Math.sin(phi), Math.sin(e), Math.cos(e) * Math.cos(phi)); }, (u, v, d, j, nv, i, nu) => {
      if (j === 0 || j === nv || i === 0 || i === nu) return 0.004;
      const phi = (u - 0.5) * 2.5, e = Math.asin(d.y);
      const eye = Math.min(Math.hypot((Math.abs(phi) - 0.34) / 0.12, (e - 0.13) / 0.08), 9);
      return 0.017 + NZ.n3(d.x * 70, d.y * 9, d.z * 70) * 0.004 - (eye < 1 ? 0.012 : 0);
    }, (u, v, p, d, o) => {
      const phi = (u - 0.5) * 2.5, e = Math.asin(d.y), eye = Math.hypot((Math.abs(phi) - 0.34) / 0.12, (e - 0.13) / 0.08), mouth = Math.abs(e + 0.5) < 0.04 && Math.abs(phi) < 0.28;
      let k = 0.7 + 0.35 * NZ.n3(d.x * 70, d.y * 9, d.z * 70); if (eye < 1.1 || mouth) k = 0.05; if (Math.abs(e + 0.05) < 0.02) k *= 0.4;
      o.r = bark[0] * k; o.g = bark[1] * k; o.b = bark[2] * k; o.a = 0.9;
    }), HEAD_ONLY);
    for (const kk of [0.3, 0.55, 0.8]) K.add('cloth', chainLoft(B, armPoint, [[kk - 0.04, 0.05], [kk, 0.052], [kk + 0.04, 0.05]], { bulk, radial: 10, sub: 2, color: rag2, rough: 0.95 }), [['armL', 1], ['foreL', 1]], true);
  }
  return { B, K, sk, style: V.style, back: new V3(0, 1.3 * s, -0.13) };
}

/* =====================================================================================
   ANIMATION
   A pose is a flat object of joint channels (radians / metres). Side channels are prefixed
   L/R and written in canonical-left terms (abduction +, twist +) - apply() mirrors the right.
   hips p*: position + YXZ rotation; spine s*, chest c*, neck n*, head h* (YXZ, +x = bend forward).
   per side: cy cz clavicle, ax ay az upper arm (XYZ, 0 = hanging), eb elbow, et forearm twist,
   wx wy wz wrist, cu finger curl, th thumb, lx ly lz thigh, kn knee, fx fy fz foot, tx toe.
   ===================================================================================== */
const CH = (() => {
  const k = ['px', 'py', 'pz', 'prx', 'pry', 'prz', 'sx', 'sy', 'sz', 'cx', 'cy', 'cz', 'nx', 'ny', 'nz', 'hx', 'hy', 'hz'];
  for (const S of ['L', 'R']) for (const c of ['cy', 'cz', 'ax', 'ay', 'az', 'eb', 'et', 'wx', 'wy', 'wz', 'cu', 'th', 'lx', 'ly', 'lz', 'kn', 'fx', 'fy', 'fz', 'tx']) k.push(S + c);
  return k;
})();
const newPose = () => { const p = {}; for (const k of CH) p[k] = 0; return p; };
const _e1 = new THREE.Euler(), _X = new V3(1, 0, 0);
const kf = (t, keys) => {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const [t0, v0] = keys[i - 1], [t1, v1] = keys[i], u = (t - t0) / (t1 - t0), s = u * u * (3 - 2 * u); return v0 + (v1 - v0) * s; }
  return keys[keys.length - 1][1];
};
const kfv = (t, keys) => { const o = new V3(); for (let a = 0; a < 3; a++) o.setComponent(a, kf(t, keys.map(k => [k[0], k[1][a]]))); return o; };
function hipsQuat(p, q = new THREE.Quaternion()) { return q.setFromEuler(_e1.set(p.prx, p.pry, p.prz, 'YXZ')); }
function chestFrame(R, p, pos, q) {
  const qh = hipsQuat(p), qs = new THREE.Quaternion().setFromEuler(_e1.set(p.sx, p.sy, p.sz, 'YXZ')), qc = new THREE.Quaternion().setFromEuler(_e1.set(p.cx, p.cy, p.cz, 'YXZ'));
  pos.copy(R.spineL).applyQuaternion(qh).add(_a.set(p.px, p.py, p.pz));
  const q2 = qh.clone().multiply(qs); pos.add(R.chestL.clone().applyQuaternion(q2));
  return q.copy(q2).multiply(qc);
}
/** arm IK: T = grip point (body space). o.th / o.fi = thumb and finger directions (body space), o.pole elbow hint */
function armIK(p, R, S, T, o = {}) {
  const cp = new V3(), cq = chestFrame(R, p, cp, new THREE.Quaternion()), inv = cq.clone().invert();
  const t = T.clone().sub(cp).applyQuaternion(inv), pole = (o.pole ? o.pole.clone() : new V3(S === 'L' ? 0.4 : -0.4, -0.2, -1)).applyQuaternion(inv);
  let th = o.th ? o.th.clone().normalize().applyQuaternion(inv) : null, fi = o.fi ? o.fi.clone().normalize().applyQuaternion(inv) : null;
  if (S === 'R') { t.x = -t.x; pole.x = -pole.x; if (th) { th.x = -th.x; fi.x = -fi.x; } }
  const qcl = new THREE.Quaternion().setFromEuler(_e1.set(0, p[S + 'cy'], p[S + 'cz'], 'XYZ')), qi = qcl.clone().invert();
  const tc = t.sub(R.clavL).applyQuaternion(qi); pole.applyQuaternion(qi);
  let hq = null;
  if (th) { th.applyQuaternion(qi); fi.applyQuaternion(qi); hq = handQuat(th, new V3().crossVectors(fi, th), new THREE.Quaternion()); tc.sub(ANCH.clone().multiplyScalar(R.hs).applyQuaternion(hq)); }
  const qa = new THREE.Quaternion(), bend = twoBone(R.shoulderL, tc, R.Lu, R.Lf, pole, -1, qa);
  _e1.setFromQuaternion(qa, 'XYZ'); p[S + 'ax'] = _e1.x; p[S + 'ay'] = _e1.y; p[S + 'az'] = _e1.z; p[S + 'eb'] = bend;
  if (hq) {
    const local = qa.clone().multiply(new THREE.Quaternion().setFromAxisAngle(_X, -bend)).invert().multiply(hq), sw = new THREE.Quaternion();
    p[S + 'et'] = twistY(local, sw); _e1.setFromQuaternion(sw, 'XYZ'); p[S + 'wx'] = _e1.x; p[S + 'wy'] = _e1.y; p[S + 'wz'] = _e1.z;
  }
}
/** leg IK: foot (ankle) target in body space, pitch = foot angle to the ground (+ toe down) */
function legIK(p, R, S, F, pitch = 0, poleB = null, yaw = 0) {
  const qh = hipsQuat(p), inv = qh.clone().invert();
  const t = F.clone().sub(_a.set(p.px, p.py, p.pz)).applyQuaternion(inv), pole = (poleB ? poleB.clone() : new V3(0, 0, 1)).applyQuaternion(inv);
  if (S === 'R') { t.x = -t.x; pole.x = -pole.x; }
  const qa = new THREE.Quaternion(), bend = twoBone(R.thighL, t, R.Lt, R.Ls, pole, 1, qa);
  _e1.setFromQuaternion(qa, 'XYZ'); p[S + 'lx'] = _e1.x; p[S + 'ly'] = _e1.y; p[S + 'lz'] = _e1.z; p[S + 'kn'] = bend;
  const qhc = S === 'R' ? mirQ(qh.clone()) : qh;
  const qf = new THREE.Quaternion().setFromEuler(_e1.set(pitch, yaw, 0, 'YXZ'));
  const local = qhc.clone().multiply(qa).multiply(new THREE.Quaternion().setFromAxisAngle(_X, bend)).invert().multiply(qf);
  _e1.setFromQuaternion(local, 'XYZ'); p[S + 'fx'] = _e1.x; p[S + 'fy'] = _e1.y; p[S + 'fz'] = _e1.z;
}
const plant = (p, R, S, x, z, pitch = 0, lift = 0, pole) => legIK(p, R, S, new V3(S === 'L' ? x : -x, R.ankleY + lift, z), pitch, pole, S === 'L' ? 0.08 : -0.08);
function cycleLen(v, crouch, s) { const run = sstep(2.4, 4.6, v) * (1 - crouch); return lerp(lerp(0.7 + 0.36 * v, 1.0 + 0.42 * v, run), 0.5 + 0.45 * v, crouch) * s; }

function basePose(p, R, c) {
  const h = c.style.hunch || 0;
  p.py = R.hipY; p.sx = 0.03 + 0.08 * h; p.cx = 0.02 + 0.2 * h; p.nx = -0.05 - 0.12 * h; p.hx = -0.02 - 0.12 * h;
  for (const S of ['L', 'R']) { p[S + 'az'] = 0.1 + (c.style.heavy ? 0.12 : 0); p[S + 'ax'] = 0.04; p[S + 'eb'] = 0.2 + 0.25 * h; p[S + 'cu'] = 0.32; p[S + 'th'] = 0.25; p[S + 'wz'] = -0.12; p[S + 'et'] = 0.15; }
}
function holdItem(p, R, c, keepSwing = 0) {
  const it = c.item; if (!it) return;
  const sw = p.Rax * keepSwing;
  p.Rcu = 0.86; p.Rth = 0.8;
  if (it === 'axe' || it === 'club' || it === 'bow') { p.Rax = 0.05 + sw; p.Reb = 0.38; p.Rwx = -0.35; p.Raz = 0.12; }
  else if (it === 'spear') { p.Rax = -0.22 + sw * 0.5; p.Reb = 1.2; p.Raz = 0.18; p.Rwx = 0.05; p.Ret = 0.2; }
  else if (it === 'torch') { p.Rax = -0.48 + sw * 0.3; p.Reb = 1.35; p.Raz = 0.22; p.Rwx = 0.15; p.Ret = 0.1; }
  else if (it === 'flashlight' || it === 'flaregun') { p.Rax = -0.75 + sw * 0.2; p.Reb = 0.75; p.Raz = 0.1; p.Rwx = 1.25; p.Rwz = 0; }
  else if (it === 'rifle') { armIK(p, R, 'R', new V3(-0.15, 1.05 * R.s, 0.2), { th: new V3(0.05, 0.25, 1), fi: new V3(0, -1, 0.25) }); }
}
const MODES = {
  idle(p, R, c) {
    basePose(p, R, c);
    const t = c.t;
    p.cx += 0.018 * Math.sin(t * 1.7); p.Lcz = p.Rcz = 0.015 * Math.sin(t * 1.7);
    p.px = 0.014 * Math.sin(t * 0.45 + c.seed); p.prz = -0.02 * Math.sin(t * 0.45 + c.seed); p.cz = 0.015 * Math.sin(t * 0.45 + c.seed);
    p.py = R.hipY - 0.012 - 0.006 * Math.sin(t * 0.45 + c.seed);
    p.hy = 0.12 * Math.sin(t * 0.31 + c.seed * 2) * Math.sin(t * 0.17);
    plant(p, R, 'L', R.footX + 0.012, 0.015); plant(p, R, 'R', R.footX + 0.012, -0.02);
    holdItem(p, R, c);
  },
  walk(p, R, c) { gait(p, R, c, 0); holdItem(p, R, c, 0.3); },
  run(p, R, c) { gait(p, R, c, 0); holdItem(p, R, c, 0.3); },
  crouch(p, R, c) { gait(p, R, c, 1); holdItem(p, R, c, 0.2); },
  carry(p, R, c) {
    gait(p, R, { ...c, speed: Math.min(c.speed, 2.4) }, 0);
    p.cz = 0.07; p.Rcz = 0.22; p.hy = 0.15; p.hz = -0.1;
    const s = R.s, bob = p.py - R.hipY;
    armIK(p, R, 'R', new V3(-0.2, 1.62 * s + bob, 0.15), { th: new V3(0.4, 0.15, 0.9), fi: new V3(-0.65, -0.7, 0.25), pole: new V3(-1, -0.6, 0) });
    armIK(p, R, 'L', new V3(-0.07, 1.55 * s + bob, 0.36), { th: new V3(-0.2, 0.2, 1), fi: new V3(-0.8, -0.5, 0.0), pole: new V3(0.5, -1, 0) });
    p.Lcu = p.Rcu = 0.75; p.Lth = p.Rth = 0.5;
  },
  attack(p, R, c) {
    basePose(p, R, c);
    const t = c.t, s = R.s;
    if (c.item === 'spear') {
      const g = kfv(t, [[0, [-0.16, 1.12, 0.18]], [0.22, [-0.2, 1.2, -0.18]], [0.36, [-0.06, 1.3, 0.72]], [0.5, [-0.08, 1.25, 0.6]], [0.7, [-0.16, 1.12, 0.18]]]); g.y *= s;
      armIK(p, R, 'R', g, { th: new V3(-0.05, 0.25, 1), fi: new V3(0, -1, 0.25) });
      p.cy = kf(t, [[0, 0], [0.22, -0.4], [0.36, 0.3], [0.7, 0]]); p.cx = kf(t, [[0, 0.05], [0.36, 0.3], [0.7, 0.05]]);
      p.Lax = kf(t, [[0, 0], [0.22, -0.9], [0.36, -1.3], [0.7, 0]]); p.Leb = 0.5;
    } else {
      const g = kfv(t, [[0, [-0.2, 1.05, 0.3]], [0.22, [-0.24, 1.86, -0.08]], [0.36, [-0.08, 1.15, 0.56]], [0.5, [0.0, 0.9, 0.42]], [0.7, [-0.2, 1.05, 0.3]]]); g.y *= s;
      const th = kfv(t, [[0, [0, 0.8, 0.6]], [0.22, [0, 0.45, -0.9]], [0.36, [0, -0.3, 1]], [0.5, [0, -0.8, 0.5]], [0.7, [0, 0.8, 0.6]]]);
      const fi = kfv(t, [[0, [0, -0.6, 0.8]], [0.22, [0, 0.9, 0.45]], [0.36, [0, -0.95, -0.3]], [0.5, [0, -0.5, -0.8]], [0.7, [0, -0.6, 0.8]]]);
      armIK(p, R, 'R', g, { th, fi, pole: new V3(-0.6, -0.3, -0.6) });
      p.cy = kf(t, [[0, 0], [0.22, -0.25], [0.36, 0.18], [0.7, 0]]); p.cx = kf(t, [[0, 0.05], [0.22, -0.15], [0.36, 0.32], [0.5, 0.25], [0.7, 0.05]]);
      p.Lax = kf(t, [[0, 0], [0.22, -0.65], [0.36, 0.3], [0.7, 0]]); p.Leb = 0.6;
    }
    p.Rcu = 0.86; p.Rth = 0.8; p.pry = p.cy * 0.35; p.nx = -p.cx * 0.5;
    p.py = R.hipY - 0.03 - 0.04 * kf(t, [[0, 0], [0.36, 1], [0.7, 0]]);
    plant(p, R, 'L', R.footX + 0.02, 0.14); plant(p, R, 'R', R.footX + 0.02, -0.12);
  },
  chop(p, R, c) {
    basePose(p, R, c);
    const t = c.t, s = R.s;
    const g = kfv(t, [[0, [-0.12, 1.1, 0.3]], [0.3, [-0.42, 1.42, -0.02]], [0.45, [0.04, 1.26, 0.45]], [0.58, [0.04, 1.26, 0.45]], [0.8, [-0.12, 1.1, 0.3]]]); g.y *= s;
    const th = kfv(t, [[0, [0, 0.75, 0.65]], [0.3, [-0.5, 0.35, -0.8]], [0.45, [0.85, 0.05, 0.5]], [0.58, [0.85, 0.05, 0.5]], [0.8, [0, 0.75, 0.65]]]);
    const fi = kfv(t, [[0, [0, -0.65, 0.75]], [0.3, [-0.85, 0, 0.5]], [0.45, [-0.49, -0.03, 0.87]], [0.58, [-0.49, -0.03, 0.87]], [0.8, [0, -0.65, 0.75]]]);
    p.cy = kf(t, [[0, 0], [0.3, -0.6], [0.45, 0.32], [0.58, 0.28], [0.8, 0]]); p.sy = p.cy * 0.4; p.pry = p.cy * 0.25;
    p.cx = kf(t, [[0, 0.08], [0.3, 0.0], [0.45, 0.22], [0.8, 0.08]]); p.ny = -p.cy * 0.5; p.hy = -p.cy * 0.3;
    armIK(p, R, 'R', g, { th, fi, pole: new V3(-0.8, -0.6, -0.2) });
    p.Rcu = p.Lcu = 0.86; p.Rth = p.Lth = 0.8;
    p.py = R.hipY - 0.04; plant(p, R, 'L', R.footX + 0.03, 0.12); plant(p, R, 'R', R.footX + 0.03, -0.1);
  },
  throw(p, R, c) {
    basePose(p, R, c);
    const t = c.t, s = R.s;
    const g = kfv(t, [[0, [-0.2, 1.2, 0.2]], [0.3, [-0.3, 1.66, -0.3]], [0.45, [-0.15, 1.62, 0.45]], [0.6, [0.05, 1.1, 0.45]], [0.7, [-0.2, 1.15, 0.25]]]); g.y *= s;
    armIK(p, R, 'R', g, { th: kfv(t, [[0, [0, 1, 0.2]], [0.3, [0, 0.6, -0.8]], [0.45, [0, 0.9, 0.4]], [0.7, [0, 1, 0.2]]]), fi: new V3(0, -0.2, 1), pole: new V3(-0.7, -0.4, -0.5) });
    p.Lax = kf(t, [[0, 0], [0.3, -1.35], [0.45, -0.6], [0.7, 0]]); p.Leb = 0.3;
    p.cy = kf(t, [[0, 0], [0.3, -0.7], [0.45, 0.4], [0.6, 0.5], [0.7, 0]]); p.pry = p.cy * 0.3; p.ny = -p.cy * 0.5;
    p.cx = kf(t, [[0, 0.05], [0.3, -0.15], [0.5, 0.35], [0.7, 0.05]]);
    p.Rcu = kf(t, [[0, 0.8], [0.42, 0.8], [0.47, 0.1], [0.7, 0.4]]);
    plant(p, R, 'L', R.footX + 0.02, 0.16); plant(p, R, 'R', R.footX + 0.02, -0.14);
  },
  bow(p, R, c) {
    basePose(p, R, c);
    const s = R.s, t = c.t;
    p.pry = -0.75; p.cy = -0.15; p.ny = 0.45; p.hy = 0.42; p.hx = -0.05; p.cx = 0.02;
    armIK(p, R, 'L', new V3(0.03, 1.46 * s, 0.6), { th: new V3(0, 1, 0), fi: new V3(0.35, 0, 0.94), pole: new V3(1, -0.3, 0) });
    armIK(p, R, 'R', new V3(-0.06, 1.57 * s, 0.06 - 0.01 * Math.sin(t * 2)), { th: new V3(0.2, 0.3, 0.93), fi: new V3(0.95, 0, -0.2), pole: new V3(-0.6, 0, -1) });
    p.Lcu = 0.86; p.Lth = 0.8; p.Rcu = 0.55; p.Rth = 0.35;
    p.py = R.hipY - 0.02; legIK(p, R, 'L', new V3(0.13, R.ankleY, 0.15), 0, null, 0.5); legIK(p, R, 'R', new V3(-0.12, R.ankleY, -0.14), 0, null, -0.9);
  },
  hurt(p, R, c) {
    MODES.idle(p, R, c);
    const e = kf(c.t, [[0, 0], [0.08, 1], [0.5, 0]]);
    p.cx -= 0.35 * e; p.sx -= 0.12 * e; p.nx -= 0.25 * e; p.hx += 0.25 * e; p.cy += 0.15 * e; p.cz += 0.08 * e;
    for (const S of ['L', 'R']) { p[S + 'az'] += 0.3 * e; p[S + 'eb'] += 0.7 * e; p[S + 'ax'] -= 0.45 * e; p[S + 'cu'] += 0.4 * e; }
    p.py -= 0.05 * e; plant(p, R, 'L', R.footX + 0.012, 0.015); plant(p, R, 'R', R.footX + 0.012, -0.02);
  },
  downed(p, R, c) {
    const t = c.t, s = R.s, st = Math.sin(t * 1.3);
    p.px = 0; p.py = 0.15; p.pz = -0.12; p.prx = -1.02 + 0.03 * st; p.prz = 0.12;
    p.sx = 0.3; p.cx = 0.22; p.cz = -0.08; p.nx = -0.15; p.hx = -0.28; p.hy = -0.15;
    armIK(p, R, 'L', new V3(0.27, 0.05, -0.36), { th: new V3(0.3, 0, 1), fi: new V3(0.4, -0.2, -1), pole: new V3(1, 0.3, -0.6) });
    armIK(p, R, 'R', new V3(-0.24 + 0.03 * st, 0.78 * s + 0.04 * Math.sin(t * 2.1), 0.42), { th: new V3(1, 0.1, 0), fi: new V3(0, 0.25, 1), pole: new V3(-0.6, -1, 0) });
    p.Lcu = 0.25; p.Lth = 0.2; p.Rcu = 0.15 + 0.1 * Math.sin(t * 2.1); p.Rth = 0.1;
    legIK(p, R, 'L', new V3(0.17, R.ankleY, 0.82), -0.9, new V3(0.2, 1, 0.2)); legIK(p, R, 'R', new V3(-0.2, R.ankleY, 0.5), -0.2, new V3(-0.2, 1, 0.5));
  },
  dead(p, R, c) {
    p.py = 0.11; p.pz = -0.25; p.prx = -PI / 2 + 0.04; p.pry = 0.15;
    p.hy = 0.6; p.hx = -0.15; p.nx = -0.1;
    p.Laz = 1.05; p.Lax = -0.2; p.Leb = 0.45; p.Raz = 1.3; p.Rax = 0.25; p.Reb = 0.2; p.Lcu = p.Rcu = 0.4; p.Lth = p.Rth = 0.3; p.Let = 0.6; p.Ret = -0.3;
    p.Llz = 0.14; p.Lkn = 0.12; p.Lfx = 0.55; p.Rlx = -0.25; p.Rlz = 0.04; p.Rkn = 0.42; p.Rfx = 0.5; p.Rly = -0.3;
  },
  sleep(p, R, c) {
    const b = Math.sin(c.t * 1.1);
    p.px = -0.32; p.py = 0.16; p.prz = -PI / 2 + 0.05;
    p.sx = 0.18; p.cx = 0.22 + 0.02 * b; p.nx = 0.2; p.hx = 0.05; p.hz = 0.2;
    p.Llx = -0.95; p.Lkn = 1.35; p.Rlx = -1.15; p.Rkn = 1.5; p.Rlz = 0.05; p.Lfx = p.Rfx = 0.5;
    p.Lax = -2.0; p.Leb = 1.9; p.Laz = 0.25; p.Rax = -0.75; p.Reb = 1.1; p.Raz = 0.1; p.Lcu = p.Rcu = 0.45; p.Lth = p.Rth = 0.3;
  },
  sit(p, R, c) {
    basePose(p, R, c);
    const t = c.t, s = R.s, rub = Math.max(0, Math.sin(t * 0.7)) ** 3;
    p.py = 0.16; p.pz = -0.12; p.prx = -0.25; p.sx = 0.3 + 0.02 * Math.sin(t * 0.6); p.cx = 0.16; p.nx = -0.05; p.hx = 0.08;
    legIK(p, R, 'L', new V3(0.15, R.ankleY, 0.36), 0.05, new V3(0.3, 1, 0.6)); legIK(p, R, 'R', new V3(-0.15, R.ankleY, 0.35), 0.05, new V3(-0.3, 1, 0.6));
    const w = 0.04 * Math.sin(t * 9) * rub;
    armIK(p, R, 'L', new V3(0.1 - 0.06 * rub, 0.52 * s, 0.5 + w), { th: new V3(-1, 0.2, 0.2), fi: new V3(0, -0.25, 1), pole: new V3(1, -0.5, -0.3) });
    armIK(p, R, 'R', new V3(-0.1 + 0.06 * rub, 0.52 * s, 0.5 - w), { th: new V3(1, 0.2, 0.2), fi: new V3(0, -0.25, 1), pole: new V3(-1, -0.5, -0.3) });
    p.Lcu = p.Rcu = 0.15; p.Lth = p.Rth = 0.1;
  },
  seated(p, R, c) {
    basePose(p, R, c);
    const t = c.t, s = R.s, vib = 0.003 * Math.sin(t * 41) + 0.002 * Math.sin(t * 67);
    p.py = 0.53 * s + vib; p.pz = -0.08; p.sx = 0.0; p.cx = 0.0; p.nx = 0.02 + vib * 3; p.hx = 0.04; p.hy = 0.2 * Math.sin(t * 0.25) * Math.sin(t * 0.13);
    legIK(p, R, 'L', new V3(0.14, R.ankleY, 0.4), 0, new V3(0.1, 0.6, 1)); legIK(p, R, 'R', new V3(-0.14, R.ankleY, 0.4), 0, new V3(-0.1, 0.6, 1));
    armIK(p, R, 'L', new V3(0.12, 0.6 * s, 0.32), { th: new V3(-0.5, 0.0, 1), fi: new V3(0.2, -1, 0.3), pole: new V3(0.8, -0.3, -0.5) });
    armIK(p, R, 'R', new V3(-0.12, 0.6 * s, 0.32), { th: new V3(0.5, 0.0, 1), fi: new V3(-0.2, -1, 0.3), pole: new V3(-0.8, -0.3, -0.5) });
    p.Lcu = p.Rcu = 0.3;
  },
  brace(p, R, c) {
    MODES.seated(p, R, c);
    const tr = 0.02 * Math.sin(c.t * 31);
    p.sx = 0.5; p.cx = 0.5 + tr; p.nx = 0.45; p.hx = 0.3;
    for (const S of ['L', 'R']) { p[S + 'ax'] = -2.55; p[S + 'az'] = 0.35; p[S + 'ay'] = -0.3; p[S + 'eb'] = 2.0; p[S + 'wx'] = 0; p[S + 'wy'] = 0; p[S + 'wz'] = -0.3; p[S + 'et'] = 0.4; p[S + 'cu'] = 0.65; p[S + 'th'] = 0.4; p[S + 'cz'] = 0.15; }
  },
  cower(p, R, c) {
    basePose(p, R, c);
    const tr = Math.sin(c.t * 29) * 0.025;
    p.py = 0.47 * R.s; p.pz = -0.1; p.prx = 0.25; p.sx = 0.55; p.cx = 0.42 + tr; p.nx = 0.3; p.hx = 0.35; p.hy = 0.15 * Math.sin(c.t * 1.3);
    plant(p, R, 'L', R.footX + 0.07, 0.08, 0.3, 0.035, new V3(0.4, 0.3, 1)); plant(p, R, 'R', R.footX + 0.07, 0.04, 0.3, 0.035, new V3(-0.4, 0.3, 1));
    for (const S of ['L', 'R']) { p[S + 'ax'] = -2.3 + tr; p[S + 'az'] = 0.5; p[S + 'eb'] = 2.05; p[S + 'cu'] = 0.65; p[S + 'th'] = 0.5; p[S + 'cz'] = 0.15; p[S + 'et'] = 0.5; }
  },
  ritual(p, R, c) {
    basePose(p, R, c);
    const w = 2.4, t = c.t + c.seed, sn = Math.sin(t * w);
    p.px = 0.06 * sn; p.prz = -0.07 * sn; p.cz = 0.1 * sn; p.py = R.hipY - 0.07 - 0.04 * Math.abs(Math.sin(t * w));
    p.cx = -0.1; p.nx = -0.2; p.hx = -0.3 + 0.1 * Math.sin(t * w * 0.5); p.hz = 0.1 * sn;
    p.Laz = 2.3 + 0.25 * Math.sin(t * w + 0.5); p.Lax = -0.35; p.Leb = 0.5 + 0.3 * Math.sin(t * w + 1); p.Lwz = 0.4;
    p.Raz = 2.3 + 0.25 * Math.sin(t * w + 2.1); p.Rax = -0.35; p.Reb = 0.5 + 0.3 * Math.sin(t * w + 2.6); p.Rwz = 0.4;
    p.Lcu = p.Rcu = 0.15; p.Lcz = p.Rcz = 0.25;
    plant(p, R, 'L', R.footX + 0.06, 0.05, 0, 0.07 * Math.max(0, sn)); plant(p, R, 'R', R.footX + 0.06, -0.02, 0, 0.07 * Math.max(0, -sn));
  },
  wave(p, R, c) {
    MODES.idle(p, R, c);
    const t = c.t, s = R.s;
    armIK(p, R, 'R', new V3(-0.3 + 0.13 * Math.sin(t * 8), 1.98 * s, 0.12), { th: new V3(1, 0.15 * Math.sin(t * 8), 0), fi: new V3(0.12 * Math.sin(t * 8), 1, 0.15), pole: new V3(-1, -0.5, 0) });
    p.Rcu = 0.05; p.Rth = 0.05; p.Rcz = 0.3; p.hx = -0.25; p.nx = -0.1; p.cz = -0.05;
    p.py += 0.015 * Math.abs(Math.sin(t * 4));
  },
  swim(p, R, c) {
    const u = (c.t % 1.4) / 1.4;
    p.py = -0.32; p.pz = -0.35; p.prx = 1.12; p.cx = -0.1; p.nx = -0.55; p.hx = -0.35;
    for (const S of ['L', 'R']) {
      p[S + 'ax'] = kf(u, [[0, -2.8], [0.3, -2.8], [0.55, -1.6], [0.75, -1.9], [1, -2.8]]);
      p[S + 'az'] = kf(u, [[0, 0.15], [0.3, 0.2], [0.55, 1.0], [0.75, 0.25], [1, 0.15]]);
      p[S + 'eb'] = kf(u, [[0, 0.1], [0.3, 0.15], [0.55, 1.2], [0.75, 2.0], [1, 0.1]]);
      p[S + 'cu'] = 0.12; p[S + 'th'] = 0.1; p[S + 'et'] = 0.8;
      p[S + 'lx'] = kf(u, [[0, 0], [0.5, 0], [0.8, -0.9], [1, 0]]); p[S + 'kn'] = kf(u, [[0, 0], [0.5, 0.1], [0.8, 2.0], [1, 0]]);
      p[S + 'lz'] = kf(u, [[0, 0.05], [0.8, 0.35], [0.9, 0.45], [1, 0.05]]); p[S + 'fx'] = kf(u, [[0, 0.9], [0.8, -0.3], [1, 0.9]]);
    }
  },
};
function gait(p, R, c, crouchK) {
  basePose(p, R, c);
  const v = c.speed, run = sstep(2.4, 4.6, v) * (1 - crouchK), move = sstep(0.05, 0.6, v);
  const C = cycleLen(v, crouchK, R.s), beta = lerp(lerp(0.62, 0.56, sstep(1, 2.5, v)), 0.36, run);
  const half = beta * C * 0.5 * move, lift = lerp(0.1, 0.3, run) * move * lerp(1, 0.7, crouchK), h = c.style.hunch || 0;
  const ph = c.phase * TAU;
  p.prx = 0.05 * run + 0.15 * crouchK;
  p.sx = 0.03 + 0.04 * move + 0.12 * run + 0.3 * crouchK + 0.08 * h; p.cx = 0.02 + 0.06 * run + 0.2 * crouchK + 0.2 * h;
  p.nx = -(p.sx + p.cx + p.prx) * 0.5; p.hx = -(p.sx + p.cx + p.prx) * 0.3;
  p.pry = -0.09 * Math.cos(ph) * move * (1 - 0.5 * crouchK); p.cy = -p.pry * 1.5; p.ny = -p.pry * 0.3;
  p.prz = 0.035 * Math.sin(ph * 2) * move * (1 - run) * 0;
  p.px = 0.016 * Math.cos(ph - 1.2) * move * (1 - run);
  p.pz = -0.1 * crouchK;
  const feet = [];
  for (const [k, S, g] of [[0, 'L', 1], [1, 'R', -1]]) {
    const q = (c.phase + k * 0.5) % 1; let z, y = R.ankleY, pitch = 0;
    if (q < beta) {
      const u = q / beta; z = half * (1 - 2 * u);
      pitch = -0.22 * move * (1 - sstep(0, 0.2, u)) + 0.55 * move * sstep(0.62, 1, u);
      if (pitch > 0) { y += 0.13 * Math.sin(pitch); z += 0.13 * (1 - Math.cos(pitch)); }
    } else {
      const u = (q - beta) / (1 - beta), e = 0.5 - 0.5 * Math.cos(PI * u);
      z = -half + 2 * half * e; y += lift * Math.sin(PI * Math.min(1, u * 1.1)) ** (run > 0.5 ? 0.7 : 1.3);
      pitch = lerp(0.55, -0.22, sstep(0, 0.85, u)) * move;
    }
    feet.push({ S, pos: new V3(g * (R.footX - 0.01 * move + 0.06 * crouchK), y, z + 0.04 * crouchK), pitch });
    const sw = Math.cos(q * TAU);
    p[S + 'ax'] = sw * lerp(0.3, 0.85, run) * move * (1 - crouchK * 0.5) + 0.04 - crouchK * 0.35;
    p[S + 'eb'] = lerp(0.25, 1.45, run) + Math.max(0, -sw) * 0.35 * move + crouchK * 0.55;
    p[S + 'az'] = 0.1 + 0.06 * run + (c.style.heavy ? 0.12 : 0);
    p[S + 'cu'] = lerp(0.32, 0.55, run);
  }
  let hy = R.hipY - 0.025 * move - 0.05 * run - 0.34 * crouchK * R.s;
  const Lm = (R.Lt + R.Ls) * 0.996;
  for (const f of feet) { const dx = Math.abs(f.pos.x) - R.thighL.x, dz = f.pos.z - p.pz; hy = Math.min(hy, f.pos.y - R.thighL.y + Math.sqrt(Math.max(0.01, Lm * Lm - dz * dz - dx * dx))); }
  p.py = hy;
  for (const f of feet) legIK(p, R, f.S, f.pos, f.pitch, null, f.S === 'L' ? 0.06 : -0.06);
}
const ONE_SHOT = { attack: 0.7, chop: 0.8, throw: 0.7, hurt: 0.5 };
const LOOK_W = { idle: 1, walk: 1, run: 0.6, crouch: 1, carry: 0.6, bow: 0.3, seated: 1, sit: 1, wave: 0.6, ritual: 0, cower: 0, brace: 0, downed: 0.6, dead: 0, sleep: 0, swim: 0.7, attack: 0.3, chop: 0.2, throw: 0.3, hurt: 0.3 };

/* =====================================================================================
   PEOPLE
   ===================================================================================== */
const BUILD_CACHE = new Map();
function getBuild(kind, opts) {
  const variant = CAN[opts.variant] ? opts.variant : 'scout', look = (((opts.look ?? 0) % 4) + 4) % 4;
  const key = kind === 'pilot' ? 'pilot' : kind === 'cannibal' ? 'c:' + variant : 's:' + look;
  if (BUILD_CACHE.has(key)) return BUILD_CACHE.get(key);
  const b = kind === 'pilot' ? buildPilot() : kind === 'cannibal' ? buildCannibal(variant) : buildSurvivor(look);
  const rig = b.B.rig, d = n => rig.defs[rig.index[n]].pos;
  const R = { s: b.B.s, sw: b.B.sw, hipY: b.B.J.hips[1], spineL: d('spine'), chestL: d('chest'), clavL: d('clavL'), shoulderL: d('armL'), thighL: d('thighL'), Lu: b.B.Lu, Lf: b.B.Lf, Lt: b.B.Lt, Ls: b.B.Ls, ankleY: b.B.J.ankle[1], footX: b.B.J.ankle[0], hs: b.B.hs, ks: b.B.ks };
  const geos = b.K.bake(rig);
  const D = { key, rig, R, geos, tex: skinTexture(b.sk), style: b.style || {}, back: b.back, chestY: b.B.J.chest[1] };
  D.smat = skinMat(D.tex);
  D.tris = 0; for (const k in geos) D.tris += triCount(geos[k]);
  BUILD_CACHE.set(key, D);
  return D;
}
/**
 * createPerson(kind, { look, variant, seed }) -> P
 *   P.root (Group), P.animate(dt, s), P.handR / P.handL (grip anchors: handle along +Y, item front +Z),
 *   P.head (eye-level centre of the head), P.back (outer face of the backpack / upper back),
 *   P.shoulderR (top of the right shoulder: a carried log centred here, axis along local Z),
 *   P.tris, P.dispose()
 */
export function createPerson(kind = 'survivor', opts = {}) {
  const D = getBuild(kind, opts), M = sharedMats(), R = D.R;
  const root = new THREE.Group(), body = new THREE.Group(); root.add(body); root.name = 'Person_' + D.key;
  const bones = D.rig.defs.map(d => { const b = new THREE.Bone(); b.name = d.name; b.position.copy(d.pos); b.quaternion.copy(d.quat); if (d.axis) b.userData.axis = d.axis; return b; });
  const by = {}; bones.forEach(b => (by[b.name] = b));
  D.rig.defs.forEach((d, i) => { if (d.parent >= 0) bones[d.parent].add(bones[i]); else body.add(bones[i]); });
  root.updateMatrixWorld(true);
  const skel = new THREE.Skeleton(bones, D.rig.defs.map(d => D.rig.world[d.name].clone().invert()));
  const meshes = [];
  for (const k in D.geos) {
    const m = new THREE.SkinnedMesh(D.geos[k], k === 'skin' ? D.smat : M[k]);
    m.bind(skel, new THREE.Matrix4()); m.castShadow = true; m.receiveShadow = true;
    m.boundingSphere = new THREE.Sphere(new V3(0, 0.8, 0), 1.7);
    body.add(m); meshes.push(m);
  }
  const anchor = (bone, pos, rx = 0) => { const o = new THREE.Object3D(); o.position.copy(pos); o.rotation.x = rx; by[bone].add(o); return o; };
  const P = { root, kind, tris: D.tris, meshes, bones: by };
  P.handL = anchor('handL', new V3(ANCH.x * R.hs, ANCH.y * R.hs, ANCH.z * R.hs), PI / 2);
  P.handR = anchor('handR', new V3(-ANCH.x * R.hs, ANCH.y * R.hs, ANCH.z * R.hs), PI / 2);
  P.head = anchor('head', new V3(0, 0.105 * R.ks, 0));
  P.back = anchor('chest', D.back.clone().sub(new V3(0, D.chestY, -0.015)));
  P.shoulderR = anchor('chest', new V3(-0.15 * R.sw, (1.5 - 1.27) * R.s + 0.07, -0.02));
  const seed = opts.seed ?? Math.floor(Math.random() * 1000);
  const st = { mode: null, w: {}, clock: {}, speed: 0, phase: hash1(seed, 5), look: new V3(), lookW: 0, yaw: 0, pitch: 0, item: null, itemPrev: null, itemK: 1 };
  const style = D.style, rate = 1 + (hash1(seed, 9) - 0.5) * 0.1;
  const acc = newPose(), tmp = newPose();
  const apply = p => {
    by.hips.position.set(p.px, p.py, p.pz); by.hips.rotation.set(p.prx, p.pry, p.prz, 'YXZ');
    by.spine.rotation.set(p.sx, p.sy, p.sz, 'YXZ'); by.chest.rotation.set(p.cx, p.cy, p.cz, 'YXZ');
    by.neck.rotation.set(p.nx, p.ny, p.nz, 'YXZ'); by.head.rotation.set(p.hx, p.hy, p.hz, 'YXZ');
    for (const [S, g] of [['L', 1], ['R', -1]]) {
      by['clav' + S].rotation.set(0, g * p[S + 'cy'], g * p[S + 'cz']);
      by['arm' + S].rotation.set(p[S + 'ax'], g * p[S + 'ay'], g * p[S + 'az']);
      by['fore' + S].rotation.set(-p[S + 'eb'], g * p[S + 'et'], 0);
      by['hand' + S].rotation.set(p[S + 'wx'], g * p[S + 'wy'], g * p[S + 'wz']);
      curlFingers(by, S, p[S + 'cu'], p[S + 'th']);
      by['thigh' + S].rotation.set(p[S + 'lx'], g * p[S + 'ly'], g * p[S + 'lz']);
      by['shin' + S].rotation.set(p[S + 'kn'], 0, 0);
      by['foot' + S].rotation.set(p[S + 'fx'], g * p[S + 'fy'], g * p[S + 'fz']);
      by['toe' + S].rotation.set(p[S + 'tx'], 0, 0);
    }
  };
  const evalMode = (m, item, out) => {
    for (const k of CH) out[k] = 0;
    (MODES[m] || MODES.idle)(out, R, { t: st.clock[m] || 0, speed: st.speed, phase: st.phase, item, style, seed: hash1(seed, 3) * 10 });
  };
  const wv = new V3(), hv = new V3(), qv = new THREE.Quaternion();
  P.animate = (dt, s = {}) => {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    let mode = s.mode || 'idle'; if (!MODES[mode]) mode = 'idle';
    if (mode !== st.mode) { if (st.mode === null) { st.w = { [mode]: 1 }; } st.mode = mode; st.clock[mode] = 0; if (!(mode in st.w)) st.w[mode] = 0; }
    for (const k in st.clock) st.clock[k] += dt * rate;
    if (s.t != null) st.clock[mode] = ONE_SHOT[mode] ? Math.min(s.t, ONE_SHOT[mode]) : s.t;
    else if (ONE_SHOT[mode]) st.clock[mode] = Math.min(st.clock[mode], ONE_SHOT[mode]);
    st.speed = damp(st.speed, s.speed || 0, 8, dt);
    const crouch = mode === 'crouch' ? 1 : 0;
    st.phase = (st.phase + dt * st.speed / cycleLen(Math.max(st.speed, 0.3), crouch, R.s)) % 1;
    const item = s.item || null;
    if (item !== st.item) { st.itemPrev = st.item; st.item = item; st.itemK = 0; }
    st.itemK = Math.min(1, st.itemK + dt / 0.25);
    let tot = 0;
    for (const m in st.w) { st.w[m] = damp(st.w[m], m === mode ? 1 : 0, 11, dt); if (m !== mode && st.w[m] < 0.002) delete st.w[m]; else tot += st.w[m]; }
    for (const k of CH) acc[k] = 0;
    let lookW = 0, twoW = 0;
    for (const m in st.w) {
      const w = st.w[m] / tot;
      evalMode(m, item, tmp);
      if (st.itemK < 1) { const b = newPose(); evalMode(m, st.itemPrev, b); for (const k of CH) tmp[k] = lerp(b[k], tmp[k], sstep(0, 1, st.itemK)); }
      for (const k of CH) acc[k] += tmp[k] * w;
      lookW += (LOOK_W[m] ?? 0) * w;
      if (m === 'chop' || (item === 'rifle' && /idle|walk|run|crouch/.test(m))) twoW += w;
    }
    // head look / aim on top
    let ty = 0, tp = 0;
    if (s.lookAt) {
      root.updateMatrixWorld(); wv.set(s.lookAt.x, s.lookAt.y, s.lookAt.z); root.worldToLocal(wv);
      ty = clamp(Math.atan2(wv.x, wv.z), -1.2, 1.2); tp = clamp(-Math.atan2(wv.y - 1.62 * R.s, Math.hypot(wv.x, wv.z)), -0.6, 0.7);
    }
    tp -= clamp(s.aim || 0, -1.2, 1.2) * 0.8;
    st.yaw = damp(st.yaw, ty * lookW, 6, dt); st.pitch = damp(st.pitch, tp * lookW, 8, dt);
    acc.cy += st.yaw * 0.25; acc.ny += st.yaw * 0.3; acc.hy += st.yaw * 0.45;
    acc.cx += st.pitch * 0.3; acc.nx += st.pitch * 0.3; acc.hx += st.pitch * 0.4;
    apply(acc);
    // two-handed grip: the left hand follows the right hand's handle
    if (twoW > 0.01) {
      root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(body.matrixWorld).invert();
      P.handR.getWorldPosition(hv).applyMatrix4(inv);
      P.handR.getWorldQuaternion(qv); qv.premultiply(new THREE.Quaternion().setFromRotationMatrix(inv));
      const Y = new V3(0, 1, 0).applyQuaternion(qv), Z = new V3(0, 0, 1).applyQuaternion(qv);
      const save = {}; for (const k of CH) if (k[0] === 'L') save[k] = acc[k];
      if (item === 'rifle') armIK(acc, R, 'L', hv.clone().addScaledVector(Y, 0.3).addScaledVector(Z, -0.03), { th: Y, fi: new V3().crossVectors(Y, Z), pole: new V3(0.5, -1, 0) });
      else armIK(acc, R, 'L', hv.clone().addScaledVector(Y, -0.36), { th: Y, fi: Z, pole: new V3(0.6, -1, -0.2) });
      for (const k in save) acc[k] = lerp(save[k], acc[k], clamp(twoW, 0, 1));
      acc.Lcu = lerp(save.Lcu, 0.86, twoW); acc.Lth = lerp(save.Lth, 0.8, twoW);
      apply(acc);
    }
  };
  P.dispose = () => { root.removeFromParent(); };
  P.animate(0, { mode: 'idle' });
  return P;
}

/* @@PART4 */

/* =====================================================================================
   LINEUP (screenshot viewer)
   ===================================================================================== */
function placeholderAxe() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.7 }), steel = new THREE.MeshStandardMaterial({ color: 0x777b80, roughness: 0.35, metalness: 0.8 });
  const h = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.018, 0.72, 12), wood); h.position.y = 0.2; g.add(h);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.07, 0.15), steel); head.position.set(0, 0.52, 0.05); g.add(head);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.12, 0.05), steel); edge.position.set(0, 0.52, 0.14); g.add(edge);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}
export async function lineup(ctx) {
  const { scene, camera, arg } = ctx;
  if (arg.startsWith('arms')) {
    camera.fov = 60; camera.updateProjectionMatrix();
    const look = +(arg.match(/(\d)$/)?.[1] ?? 0);
    const F = createFPArms(look);
    F.root.position.set(0, 1.6, 0); scene.add(F.root);
    const { tex } = await import('../core/Textures.js');
    const b = tex('barkPine'); b.map.repeat.set(2, 3); if (b.normalMap) b.normalMap.repeat.set(2, 3);
    const tree = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.36, 8, 32), new THREE.MeshStandardMaterial({ map: b.map, normalMap: b.normalMap, roughness: 0.95 }));
    tree.position.set(-0.25, 4, -0.86); tree.castShadow = tree.receiveShadow = true; scene.add(tree);
    const mode = arg.replace(/\d$/, '').split('-')[1] || 'grip';
    F.pose(mode, 1);
    if (mode === 'grip' || mode === 'gripR') {
      let axe; try { const IA = await import('./ItemArt.js'); axe = IA.createItem('axe', { shadows: false }); } catch (e) { window.__log?.('ItemArt axe unavailable: ' + e.message); axe = placeholderAxe(); }
      F.handR.add(axe);
    }
    if (mode === 'torch') { const t = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.014, 0.4, 10), new THREE.MeshStandardMaterial({ color: 0x5a3c22 })); t.position.y = 0.12; F.handL.add(t); }
    if (mode === 'bow') { const bw = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.3, 8), new THREE.MeshStandardMaterial({ color: 0x5a3c22 })); F.handL.add(bw); }
    let tris = 0; for (const m of F.meshes) tris += triCount(m.geometry);
    window.__log?.('FP arms look ' + look + ': ' + tris + ' tris, ' + F.meshes.length + ' meshes');
    return { cam: [0, 1.6, 0], look: [0, 1.6, -1], update() {} };
  }
  // third-person lineups
  const people = [];
  const add = (kind, o, x, z, mode, extra = {}) => {
    const P = createPerson(kind, { seed: people.length * 17 + 3, ...o });
    P.root.position.set(x, 0, z); P.root.rotation.y = extra.yaw ?? 0; scene.add(P.root);
    if (extra.item) { let it; try { const IA = await_items; it = IA ? IA.createItem(extra.item) : null; } catch (e) { it = null; } if (!it && extra.item === 'axe') it = placeholderAxe(); if (it) P.handR.add(it); }
    if (mode === 'carry') { const log = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.11, 2.2, 14), new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 0.9 })); log.rotation.x = PI / 2; log.position.set(0, 0.08, 0.3); log.castShadow = true; P.shoulderR.add(log); }
    people.push({ P, mode, extra });
    return P;
  };
  let await_items = null; try { await_items = await import('./ItemArt.js'); } catch (e) { await_items = null; }
  const speedOf = m => (m === 'walk' || m === 'carry' ? 1.6 : m === 'run' ? 5.5 : m === 'crouch' ? 1.0 : 0);
  let cam = [0, 1.4, 7.5], look = [0, 0.95, 0];
  const modes = ['walk', 'run', 'chop', 'downed', 'seated', 'brace', 'carry', 'cower', 'ritual', 'sit', 'wave', 'idle', 'crouch', 'attack', 'throw', 'bow', 'hurt', 'dead', 'sleep', 'swim'];
  const [base, sub] = arg.split(':');
  if (base === '' || base === 'row') {
    const list = [['survivor', { look: 0 }], ['survivor', { look: 1 }], ['survivor', { look: 2 }], ['survivor', { look: 3 }], ['pilot', {}], ['cannibal', { variant: 'scout' }], ['cannibal', { variant: 'brute' }], ['cannibal', { variant: 'elder' }], ['cannibal', { variant: 'skulker' }]];
    list.forEach(([k, o], i) => add(k, o, (i - 4) * 1.0, 0, 'idle'));
    cam = [0, 1.35, 7.2];
  } else if (base === 'cannibals') {
    const vs = ['scout', 'brute', 'elder', 'skulker'], ms = ['walk', 'crouch', 'ritual', 'cower'];
    vs.forEach((v, i) => ms.forEach((m, j) => add('cannibal', { variant: v }, (i - 1.5) * 1.15, (j - 1.5) * -1.6, m, { yaw: 0.35 })));
    cam = [0.5, 2.2, 8.5]; look = [0, 0.7, -0.5];
  } else if (base === 'face') { // portraits: ?arg=face:0..8
    const list = [['survivor', { look: 0 }], ['survivor', { look: 1 }], ['survivor', { look: 2 }], ['survivor', { look: 3 }], ['pilot', {}], ['cannibal', { variant: 'scout' }], ['cannibal', { variant: 'brute' }], ['cannibal', { variant: 'elder' }], ['cannibal', { variant: 'skulker' }]];
    const [k, o] = list[+(sub || 0)]; const P = add(k, o, 0, 0, 'idle');
    const hy = P.head.getWorldPosition(new V3()).y;
    cam = [0.35, hy + 0.05, 1.1]; look = [0, hy - 0.03, 0];
  } else if (modes.includes(base)) {
    const item = base === 'chop' ? 'axe' : base === 'attack' ? 'club' : base === 'bow' ? null : null;
    for (let i = 0; i < 4; i++) add('survivor', { look: i }, (i - 1.5) * 1.3, 0, base, { item, yaw: base === 'sleep' || base === 'dead' ? 0 : 0.5 });
    cam = [0.6, 1.5, 6.5];
  }
  let tris = 0; const seen = new Set(); for (const e of people) if (!seen.has(e.P.kind + e.P.tris)) { seen.add(e.P.kind + e.P.tris); }
  for (const e of people) tris = Math.max(tris, e.P.tris);
  window.__log?.('people: ' + people.map(e => e.P.root.name.replace('Person_', '') + '=' + e.P.tris).join(' '));
  return {
    cam, look,
    update(dt, t) {
      for (const e of people) {
        const d = ONE_SHOT[e.mode];
        e.P.animate(dt, { mode: e.mode, t: d ? (t % (d + 0.6)) : undefined, speed: speedOf(e.mode), item: e.extra.item || null });
      }
    },
  };
}
