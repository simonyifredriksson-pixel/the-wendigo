/* Trees.js - tree models for the forest (geometry only; Forest.js instances them).

   Species        height    look
   pine           16-30 m   tall straight conifer, bare lower trunk with dead stubs, drooping branch whorls
   fir             3-9 m    young bushy spruce, needles to the ground
   maple           9-16 m   autumn deciduous, orange leaf clusters on a branching skeleton
   birch          10-16 m   white bark, slender, yellow-green clusters
   dead            8-14 m   bare grey snag (swamp) / charred black (burned forest)

   Each species has VARIANTS (different seeds) and two detail levels:
     lod 0: full (near the player, casts shadows)
     lod 1: fewer cards, coarser trunk (mid distance)
   plus a baked impostor (two crossed quads textured from renders of lod 1).

   A model is { trunk: BufferGeometry, leaves: BufferGeometry|null, height, radius (trunk at 1 m), crownR }.
   Branch/leaf cards get normals that point out of the crown (not the card's
   own normal) so a crown shades like a soft volume, see Shading.foliage. */
import * as THREE from '../../lib/three.module.js';
import { mergeGeos, xf, tube } from '../core/Geo.js';
import { rng, lerp, clamp } from '../core/Util.js';
import { tex } from '../core/Textures.js';
import { windify, foliage } from '../core/Shading.js';

export const SPECIES = ['pine', 'fir', 'maple', 'birch', 'dead'];
export const VARIANTS = 3;

/* ---------------------------------------------------------------- helpers */
/** a tapered, slightly wandering trunk from y=0 to y=h; returns {geo, spine(y)->{x,z}} */
function trunk(r, h, rad, seg, radial, flare, wobble, topR = 0.02) {
  const pts = []; const n = 7;
  const ox = [], oz = [];
  for (let i = 0; i <= n; i++) { const t = i / n; ox.push(i === 0 ? 0 : (r() - 0.5) * wobble * t); oz.push(i === 0 ? 0 : (r() - 0.5) * wobble * t); pts.push([ox[i], t * h, oz[i]]); }
  pts[0][1] = -0.6; // sink below ground
  const radiusAt = (t) => {
    const base = lerp(rad, topR, Math.pow(t, 0.85));
    const fl = flare * Math.exp(-t * h / 0.9);
    return base + fl * rad;
  };
  const geo = tube(pts, radiusAt, { seg, radial, cap: false });
  // root buttresses: push the base out in lobes
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); if (y > 1.2) continue;
    const x = p.getX(i), z = p.getZ(i), a = Math.atan2(z, x);
    const lobe = Math.pow(Math.max(0, Math.cos(a * 5 + r.seedA)), 3) * rad * 0.6 * Math.exp(-Math.max(0, y) / 0.35);
    const k = 1 + lobe / Math.max(0.05, Math.hypot(x, z));
    p.setX(i, x * k); p.setZ(i, z * k);
  }
  geo.computeVertexNormals();
  const spine = (y) => { const t = clamp(y / h, 0, 1) * n, i = Math.min(n - 1, Math.floor(t)), f = t - i; return { x: lerp(ox[i], ox[i + 1], f), z: lerp(oz[i], oz[i + 1], f) }; };
  return { geo, spine, radiusAt };
}

/**
 * One drooping branch made of 2 crossed cards (each `segs` long),
 * from point o (on the trunk) along heading a, length L, width W, droop (m of drop at the tip).
 * Normals are set to `nrm(x,y,z)` (crown-shaped).
 */
