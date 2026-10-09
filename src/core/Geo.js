/* Geo.js - geometry helpers shared by all the art code.

   mergeGeos(list)             merge non-indexed or indexed BufferGeometries (position/normal/uv, + color if all have it)
   xf(geo, {p, r, s})          transform a geometry in place (position [x,y,z], rotation euler [x,y,z], scale number|[x,y,z])
   tube(points, radius, opts)  a smooth tube through points; radius is a number or fn(t 0..1) -> r; opts {seg, radial, closed, cap}
   lathe(profile, seg)         profile [[r,y],...] spun around Y (smooth normals)
   deform(geo, fn)             fn(v: Vector3, n: Vector3) mutates the vertex; normals recomputed
   noisify(geo, amp, freq, seed) push vertices along their normals by 3D noise
   colorize(geo, fn)           add a vertex colour attribute: fn(x,y,z) -> [r,g,b] 0..1
   cardCross(w, h, n)          n crossed vertical quads (impostors, grass tufts)
*/
import * as THREE from '../../lib/three.module.js';
import { Noise } from './Util.js';

const _v = new THREE.Vector3(), _n = new THREE.Vector3();

export function mergeGeos(list) {
  const geos = list.filter(Boolean).map(g => (g.index ? g.toNonIndexed() : g));
  const hasColor = geos.length && geos.every(g => g.attributes.color);
  const hasUv = geos.every(g => g.attributes.uv);
  let n = 0; for (const g of geos) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = hasUv ? new Float32Array(n * 2) : null, col = hasColor ? new Float32Array(n * 3) : null;
  let o = 0;
  for (const g of geos) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray ? g.attributes.position.array.subarray(0, c * 3) : g.attributes.position.array, o * 3);
    if (!g.attributes.normal) g.computeVertexNormals();
    nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    if (col) col.set(g.attributes.color.array.subarray(0, c * 3), o * 3);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere(); out.computeBoundingBox();
  return out;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
export function xf(geo, { p = [0, 0, 0], r = [0, 0, 0], s = 1 } = {}) {
  _e.set(r[0], r[1], r[2]); _q.setFromEuler(_e);
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(s[0], s[1], s[2]);
  _p.set(p[0], p[1], p[2]);
  _m.compose(_p, _q, _s); geo.applyMatrix4(_m); return geo;
}

/** tube through points (Vector3 or [x,y,z]) with a radius function */
export function tube(points, radius = 0.1, { seg = 24, radial = 10, cap = true, closed = false, twist = 0 } = {}) {
  const pts = points.map(p => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2])));
  const curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal');
  const rf = typeof radius === 'function' ? radius : () => radius;
  const frames = curve.computeFrenetFrames(seg, closed);
  const P = [], N = [], U = [], I = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, c = curve.getPointAt(t), r = rf(t);
    const nn = frames.normals[i], bb = frames.binormals[i];
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2 + twist * t;
      const cx = Math.cos(a), sy = Math.sin(a);
      _n.set(nn.x * cx + bb.x * sy, nn.y * cx + bb.y * sy, nn.z * cx + bb.z * sy);
      P.push(c.x + _n.x * r, c.y + _n.y * r, c.z + _n.z * r); N.push(_n.x, _n.y, _n.z); U.push(j / radial, t);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < radial; j++) {
    const a = i * (radial + 1) + j, b = a + radial + 1;
    I.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  if (cap && !closed) {
    const parts = [g];
    for (const end of [0, 1]) {
      const r = rf(end); if (r < 1e-4) continue;
      const s = new THREE.SphereGeometry(r, radial, Math.max(3, radial >> 1));
      const c = curve.getPointAt(end); xf(s, { p: [c.x, c.y, c.z] }); parts.push(s);
    }
    return mergeGeos(parts);
  }
  return g;
}

/** lathe around Y from [[radius, y], ...] */
export function lathe(profile, seg = 24) {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  return g;
}

export function deform(geo, fn) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i); if (n) _n.fromBufferAttribute(n, i); else _n.set(0, 1, 0);
    fn(_v, _n, i); p.setXYZ(i, _v.x, _v.y, _v.z);
  }
  p.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
  return geo;
}

const NZ = new Noise(99);
export function noisify(geo, amp = 0.05, freq = 2, seed = 0) {
  const p = geo.attributes.position; if (!geo.attributes.normal) geo.computeVertexNormals();
  const n = geo.attributes.normal;
  // weld: identical positions must move identically, so key the noise on position only
  for (let i = 0; i < p.count; i++) {
    _v.fromBufferAttribute(p, i); _n.fromBufferAttribute(n, i);
    const d = NZ.fbm3(_v.x * freq + seed, _v.y * freq, _v.z * freq, 3) * amp;
    p.setXYZ(i, _v.x + _n.x * d, _v.y + _n.y * d, _v.z + _n.z * d);
  }
  p.needsUpdate = true; geo.computeVertexNormals(); return geo;
}

export function colorize(geo, fn) {
  const p = geo.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const k = fn(p.getX(i), p.getY(i), p.getZ(i), i); c[i * 3] = k[0]; c[i * 3 + 1] = k[1]; c[i * 3 + 2] = k[2]; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
}

/** n vertical quads crossed around Y, bottom at y=0 */
export function cardCross(w, h, n = 2) {
  const parts = [];
  for (let i = 0; i < n; i++) { const q = new THREE.PlaneGeometry(w, h); xf(q, { p: [0, h / 2, 0] }); xf(q, { r: [0, (i / n) * Math.PI, 0] }); parts.push(q); }
  return mergeGeos(parts);
}

/** set every mesh in a group to cast/receive shadows */
export function shadows(obj, cast = true, receive = true) { obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } }); return obj; }