function branchCards(out, o, a, L, W, droop, segs, nrm, roll = 0, uvTop = 1) {
  const dx = Math.cos(a), dz = Math.sin(a);
  const sx = -dz, sz = dx; // side (perpendicular in the horizontal plane)
  for (const twist of [roll, roll + 1.35]) {
    // card width axis = side rotated about the branch axis by `twist`
    const cy = Math.sin(twist), cs = Math.cos(twist);
    const wx = sx * cs, wy = cy, wz = sz * cs;
    const P = [], N = [], U = [], I = [];
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, s = t * L;
      const px = o[0] + dx * s, pz = o[2] + dz * s, py = o[1] + s * 0.12 - droop * t * t;
      const w = W * (0.35 + 0.65 * Math.sin(Math.min(1, t * 1.3 + 0.12) * Math.PI * 0.95));
      for (const side of [-1, 1]) {
        const x = px + wx * w * 0.5 * side, y = py + wy * w * 0.5 * side, z = pz + wz * w * 0.5 * side;
        P.push(x, y, z); const nn = nrm(x, y, z); N.push(nn[0], nn[1], nn[2]); U.push(side < 0 ? 0 : 1, t * uvTop);
      }
    }
    for (let i = 0; i < segs; i++) { const k = i * 2; I.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setIndex(I);
    out.push(g);
  }
}
/** a leaf cluster: 3 cards crossing at the centre, spherical normals */
function cluster(out, c, size, r, nrm) {
  for (let k = 0; k < 3; k++) {
    const g = new THREE.PlaneGeometry(size, size);
    xf(g, { r: [k === 0 ? -Math.PI / 2 + (r() - 0.5) * 0.6 : (r() - 0.5) * 0.8, k * Math.PI / 3 + r(), (r() - 0.5) * 0.6] });
    xf(g, { p: c });
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) { const nn = nrm(p.getX(i), p.getY(i), p.getZ(i)); n.setXYZ(i, nn[0], nn[1], nn[2]); }
    out.push(g);
  }
}
const crownNormal = (cx, cy, cz, up = 0.5) => (x, y, z) => {
  let nx = x - cx, ny = (y - cy) * 0.6 + up, nz = z - cz; const l = Math.hypot(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l];
};
/** bark uv: u around, v along height (scaled so the texture is not stretched) */
function barkUV(geo, circ, vScale) {
  const uv = geo.attributes.uv; if (!uv) return geo;
  const p = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ, p.getY(i) * vScale);
  return geo;
}

/* ---------------------------------------------------------------- species */
function pine(seed, lod) {
  const r = rng(seed * 101 + 7); r.seedA = r() * 6;
  const h = 24, rad = 0.36;
  const T = trunk(r, h, rad, lod ? 8 : 16, lod ? 6 : 11, 0.55, 0.9);
  barkUV(T.geo, 2, 0.45);
  const parts = [T.geo];
  const crownBase = h * (0.38 + r() * 0.14);
  // dead stubs on the bare lower trunk
  if (!lod) for (let i = 0; i < 9; i++) {
    const y = 2 + r() * (crownBase - 2), a = r() * Math.PI * 2, s = T.spine(y), L = 0.3 + r() * 0.9;
    const o = [s.x + Math.cos(a) * 0.2, y, s.z + Math.sin(a) * 0.2];
    parts.push(tube([o, [o[0] + Math.cos(a) * L, y - L * 0.25, o[2] + Math.sin(a) * L]], (t) => 0.045 * (1 - t * 0.8), { seg: 2, radial: 4, cap: false }));
  }
  const cards = [];
  const nrm = crownNormal(0, crownBase + (h - crownBase) * 0.45, 0, 0.35);
  // detail randomness comes from its own stream so lod 0 and lod 1 keep the same silhouette
  const rd = rng(seed * 977 + 31);
  const whorl = lod ? 0.85 : 0.5;
  for (let y = crownBase; y < h - 0.6; y += whorl * (0.8 + rd() * 0.4)) {
    const t = (y - crownBase) / (h - crownBase);
    // widest a third of the way up the crown, a narrow spire on top
    const L = lerp(4.0, 0.8, Math.pow(t, 0.8)) * (t < 0.12 ? lerp(0.6, 1, t / 0.12) : 1) * (0.82 + rd() * 0.3);
    const n = lod ? 5 : 6 + Math.floor(rd() * 2);
    const a0 = rd() * Math.PI * 2, s = T.spine(y);
    for (let k = 0; k < n; k++) {
      const a = a0 + k / n * Math.PI * 2 + (rd() - 0.5) * 0.5;
      branchCards(cards, [s.x + Math.cos(a) * 0.15, y, s.z + Math.sin(a) * 0.15], a, L, L * 0.95, L * (0.3 + rd() * 0.2), lod ? 1 : 3, nrm, (rd() - 0.5) * 0.4);
    }
  }
  // the spire
  const s = T.spine(h);
  for (let k = 0; k < (lod ? 2 : 4); k++) branchCards(cards, [s.x, h - 1.6, s.z], k * 1.57, 0.3, 0.9, -1.4, 1, nrm, 1.2);
  return { trunk: mergeGeos(parts), leaves: mergeGeos(cards), height: h, radius: rad, crownR: 4.2, crownBase };
}
function fir(seed, lod) {
  const r = rng(seed * 131 + 3); r.seedA = r() * 6;
  const h = 7, rad = 0.13;
  const T = trunk(r, h, rad, lod ? 5 : 8, lod ? 5 : 8, 0.3, 0.25, 0.015);
  barkUV(T.geo, 1, 0.6);
  const cards = [];
  const nrm = crownNormal(0, h * 0.4, 0, 0.3);
  const rd = rng(seed * 733 + 17);
  for (let y = 0.35; y < h - 0.3; y += (lod ? 0.5 : 0.32) * (0.8 + rd() * 0.4)) {
    const t = y / h, L = lerp(2.3, 0.35, Math.pow(t, 0.9)) * (0.8 + rd() * 0.3);
    const n = lod ? 5 : 6, a0 = rd() * 6.28, s = T.spine(y);
    for (let k = 0; k < n; k++) { const a = a0 + k / n * 6.28 + (rd() - 0.5) * 0.4; branchCards(cards, [s.x, y, s.z], a, L, L * 1.0, L * 0.25, lod ? 1 : 2, nrm, (rd() - 0.5) * 0.5); }
  }
  for (let k = 0; k < 3; k++) branchCards(cards, [0, h - 1.0, 0], k * 2.1, 0.2, 0.6, -0.9, 1, nrm, 1.3);
  return { trunk: T.geo, leaves: mergeGeos(cards), height: h, radius: rad, crownR: 2.3, crownBase: 0.3 };
}
/** recursive limbs for deciduous trees; returns end points for leaf clusters */
function limbs(r, parts, from, dir, len, rad, depth, ends, lod, upBias) {
  const pts = [from];
  const segs = 3;
  let p = from.slice(), d = dir.slice();
  for (let i = 1; i <= segs; i++) {
    d = [d[0] + (r() - 0.5) * 0.35, d[1] + upBias * 0.15 + (r() - 0.5) * 0.2, d[2] + (r() - 0.5) * 0.35];
    const l = Math.hypot(...d); d = d.map(v => v / l);
    p = [p[0] + d[0] * len / segs, p[1] + d[1] * len / segs, p[2] + d[2] * len / segs];
    pts.push(p.slice());
  }
  parts.push(tube(pts, (t) => rad * (1 - t * 0.65), { seg: lod ? 3 : 5, radial: lod ? 4 : 6, cap: false }));
  if (depth <= 0) { ends.push({ p, d }); return; }
  const kids = depth > 1 ? 3 : 2 + (r() < 0.5 ? 1 : 0);
  for (let k = 0; k < kids; k++) {
    const t = 0.55 + r() * 0.45;
    const base = [lerp(from[0], p[0], t), lerp(from[1], p[1], t), lerp(from[2], p[2], t)];
    const a = r() * Math.PI * 2, spread = 0.7 + r() * 0.4;
    const nd = [d[0] + Math.cos(a) * spread, d[1] + 0.25, d[2] + Math.sin(a) * spread];
    limbs(r, parts, base, nd, len * (0.55 + r() * 0.15), rad * 0.55, depth - 1, ends, lod, upBias);
  }
  ends.push({ p, d });
}
function maple(seed, lod, birch = false) {
  const r = rng(seed * 151 + (birch ? 99 : 11)); r.seedA = r() * 6;
  const h = birch ? 14 : 13, rad = birch ? 0.18 : 0.3;
  const stem = h * (birch ? 0.62 : 0.42);
  const T = trunk(r, stem + 1, rad, lod ? 5 : 9, lod ? 6 : 10, birch ? 0.25 : 0.5, 0.6, rad * 0.55);
  barkUV(T.geo, birch ? 1.5 : 2, 0.5);
  const parts = [T.geo], ends = [];
  const top = T.spine(stem);
  const n = birch ? 4 : 4 + Math.floor(r() * 2);
  for (let k = 0; k < n; k++) {
    const a = k / n * Math.PI * 2 + r() * 0.6;
    const out = birch ? 0.35 : 0.75;
    limbs(r, parts, [top.x, stem - r() * (birch ? 3 : 1.5), top.z], [Math.cos(a) * out, 1, Math.sin(a) * out], h * (birch ? 0.33 : 0.36), rad * 0.55, lod ? 1 : 2, ends, lod, birch ? 1.0 : 0.4);
  }
  limbs(r, parts, [top.x, stem, top.z], [0, 1, 0], h - stem, rad * 0.45, lod ? 1 : 2, ends, lod, 1);
  // leaf clusters fill a crown ellipsoid (biased to its shell) so the canopy
  // reads as one rounded mass; limbs show through the gaps
  const cards = [];
  const crownR = birch ? 3.0 : 5.2, cy = stem + (h - stem) * (birch ? 0.45 : 0.5), ry = (h - stem) * (birch ? 0.62 : 0.55) + 0.8;
  const nrm = crownNormal(0, cy, 0, 0.45);
  const rd = rng(seed * 313 + (birch ? 5 : 9));
  const count = (birch ? 34 : 52) * (lod ? 0.45 : 1);
  for (let i = 0; i < count; i++) {
    const u = rd() * 2 - 1, a = rd() * Math.PI * 2, s = Math.sqrt(1 - u * u), k = 0.5 + 0.5 * Math.sqrt(rd());
    const p = [Math.cos(a) * s * crownR * k, cy + u * ry * k, Math.sin(a) * s * crownR * k];
    const size = (birch ? 2.1 : 3.0) * (0.8 + rd() * 0.4) * (lod ? 1.45 : 1);
    cluster(cards, p, size, rd, nrm);
  }
  void ends;
  return { trunk: mergeGeos(parts), leaves: mergeGeos(cards), height: h, radius: rad, crownR, crownBase: stem * 0.8 };
}
function dead(seed, lod) {
  const r = rng(seed * 171 + 5); r.seedA = r() * 6;
  const h = 11, rad = 0.3;
  const T = trunk(r, h * 0.85, rad, lod ? 6 : 10, lod ? 6 : 9, 0.5, 1.2, 0.05);
  barkUV(T.geo, 2, 0.5);
  const parts = [T.geo], ends = [];
  for (let k = 0; k < 4; k++) {
    const y = h * (0.35 + r() * 0.45), s = T.spine(y), a = r() * Math.PI * 2;
    limbs(r, parts, [s.x, y, s.z], [Math.cos(a), 0.6 + r() * 0.6, Math.sin(a)], h * 0.28 * (0.7 + r() * 0.5), rad * 0.4, lod ? 0 : 1, ends, lod, 0.2);
  }
  return { trunk: mergeGeos(parts), leaves: null, height: h, radius: rad, crownR: 3, crownBase: h };
}

const BUILD = { pine, fir, maple, birch: (s, l) => maple(s, l, true), dead };
const cache = new Map();
/** model(species, variant, lod) -> {trunk, leaves, height, radius, crownR} (cached) */
export const FLARE = { pine: 0.55, fir: 0.3, maple: 0.5, birch: 0.25, dead: 0.5 };
export function model(sp, v, lod) {
  const k = sp + v + ':' + lod;
  if (!cache.has(k)) { const m = BUILD[sp](v + 1, lod); m.flare = FLARE[sp]; m.sp = sp; cache.set(k, m); }
  return cache.get(k);
}
/** trunk radius of a model at local height y (matches trunk() above) */
export function trunkRadius(m, y) {
  const top = m.sp === 'fir' ? 0.015 : m.sp === 'maple' || m.sp === 'birch' ? m.radius * 0.55 : m.sp === 'dead' ? 0.05 : 0.02;
  const h = m.sp === 'maple' || m.sp === 'birch' ? m.crownBase / 0.8 + 1 : m.sp === 'dead' ? m.height * 0.85 : m.height;
  const t = Math.min(1, Math.max(0, y / h));
  return lerp(m.radius, top, Math.pow(t, 0.85)) + m.flare * Math.exp(-y / 0.9) * m.radius;
}

/* ---------------------------------------------------------------- materials */
const mats = {};
export function materials() {
  if (mats.ready) return mats;
  const bark = (name, color, h) => {
    const t = tex(name);
    return windify(new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, normalScale: new THREE.Vector2(1.4, 1.4), color, roughness: 0.95 }), { mode: 'trunk', height: h });
  };
  mats.bark = { pine: bark('barkPine', 0xffffff, 24), fir: bark('barkPine', 0xcfc6bb, 7), maple: bark('barkOak', 0xd8d0c4, 13), birch: bark('barkBirch', 0xffffff, 14), dead: bark('barkOak', 0x9a958e, 11) };
  const leaf = (name, h, color = 0xffffff, transl = 0.6) => {
    const t = tex(name);
    const m = new THREE.MeshStandardMaterial({ map: t.map, color, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
    return foliage(windify(m, { mode: 'foliage', height: h }), { translucency: transl });
  };
  mats.leaves = { pine: leaf('firBranch', 24, 0xe6efe0, 0.45), fir: leaf('firBranch', 7, 0xf0fff0, 0.45), maple: leaf('leavesAutumn', 13, 0xffffff, 0.8), birch: leaf('leavesBirch', 14, 0xffffff, 0.8), dead: null };
  // shadow casters must sway the same way and respect the alpha cut-out
  mats.depth = {};
  for (const sp of SPECIES) {
    const lm = mats.leaves[sp]; if (!lm) continue;
    const d = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: lm.map, alphaTest: 0.42 });
    mats.depth[sp] = windify(d, { mode: 'foliage', height: sp === 'pine' ? 24 : sp === 'fir' ? 7 : 13 });
    const bd = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mats.depth[sp + 'Bark'] = windify(bd, { mode: 'trunk', height: sp === 'pine' ? 24 : 13 });
  }
  mats.ready = true;
  return mats;
}

/* ---------------------------------------------------------------- impostors */
/**
 * Render each species/variant (lod 1) from two sides into one atlas texture.
 * Atlas: columns = species*variants, 2 views each -> cells of 128 x 256 px.
 * Returns { texture, cell(sp, v, view) -> [u0, v0, u1, v1], aspect(sp) }.
 */
export function bakeImpostors(renderer) {
  const cols = SPECIES.length * VARIANTS * 2, CW = 128, CHh = 256;
  const rt = new THREE.WebGLRenderTarget(cols * CW, CHh, { type: THREE.UnsignedByteType });
  rt.texture.generateMipmaps = true; rt.texture.minFilter = THREE.LinearMipmapLinearFilter; rt.texture.magFilter = THREE.LinearFilter;
  const M = materials();
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.75));
  const dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(0.3, 1, 0.6); scene.add(dl);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha(), prevTM = renderer.toneMapping;
  renderer.setRenderTarget(rt); renderer.setClearColor(0x2a3a22, 0); renderer.clear(); renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;
  const info = {};
  let col = 0;
  // bake with no wind and no fog
  for (const sp of SPECIES) for (let v = 0; v < VARIANTS; v++) {
    const m = model(sp, v, 1);
    const g = new THREE.Group();
    const tm = new THREE.Mesh(m.trunk, M.bark[sp]); g.add(tm);
    if (m.leaves) { const lm = new THREE.Mesh(m.leaves, M.leaves[sp]); g.add(lm); }
    scene.add(g);
    const w = m.crownR * 2.4, hgt = m.height * 1.06;
    cam.left = -w / 2; cam.right = w / 2; cam.top = hgt; cam.bottom = 0; cam.updateProjectionMatrix();
    for (let view = 0; view < 2; view++) {
      const a = view * Math.PI / 2;
      cam.position.set(Math.sin(a) * 80, 0, Math.cos(a) * 80); cam.lookAt(0, 0, 0); cam.position.y = 0; cam.updateMatrixWorld();
      renderer.setViewport(col * CW, 0, CW, CHh); renderer.setScissor(col * CW, 0, CW, CHh); renderer.setScissorTest(true);
      renderer.render(scene, cam);
      info[sp + v + ':' + view] = [col / cols, 0, (col + 1) / cols, 1];
      col++;
    }
    info[sp + v] = { w, h: hgt };
    scene.remove(g);
  }
  renderer.setScissorTest(false); renderer.autoClear = true;
  renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevClear, prevAlpha); renderer.toneMapping = prevTM;
  renderer.setViewport(0, 0, renderer.domElement.width / renderer.getPixelRatio(), renderer.domElement.height / renderer.getPixelRatio());
  return { texture: rt.texture, rt, info };
}
