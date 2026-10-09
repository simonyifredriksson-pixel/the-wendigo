/* PropArt.js - every static prop, building and story object on the Wendigo island.

   createProp(name, opts) -> THREE.Group
     Geometry and materials are built once per (name, seed, story, text) and cached; every call
     returns a new Group sharing them. Static geometry is merged per material (one draw call per
     surface). group.userData.colliders = PROP_INFO[name].colliders (or a per-seed variant):
     boxes {x, z, w, d, h, rot?} and cylinders {x, z, r, h} in the prop's local frame.
     Interactive parts are named Object3Ds found with getObjectByName ('door', 'rotor', 'seat0' ...).
     Light points are empty Object3Ds named 'light' (userData.color, userData.intensity);
     flame points are empty Object3Ds named 'fire'. The game owns real lights and flames.
   PROP_INFO[name] = { size: [w, h, d], colliders, notes }
   lineup(ctx) - screenshot viewer hook for _view.html.

   Conventions: metres, +Y up, the prop's front faces +Z, origin on the ground at the footprint
   centre. Buildings carry foundations / stilts down to y = -1 so they never float on slopes.
   Decals (footprint*, clawMarks, symbolTree, drawingWall) are planes facing +Z with alpha.

   Helpers (textures, materials, Bag merging, logs, planks, rocks, rope, antlers, bones) live in
   PropKit.js; prop-specific painters (helicopter livery, petroglyphs, decals, signs) are here. */
import {
  THREE, mergeGeos, xf, tube, lathe, deform, rng, clamp, lerp, sstep, TAU, tex, makeCanvas, toTex,
  N1, N2, N3, tn, pix, normalCanvas, readHeight, cells, T, M, defMat, Bag, marker, tris,
  planarUV, weld, cyl, orient, rod, bend, rope, lash, roundBox, plank, log, rockGeo, mossColors, antler, bone, V, vec,
} from './PropKit.js';
import { stdMat, windify } from '../core/Shading.js';

/* =========================================================== registry */
const BUILD = {};
export const PROP_INFO = {};
function def(name, info, builder) { PROP_INFO[name] = { colliders: [], notes: '', ...info }; BUILD[name] = builder; }
const CACHE = new Map();
export function createProp(name, opts = {}) {
  const b = BUILD[name]; if (!b) throw new Error('PropArt: unknown prop ' + name);
  const key = [name, opts.seed ?? '', opts.story ?? '', opts.text ?? '', opts.variant ?? ''].join('|');
  let tpl = CACHE.get(key);
  if (!tpl) {
    tpl = b(opts); tpl.name = name; tpl.userData.prop = name;
    if (!tpl.userData.colliders) tpl.userData.colliders = PROP_INFO[name].colliders;
    tpl.traverse(o => { if (o.isMesh) { o.matrixAutoUpdate = true; } });
    CACHE.set(key, tpl);
  }
  const g = tpl.clone(true);
  g.userData.colliders = tpl.userData.colliders.map(c => ({ ...c }));
  return g;
}
export const PROP_NAMES = () => Object.keys(BUILD);

/* =========================================================== small shared pieces */
/** decal material: alpha plane that sits on a surface without z-fighting */
function decalMat(set, { color = 0xffffff, rough = 0.9, normalScale = 1, opacity = 1, side = THREE.FrontSide } = {}) {
  const m = stdMat({ map: set.map, normalMap: set.normalMap || null, color, roughness: rough, transparent: true, depthWrite: false, opacity, side,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  if (set.normalMap) m.normalScale.set(normalScale, normalScale);
  m.userData.noShadow = true; return m;
}
/** paint a decal: draw(heightCtx, colourCtx, w, h) on two canvases; the colour canvas carries alpha.
    heightCanvas starts mid grey (0.5); darker = deeper. */
function paintDecal(w, h, draw, { strength = 3, blur = 1.5 } = {}) {
  const hc = makeCanvas(w, h), cc = makeCanvas(w, h), hg = hc.getContext('2d'), cg = cc.getContext('2d');
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, w, h); cg.clearRect(0, 0, w, h);
  draw(hg, cg, w, h);
  if (blur) { const b = makeCanvas(w, h), bg = b.getContext('2d'); bg.filter = `blur(${blur}px)`; bg.drawImage(hc, 0, 0); hg.clearRect(0, 0, w, h); hg.drawImage(b, 0, 0); }
  const hf = readHeight(hc);
  return { map: toTex(cc, { repeat: false }), normalMap: toTex(normalCanvas(hf, w, h, strength, false), { srgb: false, repeat: false }), canvas: cc };
}
/** worn stencil lettering on a transparent canvas */
function stencilTex(lines, { w = 512, h = 128, color = '#1d1c18', font = 'bold 54px Arial', seed = 3, wear = 0.5 } = {}) {
  const c = makeCanvas(w, h), g = c.getContext('2d'), r = rng(seed);
  g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach(([txt, y, f]) => { g.font = f || font; g.fillText(txt, w / 2, y * h); });
  // stencil bridges + wear
  g.globalCompositeOperation = 'destination-out';
  for (let x = 0; x < w; x += 22 + r() * 30) { g.fillRect(x, 0, 2, h); }
  for (let i = 0; i < 900 * wear; i++) { g.globalAlpha = r() * 0.9; g.beginPath(); g.arc(r() * w, r() * h, 0.5 + r() * 3.5, 0, TAU); g.fill(); }
  return { map: toTex(c, { repeat: false }) };
}
/** a flat quad facing +Z centred at p (for decals) */
function quad(w, h, p = [0, 0, 0], r = [0, 0, 0]) { const g = new THREE.PlaneGeometry(w, h); xf(g, { r, p }); return g; }
/** standard mesh from a geometry + material (not merged) */
function mesh(geo, mat, name) { const m = new THREE.Mesh(geo, mat); m.castShadow = !mat.userData?.noShadow && !mat.transparent; m.receiveShadow = true; if (name) m.name = name; if (mat.transparent) m.renderOrder = 2; return m; }
/** random point helpers */
const polar = (r, a, y = 0) => [Math.cos(a) * r, y, Math.sin(a) * r];

/** add a stone (rock geometry) with moss colours into a bag */
function addRock(bag, seed, size, p, { ry = 0, rx = 0, rz = 0, detail = 6, moss = 0.6, key = 'stone', amp = 0.22, facets = 5, sink = 0.15, wet = 0, flat = 0.35 } = {}) {
  const g = rockGeo(seed, { size, detail, amp, facets, sink, flat });
  xf(g, { p, r: [rx, ry, rz] });
  if (M(key).userData.mossy) { mossColors(g, { moss, seed, wet }); bag.add(key, g); } else bag.add(key, g, [1, 1, 1]);
  return g;
}
/** a log (bark or peeled) between two points, with end caps */
function addLog(bag, a, b, r, opts = {}) {
  const { side, ends } = log(a, b, r, opts);
  bag.add(opts.key || 'bark', side, opts.col);
  if (ends) bag.add('logEnd', ends, opts.endCol);
  return side;
}
/** board helper: centred at p, length along X before rotation r */
function addPlank(bag, len, w, t, p, r = [0, 0, 0], opts = {}) {
  const g = plank(len, w, t, opts); xf(g, { r }); if (opts.yaw) xf(g, { r: [0, opts.yaw, 0] }); xf(g, { p }); bag.add(opts.key || 'wood', g, opts.col); return g;
}
/** box with planar uv */
function boxG(w, h, d, p = [0, 0, 0], r = [0, 0, 0], k = 1, lenAxis = -1) { const g = planarUV(new THREE.BoxGeometry(w, h, d), k, k, lenAxis); xf(g, { p, r }); return g; }

/* =========================================================== ROCKS, LOGS, STUMPS */
function rockProp(kind) {
  return (opts) => {
    const seed = (opts.seed ?? 1) * 7919 + kind.length, R = rng(seed), bag = new Bag();
    const S = { rockLarge: [3.6, 2.4, 3.0], rockMedium: [1.6, 1.1, 1.3], boulder: [2.2, 1.7, 1.9] }[kind];
    const s = [S[0] * (0.85 + R() * 0.3), S[1] * (0.8 + R() * 0.4), S[2] * (0.85 + R() * 0.3)];
    const detail = { rockLarge: 10, rockMedium: 8, boulder: 9 }[kind];
    addRock(bag, seed, s, [0, 0, 0], { ry: R() * TAU, detail, moss: kind === 'boulder' ? 0.85 : 0.65, amp: kind === 'boulder' ? 0.14 : 0.24, facets: kind === 'boulder' ? 2 : 6 });
    // a few chips at the foot
    for (let i = 0; i < 3; i++) { const a = R() * TAU, d = s[0] * 0.5 + 0.1; addRock(bag, seed + i + 1, [0.25 + R() * 0.2, 0.18, 0.25], [Math.cos(a) * d, 0, Math.sin(a) * d], { detail: 1, moss: 0.4 }); }
    const g = bag.build(); const r = Math.max(s[0], s[2]) * 0.42;
    g.userData.colliders = [{ x: 0, z: 0, r, h: s[1] * 0.9 }];
    return g;
  };
}
def('rockLarge', { size: [3.6, 2.4, 3.0], colliders: [{ x: 0, z: 0, r: 1.5, h: 2.2 }], notes: 'mossy granite outcrop, variants by opts.seed' }, rockProp('rockLarge'));
def('rockMedium', { size: [1.6, 1.1, 1.3], colliders: [{ x: 0, z: 0, r: 0.65, h: 1 }], notes: 'variants by opts.seed' }, rockProp('rockMedium'));
def('boulder', { size: [2.2, 1.7, 1.9], colliders: [{ x: 0, z: 0, r: 0.9, h: 1.5 }], notes: 'rounded mossy erratic, variants by opts.seed' }, rockProp('boulder'));

def('logFallen', { size: [8.4, 1.0, 1.4], colliders: [{ x: 0, z: 0, w: 8, d: 0.9, h: 0.9 }], notes: 'big mossy fallen trunk along X' }, (opts) => {
  const R = rng((opts.seed ?? 1) * 31), bag = new Bag(), r = 0.45;
  const a = [-4, r * 0.8, 0], b = [4, r * 0.62, 0.15];
  const { side } = log(a, b, r, { seed: R() * 1e4, radial: 16, seg: 22, taper: 0.78, wob: 0.09, ends: false, k: 0.9 });
  // break the far end into splinters, and moss on top
  const p = side.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i); if (x > 3.85) { const s = N1.n2(p.getY(i) * 9, p.getZ(i) * 9); p.setX(i, x + s * 0.45 + 0.1); } }
  side.computeVertexNormals();
  mossColors(side, { moss: 0.95, up: 0.2, wet: 0.15, seed: 3 });
  bag.add('bark', side);
  // rotten, mossy root end cap
  const cap = new THREE.CircleGeometry(r * 1.01, 16); cap.rotateY(-Math.PI / 2); cap.translate(-4, r * 0.8, 0);
  bag.add('logEnd', cap, [0.45, 0.25, 0.4]);
  // splinter wood inside the broken end
  for (let i = 0; i < 9; i++) { const ang = R() * TAU, rr = R() * r * 0.7, y = r * 0.62 + Math.sin(ang) * rr, z = 0.15 + Math.cos(ang) * rr; bag.add('log', rod([3.9, y, z], [4.25 + R() * 0.5, y + (R() - 0.5) * 0.12, z + (R() - 0.5) * 0.12], 0.05 + R() * 0.05, { r1: 0.005, radial: 5 }), [0.9, 0, 0.2]); }
  // broken branch stubs
  for (let i = 0; i < 6; i++) {
    const x = -3 + i * 1.2 + R() * 0.5, ang = R() * Math.PI - Math.PI * 0.1, y0 = lerp(r * 0.8, r * 0.62, (x + 4) / 8);
    const o = [x, y0 + Math.sin(ang) * r * 0.8, Math.cos(ang) * r * 0.8], e = [x + (R() - 0.3) * 0.4, o[1] + Math.sin(ang) * (0.3 + R() * 0.5), o[2] + Math.cos(ang) * (0.3 + R() * 0.5)];
    if (e[1] < 0.05) e[1] = 0.05;
    const e2 = [lerp(o[0], e[0], 0.5), lerp(o[1], e[1], 0.5), lerp(o[2], e[2], 0.5)];
    bag.add('bark', rod(o, e2, 0.08, { r1: 0.055, radial: 7 }), [1, 0.4, 0]);
    bag.add('log', rod(e2, [e2[0] + 0.02, e2[1] + 0.06, e2[2]], 0.055, { r1: 0.01, radial: 7 }), [0.8, 0, 0.2]);
  }
  // root stubs at the root end
  for (let i = 0; i < 6; i++) { const ang = (i / 6) * TAU + R() * 0.4; bag.add('bark', bend([[-3.9, r * 0.8 + Math.sin(ang) * r * 0.7, Math.cos(ang) * r * 0.7], [-4.3, r * 0.8 + Math.sin(ang) * r * 1.3, Math.cos(ang) * r * 1.3], [-4.6 - R() * 0.3, Math.max(0.02, r * 0.8 + Math.sin(ang) * r * 1.9), Math.cos(ang) * r * 1.9]], t => lerp(0.12, 0.02, t), { radial: 6, seg: 8 }), [0.8, 0.5, 0.1]); }
  return bag.build();
});

def('stump', { size: [1.3, 0.8, 1.3], colliders: [{ x: 0, z: 0, r: 0.45, h: 0.7 }], notes: 'old rotten stump' }, (opts) => {
  const R = rng((opts.seed ?? 1) * 53), bag = new Bag(), r = 0.42, h = 0.75;
  const g = cyl(r * 1.25, r, h, 18, 8, 1.2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
    const flare = 1 + Math.max(0, 0.25 - y) * 2.2 * (0.6 + 0.4 * Math.max(0, Math.cos(a * 5)));
    let ny = y; if (y > h - 0.01) ny = h - 0.05 - Math.abs(N1.n2(Math.cos(a) * 2, Math.sin(a) * 2)) * 0.35 - (Math.sin(a * 3) > 0.6 ? 0.12 : 0);
    p.setXYZ(i, x * flare, ny - 0.08, z * flare);
  }
  g.computeVertexNormals(); mossColors(g, { moss: 0.7, up: 0.3, seed: 5, wet: 0.1 }); bag.add('bark', g);
  // rotten hollow top: a dished, dark core
  const core = lathe([[0.001, h - 0.3], [r * 0.5, h - 0.25], [r * 0.82, h - 0.14], [r * 0.94, h - 0.1]], 16); planarUV(core, 3);
  const cg = core.index ? core.toNonIndexed() : core; bag.add('char', planarUV(cg, 2.5), [0.6, 0.3, 0.6]);
  // roots
  for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + R() * 0.5; bag.add('bark', bend([polar(r * 0.9, a, 0.15), polar(r * 1.6, a + 0.1, 0.06), polar(r * 2.3 + R() * 0.3, a + (R() - 0.5) * 0.3, -0.06)], t => lerp(0.11, 0.03, t), { radial: 6, seg: 8 }), [0.8, 0.6, 0]); }
  return bag.build();
});

/* =========================================================== CRATE, BARREL */
function stencilMat(key, lines, opts) { defMat(key, () => decalMat(stencilTex(lines, opts), { rough: 0.9 })); return M(key); }
function crateGeo(bag, { w = 0.9, h = 0.56, d = 0.6, seed = 1, lid = true, broken = false } = {}) {
  const R = rng(seed), t = 0.022, bw = h / 3;
  // side boards (along X on the +-Z faces, along Z on the +-X faces)
  for (let i = 0; i < 3; i++) {
    const y = bw * (i + 0.5);
    for (const s of [-1, 1]) {
      if (!(broken && s === 1 && i === 2)) addPlank(bag, w, bw - 0.008, t, [0, y, s * (d / 2 - t / 2)], [Math.PI / 2, 0, 0], { seed: R() * 1e4, key: 'woodBrown' });
      addPlank(bag, d - 2 * t, bw - 0.008, t, [s * (w / 2 - t / 2), y, 0], [Math.PI / 2, 0, 0], { seed: R() * 1e4, key: 'woodBrown', yaw: Math.PI / 2 });
    }
  }
  // corner battens
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) bag.add('woodBrown', boxG(0.05, h, 0.05, [sx * (w / 2 - 0.02), h / 2, sz * (d / 2 + 0.01)], [0, 0, 0], 2, 1));
  // bottom
  addPlank(bag, w, d, t, [0, t / 2, 0], [0, 0, 0], { seed: R() * 1e4, key: 'woodBrown' });
  if (lid) for (let i = 0; i < 3; i++) addPlank(bag, w + 0.02, d / 3 - 0.006, t, [0, h + t / 2, (i - 1) * d / 3], [0, 0, 0], { seed: R() * 1e4, key: 'woodBrown' });
}
def('crate', { size: [0.9, 0.58, 0.6], colliders: [{ x: 0, z: 0, w: 0.9, d: 0.6, h: 0.58 }], notes: 'survey supply crate stencilled NORTHBOUND SURVEY' }, (opts) => {
  const bag = new Bag(); crateGeo(bag, { seed: (opts.seed ?? 1) * 11, lid: opts.variant !== 'open' });
  const g = bag.build(undefined, { aoMin: 0.6, aoH: 0.4 });
  const sm = stencilMat('stencilNS', [['NORTHBOUND SURVEY', 0.38], ['CAMP 2  -  No. 14', 0.75, 'bold 34px Arial']]);
  g.add(mesh(quad(0.78, 0.2, [0, 0.29, 0.302]), sm));
  g.add(mesh(quad(0.78, 0.2, [0, 0.29, -0.302], [0, Math.PI, 0]), sm));
  return g;
});

function drumGeo(bag, { seed = 1, dent = 0.02, lying = false } = {}) {
  const R = rng(seed), rr = 0.29, h = 0.88;
  const prof = [[0.001, 0.008], [rr - 0.012, 0.008], [rr + 0.006, 0.0], [rr + 0.008, 0.02], [rr, 0.03]];
  for (const y of [0.29, 0.59]) prof.push([rr, y - 0.03], [rr + 0.012, y - 0.01], [rr + 0.012, y + 0.01], [rr, y + 0.03]);
  prof.push([rr, h - 0.03], [rr + 0.008, h - 0.02], [rr + 0.006, h], [rr - 0.012, h - 0.008], [0.001, h - 0.008]);
  let g = lathe(prof, 28); g = g.index ? g.toNonIndexed() : g;
  const p = g.attributes.position, uv = g.attributes.uv, so = R() * 50;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(z, x);
    uv.setXY(i, a / TAU + 0.5, y / h);
    const d = 1 - Math.max(0, N1.n3(x * 4 + so, y * 4, z * 4)) * dent * 6;
    p.setXYZ(i, x * d, y, z * d);
  }
  g.computeVertexNormals();
  bag.add('drum', g, (x, y) => { const v = lerp(0.75, 1, sstep(0, 0.2, y)); return [v, v, v]; });
  // bungs on the lid
  bag.add('ironDark', rod([0.15, h - 0.01, 0], [0.15, h + 0.012, 0], 0.03, { radial: 8, caps: true }));
  bag.add('ironDark', rod([-0.17, h - 0.01, 0.05], [-0.17, h + 0.01, 0.05], 0.018, { radial: 8, caps: true }));
}
def('barrel', { size: [0.6, 0.9, 0.6], colliders: [{ x: 0, z: 0, r: 0.3, h: 0.9 }], notes: 'rusty 55 gal fuel drum' }, (opts) => {
  const bag = new Bag(); drumGeo(bag, { seed: (opts.seed ?? 1) * 17 });
  return bag.build(undefined, { aoMin: 0.65, aoH: 0.3 });
});

/* =========================================================== CABIN */
const CABIN = { hx: 2.8, hz: 2.3, r: 0.15, dy: 0.27, base: 0.2, courses: 10, ext: 0.32, floor: 0.32 };
function cabinOpenings() {
  return {
    front: [{ a: 0.25, b: 1.15, y0: 0.25, y1: 1.98, door: true }, { a: -2.0, b: -1.0, y0: 0.95, y1: 1.78 }],
    right: [{ a: -0.5, b: 0.5, y0: 0.95, y1: 1.78 }],
    back: [{ a: 0.6, b: 1.3, y0: 1.1, y1: 1.7 }],
    left: [],
  };
}
def('cabin', {
  size: [7.2, 5.3, 7.5],
  colliders: [
    { x: 0, z: -2.3, w: 6.2, d: 0.34, h: 2.9 }, { x: -2.8, z: 0, w: 0.34, d: 4.9, h: 2.9 }, { x: 2.8, z: 0, w: 0.34, d: 4.9, h: 2.9 },
    { x: -1.425, z: 2.3, w: 3.35, d: 0.34, h: 2.9 }, { x: 2.125, z: 2.3, w: 1.95, d: 0.34, h: 2.9 },
    { x: -3.35, z: -0.5, w: 0.85, d: 1.15, h: 5.2 }, { x: -2.25, z: -0.5, w: 0.65, d: 0.8, h: 1.0 },
    { x: 1.8, z: -1.65, w: 1.7, d: 0.95, h: 0.6 }, { x: -0.7, z: 0.3, w: 1.25, d: 0.85, h: 0.8 }, { x: 2.35, z: 0, w: 0.6, d: 1.15, h: 0.8 },
    { x: -2.9, z: 4.0, r: 0.12, h: 2.4 }, { x: 2.9, z: 4.0, r: 0.12, h: 2.4 },
  ],
  notes: "log hunting cabin 6x5 m + porch to z=4.9. 'door' (hinge at its origin, rotate +Y opens inward, closed at 0), 'desk' (journal spot on the desktop), 'fire'+'light' in the stove",
}, (opts) => {
  const R = rng(4242 + (opts.seed ?? 0)), bag = new Bag(), C = CABIN, OP = cabinOpenings();
  const group = new THREE.Group();
  // --- log walls: along X (front/back) and along Z (sides), interlocking courses
  const wallLog = (axis, fixed, y, a, b, ends) => {
    const A = axis === 'x' ? [a, y, fixed] : [fixed, y, a], Bp = axis === 'x' ? [b, y, fixed] : [fixed, y, b];
    const { side, ends: e } = log(A, Bp, C.r * (0.95 + R() * 0.1), { seed: R() * 1e5, radial: 12, seg: Math.max(2, Math.round(Math.abs(b - a) / 0.8)), taper: 0.94, wob: 0.06, ends, k: 1.0 });
    mossColors(side, { moss: 0.55, up: 0.55, seed: R() * 50, fn: (x, yy, z, ny, m, ao) => [ao, m * (yy < 1 ? 1 : 0.35) * sstep(-0.2, 0.4, N2.fbm2(x * 0.5, z * 0.5 + yy, 3)), 0.25 * (1 - sstep(0, 1.2, yy))] });
    bag.add('log', side); if (e) bag.add('logEnd', e, [0.55, 0.12, 0.2]);
  };
  const runWall = (axis, fixed, y, lo, hi, holes) => {
    // split the run [lo, hi] around openings that intersect this course
    let segs = [[lo, hi]];
    for (const o of holes) {
      if (y + C.r * 0.55 < o.y0 || y - C.r * 0.55 > o.y1) continue;
      const out = []; for (const [s0, s1] of segs) { if (o.b <= s0 || o.a >= s1) { out.push([s0, s1]); continue; } if (o.a > s0) out.push([s0, o.a]); if (o.b < s1) out.push([o.b, s1]); }
      segs = out;
    }
    for (const [s0, s1] of segs) if (s1 - s0 > 0.15) wallLog(axis, fixed, y, s0, s1, true);
  };
  for (let i = 0; i < C.courses; i++) {
    const yf = C.base + i * C.dy, ys = yf + C.dy / 2;
    runWall('x', C.hz, yf, -C.hx - C.ext, C.hx + C.ext, OP.front);
    runWall('x', -C.hz, yf, -C.hx - C.ext, C.hx + C.ext, OP.back.map(o => ({ ...o, a: -o.b, b: -o.a })));
    if (i < C.courses - 1 || true) {
      runWall('z', C.hx, ys, -C.hz - C.ext, C.hz + C.ext, OP.right);
      runWall('z', -C.hx, ys, -C.hz - C.ext, C.hz + C.ext, OP.left);
    }
  }
  // sill logs under the side walls (half buried)
  for (const s of [-1, 1]) wallLog('z', s * C.hx, 0.07, -C.hz - 0.2, C.hz + 0.2, true);
  const wallTop = C.base + (C.courses - 1) * C.dy + C.dy / 2 + C.r; // ~2.92
  // --- foundation: fieldstone skirt and piers down to y=-1
  const skirt = roundBox(C.hx * 2 + 0.1, 1.08, C.hz * 2 + 0.1, 0.06, 8, 2, 8); xf(skirt, { p: [0, -0.48, 0] }); bag.add('fieldstone', planarUV(skirt, 1.1), [0.7, 0.2, 0.2]);
  for (const [x, z] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const pier = roundBox(0.6, 1.2, 0.6, 0.06, 2, 3, 2); noisifyLite(pier, 0.03); xf(pier, { p: [x * C.hx, -0.42, z * C.hz] }); bag.add('fieldstone', planarUV(pier, 1.1), [0.8, 0.35, 0.1]); }
  // --- floor boards inside
  for (let x = -C.hx + 0.2, i = 0; x < C.hx - 0.15; x += 0.2, i++) addPlank(bag, C.hz * 2 - 0.2, 0.19, 0.03, [x, C.floor, 0], [0, Math.PI / 2, 0], { seed: i * 7 + 1, key: 'woodBrown' });
  // --- roof: gable along X, shingle strips over a board deck, purlin logs out the gables
  const pitch = 0.6, eaveZ = C.hz + 0.6, eaveY = wallTop - 0.05, ridgeY = eaveY + eaveZ * Math.tan(pitch), roofLen = C.hx * 2 + 1.0;
  const slopeLen = eaveZ / Math.cos(pitch);
  const sag = (g) => deform(g, v => { v.y -= 0.07 * Math.sin(clamp((v.x + roofLen / 2) / roofLen, 0, 1) * Math.PI) * sstep(0.3, 3.0, v.y); });
  const roofSide = (s) => {
    // s=+1 front slope (toward +Z), s=-1 back slope
    const rot = [s * pitch, 0, 0];
    const deck = plankSheet(roofLen, slopeLen, 0.04, 'woodBrown', R);
    const dg = mergeGeos(deck); xf(dg, { p: [0, 0, 0], r: [-Math.PI / 2, 0, 0] });
    // place: local strip built in XZ plane (z downslope) -> rotate about X then translate
    const place = (g, off = 0) => { xf(g, { p: [0, off, 0] }); xf(g, { r: [s > 0 ? pitch : -pitch, s > 0 ? 0 : Math.PI, 0] }); xf(g, { p: [0, ridgeY, 0] }); return sag(g); };
    // deck underside visible from inside
    const deckG = new THREE.BoxGeometry(roofLen, 0.035, slopeLen + 0.05, 6, 1, 6); const dgu = planarUV(deckG, 1.6, 0.42, 0); xf(dgu, { p: [0, 0, slopeLen / 2] });
    bag.add('woodBrown', place(dgu, -0.03), [0.62, 0.62, 0.62].map((v, i) => i === 0 ? v : i === 1 ? 0 : 0));
    // shingle rows from eave to ridge
    const rows = Math.ceil(slopeLen / 0.3) + 1;
    for (let i = 0; i < rows; i++) {
      const zc = slopeLen - 0.15 - i * 0.3; if (zc < -0.1) break;
      const sg = new THREE.BoxGeometry(roofLen, 0.025, 0.42, 14, 1, 1);
      const uv = sg.attributes.uv, pp = sg.attributes.position, row = Math.floor(R() * 8), uo = R();
      for (let k = 0; k < pp.count; k++) uv.setXY(k, pp.getX(k) * 0.33 + uo, (row + 0.5) / 8 - pp.getZ(k) / 0.42 / 8);
      // tilt the butt up so rows step
      for (let k = 0; k < pp.count; k++) pp.setY(k, pp.getY(k) + (pp.getZ(k) + 0.21) * 0.06 + N1.n2(pp.getX(k) * 0.8 + i, i) * 0.01);
      sg.computeVertexNormals(); xf(sg, { p: [0, 0.02, zc] });
      const gg = place(sg);
      mossColors(gg, { moss: 0.8, up: 0.5, seed: i * 3 + s, fn: (x, y, z, ny, m, a) => [a * (0.85 + 0.15 * Math.sin(i * 1.7)), m * sstep(-0.1, 0.5, N2.fbm2(x * 0.35 + s * 5, z * 0.5 + y * 0.3, 3) + (s < 0 ? 0.25 : 0) + (1 - (y - eaveY) / (ridgeY - eaveY)) * 0.35)] });
      bag.add('shingle', gg);
    }
  };
  roofSide(1); roofSide(-1);
  // ridge cap boards
  for (const s of [-1, 1]) { const rc = plank(roofLen + 0.05, 0.2, 0.03, { seed: 77 + s }); xf(rc, { r: [s * (Math.PI / 2 - pitch) * 0.0 + s * pitch, 0, 0] }); xf(rc, { p: [0, ridgeY + 0.05, s * 0.08] }); bag.add('wood', sag(rc), [0.85, 0.4, 0]); }
  // purlins + ridge log sticking out of the gables
  for (const t of [0, 0.5, 0.92]) for (const s of t === 0 ? [1] : [-1, 1]) {
    const z = s * eaveZ * t, y = ridgeY - eaveZ * t * Math.tan(pitch) - 0.16;
    addLog(bag, [-roofLen / 2 - 0.05, y, z], [roofLen / 2 + 0.05, y, z], 0.12, { key: 'log', seed: t * 100 + s * 7, radial: 10, seg: 6, col: [0.85, 0.2, 0.1], endCol: [0.5, 0.1, 0.2] });
  }
  // gable boards (vertical) on +-X, filling the triangle above the side walls
  for (const sx of [-1, 1]) {
    for (let z = -C.hz - 0.1; z < C.hz + 0.1; z += 0.21) {
      const top = ridgeY - Math.abs(z) * Math.tan(pitch) - 0.12, bot = wallTop - 0.2; if (top - bot < 0.08) continue;
      const g = plank(top - bot, 0.2, 0.03, { seed: Math.round(z * 100) + sx * 999 }); xf(g, { r: [0, 0, Math.PI / 2] }); xf(g, { p: [sx * (C.hx + 0.02), (top + bot) / 2, z] });
      bag.add('wood', g, (x, y) => [lerp(0.7, 1, sstep(bot, bot + 0.8, y)), 0, 0.1]);
    }
  }
  // fascia boards along the eaves
  for (const s of [-1, 1]) { const f = plank(roofLen, 0.18, 0.03, { seed: 55 + s }); xf(f, { r: [Math.PI / 2, 0, 0], p: [0, eaveY - 0.06, s * (eaveZ + 0.01)] }); bag.add('wood', sag(f), [0.8, 0.3, 0.2]); }
  // --- door frame, window frames, glass
  frameOpening(bag, 'x', C.hz, OP.front[0], true);
  frameOpening(bag, 'x', C.hz, OP.front[1]);
  frameOpening(bag, 'z', C.hx, OP.right[0]);
  frameOpening(bag, 'x', -C.hz, { ...OP.back[0], a: -OP.back[0].b, b: -OP.back[0].a });
  const glass = new Bag();
  windowPanes(glass, bag, 'x', C.hz + 0.02, OP.front[1], R, 1);
  windowPanes(glass, bag, 'z', C.hx + 0.02, OP.right[0], R, 0);
  windowPanes(glass, bag, 'x', -C.hz - 0.02, { ...OP.back[0], a: -OP.back[0].b, b: -OP.back[0].a }, R, 2);
  // --- porch: deck, joists, posts, shed roof, steps (one broken)
  const pz0 = C.hz + 0.18, pz1 = C.hz + 1.95, py = 0.42;
  for (let x = -C.hx - 0.15, i = 0; x < C.hx + 0.2; x += 0.16, i++) {
    if (i === 9 || i === 23) continue; // missing boards
    const broken = i === 15; const len = broken ? (pz1 - pz0) * 0.55 : pz1 - pz0;
    addPlank(bag, len, 0.15, 0.035, [x, py - (broken ? 0.03 : 0), pz0 + len / 2], [0, Math.PI / 2, broken ? 0.06 : (R() - 0.5) * 0.02], { seed: i * 13 + 5 });
  }
  for (const x of [-C.hx, 0, C.hx]) addLog(bag, [x, py - 0.12, pz0 - 0.1], [x, py - 0.12, pz1], 0.08, { key: 'log', seed: x * 9 + 1, radial: 8, seg: 2 });
  addLog(bag, [-C.hx - 0.2, py - 0.12, pz1 - 0.05], [C.hx + 0.2, py - 0.12, pz1 - 0.05], 0.1, { key: 'log', seed: 404, radial: 8, seg: 4 });
  const postTop = 2.45;
  for (const x of [-C.hx - 0.1, C.hx + 0.1]) { addLog(bag, [x, -1, pz1 - 0.1], [x, postTop, pz1 - 0.1], 0.1, { key: 'log', seed: x * 77, radial: 9, seg: 4, taper: 0.92, col: (xx, y) => [1, sstep(0.6, -0.4, y) * 0.8, 0.2] }); }
  // porch roof (shed) from under the main eave out over the posts
  const prA = [C.hz + 0.25, wallTop - 0.25], prB = [pz1 + 0.35, postTop + 0.02];
  const pLen = Math.hypot(prB[0] - prA[0], prB[1] - prA[1]), pAng = Math.atan2(prA[1] - prB[1], prB[0] - prA[0]);
  addLog(bag, [-C.hx - 0.4, postTop - 0.05, pz1 - 0.1], [C.hx + 0.4, postTop - 0.05, pz1 - 0.1], 0.1, { key: 'log', seed: 505, radial: 9, seg: 5 });
  for (let i = 0; i < Math.ceil(pLen / 0.3) + 1; i++) {
    const zc = pLen - 0.15 - i * 0.3; if (zc < 0) break;
    const sg = new THREE.BoxGeometry(roofLen, 0.025, 0.42, 14, 1, 1), uv = sg.attributes.uv, pp = sg.attributes.position, row = Math.floor(R() * 8), uo = R();
    for (let k = 0; k < pp.count; k++) { uv.setXY(k, pp.getX(k) * 0.33 + uo, (row + 0.5) / 8 - pp.getZ(k) / 0.42 / 8); pp.setY(k, pp.getY(k) + (pp.getZ(k) + 0.21) * 0.06); }
    sg.computeVertexNormals(); xf(sg, { p: [0, 0.02, zc] }); xf(sg, { r: [pAng, 0, 0] }); xf(sg, { p: [0, prA[1], prA[0]] });
    mossColors(sg, { moss: 0.9, up: 0.5, seed: 40 + i }); bag.add('shingle', sag(sg));
  }
  const pdeck = new THREE.BoxGeometry(roofLen, 0.03, pLen, 6, 1, 3); planarUV(pdeck, 1.6, 0.42, 0); const pdu = planarUV(pdeck, 1.6, 0.42, 0); xf(pdu, { p: [0, -0.01, pLen / 2] }); xf(pdu, { r: [pAng, 0, 0] }); xf(pdu, { p: [0, prA[1], prA[0]] }); bag.add('woodBrown', sag(pdu), [0.6, 0, 0]);
  // steps: two treads on stringers, the lower one split and sagging
  const sx0 = 0.7;
  for (const sx of [sx0 - 0.55, sx0 + 0.55]) addPlank(bag, 0.75, 0.22, 0.05, [sx, 0.15, pz1 + 0.32], [0.55, Math.PI / 2, 0], { seed: sx * 99 });
  addPlank(bag, 1.2, 0.26, 0.04, [sx0, 0.3, pz1 + 0.18], [0, 0, 0], { seed: 61 });
  addPlank(bag, 0.62, 0.26, 0.04, [sx0 - 0.3, 0.1, pz1 + 0.46], [0.08, 0, -0.18], { seed: 62 });
  addPlank(bag, 0.5, 0.26, 0.04, [sx0 + 0.38, 0.06, pz1 + 0.5], [-0.12, 0.15, 0.32], { seed: 63 });
  // --- chimney: fieldstone stack on the -X gable
  const chx = -C.hx - 0.58, chz = -0.5;
  const base = roundBox(0.85, 3.3, 1.15, 0.08, 3, 8, 3); noisifyLite(base, 0.035); xf(base, { p: [chx, 0.65, chz] }); bag.add('fieldstone', planarUV(base, 1.1), (x, y) => [lerp(0.7, 1, sstep(-1, 1, y)), 0.25 * sstep(1.2, -0.5, y), 0.1]);
  const shoulder = roundBox(0.85, 0.5, 1.15, 0.08, 3, 2, 3); deform(shoulder, v => { if (v.y > 0) { v.x *= 0.72; v.z *= 0.62; } }); xf(shoulder, { p: [chx, 2.55, chz] }); bag.add('fieldstone', planarUV(shoulder, 1.1));
  const stack = roundBox(0.62, ridgeY + 0.8 - 2.8, 0.72, 0.05, 2, 8, 2); noisifyLite(stack, 0.025); xf(stack, { p: [chx, 2.8 + (ridgeY + 0.8 - 2.8) / 2, chz] });
  bag.add('fieldstone', planarUV(stack, 1.1), (x, y) => [lerp(1, 0.45, sstep(ridgeY - 0.5, ridgeY + 0.8, y)), 0.3 * sstep(0.3, 0.9, N1.n2(y * 2, x)), 0]);
  const capS = roundBox(0.8, 0.1, 0.9, 0.03, 2, 1, 2); xf(capS, { p: [chx, ridgeY + 0.85, chz] }); bag.add('stone', planarUV(capS, 0.5), [0.5, 0.4, 0.2]);
  // --- interior furniture
  const F = C.floor + 0.015;
  // wood stove + pipe through the wall into the chimney
  const st = new Bag();
  st.add('ironDark', planarUV(roundBox(0.62, 0.5, 0.78, 0.025, 2, 2, 2), 2), [0.8, 0.75, 0.7]);
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) st.add('ironDark', rod([lx * 0.25, -0.43, lz * 0.33], [lx * 0.25, -0.2, lz * 0.33], 0.025));
  st.add('ironDark', boxG(0.02, 0.3, 0.36, [0.32, 0, 0.0]));
  st.add('rust', rod([-0.12, 0.25, -0.2], [-0.12, 1.35, -0.2], 0.075, { radial: 12 }));
  st.add('rust', rod([-0.12, 1.3, -0.2], [-0.62, 1.3, -0.2], 0.075, { radial: 12 }));
  for (const [mm, list] of st.m) for (const g of list) { xf(g, { p: [-C.hx + 0.6, F + 0.43, chz + 0.2] }); bag.add(mm, g); }
  // bed: plank frame, stained mattress, rumpled blanket
  const bx = 1.85, bz = -1.6;
  for (const s of [-1, 1]) addPlank(bag, 1.9, 0.2, 0.04, [bx, F + 0.32, bz + s * 0.45], [Math.PI / 2, 0, 0], { seed: 90 + s, key: 'woodBrown' });
  for (const s of [-1, 1]) addPlank(bag, 0.94, 0.2, 0.04, [bx + s * 0.95, F + 0.32, bz], [Math.PI / 2, 0, 0], { seed: 92 + s, key: 'woodBrown', yaw: Math.PI / 2 });
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bag.add('woodBrown', boxG(0.07, lx > 0 ? 0.75 : 0.45, 0.07, [bx + lx * 0.93, F + (lx > 0 ? 0.375 : 0.225), bz + lz * 0.43], [0, 0, 0], 2, 1));
  for (let i = 0; i < 5; i++) addPlank(bag, 0.86, 0.16, 0.025, [bx - 0.75 + i * 0.37, F + 0.28, bz], [0, Math.PI / 2, 0], { seed: 120 + i, key: 'woodBrown' });
  const matt = roundBox(1.8, 0.14, 0.84, 0.06, 8, 2, 4); deform(matt, v => { v.y -= 0.03 * Math.sin((v.x / 1.8 + 0.5) * Math.PI) * (v.y > 0 ? 1 : 0.4); }); planarUV(matt, 1); const mt = planarUV(matt, 1.2); xf(mt, { p: [bx, F + 0.4, bz] });
  bag.add('ticking', mt, (x, y, z) => { const s = sstep(0.1, 0.5, N2.fbm2(x * 3, z * 3, 3)); return [1 - s * 0.45, 1 - s * 0.5, 1 - s * 0.6]; });
  const blank = new THREE.PlaneGeometry(1.2, 1.1, 14, 12); deform(blank, v => { v.z += N1.fbm2(v.x * 2.5, v.y * 2.5, 3) * 0.07; }); xf(blank, { r: [-Math.PI / 2, 0, 0] });
  deform(blank, v => { const ox = Math.abs(v.z) - 0.42; if (ox > 0) { v.y -= ox * 1.1; v.z = Math.sign(v.z) * (0.42 + ox * 0.15); } });
  xf(blank, { p: [bx + 0.25, F + 0.49, bz], r: [0, 0.05, 0] }); bag.add('blanket', blank);
  // table and chair
  const tx = -0.7, tz = 0.3;
  for (let i = 0; i < 5; i++) addPlank(bag, 1.2, 0.165, 0.035, [tx, F + 0.76, tz - 0.34 + i * 0.17], [0, 0, 0], { seed: 140 + i, key: 'woodBrown' });
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bag.add('woodBrown', boxG(0.07, 0.74, 0.07, [tx + lx * 0.52, F + 0.37, tz + lz * 0.33], [0, 0, 0], 2, 1));
  chairGeo(bag, [tx + 0.15, F, tz + 0.75], Math.PI + 0.35, false);
  chairGeo(bag, [tx - 0.95, F, tz - 0.2], 0, true);
  // shelf on the back wall with jars and tins
  for (const y of [1.25, 1.65]) {
    addPlank(bag, 1.5, 0.26, 0.03, [-0.9, F + y, -C.hz + 0.27], [0, 0, 0], { seed: y * 100, key: 'woodBrown' });
    for (let i = 0; i < 6; i++) { if (R() < 0.3) continue; const jx = -1.55 + i * 0.25 + R() * 0.05, hh = 0.09 + R() * 0.12; bag.add(R() < 0.5 ? 'rust' : 'glassLamp', rod([jx, F + y + 0.015, -C.hz + 0.27], [jx, F + y + 0.015 + hh, -C.hz + 0.27], 0.04 + R() * 0.015, { radial: 10, caps: true })); }
  }
  // desk under the right-hand window; the journal spot is the 'desk' marker
  const dx = C.hx - 0.47, dz = 0;
  for (let i = 0; i < 4; i++) addPlank(bag, 0.6, 0.29, 0.03, [dx, F + 0.75, dz - 0.44 + i * 0.29], [0, 0, 0], { seed: 160 + i, key: 'woodBrown' });
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) bag.add('woodBrown', boxG(0.06, 0.73, 0.06, [dx + lx * 0.25, F + 0.365, dz + lz * 0.53], [0, 0, 0], 2, 1));
  addPlank(bag, 0.55, 0.25, 0.02, [dx, F + 0.62, dz - 0.3], [0, 0, 0], { seed: 170, key: 'woodBrown' });
  bag.add('rust', rod([dx + 0.1, F + 0.765, dz + 0.35], [dx + 0.1, F + 0.86, dz + 0.35], 0.04, { radial: 10, caps: true })); // tin cup
  chairGeo(bag, [dx - 0.55, F, dz + 0.05], -Math.PI / 2 + 0.2, false);
  // antlers mounted over the door inside
  const ant = mergeGeos([antler(7, 0.7, 1), antler(8, 0.7, -1)]); xf(ant, { r: [0.6, 0, 0], p: [0.7, 2.3, C.hz - 0.2] }); bag.add('bone', ant, [0.85, 0.82, 0.75]);
  bag.build(group, { aoY: 0.32, aoMin: 0.55, aoH: 0.9 });
  glass.build(group, { ao: false });
  // --- the door: separate object hinged at its origin
  const door = new THREE.Object3D(); door.name = 'door'; door.position.set(OP.front[0].a + 0.02, C.floor, C.hz + 0.02);
  const db = new Bag(), dw = 0.86, dh = 1.62;
  for (let i = 0; i < 4; i++) { const g = plank(dh, dw / 4 - 0.006, 0.04, { seed: 300 + i }); xf(g, { r: [0, 0, Math.PI / 2], p: [dw / 8 + i * dw / 4, dh / 2, 0] }); db.add('wood', g); }
  for (const y of [0.25, dh - 0.25]) { const g = plank(dw - 0.06, 0.12, 0.03, { seed: 310 + y }); xf(g, { p: [dw / 2, y, 0.035], r: [Math.PI / 2, 0, 0] }); db.add('wood', g); }
  const br = plank(Math.hypot(dw - 0.15, dh - 0.6), 0.12, 0.03, { seed: 320 }); xf(br, { r: [Math.PI / 2, 0, Math.atan2(dh - 0.6, dw - 0.15)], p: [dw / 2, dh / 2, 0.035] }); db.add('wood', br);
  for (const y of [0.25, dh - 0.25]) db.add('ironDark', boxG(0.34, 0.035, 0.008, [0.17, y, 0.055]));
  db.add('ironDark', rod([dw - 0.1, 0.9, 0.02], [dw - 0.1, 0.9, 0.11], 0.012)); db.add('ironDark', rod([dw - 0.1, 0.84, 0.11], [dw - 0.1, 0.96, 0.11], 0.012));
  db.build(door, { aoY: 0, aoMin: 0.7, aoH: 0.6 });
  group.add(door);
  // markers
  group.add(marker('desk', [dx, F + 0.77, dz + 0.05], -Math.PI / 2));
  group.add(marker('fire', [-C.hx + 0.6, F + 0.42, chz + 0.2]));
  group.add(marker('light', [-C.hx + 0.95, F + 0.6, chz + 0.2], 0, { color: 0xff8a3a, intensity: 2.5 }));
  group.userData.tris = tris(group);
  return group;
});
/** lightweight vertex wobble that keeps shared box vertices together */
function noisifyLite(g, amp, f = 3) { deform(g, v => { const n = N2.n3(v.x * f, v.y * f, v.z * f); v.x += n * amp; v.z += N1.n3(v.x * f, v.y * f, v.z * f) * amp; }); return g; }
/** boards laid side by side into a sheet (unused helper kept small) */
function plankSheet(len, width, t, key, R) { const out = []; for (let z = 0; z < width; z += 0.2) { const g = plank(len, 0.19, t, { seed: R() * 1e4 }); xf(g, { p: [0, 0, z + 0.1] }); out.push(g); } return out; }
/** framing boards around a wall opening (axis 'x': wall runs along X at z=fixed) */
function frameOpening(bag, axis, fixed, o, door = false) {
  const put = (g, a, y) => { if (axis === 'x') xf(g, { p: [a, y, fixed] }); else { xf(g, { r: [0, Math.PI / 2, 0] }); xf(g, { p: [fixed, y, a] }); } bag.add('wood', g, [0.85, 0.15, 0.1]); };
  const w = o.b - o.a, depth = 0.36;
  for (const a of [o.a - 0.03, o.b + 0.03]) put(planarUV(new THREE.BoxGeometry(0.06, o.y1 - o.y0 + 0.1, depth), 1.6, 0.42, 1), a, (o.y0 + o.y1) / 2);
  put(planarUV(new THREE.BoxGeometry(w + 0.14, 0.07, depth), 1.6, 0.42, 0), (o.a + o.b) / 2, o.y1 + 0.03);
  if (!door) put(planarUV(new THREE.BoxGeometry(w + 0.2, 0.05, depth + 0.08), 1.6, 0.42, 0), (o.a + o.b) / 2, o.y0 - 0.02);
}
/** sash with four dirty panes (one broken out); glassBag gets the panes */
function windowPanes(glassBag, bag, axis, fixed, o, R, broken) {
  const w = o.b - o.a, h = o.y1 - o.y0, cx = (o.a + o.b) / 2, cy = (o.y0 + o.y1) / 2;
  const put = (g, key, col) => { if (axis !== 'x') xf(g, { r: [0, Math.PI / 2, 0] }); if (axis === 'x') xf(g, { p: [cx, cy, fixed - Math.sign(fixed) * 0.1] }); else xf(g, { p: [fixed - Math.sign(fixed) * 0.1, cy, cx] }); (key === 'glassDirty' ? glassBag : bag).add(key, g, col); };
  put(boxG(0.04, h, 0.05, [0, 0, 0]), 'wood', [0.9, 0.1, 0]); put(boxG(w, 0.04, 0.05, [0, 0, 0]), 'wood', [0.9, 0.1, 0]);
  for (const s of [-1, 1]) { put(boxG(0.05, h, 0.06, [s * (w / 2 - 0.025), 0, 0]), 'wood', [0.9, 0.1, 0]); put(boxG(w, 0.05, 0.06, [0, s * (h / 2 - 0.025), 0]), 'wood', [0.9, 0.1, 0]); }
  let k = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    if (k++ === broken) { // shards left in the corner of the broken pane
      const s = new THREE.BufferGeometry(); s.setAttribute('position', new THREE.Float32BufferAttribute([sx * 0.04, sy * 0.04, 0, sx * w * 0.42, sy * 0.04, 0, sx * 0.04, sy * h * 0.3, 0], 3)); s.setAttribute('uv', new THREE.Float32BufferAttribute([0.1, 0.1, 0.9, 0.1, 0.1, 0.7], 2)); s.computeVertexNormals();
      put(s, 'glassDirty', [1, 1, 1]); continue;
    }
    const g = new THREE.PlaneGeometry(w / 2 - 0.04, h / 2 - 0.04); const uv = g.attributes.uv; const off = [R(), R()]; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.5 + off[0] * 0.5, uv.getY(i) * 0.5 + off[1] * 0.5);
    xf(g, { p: [sx * w / 4, sy * h / 4, 0] }); if (axis !== 'x') xf(g, { r: [0, 0, 0] }); put(g, 'glassDirty', [1, 1, 1]);
  }
}
/** a simple slat-back chair; knocked = lying on its back */
function chairGeo(bag, p, ry, knocked) {
  const parts = [];
  const s = new THREE.Group();
  const add = (g) => parts.push(g);
  for (let i = 0; i < 3; i++) { const g = plank(0.42, 0.135, 0.03, { seed: 500 + i }); xf(g, { p: [0, 0.45, -0.14 + i * 0.14] }); add(g); }
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) add(boxG(0.04, lz < 0 ? 0.95 : 0.44, 0.04, [lx * 0.18, lz < 0 ? 0.475 : 0.22, lz * 0.18], [0, 0, 0], 2, 1));
  for (const y of [0.7, 0.85]) { const g = plank(0.4, 0.08, 0.02, { seed: 510 + y * 10 }); xf(g, { r: [Math.PI / 2, 0, 0], p: [0, y, -0.18] }); add(g); }
  add(boxG(0.36, 0.025, 0.025, [0, 0.15, 0.18])); add(boxG(0.025, 0.025, 0.36, [0.18, 0.15, 0]));
  const g = mergeGeos(parts);
  if (knocked) xf(g, { r: [-Math.PI / 2 + 0.15, 0, 0], p: [0, 0.18, 0.45] });
  xf(g, { r: [0, ry, 0] }); xf(g, { p });
  bag.add('woodBrown', g);
  void s;
}

/* =========================================================== HELICOPTER
   A Bell 412-like utility helicopter. The fuselage is a loft of superellipse cross sections
   (key stations below, nose at +Z). Every quad of the loft is classified as skin, glass or hole
   (open door), so windows and the door are real openings into a modelled interior.
   Livery uv: u = distance from the nose / length, v = angle around the section / 2PI
   (v=0 belly, 0.25 right (+X) side, 0.5 roof, 0.75 left (-X) side). */
const HZ0 = 5.62, HL = 14.2;
// [z, bottom y, top y, half width, squareness]
const HKEYS = [
  [5.62, 1.22, 1.46, 0.08, 2.2], [5.48, 1.0, 1.8, 0.48, 2.3], [5.18, 0.84, 2.1, 0.79, 2.5], [4.65, 0.76, 2.38, 1.0, 2.9],
  [4.0, 0.72, 2.56, 1.12, 3.3], [3.2, 0.7, 2.64, 1.18, 3.7], [2.0, 0.7, 2.66, 1.2, 4.0], [-1.0, 0.7, 2.66, 1.2, 4.0],
  [-1.8, 0.74, 2.64, 1.15, 3.8], [-2.6, 0.98, 2.56, 0.96, 3.2], [-3.4, 1.36, 2.42, 0.6, 2.8], [-4.1, 1.6, 2.28, 0.38, 2.4],
  [-8.3, 1.86, 2.2, 0.21, 2.2], [-8.56, 1.94, 2.15, 0.1, 2.2],
];
/** monotone cubic interpolation of key column ch at z (keys sorted by descending z) */
function keyInterp(keys, z, ch) {
  const n = keys.length; if (z >= keys[0][0]) return keys[0][ch]; if (z <= keys[n - 1][0]) return keys[n - 1][ch];
  let i = 0; while (keys[i + 1][0] > z) i++;
  const slope = (k) => (keys[k + 1][ch] - keys[k][ch]) / (keys[k + 1][0] - keys[k][0]);
  const tan = (k) => { if (k <= 0) return slope(0); if (k >= n - 1) return slope(n - 2); const a = slope(k - 1), b = slope(k); return a * b <= 0 ? 0 : (a + b) / 2; };
  const z0 = keys[i][0], z1 = keys[i + 1][0], h = z1 - z0, t = (z - z0) / h, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * keys[i][ch] + (t3 - 2 * t2 + t) * h * tan(i) + (-2 * t3 + 3 * t2) * keys[i + 1][ch] + (t3 - t2) * h * tan(i + 1);
}
const heliSect = (z) => ({ b: keyInterp(HKEYS, z, 1), t: keyInterp(HKEYS, z, 2), hw: keyInterp(HKEYS, z, 3), n: keyInterp(HKEYS, z, 4) });
/** point on a section at angle th (0 = belly, PI/2 = +X side), shrunk by off */
function sectPt(S, th, off = 0) {
  const s = Math.sin(th), c = -Math.cos(th), e = 2 / S.n;
  const hw = Math.max(0.01, S.hw - off), hh = Math.max(0.01, (S.t - S.b) / 2 - off), cy = (S.t + S.b) / 2;
  return [hw * Math.sign(s) * Math.pow(Math.abs(s), e), cy + hh * Math.sign(c) * Math.pow(Math.abs(c), e)];
}
const sectPerim = (z) => { const S = heliSect(z); let p = 0, a = sectPt(S, 0); for (let j = 1; j <= 64; j++) { const b = sectPt(S, j / 64 * TAU); p += Math.hypot(b[0] - a[0], b[1] - a[1]); a = b; } return p; };
const cToV = (c, side) => { const v = Math.acos(clamp(-c, -1, 1)) / TAU; return side > 0 ? v : 1 - v; };
/** classify a quad of the outer skin: 'skin' | 'glass' | 'hole' */
function heliClass(z, s, c) {
  const side = Math.abs(s);
  if (z > 4.18 && z < 5.4 && c > 0.1 && side > 0.035) return 'glass';                       // windscreen
  if (z > 4.6 && z < 5.28 && c > -0.66 && c < -0.18 && side > 0.18 && side < 0.8) return 'glass'; // chin windows
  if (z > 3.15 && z < 4.12 && c > 0.08 && c < 0.86 && side > 0.3) return 'glass';             // cockpit doors
  if (z > 3.45 && z < 4.15 && c > 0.93 && side < 0.3 && side > 0.04) return 'glass';           // overhead
  if (s < 0 && z > -0.85 && z < 2.55 && c > -0.74 && c < 0.8) return 'hole';                  // open cabin door (left, -X)
  if (s > 0 && c > 0.06 && c < 0.7 && ((z > 0.15 && z < 1.05) || (z > 1.45 && z < 2.35))) return 'glass'; // right door windows
  if (z > -1.75 && z < -1.1 && c > 0.1 && c < 0.62) return 'glass';                            // aft windows
  return 'skin';
}
/** loft between z0 and z1; returns {skin, glass} geometries. classify(z, s, c) per quad. */
function heliLoft({ z0, z1, nz, nt = 60, off = 0, flip = false, classify = () => 'skin', warp = null, th0 = 0, th1 = TAU, sect = heliSect, uz = 0 }) {
  const P = [], UV = [], cols = nt + 1;
  for (let i = 0; i <= nz; i++) {
    const z = lerp(z0, z1, i / nz), S = sect(z);
    for (let j = 0; j <= nt; j++) {
      const th = lerp(th0, th1, j / nt), [x, y] = sectPt(S, th, off);
      const v = new THREE.Vector3(x, y, z); if (warp) warp(v, th);
      P.push(v.x, v.y, v.z); UV.push((HZ0 - z - uz) / HL, th / TAU);
    }
  }
  const all = [], byCls = {};
  for (let i = 0; i < nz; i++) for (let j = 0; j < nt; j++) {
    const a = i * cols + j, b = a + cols, zc = lerp(z0, z1, (i + 0.5) / nz), thc = lerp(th0, th1, (j + 0.5) / nt);
    const tri = flip ? [a, a + 1, b, b, a + 1, b + 1] : [a, b, a + 1, b, b + 1, a + 1];
    all.push(...tri);
    const cls = classify(zc, Math.sin(thc), -Math.cos(thc), i, j); if (cls === 'hole') continue;
    (byCls[cls] = byCls[cls] || []).push(...tri);
  }
  const base = new THREE.BufferGeometry();
  base.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); base.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  base.setIndex(all); base.computeVertexNormals();
  const out = {};
  for (const k in byCls) { const g = new THREE.BufferGeometry(); g.setAttribute('position', base.attributes.position); g.setAttribute('normal', base.attributes.normal); g.setAttribute('uv', base.attributes.uv); g.setIndex(byCls[k]); out[k] = g.toNonIndexed(); }
  return out;
}
/** fan cap closing a section at z (outward along dir +1 nose / -1 tail) */
function sectCap(z, dir, nt = 60, warp = null) {
  const S = heliSect(z), P = [], UV = [], cy = (S.t + S.b) / 2, u = (HZ0 - z) / HL;
  for (let j = 0; j < nt; j++) {
    const a = sectPt(S, j / nt * TAU), b = sectPt(S, (j + 1) / nt * TAU);
    const tri = dir > 0 ? [[0, cy, z + dir * 0.03], a, b] : [[0, cy, z + dir * 0.03], b, a];
    for (const p of tri) { const v = new THREE.Vector3(p[0], p[1], p.length > 2 ? p[2] : z); if (warp) warp(v, 0); P.push(v.x, v.y, v.z); UV.push(u, 0.5); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.computeVertexNormals(); return g;
}

/** paint the red/white livery (2048 x 1024) with panel lines, rivets, registration and grime */
function paintLivery(wreck) {
  const W = 2048, H = 1024, c = makeCanvas(W, H), g = c.getContext('2d'), img = g.createImageData(W, H), d = img.data;
  const hc = makeCanvas(W, H), hg = hc.getContext('2d'); hg.fillStyle = '#808080'; hg.fillRect(0, 0, W, H);
  const RED = [150, 24, 22], WHITE = [222, 221, 214], STRIPE = [36, 38, 42], BELLY = [74, 74, 76];
  for (let y = 0; y < H; y++) {
    const v = 1 - (y + 0.5) / H, cc = -Math.cos(v * TAU);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, z = HZ0 - u * HL;
      const bnd = lerp(-0.02, 0.5, sstep(-1.6, -3.6, z)) + 0.14 * sstep(4.7, 5.5, z);
      let col = cc < bnd ? RED : cc < bnd + 0.035 ? WHITE : cc < bnd + 0.085 ? STRIPE : WHITE;
      if (cc < -0.9) col = BELLY;
      // grime: streaks running down, dirty belly, exhaust soot along the top aft of the engine
      const n = N1.fbm2(u * 22, v * 9, 2), st = N2.n2(u * 260, v * 6);
      let k = 1 - 0.06 * n - 0.07 * Math.max(0, st) * (1 - cc) * 0.5;
      k -= 0.22 * sstep(-0.5, -0.95, cc) * (0.6 + 0.4 * n);
      const soot = sstep(-2.2, -3.2, z) * sstep(-7.5, -4.0, z) * sstep(0.3, 0.95, cc);
      k -= soot * (0.45 + 0.25 * n);
      let r = col[0] * k, gg = col[1] * k, b = col[2] * k;
      if (wreck) {
        const sc = N3.fbm2(u * 9, v * 5, 4);
        const burn = clamp((sc + 0.15) * 3 * (sstep(-0.5, -3.5, z) * sstep(0.0, 0.8, cc) + sstep(4.0, 5.4, z) * 0.9 + 0.12), 0, 1);
        const bare = clamp((N2.fbm2(u * 40, v * 30, 3) - 0.35) * 5, 0, 1) * 0.7;
        r = lerp(r, 165, bare * 0.6); gg = lerp(gg, 160, bare * 0.6); b = lerp(b, 156, bare * 0.6);
        r = lerp(r, 22 + 30 * sc, burn); gg = lerp(gg, 18 + 20 * sc, burn); b = lerp(b, 16 + 12 * sc, burn);
        const mud = sstep(-0.3, -0.9, cc) * clamp(N1.fbm2(u * 30, v * 30, 3) + 0.5, 0, 1);
        r = lerp(r, 58, mud * 0.8); gg = lerp(gg, 48, mud * 0.8); b = lerp(b, 36, mud * 0.8);
      }
      const i = (y * W + x) * 4; d[i] = r; d[i + 1] = gg; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const X = (z) => (HZ0 - z) / HL * W, Y = (v) => (1 - v) * H;
  const line = (ctx, z0, v0, z1, v1, col, w) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(X(z0), Y(v0)); ctx.lineTo(X(z1), Y(v1)); ctx.stroke(); };
  const panel = (z0, z1, c0, c1, sides = [1, -1]) => {
    for (const s of sides) {
      const v0 = cToV(c0, s), v1 = cToV(c1, s);
      for (const [ctx, col, w] of [[g, 'rgba(20,18,18,0.55)', 2], [hg, '#3a3a3a', 3]]) {
        line(ctx, z0, v0, z1, v0, col, w); line(ctx, z0, v1, z1, v1, col, w); line(ctx, z0, v0, z0, v1, col, w); line(ctx, z1, v0, z1, v1, col, w);
      }
      // rivet rows
      g.fillStyle = 'rgba(255,255,255,0.18)'; hg.fillStyle = '#b0b0b0';
      for (let z = Math.min(z0, z1); z < Math.max(z0, z1); z += 0.07) for (const vv of [v0, v1]) { g.fillRect(X(z), Y(vv) + 4, 2, 2); hg.fillRect(X(z), Y(vv) + 4, 2, 2); }
    }
  };
  panel(3.12, 4.2, -0.64, 0.93);              // cockpit doors
  panel(-0.87, 2.57, -0.76, 0.82, [1]);       // sliding door (right side, closed)
  panel(-1.78, -1.07, 0.08, 0.64);            // aft windows
  panel(-2.0, -3.3, -0.3, 0.55);              // baggage door
  for (const z of [5.2, -4.12, -6.3]) for (const [ctx, col, w] of [[g, 'rgba(20,18,18,0.5)', 2], [hg, '#404040', 3]]) line(ctx, z, 0, z, 1, col, w);
  // registration on the tail boom, both sides (left side drawn rotated so it reads correctly)
  const reg = (txt, zc, cc, hM, s, col) => {
    const per = sectPerim(zc), sx = W / HL, sy = H / per, x = X(zc), y = Y(cToV(cc, s));
    g.save(); g.translate(x, y); if (s < 0) g.rotate(Math.PI);
    g.scale(sx / sy, 1); g.fillStyle = col; g.font = `bold ${Math.round(hM * sy)}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(txt, 0, 0); g.restore();
  };
  for (const s of [1, -1]) {
    reg('N-417K', -5.3, 0.05, 0.26, s, wreck ? 'rgba(235,232,225,0.75)' : 'rgba(240,238,232,0.95)');
    reg('AURORA HELI', 0.55, -0.42, 0.13, s, 'rgba(240,238,232,0.9)');
    reg('DANGER  -  TAIL ROTOR', -7.6, 0.1, 0.05, s, 'rgba(235,225,40,0.9)');
    reg('NO STEP', -2.9, 0.62, 0.05, s, 'rgba(30,30,30,0.8)');
  }
  if (wreck) { // scratches
    const r = rng(9); g.strokeStyle = 'rgba(200,196,190,0.5)'; for (let i = 0; i < 160; i++) { const x0 = r() * W, y0 = r() * H, l = 20 + r() * 120; g.lineWidth = 0.6 + r(); g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + l, y0 + (r() - 0.5) * 20); g.stroke(); }
  }
  const hf = readHeight(hc);
  return { map: toTex(c, { repeat: false }), normalMap: toTex(normalCanvas(hf, W, H, 1.5, false), { srgb: false, repeat: false }) };
}
/** cockpit instrument panel: colour + emissive canvases */
function paintPanel() {
  const W = 1024, H = 384, c = makeCanvas(W, H), e = makeCanvas(W, H), g = c.getContext('2d'), ge = e.getContext('2d');
  g.fillStyle = '#26282a'; g.fillRect(0, 0, W, H); ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  const r = rng(12);
  for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},${r() < 0.5 ? 255 : 0},0.025)`; g.fillRect(r() * W, r() * H, 4 + r() * 30, 2 + r() * 8); }
  const screen = (x, y, w, h, kind) => {
    for (const ctx of [g, ge]) { ctx.fillStyle = '#05070a'; ctx.fillRect(x, y, w, h); }
    ge.save(); ge.beginPath(); ge.rect(x + 4, y + 4, w - 8, h - 8); ge.clip();
    if (kind === 'pfd') {
      ge.fillStyle = '#2a6fc0'; ge.fillRect(x, y, w, h * 0.55); ge.fillStyle = '#7a4a22'; ge.fillRect(x, y + h * 0.55, w, h);
      ge.strokeStyle = '#fff'; ge.lineWidth = 2; ge.beginPath(); ge.moveTo(x, y + h * 0.55); ge.lineTo(x + w, y + h * 0.55); ge.stroke();
      for (let k = -2; k <= 2; k++) { ge.beginPath(); ge.moveTo(x + w * 0.4, y + h * 0.55 + k * 14); ge.lineTo(x + w * 0.6, y + h * 0.55 + k * 14); ge.stroke(); }
      ge.strokeStyle = '#ffd400'; ge.lineWidth = 4; ge.beginPath(); ge.moveTo(x + w * 0.3, y + h * 0.55); ge.lineTo(x + w * 0.45, y + h * 0.55); ge.lineTo(x + w * 0.5, y + h * 0.6); ge.lineTo(x + w * 0.55, y + h * 0.55); ge.lineTo(x + w * 0.7, y + h * 0.55); ge.stroke();
      ge.fillStyle = 'rgba(0,0,0,0.5)'; ge.fillRect(x + 6, y + 8, 30, h - 16); ge.fillRect(x + w - 36, y + 8, 30, h - 16);
      ge.fillStyle = '#fff'; ge.font = '12px Arial'; for (let k = 0; k < 6; k++) { ge.fillText(String(90 + k * 10), x + 9, y + 20 + k * 22); ge.fillText(String(24 + k) + '00', x + w - 34, y + 20 + k * 22); }
    } else if (kind === 'nd') {
      ge.fillStyle = '#071a10'; ge.fillRect(x, y, w, h);
      ge.strokeStyle = '#2f8a46'; ge.lineWidth = 1; for (let k = 0; k < 14; k++) { ge.beginPath(); let px = x, py = y + r() * h; ge.moveTo(px, py); while (px < x + w) { px += 10; py += (r() - 0.5) * 12; ge.lineTo(px, py); } ge.stroke(); }
      ge.strokeStyle = '#e040e0'; ge.lineWidth = 3; ge.beginPath(); ge.moveTo(x + w / 2, y + h - 10); ge.lineTo(x + w * 0.62, y + 20); ge.stroke();
      ge.strokeStyle = '#ddd'; ge.lineWidth = 2; ge.beginPath(); ge.arc(x + w / 2, y + h - 10, h * 0.7, Math.PI * 1.15, Math.PI * 1.85); ge.stroke();
      ge.fillStyle = '#fff'; ge.beginPath(); ge.moveTo(x + w / 2, y + h - 22); ge.lineTo(x + w / 2 - 7, y + h - 6); ge.lineTo(x + w / 2 + 7, y + h - 6); ge.fill();
    } else {
      ge.fillStyle = '#0a0d10'; ge.fillRect(x, y, w, h);
      for (let k = 0; k < 4; k++) { const bx = x + 12 + k * (w - 24) / 4; ge.fillStyle = '#1a1f24'; ge.fillRect(bx, y + 12, (w - 24) / 4 - 8, h - 40); const f = 0.4 + r() * 0.5; ge.fillStyle = k === 3 ? '#e0a020' : '#30c050'; ge.fillRect(bx, y + 12 + (h - 40) * (1 - f), (w - 24) / 4 - 8, (h - 40) * f); }
      ge.fillStyle = '#9ad'; ge.font = '13px Arial'; ge.fillText('NG   NR   TQ   T4', x + 14, y + h - 12);
    }
    ge.restore();
    g.strokeStyle = '#555'; g.lineWidth = 3; g.strokeRect(x, y, w, h);
  };
  screen(40, 60, 200, 170, 'pfd'); screen(255, 60, 200, 170, 'nd'); screen(569, 60, 200, 170, 'nd'); screen(784, 60, 200, 170, 'pfd');
  screen(462, 60, 100, 120, 'eng');
  // round standby gauges and switch rows
  for (const [x, y] of [[100, 300], [190, 300], [834, 300], [924, 300], [512, 250]]) { g.fillStyle = '#0b0b0b'; g.beginPath(); g.arc(x, y, 34, 0, TAU); g.fill(); g.strokeStyle = '#ccc'; g.lineWidth = 2; for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; g.beginPath(); g.moveTo(x + Math.cos(a) * 26, y + Math.sin(a) * 26); g.lineTo(x + Math.cos(a) * 31, y + Math.sin(a) * 31); g.stroke(); } g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 20, y - 14); g.stroke(); }
  for (let k = 0; k < 22; k++) { const x = 290 + k * 20, y = 300 + (k % 2) * 40; g.fillStyle = '#111'; g.fillRect(x, y, 12, 22); g.fillStyle = '#bbb'; g.fillRect(x + 4, y + 2, 4, 9); ge.fillStyle = k % 5 === 0 ? '#6a4000' : '#000'; ge.fillRect(x + 2, y - 8, 8, 4); }
  return { map: toTex(c, { repeat: false }), emissiveMap: toTex(e, { repeat: false }) };
}

defMat('heliSkin', () => { const L = paintLivery(false); return stdMat({ map: L.map, normalMap: L.normalMap, roughness: 0.42, metalness: 0.15, vertexColors: true }); });
defMat('heliSkinWreck', () => { const L = paintLivery(true); return stdMat({ map: L.map, normalMap: L.normalMap, roughness: 0.7, metalness: 0.15, vertexColors: true }); });
defMat('heliInt', () => stdMat({ map: T('grime').map, color: 0x7d7b74, roughness: 0.8, side: THREE.DoubleSide, vertexColors: true }));
defMat('heliFloor', () => stdMat({ map: T('grime').map, normalMap: T('fabric').normalMap, color: 0x34363a, roughness: 0.9, vertexColors: true }));
defMat('heliSeat', () => stdMat({ map: T('fabric').map, normalMap: T('fabric').normalMap, color: 0x3a4656, roughness: 0.95, vertexColors: true }));
defMat('heliBlack', () => stdMat({ map: T('grime').map, color: 0x1c1d1f, roughness: 0.6, metalness: 0.2, vertexColors: true }));
defMat('heliRed', () => stdMat({ map: T('grime').map, color: 0x8a1614, roughness: 0.45, metalness: 0.15, vertexColors: true }));
defMat('heliWhite', () => stdMat({ map: T('grime').map, color: 0xd8d6cf, roughness: 0.45, metalness: 0.15, vertexColors: true }));
defMat('heliBlade', () => stdMat({ map: T('grime').map, color: 0x2a2b2d, roughness: 0.5, metalness: 0.3, vertexColors: true }));
defMat('heliPanel', () => { const P = paintPanel(); return stdMat({ map: P.map, emissiveMap: P.emissiveMap, emissive: 0xffffff, emissiveIntensity: 1.3, roughness: 0.5, vertexColors: true }); });
defMat('belt', () => stdMat({ color: 0x5a5236, roughness: 0.8, vertexColors: true }));
defMat('emergency', () => { const c = makeCanvas(512, 256), g = c.getContext('2d'); g.fillStyle = '#e8641a'; g.fillRect(0, 0, 512, 256); const r = rng(5); for (let i = 0; i < 300; i++) { g.fillStyle = `rgba(60,30,10,${r() * 0.12})`; g.beginPath(); g.arc(r() * 512, r() * 256, 2 + r() * 14, 0, TAU); g.fill(); } g.fillStyle = '#f2efe6'; g.fillRect(150, 70, 212, 116); g.fillStyle = '#c81e1e'; g.fillRect(236, 82, 40, 92); g.fillRect(210, 108, 92, 40); g.fillStyle = '#f2efe6'; g.font = 'bold 30px Arial'; g.textAlign = 'center'; g.fillText('EMERGENCY', 256, 40); g.font = 'bold 20px Arial'; g.fillText('SURVIVAL KIT  -  N-417K', 256, 224); return stdMat({ map: toTex(c, { repeat: false }), roughness: 0.5, metalness: 0.05, vertexColors: true }); });

/** a main rotor blade along +X from r0 to r1: an airfoil with a swept, white-tipped end. bendFn(x)->[dy, dz, twist] */
function bladeGeo(r0 = 0.55, r1 = 7.0, chord = 0.42, thick = 0.055, bendFn = null) {
  const g = new THREE.BoxGeometry(r1 - r0, thick, chord, 26, 1, 8); g.translate((r0 + r1) / 2, 0, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = clamp(z / chord + 0.5, 0, 1), tf = 1 - t; // leading edge at +Z
    const af = 5 * (0.2969 * Math.sqrt(tf + 1e-4) - 0.126 * tf - 0.3516 * tf * tf + 0.2843 * tf ** 3 - 0.1036 * tf ** 4);
    y = Math.sign(y) * thick * af * (y > 0 ? 1 : 0.7);
    const tip = sstep(r1 - 0.45, r1, x); z = z * (1 - tip * 0.35) - tip * chord * 0.18;
    if (bendFn) { const [dy, dz, tw] = bendFn(x); const cy = y * Math.cos(tw) - z * Math.sin(tw), cz = y * Math.sin(tw) + z * Math.cos(tw); y = cy + dy; z = cz + dz; }
    p.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  return colorizeBlade(planarUV(g, 1));
}
function colorizeBlade(g) {
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const x = Math.abs(p.getX(i)); const tip = x > 6.5 && x < 6.8 ? 1 : 0; c.set(tip ? [30, 30, 28] : [1, 1, 1], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g;
}
/** the rotor head: hub, yoke, pitch links, blade grips (around origin) */
function rotorHub(bag) {
  bag.add('heliBlack', rod([0, -0.25, 0], [0, 0.18, 0], 0.13, { radial: 16, caps: true }));
  bag.add('alu', planarUV(roundBox(1.25, 0.1, 0.32, 0.04, 6, 1, 2), 2));
  bag.add('alu', xf(planarUV(roundBox(1.25, 0.1, 0.32, 0.04, 6, 1, 2), 2), { r: [0, Math.PI / 2, 0] }));
  const dome = new THREE.SphereGeometry(0.17, 14, 7, 0, TAU, 0, Math.PI / 2); dome.translate(0, 0.18, 0); bag.add('heliBlack', dome);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    bag.add('heliBlack', xf(planarUV(roundBox(0.34, 0.14, 0.2, 0.04, 2, 1, 1), 2), { p: [0.6 * ca, 0, -0.6 * sa], r: [0, a, 0] }));
    bag.add('alu', rod([0.32 * ca + 0.1 * sa, -0.22, -0.32 * sa + 0.1 * ca], [0.45 * ca + 0.12 * sa, 0.0, -0.45 * sa + 0.12 * ca], 0.018));
  }
}
/** passenger/crew seat facing +Z with the hip point at the origin; floor at y = -h */
function seatGeo(bag, h = 0.45, { pilot = false, belts = true, tilt = 0 } = {}) {
  const S = new Bag();
  const cush = roundBox(0.5, 0.11, 0.48, 0.045, 4, 2, 4); deform(cush, v => { v.y -= 0.02 * Math.cos(v.x * 6) * (v.y > 0 ? 1 : 0); }); xf(cush, { p: [0, -0.06, 0.06] }); S.add('heliSeat', planarUV(cush, 3));
  const back = roundBox(0.5, 0.66, 0.11, 0.045, 4, 5, 2); deform(back, v => { v.z += 0.03 * Math.cos(v.x * 5); }); xf(back, { r: [-0.18 - tilt, 0, 0], p: [0, 0.32, -0.2] }); S.add('heliSeat', planarUV(back, 3));
  const head = roundBox(0.32, 0.2, 0.1, 0.04, 2, 2, 1); xf(head, { r: [-0.2 - tilt, 0, 0], p: [0, 0.76, -0.3] }); S.add('heliSeat', planarUV(head, 3));
  // tube frame to the floor
  for (const sx of [-0.22, 0.22]) {
    S.add('alu', rod([sx, -0.12, 0.25], [sx, -h, 0.22], 0.016)); S.add('alu', rod([sx, -0.12, -0.15], [sx, -h, -0.2], 0.016));
    S.add('alu', rod([sx, -0.12, 0.25], [sx, -0.12, -0.2], 0.014)); S.add('alu', rod([sx, -h, 0.22], [sx, -h, -0.2], 0.02));
  }
  if (pilot) { S.add('heliBlack', rod([-0.27, 0.0, -0.15], [-0.27, 0.02, 0.2], 0.03)); S.add('heliBlack', rod([0.27, 0.0, -0.15], [0.27, 0.02, 0.2], 0.03)); }
  if (belts) {
    for (const sx of [-0.12, 0.12]) S.add('belt', xf(planarUV(new THREE.BoxGeometry(0.045, 0.62, 0.008), 2), { r: [-0.18, 0, sx * 0.4], p: [sx, 0.32, -0.135] }));
    S.add('belt', xf(planarUV(new THREE.BoxGeometry(0.46, 0.045, 0.008), 2), { p: [0, 0.0, 0.2], r: [-1.2, 0, 0] }));
    S.add('alu', xf(planarUV(new THREE.BoxGeometry(0.08, 0.05, 0.02), 2), { p: [0, 0.02, 0.21] }));
  }
  return S;
}
/** merge a bag into another under a transform */
function bagInto(dst, src, p = [0, 0, 0], r = [0, 0, 0]) { for (const [k, list] of src.m) for (const g of list) { xf(g, { r }); xf(g, { p }); dst.add(k, g); } }

const HELI = { floor: 0.98, mastZ: 0.35, hubY: 3.98, tailHub: [0.34, 2.72, -8.38] };
/** build the helicopter. wreck=true: crumpled, broken, scorched */
function buildHeli(wreck) {
  const R = rng(wreck ? 99 : 7), root = new THREE.Group();
  const body = new THREE.Group(); body.name = 'fuselage'; root.add(body);
  const bag = new Bag(), glassBag = new Bag(), skinKey = wreck ? 'heliSkinWreck' : 'heliSkin';
  // wreck: crumple the nose, dent everything, keep glass only in a few panes
  const crumple = (v) => {
    const k = sstep(3.4, 5.7, v.z); if (k <= 0) return 0; const n = N1.n3(v.x * 1.7, v.y * 1.7, v.z * 1.7);
    v.z -= k * k * 1.1; v.y += k * 0.35 * sstep(1.6, 0.6, v.y); v.x *= 1 + k * 0.12 * n; return k;
  };
  const warp = wreck ? (v) => {
    const k = crumple(v); const n = N1.n3(v.x * 1.7, v.y * 1.7, v.z * 1.7), n2 = N2.n3(v.x * 4, v.y * 4, v.z * 4);
    v.x += n * 0.06 * (0.3 + k * 2); v.y += n2 * 0.04 * (0.3 + k * 2);
    if (v.y < 0.85) v.y = lerp(v.y, 0.85, 0.5); // belly flattened
  } : null;
  const warped = new Set();
  const cls = wreck ? (z, s, c, i, j) => { const k = heliClass(z, s, c); if (k === 'glass') return (N3.n2(i * 0.31, j * 0.37) > 0.35 ? 'glass' : 'hole'); return k; } : heliClass;
  const tailCut = -4.35;
  const outer = heliLoft({ z0: HZ0, z1: wreck ? tailCut : -8.56, nz: wreck ? 88 : 116, nt: 60, classify: cls, warp });
  bag.add(skinKey, outer.skin, [1, 1, 1]); warped.add(outer.skin);
  if (outer.glass) glassBag.add('glass', outer.glass);
  const nc = sectCap(HZ0 - 0.001, 1, 60, warp); warped.add(nc); bag.add(skinKey, nc);
  if (!wreck) bag.add(skinKey, sectCap(-8.56, -1));
  // inner skin of cockpit + cabin (holes match the outer windows and the door)
  const inner = heliLoft({ z0: 5.35, z1: -1.86, nz: 54, nt: 60, off: 0.055, flip: true, classify: (z, s, c, i, j) => { const k = heliClass(z, s, c); return k === 'skin' ? 'skin' : 'hole'; }, warp });
  bag.add('heliInt', inner.skin, (x, y) => { const v = lerp(0.55, 1, sstep(1.0, 2.4, y)); return [v, v, v]; }); warped.add(inner.skin);
  // door frame seal around the open door
  const S0 = heliSect(1.0);
  const dvA = Math.acos(0.74), dvB = Math.acos(-0.8); // theta range of the opening on the -X side
  for (const z of [-0.85, 2.55]) { const pts = []; for (let k = 0; k <= 8; k++) { const th = TAU - lerp(dvA, dvB, k / 8); const [x, y] = sectPt(heliSect(z), th, 0.02); pts.push([x, y, z]); } bag.add('heliBlack', bend(pts, 0.03, { radial: 6, seg: 16 })); }
  for (const th of [TAU - dvA, TAU - dvB]) { const [x, y] = sectPt(S0, th, 0.02); bag.add('heliBlack', rod([x, y, -0.85], [x, y, 2.55], 0.03, { radial: 6 })); }
  // the sliding cabin door, run back along its rails (outer skin + inner trim, two windows)
  if (!wreck) {
    const dCls = (z, s, c) => (c > 0.06 && c < 0.7 && ((z > -1.7 && z < -0.8) || (z > -0.4 && z < 0.5))) ? 'glass' : 'skin';
    const dOut = heliLoft({ z0: 0.95, z1: -2.45, nz: 24, nt: 20, th0: TAU - dvB - 0.03, th1: TAU - dvA + 0.03, off: -0.07, sect: () => S0, classify: dCls, uz: 1.6 });
    bag.add(skinKey, dOut.skin, [1, 1, 1]); glassBag.add('glass', dOut.glass);
    const dIn = heliLoft({ z0: 0.95, z1: -2.45, nz: 12, nt: 12, th0: TAU - dvB - 0.03, th1: TAU - dvA + 0.03, off: -0.035, flip: true, sect: () => S0, classify: (z, s, c) => dCls(z, s, c) === 'glass' ? 'hole' : 'skin' });
    bag.add('heliInt', dIn.skin, [0.8, 0.8, 0.8]);
    for (const th of [TAU - dvA + 0.05, TAU - dvB - 0.05]) { const [x, y] = sectPt(S0, th, -0.04); bag.add('alu', rod([x, y, 2.6], [x, y, -2.6], 0.018, { radial: 5 })); }
  }
  // floor, rear bulkhead
  const fl = new THREE.BoxGeometry(2.2, 0.04, 6.4, 2, 1, 8); xf(fl, { p: [0, HELI.floor - 0.02, 1.33] });
  deform(fl, v => { const S = heliSect(v.z); const w = Math.max(0.2, sectHalfWidthAt(S, HELI.floor, 0.06)); v.x = Math.sign(v.x) * Math.min(Math.abs(v.x), w); });
  bag.add('heliFloor', planarUV(fl, 2));
  const bh = new THREE.Shape(), Sb = heliSect(-1.86);
  for (let k = 0; k <= 40; k++) { const [x, y] = sectPt(Sb, k / 40 * TAU, 0.05); if (k === 0) bh.moveTo(x, y); else bh.lineTo(x, y); }
  const bhg = new THREE.ShapeGeometry(bh, 2); bhg.translate(0, 0, -1.85); bag.add('heliInt', planarUV(bhg, 1.5), [0.8, 0.8, 0.8]);
  // cargo net on the bulkhead, fire extinguisher, first-aid box, grab handles
  for (let k = 0; k < 7; k++) { const x = -0.9 + k * 0.3; bag.add('belt', rod([x, 1.05, -1.8], [x, 2.25, -1.8], 0.008, { radial: 4 })); }
  for (let k = 0; k < 5; k++) { const y = 1.1 + k * 0.28; bag.add('belt', rod([-0.95, y, -1.8], [0.95, y, -1.8], 0.008, { radial: 4 })); }
  bag.add('heliRed', rod([0.85, 1.05, -1.72], [0.85, 1.5, -1.72], 0.06, { radial: 12, caps: true }));
  bag.add('heliWhite', boxG(0.34, 0.24, 0.12, [-0.75, 2.05, -1.76]));
  for (const z of [-0.6, 0.6, 1.8]) bag.add('heliBlack', bend([[0.95, 2.45, z - 0.15], [1.0, 2.38, z], [0.95, 2.45, z + 0.15]], 0.015, { radial: 5, seg: 6 }));
  // cabin seats facing each other: seat0/1 at the back facing forward, seat2/3 facing aft
  const seats = [[-0.45, -1.28, 0], [0.45, -1.28, 0], [-0.45, 1.85, Math.PI], [0.45, 1.85, Math.PI]];
  const hipH = 0.46;
  seats.forEach(([x, z, ry], i) => {
    let p = [x, HELI.floor + hipH, z], rr = [0, ry, 0];
    if (wreck && i === 3) { p = [x + 0.15, HELI.floor + hipH - 0.1, z - 0.2]; rr = [0.25, ry + 0.4, 0.3]; }
    bagInto(bag, seatGeo(bag, hipH), p, rr);
    const m = marker('seat' + i, p, rr[1]); body.add(m);
  });
  // headsets on hooks over the rear seats
  for (const x of [-0.45, 0.45]) { const hs = new THREE.TorusGeometry(0.09, 0.012, 5, 14, Math.PI); xf(hs, { p: [x, 2.27, -1.7] }); bag.add('heliBlack', hs); for (const s of [-1, 1]) bag.add('heliBlack', xf(new THREE.CylinderGeometry(0.045, 0.045, 0.04, 10), { r: [0, 0, Math.PI / 2], p: [x + s * 0.09, 2.25, -1.7] })); }
  // cockpit: two crew seats, instrument panel + glareshield, pedestal, cyclics, collectives, pedals, overhead
  const pz = 3.42;
  for (const x of [-0.55, 0.55]) bagInto(bag, seatGeo(bag, 0.42, { pilot: true }), [x, HELI.floor + 0.42, pz]);
  body.add(marker('pilotSeat', [-0.55, HELI.floor + 0.42, pz], 0));
  body.add(marker('copilotSeat', [0.55, HELI.floor + 0.42, pz], 0));
  const panel = new THREE.PlaneGeometry(2.0, 0.75);
  xf(panel, { r: [0, Math.PI, 0] }); xf(panel, { r: [0.28, 0, 0], p: [0, 1.66, 4.4] }); bag.add('heliPanel', panel);
  const pb = roundBox(2.05, 0.78, 0.12, 0.03, 4, 2, 1); xf(pb, { r: [0.28, 0, 0], p: [0, 1.66, 4.47] }); bag.add('heliBlack', planarUV(pb, 2));
  const gs = roundBox(2.1, 0.06, 0.42, 0.03, 4, 1, 2); xf(gs, { p: [0, 2.06, 4.3], r: [0.12, 0, 0] }); bag.add('heliBlack', planarUV(gs, 2));
  const ped = roundBox(0.34, 0.78, 0.9, 0.04, 2, 3, 3); xf(ped, { p: [0, HELI.floor + 0.39, 3.95], r: [0.15, 0, 0] }); bag.add('heliBlack', planarUV(ped, 2));
  for (const x of [-0.55, 0.55]) {
    bag.add('heliBlack', bend([[x, HELI.floor, pz + 0.42], [x, HELI.floor + 0.35, pz + 0.38], [x, HELI.floor + 0.62, pz + 0.32]], 0.018, { radial: 6, seg: 8 }));
    bag.add('heliBlack', rod([x, HELI.floor + 0.6, pz + 0.32], [x, HELI.floor + 0.75, pz + 0.3], 0.03, { radial: 8, caps: true }));
    bag.add('heliBlack', rod([x - 0.3, HELI.floor + 0.12, pz - 0.15], [x - 0.3, HELI.floor + 0.32, pz + 0.38], 0.022, { radial: 6, caps: true }));
    for (const s of [-1, 1]) bag.add('alu', xf(planarUV(roundBox(0.09, 0.2, 0.03, 0.01, 1, 1, 1), 3), { p: [x + s * 0.13, HELI.floor + 0.12, pz + 0.95], r: [-0.5, 0, 0] }));
  }
  const oh = roundBox(0.5, 0.08, 0.55, 0.03, 2, 1, 2); xf(oh, { p: [0, 2.5, 3.65] }); bag.add('heliBlack', planarUV(oh, 2));
  body.add(marker('light', [0, 2.45, 0.4], 0, { color: 0xffe2b0, intensity: wreck ? 0 : 1.2 }));
  // ---- exterior: engine cowling, mast, exhausts, intakes, beacon, antennas
  const cowlSect = (z) => ({ b: 2.5, t: keyInterp([[1.6, 0, 2.62], [1.2, 0, 3.1], [0.6, 0, 3.22], [-2.2, 0, 3.2], [-3.1, 0, 2.86], [-3.5, 0, 2.6]], z, 2), hw: keyInterp([[1.6, 0, 0.3], [1.2, 0, 0.55], [0.6, 0, 0.64], [-2.2, 0, 0.62], [-3.1, 0, 0.42], [-3.5, 0, 0.2]], z, 2), n: 3.2 });
  const cowl = heliLoft({ z0: 1.6, z1: -3.5, nz: 30, nt: 32, th0: TAU * 0.2, th1: TAU * 0.8, sect: cowlSect, warp: wreck ? (v) => { v.x += N1.n3(v.x * 3, v.y * 3, v.z * 3) * 0.05; } : null });
  bag.add('heliWhite', planarUV(cowl.skin, 1), wreck ? (x, y, z) => { const b = sstep(-0.2, 0.6, N3.fbm2(x * 2, z * 1.5, 3)); return [1 - b * 0.85, 1 - b * 0.88, 1 - b * 0.9]; } : (x, y, z) => { const s = sstep(-1.8, -3.4, z) * 0.5; return [1 - s, 1 - s, 1 - s]; });
  for (const s of [-1, 1]) {
    bag.add('heliBlack', xf(planarUV(roundBox(0.06, 0.32, 0.55, 0.02, 1, 2, 2), 2), { p: [s * 0.62, 2.88, 0.75] }));
    bag.add('ironDark', rod([s * 0.3, 2.98, -2.6], [s * 0.36, 3.22, -3.05], 0.1, { r1: 0.115, radial: 14 }), [0.5, 0.47, 0.44]);
    bag.add('heliBlack', rod([s * 0.355, 3.2, -3.03], [s * 0.36, 3.225, -3.07], 0.085, { radial: 14, caps: true }), [0.05, 0.05, 0.05]);
  }
  bag.add('heliBlack', rod([0, 3.0, HELI.mastZ], [0, HELI.hubY - 0.2, HELI.mastZ], 0.11, { radial: 14 }));
  bag.add('heliWhite', xf(lathe([[0.36, 0], [0.33, 0.12], [0.2, 0.3], [0.12, 0.36]], 18), { p: [0, 3.15, HELI.mastZ] }));
  bag.add('heliRed', xf(new THREE.SphereGeometry(0.06, 10, 6), { p: [0, 3.27, -2.2] }), [2.5, 0.6, 0.6]);
  bag.add('heliBlack', rod([0, 2.6, 4.5], [0, 2.95, 4.2], 0.012)); bag.add('heliBlack', rod([0.3, 0.7, 2.0], [0.32, 0.45, 1.85], 0.01));
  // landing light, pitot tubes, steps, wire cutter
  bag.add('alu', xf(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 14), { r: [0.3, 0, 0], p: [0, 0.86, 4.6] }), [2.2, 2.2, 2.0]);
  for (const s of [-1, 1]) bag.add('alu', rod([s * 0.3, 1.5, 5.3], [s * 0.36, 1.48, 5.75], 0.012));
  bag.add('alu', rod([0, 2.5, 5.0], [0, 2.95, 4.75], 0.02));
  // ---- skids
  const skidG = (s, broken) => {
    const y = 0.07, x = s * 1.22, pts = broken ? [[x, y, -2.0], [x + s * 0.1, y, 0.0], [x + s * 0.35, y + 0.05, 1.5], [x + s * 0.8, y + 0.02, 2.4]] : [[x, y + 0.12, -2.35], [x, y, -2.0], [x, y, 0.5], [x, y, 2.9], [x, y + 0.1, 3.3], [x, y + 0.42, 3.55]];
    bag.add('alu', bend(pts, 0.05, { radial: 8, seg: 24 }));
    for (const z of [-1.2, 1.95]) { if (broken && z > 0) continue; bag.add('alu', bend([[x, y, z], [x * 0.96, 0.45, z], [x * 0.75, 0.72, z], [x * 0.4, 0.76, z]], 0.055, { radial: 8, seg: 12 })); }
    if (!broken) bag.add('alu', xf(planarUV(roundBox(0.06, 0.04, 0.4, 0.015, 1, 1, 2), 3), { p: [x - s * 0.05, 0.3, 1.0] }));
  };
  skidG(1, wreck); skidG(-1, false);
  // ---- tail parts (boom extras, fin, stabiliser, tail rotor) collected in their own bag so the wreck can move them
  const tb = new Bag(), tailG = new THREE.Group();
  if (wreck) {
    const tailLoft = heliLoft({ z0: tailCut - 0.05, z1: -8.56, nz: 34, nt: 40, warp: (v) => { v.x += N1.n3(v.x * 3, v.y * 3, v.z * 3) * 0.02; } });
    tb.add(skinKey, tailLoft.skin, [1, 1, 1]); tb.add(skinKey, sectCap(-8.56, -1));
  }
  tb.add('heliWhite', rod([0, 2.24, -3.3], [0, 2.26, -8.0], 0.07, { radial: 10, caps: true }));
  const fin = new THREE.Shape([new THREE.Vector2(-7.7, 2.1), new THREE.Vector2(-8.25, 3.62), new THREE.Vector2(-8.72, 3.66), new THREE.Vector2(-8.66, 2.0), new THREE.Vector2(-8.85, 1.35), new THREE.Vector2(-8.55, 1.35), new THREE.Vector2(-8.3, 1.9)]);
  const fg = new THREE.ExtrudeGeometry(fin, { depth: 0.08, bevelEnabled: true, bevelThickness: 0.025, bevelSize: 0.03, bevelSegments: 2, curveSegments: 4 });
  fg.rotateY(-Math.PI / 2); fg.translate(0.04, 0, 0); tb.add('heliRed', planarUV(fg, 1));
  const stab = roundBox(3.1, 0.07, 0.55, 0.03, 8, 1, 3); xf(stab, { p: [0, 2.05, -6.05] }); tb.add('heliWhite', planarUV(stab, 1));
  for (const s of [-1, 1]) { const ep = roundBox(0.05, 0.6, 0.48, 0.02, 1, 2, 2); xf(ep, { p: [s * 1.55, 2.1, -6.08], r: [0, 0, 0] }); tb.add('heliRed', planarUV(ep, 1)); }
  tb.add('heliBlack', rod([0.0, HELI.tailHub[1], HELI.tailHub[2]], [HELI.tailHub[0] - 0.05, HELI.tailHub[1], HELI.tailHub[2]], 0.07, { radial: 10, caps: true }));
  const tr = new THREE.Object3D(); tr.name = 'tailRotor'; tr.position.set(...HELI.tailHub); tailG.add(tr);
  const trb = new Bag();
  for (const s of [-1, 1]) { const b = bladeGeo(0.12, 1.32, 0.2, 0.03); xf(b, { r: [0, 0, Math.PI / 2] }); xf(b, { r: [s > 0 ? 0 : Math.PI, 0, 0] }); trb.add('heliBlade', b); }
  trb.add('heliBlack', rod([-0.06, 0, 0], [0.12, 0, 0], 0.08, { radial: 10, caps: true }));
  if (wreck) { for (const [k, l] of trb.m) for (const g0 of l) { deform(g0, v => { v.y += Math.max(0, -v.z) * 0.15; }); } }
  trb.build(tr, { ao: false });
  // ---- main rotor
  const rotor = new THREE.Object3D(); rotor.name = 'rotor'; rotor.position.set(0, HELI.hubY, HELI.mastZ);
  const rb = new Bag(); rotorHub(rb);
  for (let i = 0; i < 4; i++) {
    let bendFn = (x) => [-0.012 * x * x * 0.25, 0, 0.12 - x * 0.012];
    let r1 = 7.0;
    if (wreck) {
      bendFn = [(x) => [-0.075 * Math.max(0, x - 2.2) ** 1.7, 0.04 * Math.max(0, x - 3) ** 2, 0.2 + x * 0.05],
        (x) => [-0.01 * x * x, -0.02 * x * x, 0.1], (x) => [0.05 * Math.max(0, x - 1.5) ** 1.6, -0.09 * Math.max(0, x - 2) ** 1.5, -0.3],
        (x) => [-0.02 * x * x, 0, 0.1]][i];
      r1 = [6.4, 2.6, 5.2, 1.9][i];
    }
    const b = bladeGeo(0.62, r1, 0.42, 0.055, bendFn); xf(b, { r: [0, i * Math.PI / 2 + 0.3, 0] }); rb.add('heliBlade', b);
  }
  rb.build(rotor, { ao: false });
  if (wreck) { rotor.rotation.set(0.12, 0.4, -0.08); }
  body.add(rotor);
  // ---- merge (the wreck's crumpled nose also pushes the cockpit furniture back)
  if (wreck) for (const list of bag.m.values()) for (const g0 of list) if (!warped.has(g0)) { const p = g0.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); crumple(v); p.setXYZ(i, v.x, v.y, v.z); } }
  bag.build(body, { ao: false });
  glassBag.build(body, { ao: false });
  tb.build(tailG, { ao: false });
  if (!wreck) { body.add(tailG); return { root, body, tail: tailG }; }
  return { root, body, tail: tailG, tb };
}
/** half width of a section at height y */
function sectHalfWidthAt(S, y, off) {
  let best = 0; for (let k = 0; k <= 48; k++) { const [x, yy] = sectPt(S, k / 48 * Math.PI, off); if (Math.abs(yy - y) < 0.12) best = Math.max(best, x); } return best || S.hw - off;
}

def('helicopter', {
  size: [3.2, 4.2, 17.4],
  colliders: [{ x: 0, z: 0.6, w: 2.45, d: 9.8, h: 2.7 }, { x: 0, z: -6.2, w: 0.8, d: 5, h: 2.4 }, { x: 0, z: -8.3, w: 0.3, d: 1, h: 3.7 }],
  notes: "intact Bell 412-like, nose +Z. 'rotor' spins about Y, 'tailRotor' about X; 'seat0'..'seat3' (hip point, +Z = facing), 'pilotSeat' (+'copilotSeat'), 'light' in the cabin roof. Open cabin door on the -X side.",
}, () => {
  const { root } = buildHeli(false);
  root.userData.tris = tris(root);
  return root;
});

def('helicopterWreck', {
  size: [12, 3.6, 16],
  colliders: [{ x: 0, z: 0.5, w: 2.8, d: 9.5, h: 2.4, rot: 0.08 }, { x: -3.6, z: -9.2, w: 1.2, d: 4.6, h: 1.6, rot: 0.55 }, { x: 2.2, z: 3.8, w: 1.4, d: 1.6, h: 0.9 }],
  notes: "crashed helicopter: crumpled nose, tail boom broken off and lying at (-3.6, -9.2), bent rotor, 'fire' smouldering points (+'light'), 'supplyCrate' (orange emergency box), seats 'seat0'..'seat3' still named inside",
}, () => {
  const { root, body, tail } = buildHeli(true);
  // fuselage rolled onto its right side, nose dug in
  body.rotation.set(0.1, 0.08, -0.32); body.position.set(0, -0.38, 0.4);
  // the broken tail lies a few metres away
  const tailWrap = new THREE.Group(); tail.position.set(0, -2.05, 6.4); tailWrap.add(tail);
  tailWrap.rotation.set(0.05, 0.55, 1.35); tailWrap.position.set(-3.5, 0.25, -9.2);
  root.add(tailWrap);
  const bag = new Bag(), R = rng(31);
  // dirt pushed up in front of the nose and a gouge trench
  const mound = rockGeo(5, { size: [4.2, 1.1, 2.0], detail: 9, amp: 0.3, facets: 0, flat: 0.1, sink: 0.45 }); xf(mound, { p: [0.3, 0, 6.2], r: [0, 0.15, 0] }); bag.add('soil', planarUV(mound, 0.6), [0.75, 0.7, 0.65]);
  for (let i = 0; i < 9; i++) { const g = rockGeo(i + 40, { size: [0.5 + R() * 0.6, 0.3, 0.5 + R() * 0.5], detail: 3, amp: 0.4, facets: 0, sink: 0.4 }); xf(g, { p: [-2 + R() * 4.5, 0, 5 + R() * 3] }); bag.add('soil', planarUV(g, 0.6), [0.7, 0.65, 0.6]); }
  // scattered panels and fragments
  for (let i = 0; i < 11; i++) {
    const pg = new THREE.PlaneGeometry(0.4 + R() * 0.8, 0.3 + R() * 0.6, 3, 3); deform(pg, v => { v.z += (v.x * v.x) * (R() - 0.3) * 0.8 + N1.n2(v.x * 3 + i, v.y * 3) * 0.06; });
    const uv = pg.attributes.uv, u0 = 0.1 + R() * 0.6, v0 = R() < 0.5 ? 0.1 + R() * 0.1 : 0.4 + R() * 0.1; for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * 0.05, v0 + uv.getY(k) * 0.08);
    const a = R() * TAU, d = 3.5 + R() * 6; xf(pg, { r: [-Math.PI / 2 + (R() - 0.5) * 0.6, R() * TAU, (R() - 0.5) * 0.5], p: [Math.cos(a) * d, 0.06 + R() * 0.1, Math.sin(a) * d - 1] });
    bag.add('heliSkinWreck', pg, [1, 1, 1]);
  }
  M('heliSkinWreck').side = THREE.DoubleSide;
  // the snapped rotor blade lying on the ground, a torn skid section, a thrown seat
  const bl = bladeGeo(0.0, 4.6, 0.42, 0.055, (x) => [0.02 * x * x, 0.05 * x * x, 0.2]); xf(bl, { r: [0, 0.8, 0.05], p: [4.2, 0.12, -3.4] }); bag.add('heliBlade', bl);
  bag.add('alu', bend([[-3.8, 0.06, 3], [-4.6, 0.08, 4.1], [-5.0, 0.2, 4.6]], 0.05, { radial: 8, seg: 10 }));
  const st = seatGeo(bag, 0.45, {}); bagInto(bag, st, [5.2, 0.32, 1.2], [1.35, 0.6, 0.2]);
  // spilled cargo: a split wooden crate and its contents
  const cb = new Bag(); crateGeo(cb, { seed: 77, lid: false, broken: true }); bagInto(bag, cb, [3.4, 0.0, -1.0], [0.1, 0.7, 0.25]);
  for (let i = 0; i < 7; i++) { const x = 3.6 + R() * 1.6, z = -0.3 + R() * 1.4; bag.add(R() < 0.5 ? 'rust' : 'olive', rod([x, 0.04, z], [x + (R() - 0.5) * 0.2, 0.04 + (R() - 0.5) * 0.02, z + 0.14], 0.04, { radial: 10, caps: true })); }
  for (let i = 0; i < 3; i++) { const g = roundBox(0.5, 0.18, 0.32, 0.07, 3, 2, 3); noisifyLite(g, 0.03, 4); xf(g, { p: [4.4 + R() * 0.8, 0.09, 0.6 + R() * 0.8], r: [0, R() * 3, 0] }); bag.add('canvas', planarUV(g, 1.5), [0.55, 0.6, 0.45]); }
  bag.build(root, { aoMin: 0.7, aoH: 0.3 });
  // the orange emergency box the player loots
  const sc = new THREE.Object3D(); sc.name = 'supplyCrate'; sc.position.set(2.3, 0, 3.6); sc.rotation.set(0, -0.5, 0);
  const sb = new Bag();
  const box = roundBox(0.62, 0.34, 0.42, 0.03, 3, 2, 2); const bu = box.attributes.uv; void bu; xf(box, { p: [0, 0.17, 0] });
  sb.add('emergency', boxFrontUV(box, 0.62, 0.34, 0.42));
  for (const s of [-1, 1]) { sb.add('heliBlack', boxG(0.05, 0.08, 0.03, [s * 0.2, 0.25, 0.22])); sb.add('heliBlack', bend([[s * 0.31, 0.3, -0.06], [s * 0.34, 0.36, 0], [s * 0.31, 0.3, 0.06]], 0.012, { radial: 5, seg: 6 })); }
  sb.build(sc, { ao: false }); root.add(sc);
  // smouldering points
  root.add(marker('fire', [0.6, 2.4, -1.6])); root.add(marker('fire', [-1.2, 0.2, 2.6]));
  root.add(marker('fire', [-3.2, 0.3, -6.9]));
  root.add(marker('light', [0.3, 2.0, -1.4], 0, { color: 0xff7a30, intensity: 1.6 }));
  root.userData.tris = tris(root);
  return root;
});
/** uv for a box so that the +Z and -Z faces each show the whole label texture */
function boxFrontUV(g, w, h, d) {
  const n = g.index ? g.toNonIndexed() : g, p = n.attributes.position, nn = n.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ax = Math.abs(nn.getX(i)), az = Math.abs(nn.getZ(i));
    let u, v;
    if (az > 0.6) { u = nn.getZ(i) > 0 ? x / w + 0.5 : 0.5 - x / w; v = y / h; } else if (ax > 0.6) { u = 0.02 + (z / d + 0.5) * 0.1; v = y / h * 0.2; } else { u = x / w * 0.1 + 0.05; v = 0.05 + z / d * 0.1; }
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  n.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); return n;
}

/* =========================================================== shared organic pieces */
/** set a vertex colour attribute from fn(x,y,z) in the geometry's current frame */
function paintVerts(g, fn) { const p = g.attributes.position, c = new Float32Array(p.count * 3); for (let i = 0; i < p.count; i++) c.set(fn(p.getX(i), p.getY(i), p.getZ(i)), i * 3); g.setAttribute('color', new THREE.BufferAttribute(c, 3)); return g; }
/** colliders of a sub-part placed at p with yaw ry */
function placeCols(list, p, ry = 0) {
  const c = Math.cos(ry), s = Math.sin(ry);
  return list.map(o => ({ ...o, x: o.x * c + o.z * s + p[0], z: -o.x * s + o.z * c + p[2], ...(o.w !== undefined ? { rot: (o.rot || 0) + ry } : {}) }));
}
/** a weathered deer skull, snout toward +Z, origin under the back of the skull */
function addSkull(bag, p, r = [0, 0, 0], s = 1, { antlers = true, seed = 1, col = [0.9, 0.86, 0.76], antlerScale = 0.55, jaw = false } = {}) {
  const parts = [];
  const cr = new THREE.SphereGeometry(0.07, 14, 10); xf(cr, { s: [1, 0.8, 1.15], p: [0, 0.06, 0] }); parts.push(cr);
  const sn = new THREE.SphereGeometry(0.05, 12, 8); deform(sn, v => { const t = clamp((v.z + 0.05) / 0.1, 0, 1); v.x *= lerp(1, 0.5, t); v.y *= lerp(1, 0.62, t); }); xf(sn, { s: [1, 0.85, 2.7], p: [0, 0.035, 0.14] }); parts.push(sn);
  for (const sx of [-1, 1]) { const o = new THREE.TorusGeometry(0.024, 0.009, 5, 10); xf(o, { r: [0, sx * 1.15, 0], p: [sx * 0.052, 0.072, 0.065] }); parts.push(o); }
  if (jaw) for (const sx of [-1, 1]) parts.push(bend([[sx * 0.04, 0.0, 0.02], [sx * 0.03, -0.02, 0.12], [sx * 0.012, 0.0, 0.25]], 0.009, { radial: 5, seg: 6 }));
  const g = mergeGeos(parts);
  paintVerts(g, (x, y, z) => { const k = lerp(0.8, 1, sstep(0.0, 0.1, y)); return [col[0] * k, col[1] * k, col[2] * k]; });
  const dark = [];
  for (const sx of [-1, 1]) { const e = new THREE.SphereGeometry(0.021, 8, 6); xf(e, { p: [sx * 0.05, 0.072, 0.07] }); dark.push(e); }
  const na = new THREE.SphereGeometry(0.02, 8, 6); xf(na, { s: [0.8, 0.5, 2.2], p: [0, 0.052, 0.21] }); dark.push(na);
  const dg = mergeGeos(dark); paintVerts(dg, () => [0.06, 0.05, 0.04]);
  const all = [g, dg];
  if (antlers) for (const m of [-1, 1]) { const a = antler(seed * 3 + (m > 0 ? 1 : 2), antlerScale, m); xf(a, { r: [-0.35, 0, -m * 0.4], p: [m * 0.04, 0.1, 0.02] }); paintVerts(a, (x, y) => { const k = lerp(0.55, 0.85, sstep(0.1, 0.5, y)); return [k * 0.95, k * 0.85, k * 0.7]; }); all.push(a); }
  for (const x of all) { xf(x, { s, r, p }); bag.add('bone', x); }
}
/** a long bone lying on the ground at p with yaw a (non-indexed, coloured) */
function addBone(bag, len, r, p, a = 0, roll = 0, col = [0.86, 0.82, 0.72]) {
  const g = bone(len, r, 6); xf(g, { p: [0, -len / 2, 0] }); xf(g, { r: [0, 0, Math.PI / 2] }); xf(g, { r: [roll, a, 0], p: [p[0], p[1] + r * 1.4, p[2]] });
  bag.add('bone', g, col);
}
/** a curved rib */
function addRib(bag, p, a, s = 1, col = [0.84, 0.8, 0.7]) {
  const g = bend([[0, 0, 0], [0.12 * s, 0.05 * s, 0.02], [0.24 * s, 0.03 * s, 0.1 * s], [0.3 * s, 0.0, 0.22 * s]], t => lerp(0.012, 0.006, t) * s, { radial: 5, seg: 8 });
  xf(g, { r: [0, a, 0], p }); bag.add('bone', g, col);
}
/** a vertebra */
function addVert(bag, p, a, s = 1) {
  const g = mergeGeos([xf(new THREE.CylinderGeometry(0.03 * s, 0.032 * s, 0.04 * s, 8), { r: [Math.PI / 2, 0, 0] }), rod([0, 0, 0], [0, 0.06 * s, -0.01], 0.008 * s, { radial: 4 }), rod([0, 0, 0], [0.05 * s, 0.01, 0], 0.007 * s, { radial: 4 }), rod([0, 0, 0], [-0.05 * s, 0.01, 0], 0.007 * s, { radial: 4 })]);
  xf(g, { r: [0, a, 0], p: [p[0], p[1] + 0.03 * s, p[2]] }); bag.add('bone', g, [0.82, 0.78, 0.68]);
}
/** a pole (rough peeled stick) between two points */
function addStick(bag, a, b, r, key = 'log', col) { bag.add(key, rod(a, b, r, { r1: r * 0.8, radial: r > 0.05 ? 8 : 5, seg: 2, k: 2 }), col); }

/* ----- extra materials painted on canvas ----- */
defMat('denim', () => stdMat({ map: tex('cloth').map, normalMap: tex('cloth').normalMap, color: 0x6a7686, roughness: 0.95, vertexColors: true }));
defMat('leather', () => stdMat({ map: T('grime').map, color: 0x3b2a1e, roughness: 0.75, vertexColors: true }));
defMat('parka', () => {
  const s = pix(512, 512, (x, y, o) => {
    const u = x / 512, v = y / 512, n = tn(N1, u, v, 6, 6, 4), st = tn(N2, u, v, 3, 3, 3), f = tn(N3, u, v, 60, 60, 1);
    const quilt = Math.abs((y % 48) - 24) > 22 ? 0.7 : 1, stripe = v > 0.42 && v < 0.5 ? 1 : 0;
    const fade = clamp(0.5 + n * 0.8, 0, 1);
    let r = lerp(92, 150, fade), g = lerp(48, 70, fade), b = lerp(34, 42, fade);
    if (stripe) { r = 132 + n * 20; g = 118 + n * 18; b = 92 + n * 14; }
    const dirt = clamp(st * 1.6 + 0.15, 0, 0.65); r *= (1 - dirt) * quilt; g *= (1 - dirt * 0.9) * quilt; b *= (1 - dirt * 0.8) * quilt;
    o[0] = r + f * 6; o[1] = g + f * 5; o[2] = b + f * 4;
    o[3] = (tn(N3, u + 0.4, v, 7, 7, 3) > 0.42 || (st < -0.5 && f > 0.2)) ? 0 : 255;
    return quilt * 0.5 + n * 0.1;
  }, { strength: 2 });
  return stdMat({ map: s.map, normalMap: s.normalMap, roughness: 0.8, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true });
});
defMat('feather', () => {
  const c = makeCanvas(64, 256), g = c.getContext('2d'), r = rng(8);
  g.strokeStyle = '#e8e2d0'; g.lineWidth = 2; g.beginPath(); g.moveTo(32, 250); g.lineTo(32, 8); g.stroke();
  for (let y = 20; y < 236; y += 2) { const w = Math.sin((y - 8) / 240 * Math.PI) * 26; const k = r(); g.strokeStyle = y > 150 ? `rgba(${40 + k * 30},${36 + k * 20},${30 + k * 20},0.95)` : `rgba(${60 + k * 40},${48 + k * 30},${36 + k * 20},0.95)`; g.lineWidth = 1.4; for (const sd of [-1, 1]) { if (r() < 0.06) continue; g.beginPath(); g.moveTo(32, y); g.quadraticCurveTo(32 + sd * w * 0.6, y - 6, 32 + sd * w, y - 14); g.stroke(); } }
  return stdMat({ map: toTex(c, { repeat: false }), roughness: 0.8, side: THREE.DoubleSide, alphaTest: 0.4, vertexColors: true });
});
defMat('ochreStone', () => stdMat({ map: tex('rock').map, normalMap: tex('rock').normalMap, color: 0xc0583e, roughness: 0.9, vertexColors: true }));
defMat('totemWood', () => stdMat({ map: T('greyWood').map, normalMap: T('greyWood').normalMap, roughness: 0.92, vertexColors: true }));
defMat('tarpTorn', () => {
  const c = makeCanvas(512, 512), g = c.getContext('2d'), r = rng(19);
  g.drawImage(T('canvas').canvas, 0, 0); g.globalCompositeOperation = 'multiply'; g.fillStyle = '#7d8c6a'; g.fillRect(0, 0, 512, 512);
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 7; i++) { const cx = 60 + r() * 400, cy = 80 + r() * 380, rr = 15 + r() * 55; g.beginPath(); for (let k = 0; k < 12; k++) { const a = k / 12 * TAU, d = rr * (0.4 + r() * 0.8); g.lineTo(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 1.6); } g.fill(); }
  g.beginPath(); g.moveTo(0, 512); for (let x = 0; x <= 512; x += 16) g.lineTo(x, 470 - r() * 90 - (x > 300 ? 120 * r() : 0)); g.lineTo(512, 512); g.fill();
  return windify(stdMat({ map: toTex(c, { repeat: false }), roughness: 0.9, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true }), { mode: 'foliage', height: 2.5, bend: 2 });
});

/* =========================================================== CAMP PROPS */
function lanternGeo(bag, p = [0, 0, 0], ry = 0, tipped = false) {
  const L = new Bag();
  L.add('redPaint', lathe([[0.001, 0], [0.085, 0], [0.095, 0.02], [0.09, 0.07], [0.06, 0.085], [0.035, 0.09]], 18));
  L.add('glassLamp', lathe([[0.035, 0.09], [0.06, 0.11], [0.068, 0.17], [0.055, 0.23], [0.032, 0.25]], 16));
  for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + 0.4; L.add('redPaint', bend([[Math.cos(a) * 0.06, 0.085, Math.sin(a) * 0.06], [Math.cos(a) * 0.078, 0.17, Math.sin(a) * 0.078], [Math.cos(a) * 0.04, 0.26, Math.sin(a) * 0.04]], 0.0035, { radial: 4, seg: 8, cap: false })); }
  for (const s of [-1, 1]) L.add('redPaint', bend([[s * 0.09, 0.03, 0], [s * 0.1, 0.18, 0], [s * 0.05, 0.3, 0]], 0.005, { radial: 4, seg: 6 }));
  L.add('redPaint', lathe([[0.03, 0.25], [0.05, 0.26], [0.045, 0.29], [0.02, 0.31], [0.001, 0.315]], 14));
  const bail = new THREE.TorusGeometry(0.075, 0.003, 4, 16, Math.PI); xf(bail, { p: [0, 0.31, 0] }); L.add('ironDark', bail);
  L.add('ironDark', rod([0.07, 0.05, 0], [0.11, 0.05, 0], 0.008, { radial: 6, caps: true }));
  bagInto(bag, L, [0, 0, 0], [0, ry, 0]);
  void tipped;
}
def('lantern', { size: [0.22, 0.34, 0.22], colliders: [], notes: "1980s kerosene hurricane lantern; 'light' marker in the globe (unlit by default: intensity 0.8)" }, () => {
  const bag = new Bag(); lanternGeo(bag); const g = bag.build(undefined, { aoMin: 0.7, aoH: 0.1 });
  g.add(marker('light', [0, 0.17, 0], 0, { color: 0xffb060, intensity: 0.8 })); return g;
});
defMat('radioFace', () => {
  const c = makeCanvas(512, 320), g = c.getContext('2d'), r = rng(44);
  g.drawImage(T('olivePaint').canvas, 0, 0, 512, 320);
  g.fillStyle = 'rgba(20,22,16,0.85)'; g.fillRect(24, 30, 150, 90); g.fillStyle = '#c9c2a2'; g.fillRect(32, 38, 134, 74);
  g.strokeStyle = '#222'; g.lineWidth = 2; g.beginPath(); g.arc(99, 110, 60, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); g.beginPath(); g.moveTo(99, 110); g.lineTo(130, 58); g.stroke();
  for (let k = 0; k < 10; k++) { const a = Math.PI * 1.2 + k / 9 * Math.PI * 0.6; g.beginPath(); g.moveTo(99 + Math.cos(a) * 52, 110 + Math.sin(a) * 52); g.lineTo(99 + Math.cos(a) * 60, 110 + Math.sin(a) * 60); g.stroke(); }
  g.fillStyle = '#111'; for (let y = 160; y < 290; y += 9) for (let x = 30; x < 170; x += 9) { g.beginPath(); g.arc(x, y, 3, 0, TAU); g.fill(); }
  g.fillStyle = '#e8e0c4'; g.font = 'bold 22px Arial'; g.fillText('NORTHCOM  SR-80', 210, 52); g.font = '14px Arial';
  ['VOL', 'SQL', 'BAND', 'CHAN', 'MODE'].forEach((t, i) => g.fillText(t, 222 + (i % 3) * 95, 110 + Math.floor(i / 3) * 110));
  g.fillStyle = 'rgba(15,15,12,0.9)'; g.fillRect(300, 250, 170, 40); g.fillStyle = '#7a1'; g.font = 'bold 26px monospace'; g.fillText('146.52', 320, 280);
  for (let i = 0; i < 200; i++) { g.fillStyle = `rgba(${90 + r() * 60},${40 + r() * 20},20,${r() * 0.35})`; g.beginPath(); g.arc(r() * 512, r() * 320, 1 + r() * 6, 0, TAU); g.fill(); }
  return stdMat({ map: toTex(c, { repeat: false }), roughness: 0.75, metalness: 0.2, vertexColors: true });
});
function radioGeo(bag) {
  const R = new Bag();
  R.add('olive', planarUV(roundBox(0.46, 0.28, 0.26, 0.02, 3, 2, 2), 2), [0.9, 0.9, 0.9]);
  const f = new THREE.PlaneGeometry(0.44, 0.26); xf(f, { p: [0, 0.0, 0.131] }); R.add('radioFace', f);
  for (const [x, y] of [[0.02, 0.035], [0.11, 0.035], [0.2, 0.035], [0.02, -0.07], [0.11, -0.07]]) R.add('heliBlack', rod([x, y, 0.13], [x, y, 0.16], 0.016, { radial: 10, caps: true }));
  for (const s of [-1, 1]) R.add('ironDark', bend([[s * 0.2, 0.12, -0.06], [s * 0.2, 0.18, 0], [s * 0.2, 0.12, 0.06]], 0.008, { radial: 5, seg: 6 }));
  R.add('ironDark', bend([[0.19, 0.14, -0.08], [0.22, 0.6, -0.1], [0.32, 0.95, -0.05], [0.5, 1.1, 0.05]], 0.004, { radial: 4, seg: 16 }));
  const hs = roundBox(0.06, 0.05, 0.22, 0.02, 1, 1, 2); xf(hs, { p: [-0.1, 0.165, -0.02], r: [0, 0.3, 0] }); R.add('heliBlack', planarUV(hs, 2));
  const coil = []; for (let k = 0; k <= 60; k++) { const t = k / 60, a = t * TAU * 9; coil.push([-0.21 + Math.cos(a) * 0.012 + t * 0.0, 0.05 + Math.sin(a) * 0.012 + t * 0.08, -0.13 + t * 0.06]); }
  R.add('heliBlack', bend(coil, 0.003, { radial: 3, seg: 120 }));
  bagInto(bag, R, [0, 0.14, 0]);
}
def('radio', { size: [0.46, 0.3, 0.26], colliders: [], notes: '1980s field radio set (rusted, antenna bent), front +Z' }, () => { const bag = new Bag(); radioGeo(bag); return bag.build(undefined, { aoMin: 0.7, aoH: 0.15 }); });

function signTex(lines, seed) {
  const W = 512, H = 160, s = pix(W, H, (x, y, o) => {
    const u = x / W, v = y / H, g1 = N1.fbm2(u * 6, v * 30, 3), g2 = N2.fbm2(u * 40, v * 60, 2);
    const crack = Math.abs(N3.fbm2(u * 3 + seed, v * 14, 3)) < 0.015 ? 1 : 0, seam = Math.abs(v - 0.5) < 0.006 ? 1 : 0;
    const c = 108 + g1 * 30 + g2 * 10; o[0] = c * (1 - crack * 0.6 - seam * 0.6); o[1] = c * 0.94 * (1 - crack * 0.6 - seam * 0.6); o[2] = c * 0.84 * (1 - crack * 0.6 - seam * 0.6);
    return 0.5 + g1 * 0.2 - crack * 0.4 - seam * 0.4;
  }, { strength: 3, wrap: false, after: (g) => {
    // paint the letters on their own layer, flake them, then lay them on the board
    const r = rng(seed), c2 = makeCanvas(W, H), g2 = c2.getContext('2d');
    g2.fillStyle = 'rgba(226,220,196,0.92)'; g2.textAlign = 'center'; g2.textBaseline = 'middle';
    lines.forEach(([t, y, f]) => { g2.font = f; g2.fillText(t, W / 2, y * H); });
    g2.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 1600; i++) { g2.globalAlpha = 0.3 + r() * 0.7; g2.beginPath(); g2.ellipse(r() * W, r() * H, 1 + r() * 5, 0.5 + r() * 1.5, 0, 0, TAU); g2.fill(); }
    g.drawImage(c2, 0, 0);
    g.fillStyle = 'rgba(40,30,20,0.25)'; for (let i = 0; i < 60; i++) { g.beginPath(); g.ellipse(r() * W, r() * H, 3 + r() * 20, 2 + r() * 8, 0, 0, TAU); g.fill(); }
    for (const x of [16, W - 16]) for (const y of [26, H - 26]) { g.fillStyle = 'rgba(70,40,20,0.9)'; g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill(); g.fillStyle = 'rgba(90,50,24,0.4)'; g.fillRect(x - 2, y, 4, 22); }
  } });
  return s;
}
def('signpost', { size: [1.4, 2.1, 0.2], colliders: [{ x: 0, z: 0, r: 0.1, h: 2 }], notes: "weathered survey sign; opts.text = 'private' for PRIVATE LAND - NO HUNTING" }, (opts) => {
  const priv = opts.text === 'private', key = priv ? 'signPrivate' : 'signCamp';
  defMat(key, () => { const s = priv ? signTex([['PRIVATE LAND', 0.33, 'bold 56px Georgia'], ['-  NO HUNTING  -', 0.72, 'bold 40px Georgia']], 5) : signTex([['NORTHBOUND SURVEY', 0.33, 'bold 50px Arial'], ['CAMP 2   →', 0.72, 'bold 50px Arial']], 9); return stdMat({ map: s.map, normalMap: s.normalMap, roughness: 0.9, vertexColors: true }); });
  const bag = new Bag();
  addLog(bag, [0, -0.6, -0.04], [0.02, 2.05, -0.04], 0.07, { key: 'log', seed: 3, radial: 8, seg: 3, taper: 0.85, col: (x, y) => [1, sstep(0.5, -0.2, y) * 0.8, 0.2] });
  const board = new THREE.BoxGeometry(1.3, 0.4, 0.035); const uv = board.attributes.uv, nn = board.attributes.normal;
  for (let i = 0; i < uv.count; i++) if (Math.abs(nn.getZ(i)) < 0.5) uv.setXY(i, 0.01, 0.01);
  xf(board, { p: [0.08, 1.62, 0.0], r: [0, 0, priv ? 0.04 : -0.06] }); bag.add(key, board, [0.95, 0.95, 0.95]);
  for (const s of [-1, 1]) bag.add('ironDark', rod([0.08 + s * 0.6, 1.62 + s * 0.04 * (priv ? 1 : -1), 0.02], [0.08 + s * 0.6, 1.62, 0.03], 0.006));
  bag.add('wood', rod([0.02, 0.0, -0.04], [0.02, 0.02, -0.04], 0.1)); // packed earth collar
  return bag.build(undefined, { aoMin: 0.55, aoH: 0.6 });
});

/** canvas tent, ridge along Z, door +Z. collapsed: ridge fallen and draped */
function tentGeo(bag, { collapsed = false, seed = 1 } = {}) {
  const R = rng(seed), L = 2.4, W = 1.0, H = collapsed ? 0.55 : 1.55, sagA = collapsed ? 0.3 : 0.06;
  for (const s of [-1, 1]) {
    const g = new THREE.PlaneGeometry(L, 1, 16, 10), p = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      const z = p.getX(i), t = p.getY(i) + 0.5; // t=0 eave, 1 ridge
      let x = s * lerp(W + 0.1, 0, t), y = lerp(0.02, H, t);
      y -= sagA * Math.sin((z / L + 0.5) * Math.PI) * Math.sin(t * Math.PI) * (collapsed ? 1.6 : 1);
      x += s * N1.fbm2(z * 2 + seed, t * 3, 3) * (collapsed ? 0.3 : 0.03);
      if (collapsed) { y += N2.fbm2(z * 3, t * 3 + s, 3) * 0.12; y = Math.max(0.03, y); }
      p.setXYZ(i, x, y, z); uv.setXY(i, z * 0.5 + s, t * Math.hypot(W, H) * 0.5);
    }
    g.computeVertexNormals(); bag.add('canvas', g, (x, y) => { const k = lerp(0.6, 1, sstep(0, 0.6, y)); return [k, k * 0.98, k * 0.94]; });
  }
  // back wall and two door flaps (left one tied back)
  const tri = (pts, col = [1, 1, 1]) => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2)); g.computeVertexNormals(); bag.add('canvas', g, col); };
  const hb = H - (collapsed ? 0.2 : 0);
  tri([[-W - 0.1, 0.02, -L / 2], [W + 0.1, 0.02, -L / 2], [0, hb, -L / 2]]);
  tri([[0, 0.02, L / 2 + 0.02], [W + 0.1, 0.02, L / 2], [0, hb, L / 2 + 0.01]], [0.9, 0.9, 0.88]);
  if (!collapsed) tri([[-W * 0.8, 0.25, L / 2 + 0.15], [-W - 0.1, 0.02, L / 2], [-0.1, hb * 0.95, L / 2 + 0.02]], [0.85, 0.85, 0.83]);
  if (!collapsed) { addStick(bag, [0, 0, L / 2 + 0.02], [0, H + 0.12, L / 2 + 0.02], 0.02, 'woodBrown'); addStick(bag, [0, 0, -L / 2 - 0.02], [0, H + 0.12, -L / 2 - 0.02], 0.02, 'woodBrown'); addStick(bag, [0, H + 0.03, -L / 2 - 0.05], [0, H + 0.03, L / 2 + 0.05], 0.018, 'woodBrown'); }
  else { addStick(bag, [0.1, 0, L / 2 + 0.1], [0.5, 0.55, L / 2 - 0.2], 0.02, 'woodBrown'); addStick(bag, [-0.3, 0.03, -L / 2 - 0.4], [0.4, 0.06, -L / 2 + 0.6], 0.02, 'woodBrown'); }
  // guy ropes and pegs
  for (const z of [-1, 1]) { const top = [0, H + 0.1 - (collapsed ? 0.2 : 0), z * (L / 2 + 0.03)], peg = [0, 0.04, z * (L / 2 + 1.0)]; bag.add('rope', rope(top, peg, collapsed ? 0.25 : 0.02, 0.006)); addStick(bag, [0, -0.1, peg[2]], [0, 0.1, peg[2] + z * 0.04], 0.012, 'woodBrown'); }
  for (const s of [-1, 1]) for (const z of [-0.9, 0, 0.9]) { const e = [s * (W + 0.1), 0.05, z], peg = [s * (W + 0.45), 0.03, z]; bag.add('rope', rope(e, peg, 0.0, 0.005, 3)); addStick(bag, [peg[0], -0.08, z], [peg[0] + s * 0.03, 0.08, z], 0.01, 'woodBrown'); }
  // ground sheet inside
  const gs = new THREE.PlaneGeometry(2.0, L - 0.1); xf(gs, { r: [-Math.PI / 2, 0, 0], p: [0, 0.01, 0] }); bag.add('heliBlack', gs, [0.6, 0.65, 0.5]);
  void R;
}
def('tent', { size: [2.3, 1.7, 3.2], colliders: [{ x: 0, z: 0, w: 2.2, d: 2.4, h: 1.6 }], notes: "old canvas A-frame tent, door +Z (left flap tied back); opts.variant='collapsed'" }, (opts) => {
  const bag = new Bag(); tentGeo(bag, { collapsed: opts.variant === 'collapsed', seed: (opts.seed ?? 1) * 7 }); return bag.build(undefined, { aoMin: 0.6, aoH: 0.5 });
});

def('surveyCamp', {
  size: [12, 2.4, 11],
  colliders: [{ x: -4, z: -2.2, w: 2.4, d: 2.6, h: 0.7, rot: 0.3 }, { x: 3.6, z: -3.6, w: 2.4, d: 2.6, h: 0.7, rot: -0.5 }, { x: 0, z: 0.8, w: 1.25, d: 0.7, h: 0.75 },
    { x: -1.8, z: -0.4, w: 0.95, d: 0.65, h: 1.15 }, { x: 1.7, z: 0.4, w: 0.9, d: 0.6, h: 0.6, rot: 0.6 }, { x: -2.8, z: 1.7, r: 0.3, h: 0.9 }, { x: -3.2, z: 4.2, r: 0.1, h: 2.3 }, { x: 1.4, z: 4.8, r: 0.1, h: 2.3 }],
  notes: "abandoned 1980s survey camp: collapsed tents, folding table with 'journal' marker, radio, lantern, NORTHBOUND SURVEY crates, cold fire ring, torn tarp between two posts",
}, () => {
  const bag = new Bag(), R = rng(808), root = new THREE.Group();
  const t1 = new Bag(); tentGeo(t1, { collapsed: true, seed: 3 }); bagInto(bag, t1, [-4, 0, -2.2], [0, 0.3, 0]);
  const t2 = new Bag(); tentGeo(t2, { collapsed: true, seed: 9 }); bagInto(bag, t2, [3.6, 0, -3.6], [0, -0.5, 0]);
  // folding table: plywood top on aluminium X legs
  const tb = new Bag(); addPlank(tb, 1.2, 0.65, 0.02, [0, 0.72, 0], [0, 0, 0], { seed: 4, key: 'woodBrown' });
  for (const s of [-1, 1]) { tb.add('alu', rod([s * 0.5, 0.0, -0.28], [s * 0.5, 0.71, 0.28], 0.012)); tb.add('alu', rod([s * 0.5, 0.0, 0.28], [s * 0.5, 0.71, -0.28], 0.012)); }
  tb.add('alu', rod([-0.5, 0.36, 0], [0.5, 0.36, 0], 0.01));
  bagInto(bag, tb, [0, 0, 0.8], [0, 0.05, 0]);
  const rb = new Bag(); radioGeo(rb); bagInto(bag, rb, [0.3, 0.73, 0.7], [0, -0.3, 0]);
  const ln = new Bag(); lanternGeo(ln); bagInto(bag, ln, [-0.4, 0.73, 0.95], [0, 0, 0]);
  // a folding chair knocked over
  const ch = new Bag(); ch.add('canvas', xf(planarUV(new THREE.BoxGeometry(0.42, 0.02, 0.38), 1), { p: [0, 0.42, 0] }), [0.5, 0.6, 0.45]);
  for (const s of [-1, 1]) { ch.add('alu', rod([s * 0.21, 0, -0.2], [s * 0.21, 0.42, 0.2], 0.01)); ch.add('alu', rod([s * 0.21, 0, 0.2], [s * 0.21, 0.85, -0.22], 0.01)); }
  ch.add('canvas', xf(planarUV(new THREE.BoxGeometry(0.42, 0.25, 0.01), 1), { p: [0, 0.72, -0.16], r: [-0.35, 0, 0] }), [0.5, 0.6, 0.45]);
  bagInto(bag, ch, [0.9, 0.2, 1.5], [-1.4, 0.8, 0]);
  // crates: a stack, a single one, an open one on its side
  const cr = (p, ry, rr = [0, 0], seed = 1, lid = true) => { const c = new Bag(); crateGeo(c, { seed, lid }); bagInto(bag, c, p, [rr[0], ry, rr[1]]); };
  cr([-1.8, 0, -0.4], 0.1, [0, 0], 2); cr([-1.8, 0.58, -0.4], -0.15, [0, 0], 3); cr([1.7, 0.0, 0.4], 0.6, [0, 0], 4, false);
  cr([2.3, 0.3, 2.0], 1.2, [0, Math.PI / 2], 5, false);
  // a rusted drum
  const dr = new Bag(); drumGeo(dr, { seed: 21, dent: 0.03 }); bagInto(bag, dr, [-2.8, 0, 1.7]);
  // cold fire ring
  for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + R() * 0.2; addRock(bag, 900 + i, [0.3 + R() * 0.12, 0.2 + R() * 0.08, 0.26], [2.4 + Math.cos(a) * 0.62, 0, 3.0 + Math.sin(a) * 0.62], { ry: R() * 3, detail: 2, moss: 0.3 }); }
  const ash = new THREE.CircleGeometry(0.55, 18); deform(ash, v => { v.z += N1.n2(v.x * 4, v.y * 4) * 0.02; }); xf(ash, { r: [-Math.PI / 2, 0, 0], p: [2.4, 0.03, 3.0] }); bag.add('char', planarUV(ash, 2), [0.8, 0, 0.2]);
  for (let i = 0; i < 4; i++) { const a = R() * TAU; addLog(bag, [2.4 + Math.cos(a) * 0.4, 0.06, 3.0 + Math.sin(a) * 0.4], [2.4 - Math.cos(a) * 0.1, 0.12, 3.0 - Math.sin(a) * 0.1], 0.05, { key: 'char', seed: 30 + i, radial: 6, seg: 2, ends: false }); }
  // torn tarp between two posts
  const pA = [-3.2, 0, 4.2], pB = [1.4, 0, 4.8];
  for (const p of [pA, pB]) addLog(bag, [p[0], -0.5, p[2]], [p[0] + 0.05, 2.3, p[2]], 0.08, { key: 'log', seed: p[0] * 10, radial: 8, seg: 3 });
  bag.add('rope', rope([pA[0], 2.15, pA[2]], [pB[0], 2.15, pB[2]], 0.25, 0.008));
  const tarp = new THREE.PlaneGeometry(4.2, 1.9, 16, 8); deform(tarp, v => { const t = (v.x + 2.1) / 4.2; v.y -= 0.22 * Math.sin(t * Math.PI) * (v.y > 0 ? 1 : 0.6); v.z += N1.fbm2(v.x * 1.2, v.y * 1.5, 3) * 0.12; });
  const ta = Math.atan2(pB[2] - pA[2], pB[0] - pA[0]); xf(tarp, { r: [0, -ta, 0], p: [(pA[0] + pB[0]) / 2, 2.1 - 0.95, (pA[2] + pB[2]) / 2] });
  bag.add('tarpTorn', tarp, [1, 1, 1]);
  bag.build(root, { aoMin: 0.6, aoH: 0.5 });
  const sm = stencilMat('stencilNS', [['NORTHBOUND SURVEY', 0.38], ['CAMP 2  -  No. 14', 0.75, 'bold 34px Arial']]);
  for (const [p, ry] of [[[-1.8, 0.29, -0.4], 0.1], [[-1.8, 0.87, -0.4], -0.15], [[1.7, 0.29, 0.4], 0.6]]) { const q = quad(0.78, 0.2, [0, 0, 0.302]); xf(q, { r: [0, ry, 0], p }); root.add(mesh(q, sm)); }
  root.add(marker('journal', [-0.05, 0.745, 0.85], 0.4));
  root.add(marker('light', [-0.4, 0.9, 0.95], 0, { color: 0xffb060, intensity: 0 }));
  return root;
});

/* =========================================================== BONES, SKULLS, REMAINS */
def('skull', { size: [0.5, 0.45, 0.35], colliders: [], notes: 'weathered deer skull with antlers, snout +Z' }, (opts) => {
  const bag = new Bag(); addSkull(bag, [0, 0.03, -0.1], [-0.12, 0, 0.18], 1.2, { seed: opts.seed ?? 1, antlerScale: 0.5, jaw: false }); return bag.build(undefined, { aoMin: 0.6, aoH: 0.12 });
});
def('bones', { size: [1.6, 0.15, 1.2], colliders: [], notes: 'scattered old animal bones, not gory' }, (opts) => {
  const R = rng((opts.seed ?? 1) * 97), bag = new Bag();
  addBone(bag, 0.42, 0.016, [-0.3, 0, 0.1], 0.4, 0.3); addBone(bag, 0.36, 0.014, [0.2, 0, -0.25], 2.1, 1.2); addBone(bag, 0.28, 0.012, [0.45, 0, 0.3], -0.6, 0.6);
  for (let i = 0; i < 6; i++) addRib(bag, [-0.1 + R() * 0.5, 0.01, -0.1 + R() * 0.4], R() * TAU, 0.9 + R() * 0.3);
  for (let i = 0; i < 4; i++) addVert(bag, [-0.5 + R() * 0.4, 0, -0.4 + R() * 0.3], R() * TAU);
  addSkull(bag, [0.55, 0.0, -0.15], [0.2, -2.2, 1.2], 1, { antlers: false });
  const pel = roundBox(0.18, 0.04, 0.14, 0.018, 3, 1, 3); deform(pel, v => { v.y += Math.cos(v.x * 14) * 0.012; }); xf(pel, { p: [-0.55, 0.03, 0.35], r: [0.1, 0.6, 0] }); bag.add('bone', planarUV(pel, 4), [0.8, 0.76, 0.66]);
  return bag.build(undefined, { aoMin: 0.6, aoH: 0.1 });
});
def('bloodlessPile', { size: [1.8, 1.4, 1.8], colliders: [{ x: 0, z: 0, r: 0.8, h: 1.0 }], notes: 'a neat, eerie cairn of clean bones crowned with antlered skulls' }, () => {
  const R = rng(616), bag = new Bag();
  for (let ring = 0; ring < 4; ring++) {
    const n = 12 - ring * 2, rr = 0.75 - ring * 0.18, y = ring * 0.12;
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + ring * 0.3, len = 0.5 - ring * 0.06;
      const g = bone(len, 0.018, 5); xf(g, { p: [0, -len / 2, 0] }); xf(g, { r: [0, 0, Math.PI / 2 - 0.25 - ring * 0.12] });
      xf(g, { r: [0, -a, 0], p: [Math.cos(a) * rr * 0.6, y + 0.05, Math.sin(a) * rr * 0.6] }); bag.add('bone', g, [0.96, 0.93, 0.86]);
    }
  }
  for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; addSkull(bag, [Math.cos(a) * 0.18, 0.48, Math.sin(a) * 0.18], [-0.2, Math.PI / 2 - a, 0], 1.2, { seed: 40 + i, antlerScale: 0.55, col: [0.97, 0.94, 0.88] }); }
  addSkull(bag, [0, 0.6, 0], [-0.5, 0.4, 0], 1.3, { seed: 50, antlerScale: 0.75, col: [0.97, 0.94, 0.88] });
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; addVert(bag, [Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95], a, 1.1); }
  return bag.build(undefined, { aoMin: 0.55, aoH: 0.5 });
});
def('humanRemains', { size: [1.8, 1.4, 1.6], colliders: [{ x: 0, z: -0.65, r: 0.8, h: 1.2 }], notes: 'skeleton in a torn 1980s parka slumped against a rock, facing +Z' }, () => {
  const bag = new Bag();
  addRock(bag, 777, [1.7, 1.3, 1.1], [0, 0, -0.75], { detail: 8, moss: 0.7, ry: 0.4 });
  // torso inside the parka: a slumped lathe body leaning back on the rock
  // a puffy, collapsed parka: the body inside has gone, so the chest has sunk between the shoulders
  const torso = lathe([[0.001, -0.02], [0.19, 0.0], [0.24, 0.1], [0.23, 0.26], [0.25, 0.42], [0.27, 0.52], [0.2, 0.6], [0.09, 0.64], [0.06, 0.66]], 22);
  deform(torso, v => { v.z *= 0.62; if (v.z > 0) v.z *= 1 - 0.35 * Math.sin(clamp(v.y / 0.6, 0, 1) * Math.PI) * Math.exp(-v.x * v.x * 40); v.x += N1.n3(v.x * 7, v.y * 7, v.z * 7) * 0.02; v.z += N2.n3(v.x * 7, v.y * 7, v.z * 7) * 0.025; v.y += Math.sin(v.y * 40) * 0.004; });
  xf(torso, { r: [-0.42, 0.1, 0.1], p: [0, 0.1, -0.1] }); bag.add('parka', planarUV(torso, 2.2), (x, y) => { const k = lerp(0.7, 1, sstep(0.05, 0.4, y)); return [k, k, k]; });
  const hood = new THREE.SphereGeometry(0.19, 16, 8, 0, TAU, 0, Math.PI * 0.62); deform(hood, v => { v.x += N1.n3(v.x * 8, v.y * 8, v.z * 8) * 0.025; v.y *= 0.7; }); xf(hood, { r: [-1.5, 0, 0.25], p: [0.04, 0.66, -0.4] }); bag.add('parka', planarUV(hood, 2), [0.75, 0.75, 0.75]);
  const fur = new THREE.TorusGeometry(0.15, 0.04, 6, 14); deform(fur, v => { v.x += N2.n3(v.x * 20, v.y * 20, v.z * 20) * 0.015; }); xf(fur, { r: [-0.4, 0, 0.25], p: [0.05, 0.66, -0.33] }); bag.add('pelt', planarUV(fur, 3), [0.75, 0.7, 0.6]);
  // skull slumped forward and to the side, with jaw
  const sk = new Bag(); const head = new THREE.SphereGeometry(0.085, 14, 10); xf(head, { s: [0.82, 0.95, 1.05] }); sk.add('bone', head, (x, y) => { const k = lerp(0.42, 0.62, sstep(-0.05, 0.08, y)); return [k, k * 0.92, k * 0.76]; });
  const face = new THREE.SphereGeometry(0.062, 10, 8); xf(face, { s: [0.9, 0.9, 0.7], p: [0, -0.05, 0.055] }); sk.add('bone', face, [0.5, 0.45, 0.36]);
  for (const s of [-1, 1]) sk.add('bone', xf(new THREE.SphereGeometry(0.024, 8, 6), { p: [s * 0.035, -0.02, 0.1] }), [0.05, 0.04, 0.03]);
  sk.add('bone', xf(new THREE.SphereGeometry(0.014, 6, 5), { s: [1, 1.4, 1], p: [0, -0.06, 0.115] }), [0.05, 0.04, 0.03]);
  sk.add('bone', bend([[-0.05, -0.1, 0.0], [-0.03, -0.14, 0.07], [0, -0.15, 0.1], [0.03, -0.14, 0.07], [0.05, -0.1, 0.0]], 0.012, { radial: 5, seg: 10 }), [0.74, 0.7, 0.6]);
  bagInto(bag, sk, [0.08, 0.64, -0.24], [0.45, 0.2, 0.45]);
  // sleeves: arms in the lap, hand bones poking out
  for (const s of [-1, 1]) {
    const sh = [s * 0.25, 0.55, -0.34], el = [s * 0.33, 0.25, -0.12], wr = [s * 0.14, 0.2, 0.16];
    bag.add('parka', bend([sh, [s * 0.32, 0.42, -0.24], el, [s * 0.25, 0.2, 0.02], wr], t => lerp(0.085, 0.07, t), { radial: 10, seg: 14, cap: false }), [0.9, 0.9, 0.9]);
    bag.add('parka', xf(new THREE.CylinderGeometry(0.075, 0.072, 0.03, 10, 1, true), { r: [Math.PI / 2 - 0.4, s * 0.6, 0], p: wr }), [0.5, 0.5, 0.5]);
    for (let f = 0; f < 4; f++) bag.add('bone', bend([[wr[0], wr[1], wr[2]], [wr[0] + s * (f - 1.5) * 0.015, wr[1] - 0.04, wr[2] + 0.06], [wr[0] + s * (f - 1.5) * 0.02, wr[1] - 0.09, wr[2] + 0.09]], 0.006, { radial: 4, seg: 4 }), [0.78, 0.74, 0.62]);
  }
  // legs in faded jeans, boots, a bare shin where the cloth rotted
  for (const s of [-1, 1]) {
    // left leg drawn up at the knee, right leg stretched out with the shin bone bare below a torn cuff
    const hip = [s * 0.11, 0.1, -0.08], knee = s < 0 ? [-0.2, 0.36, 0.3] : [0.2, 0.13, 0.42], ank = s < 0 ? [-0.18, 0.08, 0.62] : [0.3, 0.07, 0.86];
    if (s < 0) bag.add('denim', bend([hip, [-0.16, 0.22, 0.1], knee, [-0.19, 0.24, 0.47], ank], t => lerp(0.085, 0.06, t), { radial: 10, seg: 16 }), (x, y) => { const k = lerp(0.65, 1, sstep(0, 0.3, y)); return [k, k, k]; });
    else { const cuff = [lerp(knee[0], ank[0], 0.35), 0.1, lerp(knee[2], ank[2], 0.35)]; bag.add('denim', bend([hip, [0.16, 0.11, 0.18], knee, cuff], t => lerp(0.085, 0.066, t), { radial: 10, seg: 14 }), [0.8, 0.8, 0.8]); bag.add('bone', rod(cuff, ank, 0.018, { r1: 0.022 }), [0.78, 0.74, 0.64]); bag.add('bone', rod([cuff[0] + 0.035, cuff[1], cuff[2]], [ank[0] + 0.03, ank[1] + 0.005, ank[2]], 0.009), [0.74, 0.7, 0.6]); }
    const boot = roundBox(0.11, 0.13, 0.27, 0.04, 2, 2, 3); deform(boot, v => { if (v.z > 0.05) v.y -= (v.z - 0.05) * 0.4 * (v.y > 0 ? 1 : 0); }); xf(boot, { p: [ank[0], 0.065, ank[2] + 0.08], r: [0.15, s * 0.3, s * 0.5] }); bag.add('leather', planarUV(boot, 3), [0.8, 0.8, 0.8]);
  }
  // a rusted compass and an old canteen beside him
  bag.add('olive', xf(lathe([[0.001, 0], [0.09, 0.0], [0.1, 0.06], [0.09, 0.12], [0.03, 0.14], [0.02, 0.17]], 14), { r: [Math.PI / 2, 0.8, 0], p: [0.5, 0.09, 0.3] }));
  return bag.build(undefined, { aoMin: 0.5, aoH: 0.4 });
});

/* =========================================================== DECALS (planes facing +Z) */
function decalProp(key, w, h, painter, opts = {}) {
  return () => {
    defMat(key, () => decalMat(painter(), opts));
    const g = new THREE.Group(); const m = mesh(new THREE.PlaneGeometry(w, h), M(key), 'decal'); g.add(m); return g;
  };
}
/** pecked line: many small dots stamped along a polyline */
function peck(ctx, pts, w, R, alpha = 1) {
  ctx.globalAlpha = alpha;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], L = Math.hypot(x1 - x0, y1 - y0);
    for (let d = 0; d < L; d += 1.1) { const t = d / L; for (let k = 0; k < 2; k++) { const a = R() * TAU, rr = R() * w * 0.5; ctx.beginPath(); ctx.arc(x0 + (x1 - x0) * t + Math.cos(a) * rr, y0 + (y1 - y0) * t + Math.sin(a) * rr, w * (0.18 + R() * 0.16), 0, TAU); ctx.fill(); } }
  }
  ctx.globalAlpha = 1;
}
def('footprint', { size: [0.14, 0.3, 0.01], colliders: [], notes: 'decal plane facing +Z (toes toward +Y): a bare human footprint in mud' }, decalProp('decFoot', 0.17, 0.33, () => paintDecal(128, 256, (hg, cg) => {
  const sh = (g, col, grow = 0) => { g.fillStyle = col; g.beginPath(); g.ellipse(64, 196, 26 + grow, 38 + grow, 0, 0, TAU); g.fill(); g.beginPath(); g.ellipse(58, 130, 22 + grow, 40 + grow, -0.15, 0, TAU); g.fill(); g.beginPath(); g.ellipse(70, 92, 34 + grow, 24 + grow, 0.15, 0, TAU); g.fill(); [[40, 60, 13], [62, 52, 10], [80, 52, 9], [95, 58, 8], [106, 68, 7]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r + grow, 0, TAU); g.fill(); }); };
  cg.filter = 'blur(3px)'; sh(cg, 'rgba(46,34,24,0.85)', 6); cg.filter = 'none'; sh(cg, 'rgba(34,25,18,0.9)');
  hg.filter = 'blur(2px)'; sh(hg, '#a0a0a0', 7); sh(hg, '#404040'); hg.filter = 'none';
}, { strength: 4, blur: 2 }), { rough: 0.6 }));
def('footprintGiant', { size: [1.3, 2.5, 0.01], colliders: [], notes: 'decal plane facing +Z (toes toward +Y): a 2.5 m clawed hoof print pressed into mud' }, decalProp('decGiant', 1.4, 2.6, () => paintDecal(256, 512, (hg, cg) => {
  const R = rng(66);
  const sh = (g, col, grow) => {
    g.fillStyle = col; g.beginPath(); g.ellipse(128, 410, 62 + grow, 70 + grow, 0, 0, TAU); g.fill();
    for (const s of [-1, 1]) { g.beginPath(); g.moveTo(128 + s * 8, 380); g.quadraticCurveTo(128 + s * (70 + grow), 300, 128 + s * (40 + grow * 0.5), 150); g.quadraticCurveTo(128 + s * 26, 120, 128 + s * 12, 160); g.quadraticCurveTo(128 + s * 6, 260, 128 + s * 8, 380); g.fill(); }
  };
  cg.filter = 'blur(6px)'; sh(cg, 'rgba(40,30,20,0.85)', 14); cg.filter = 'none'; sh(cg, 'rgba(28,21,15,0.92)', 0);
  hg.filter = 'blur(6px)'; sh(hg, '#b8b8b8', 16); sh(hg, '#383838', 0); hg.filter = 'none';
  // claw gouges reaching forward from each toe and a dew claw at the back
  for (const [x0, y0, x1, y1] of [[104, 150, 86, 30], [152, 150, 172, 28], [128, 170, 128, 60], [80, 430, 50, 500]]) {
    for (const [g, col, w] of [[cg, 'rgba(26,20,14,0.9)', 12], [hg, '#2a2a2a', 9]]) { g.strokeStyle = col; g.lineWidth = w; g.lineCap = 'round'; g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo((x0 + x1) / 2 + (R() - 0.5) * 16, (y0 + y1) / 2, x1, y1); g.stroke(); }
  }
  for (let i = 0; i < 90; i++) { cg.fillStyle = `rgba(${50 + R() * 30},${38 + R() * 20},26,${0.4 + R() * 0.4})`; const a = R() * TAU, d = 90 + R() * 70; cg.beginPath(); cg.arc(128 + Math.cos(a) * d * 0.7, 300 + Math.sin(a) * d * 1.4, 2 + R() * 6, 0, TAU); cg.fill(); }
}, { strength: 5, blur: 3 }), { rough: 0.5 }));
def('clawMarks', { size: [0.6, 1.5, 0.01], colliders: [], notes: 'decal for tree trunks, facing +Z: four deep gouges showing pale wood' }, decalProp('decClaw', 0.65, 1.55, () => paintDecal(192, 512, (hg, cg) => {
  const R = rng(13);
  for (let k = 0; k < 4; k++) {
    const x0 = 36 + k * 40 + (R() - 0.5) * 8, pts = []; for (let i = 0; i <= 20; i++) { const t = i / 20; pts.push([x0 + Math.sin(t * 2.2 + k) * 10 + t * 18, 30 + k * 10 + t * (440 - k * 25)]); }
    const wf = t => Math.sin(Math.min(1, t * 1.15) * Math.PI) * 15 + 2;
    for (let i = 1; i < pts.length; i++) {
      const t = i / pts.length, w = wf(t);
      cg.strokeStyle = 'rgba(48,30,18,0.95)'; cg.lineWidth = w + 9; cg.lineCap = 'round'; cg.beginPath(); cg.moveTo(...pts[i - 1]); cg.lineTo(...pts[i]); cg.stroke();
    }
    for (let i = 1; i < pts.length; i++) { const t = i / pts.length, w = wf(t); cg.strokeStyle = `rgba(${200 + R() * 20},${168 + R() * 15},${118 + R() * 10},1)`; cg.lineWidth = w; cg.beginPath(); cg.moveTo(...pts[i - 1]); cg.lineTo(...pts[i]); cg.stroke(); hg.strokeStyle = '#202020'; hg.lineWidth = w + 4; hg.lineCap = 'round'; hg.beginPath(); hg.moveTo(...pts[i - 1]); hg.lineTo(...pts[i]); hg.stroke(); }
    for (let i = 0; i < 40; i++) { const p = pts[Math.floor(R() * pts.length)]; cg.strokeStyle = 'rgba(150,110,70,0.8)'; cg.lineWidth = 1; cg.beginPath(); cg.moveTo(p[0] - 6, p[1]); cg.lineTo(p[0] + 6, p[1] + R() * 8); cg.stroke(); }
  }
}, { strength: 6, blur: 2 })));
def('symbolTree', { size: [0.6, 0.6, 0.01], colliders: [], notes: 'decal for tree trunks, facing +Z: an antler-and-spiral sign daubed in red ochre' }, decalProp('decSymbol', 0.7, 0.8, () => paintDecal(256, 320, (hg, cg) => {
  const R = rng(31); cg.fillStyle = 'rgb(128,36,22)'; cg.strokeStyle = 'rgb(128,36,22)'; cg.lineCap = 'round';
  const daub = (pts, w) => { cg.lineWidth = w; cg.beginPath(); cg.moveTo(...pts[0]); for (const p of pts.slice(1)) cg.lineTo(...p); cg.stroke(); };
  const sp = []; for (let i = 0; i < 70; i++) { const a = i * 0.28, r = 6 + i * 0.95; sp.push([128 + Math.cos(a) * r, 180 + Math.sin(a) * r]); } daub(sp, 9);
  daub([[128, 120], [128, 40]], 10);
  for (const s of [-1, 1]) { daub([[128, 70], [128 + s * 50, 30], [128 + s * 70, 10]], 9); daub([[128 + s * 30, 52], [128 + s * 42, 18]], 7); daub([[128 + s * 55, 25], [128 + s * 90, 34]], 6); }
  for (let i = 0; i < 9; i++) { const x = 70 + R() * 120, y = 140 + R() * 100; cg.lineWidth = 2 + R() * 3; cg.beginPath(); cg.moveTo(x, y); cg.lineTo(x + (R() - 0.5) * 3, y + 20 + R() * 60); cg.stroke(); }
  cg.globalCompositeOperation = 'destination-out'; for (let i = 0; i < 500; i++) { cg.globalAlpha = R() * 0.7; cg.beginPath(); cg.arc(R() * 256, R() * 320, 1 + R() * 4, 0, TAU); cg.fill(); }
  void hg;
}, { strength: 1, blur: 0 }), { rough: 0.95, opacity: 0.92 }));
def('drawingWall', { size: [2, 1.2, 0.01], colliders: [], notes: 'cave painting decal facing +Z: ochre hunters with spears and a giant antlered shape, charcoal and hand prints' }, decalProp('decDrawing', 2, 1.2, () => paintDecal(1024, 614, (hg, cg) => {
  const R = rng(5150), O = 'rgba(146,52,30,0.9)', K = 'rgba(24,20,18,0.85)';
  const st = (pts, w, col) => { cg.strokeStyle = col; cg.lineWidth = w; cg.lineCap = 'round'; cg.lineJoin = 'round'; cg.beginPath(); cg.moveTo(...pts[0]); for (const p of pts.slice(1)) cg.lineTo(...p); cg.stroke(); };
  const hunter = (x, y, s, dir) => { st([[x, y - 60 * s], [x - 4 * s * dir, y - 20 * s]], 6 * s, O); cg.fillStyle = O; cg.beginPath(); cg.arc(x + 2 * s * dir, y - 70 * s, 8 * s, 0, TAU); cg.fill(); st([[x - 4 * s * dir, y - 20 * s], [x - 16 * s * dir, y + 10 * s]], 5 * s, O); st([[x - 4 * s * dir, y - 20 * s], [x + 12 * s * dir, y + 8 * s]], 5 * s, O); st([[x, y - 52 * s], [x + 18 * s * dir, y - 44 * s], [x + 30 * s * dir, y - 60 * s]], 4 * s, O); st([[x - 30 * s * dir, y - 30 * s], [x + 62 * s * dir, y - 76 * s]], 2.5 * s, K); };
  [[150, 470, 1.1], [240, 455, 1], [320, 480, 1.05], [400, 460, 0.95], [110, 380, 0.8]].forEach(([x, y, s]) => hunter(x, y, s, 1));
  // the giant antlered shape, towering, long-armed
  const gx = 720, gy = 560;
  st([[gx, gy - 380], [gx - 6, gy - 150]], 26, O); st([[gx - 6, gy - 150], [gx - 50, gy]], 14, O); st([[gx - 6, gy - 150], [gx + 34, gy]], 14, O);
  st([[gx - 2, gy - 350], [gx - 70, gy - 240], [gx - 92, gy - 90], [gx - 120, gy - 50]], 9, O); st([[gx + 2, gy - 350], [gx + 70, gy - 250], [gx + 95, gy - 100], [gx + 128, gy - 60]], 9, O);
  cg.fillStyle = O; cg.beginPath(); cg.ellipse(gx, gy - 400, 18, 28, 0, 0, TAU); cg.fill();
  const ant = (x, y, a, l, d) => { if (d > 4 || l < 8) return; const x1 = x + Math.cos(a) * l, y1 = y + Math.sin(a) * l; st([[x, y], [x1, y1]], Math.max(2, 7 - d * 1.4), K); ant(x1, y1, a - 0.45, l * 0.72, d + 1); ant(x1, y1, a + 0.4, l * 0.65, d + 1); };
  ant(gx - 10, gy - 420, -Math.PI / 2 - 0.6, 60, 0); ant(gx + 10, gy - 420, -Math.PI / 2 + 0.6, 60, 0);
  for (const [x, y] of [[gx - 6, gy - 404], [gx + 8, gy - 404]]) { cg.fillStyle = 'rgba(230,220,200,0.8)'; cg.beginPath(); cg.arc(x, y, 3, 0, TAU); cg.fill(); }
  // deer fleeing, hand prints, dot rows
  for (const [x, y] of [[520, 420], [560, 380]]) { st([[x, y], [x + 50, y - 4]], 12, K); st([[x + 50, y - 4], [x + 64, y - 34]], 6, K); for (const dx of [4, 12, 40, 48]) st([[x + dx, y + 2], [x + dx - 8, y + 34]], 3, K); }
  for (const [x, y, a] of [[60, 120, 0.2], [120, 90, -0.3], [930, 140, 0.1], [880, 90, 0.4]]) { cg.save(); cg.translate(x, y); cg.rotate(a); cg.fillStyle = 'rgba(150,56,32,0.75)'; cg.beginPath(); cg.ellipse(0, 10, 20, 24, 0, 0, TAU); cg.fill(); for (let f = 0; f < 5; f++) { const fa = -2.4 + f * 0.42; cg.beginPath(); cg.ellipse(Math.cos(fa) * 30, 10 + Math.sin(fa) * 32, 5, 12, fa + Math.PI / 2, 0, TAU); cg.fill(); } cg.restore(); }
  cg.fillStyle = K; for (let i = 0; i < 24; i++) { cg.beginPath(); cg.arc(160 + i * 18, 560 + Math.sin(i) * 6, 4, 0, TAU); cg.fill(); }
  // weathering: flake pigment away, mineral bloom
  cg.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 4000; i++) { cg.globalAlpha = R() * 0.8; cg.beginPath(); cg.arc(R() * 1024, R() * 614, 1 + R() * 5, 0, TAU); cg.fill(); }
  for (let i = 0; i < 30; i++) { cg.globalAlpha = 0.5; cg.beginPath(); cg.ellipse(R() * 1024, R() * 614, 20 + R() * 60, 8 + R() * 20, R() * 3, 0, TAU); cg.fill(); }
  void hg;
}, { strength: 1, blur: 0 }), { rough: 0.95 }));

/* =========================================================== STANDING STONES + PETROGLYPHS */
/** a weathered standing stone (w x h x d), base sunk 0.25 m. flatFront keeps a dressed face toward +Z */
function standingStoneGeo(seed, w, h, d, { flatFront = false, sink = 0.25, rough = 1 } = {}) {
  const R = rng(seed), so = R() * 100;
  let g = roundBox(w, h, d, Math.min(w, d) * 0.3, 8, 16, 5); g = weld(g);
  const p = g.attributes.position, v = new THREE.Vector3();
  const topCut = 0.08 + R() * 0.12, topTilt = (R() - 0.5) * 0.3;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i); const ty = v.y / h + 0.5;
    v.x *= lerp(1.04, flatFront ? 0.86 : 0.7, ty); if (v.z < 0 || !flatFront) v.z *= lerp(1.06, 0.72, ty);
    if (ty > 0.7) v.y -= (ty - 0.7) / 0.3 * h * (topCut * (0.5 + 0.5 * N1.n2(v.x * 2 + so, v.z * 2)) + topTilt * v.x / w);
    const front = flatFront && v.z > d * 0.3 && Math.abs(v.x) < w * 0.4 && ty > 0.1 && ty < 0.9;
    const n = N2.fbm3(v.x * 1.3 + so, v.y * 1.3, v.z * 1.3, 4), n2 = N1.n3(v.x * 5 + so, v.y * 5, v.z * 5);
    const a = (front ? 0.008 : 0.07 * rough) * Math.min(w, d) * 2;
    v.x += Math.sign(v.x) * (n * a * 1.4 + n2 * a * 0.3); v.z += (front ? 0 : Math.sign(v.z)) * (n * a + n2 * a * 0.3); v.y += n2 * a * 0.2;
    p.setXYZ(i, v.x, v.y + h / 2 - sink, v.z);
  }
  g.computeVertexNormals();
  g = planarUV(g, 0.5, 0.5, -1, [R() * 5, R() * 5]);
  mossColors(g, { moss: 0.75, up: 0.35, seed, fn: (x, y, z, ny, m, ao) => [ao * lerp(0.75, 1, sstep(-0.2, 0.6, y)), clamp(m + sstep(0.4, -0.1, y) * 0.6 * sstep(0, 0.6, N3.fbm2(x * 2 + seed, z * 2, 3)), 0, 1) * (flatFront && z > d * 0.3 ? 0.25 : 1), 0.1] });
  return g;
}
/** pecked carvings: draw(ctx-like api) onto a mask; returns {map, normalMap} alpha decal */
function carveTex(W, H, seed, draw, { ochreAmt = 1 } = {}) {
  const mk = makeCanvas(W, H), oc = makeCanvas(W, H), mg = mk.getContext('2d'), og = oc.getContext('2d'), R = rng(seed);
  mg.fillStyle = '#fff'; og.strokeStyle = '#fff'; og.fillStyle = '#fff'; og.lineCap = og.lineJoin = 'round';
  const api = {
    R,
    line(pts, w = 9, ochre = false) { w *= 2.1; peck(mg, pts, w, R); if (ochre) { og.lineWidth = w * 0.85; og.beginPath(); og.moveTo(...pts[0]); for (const q of pts.slice(1)) og.lineTo(...q); og.stroke(); } },
    blob(x, y, rx, ry = rx, ochre = false) { for (let i = 0; i < rx * ry * 0.9; i++) { const a = R() * TAU, r = Math.sqrt(R()); mg.beginPath(); mg.arc(x + Math.cos(a) * r * rx, y + Math.sin(a) * r * ry, 1.4 + R() * 1.6, 0, TAU); mg.fill(); } if (ochre) { og.beginPath(); og.ellipse(x, y, rx * 1.15, ry * 1.15, 0, 0, TAU); og.fill(); } },
    ring(x, y, rx, ry = rx, w = 7, ochre = false, a0 = 0, a1 = TAU) { const pts = []; for (let k = 0; k <= 28; k++) { const a = lerp(a0, a1, k / 28); pts.push([x + Math.cos(a) * rx, y + Math.sin(a) * ry]); } api.line(pts, w, ochre); },
  };
  draw(api);
  const blurC = makeCanvas(W, H), bg = blurC.getContext('2d'); bg.filter = 'blur(2.5px)'; bg.drawImage(mk, 0, 0);
  const ob = makeCanvas(W, H), obg = ob.getContext('2d'); obg.filter = 'blur(3px)'; obg.drawImage(oc, 0, 0);
  const m0 = readHeight(mk), mb = readHeight(blurC), oo = readHeight(ob);
  const s = pix(W, H, (x, y, o) => {
    const i = y * W + x, u = x / W, v = y / H;
    const wea = clamp(0.75 + N1.fbm2(u * 4 + seed, v * 4, 4) * 0.9, 0.4, 1), grain = N3.n2(x * 0.8, y * 0.8) * 0.5 + 0.5;
    const m = Math.max(m0[i], mb[i] * 0.8) * wea, oc2 = oo[i] * clamp(0.3 + N2.fbm2(u * 7 + seed, v * 7, 3) * 1.6, 0, 1) * ochreAmt * 0.8;
    // dark weathered patina on the dressed face, so fresh pecking reads light against it
    const edge = Math.min(u, 1 - u, v, 1 - v) + N1.fbm2(u * 7 + seed, v * 7, 3) * 0.06;
    const pat = sstep(0.0, 0.14, edge) * clamp(0.5 + N2.fbm2(u * 3 + seed, v * 3, 3) * 0.6, 0.2, 0.85);
    const lich = clamp((N3.fbm2(u * 14 + seed, v * 14, 3) - 0.35) * 4, 0, 1);
    let r = lerp(72, 150, lich), gg = lerp(66, 152, lich), b = lerp(56, 124, lich);
    const pk = 1 + grain * 0.18; r = lerp(r, 206 * pk, clamp(m * 1.3, 0, 1)); gg = lerp(gg, 198 * pk, clamp(m * 1.3, 0, 1)); b = lerp(b, 178 * pk, clamp(m * 1.3, 0, 1));
    r = lerp(r, 140, oc2); gg = lerp(gg, 56, oc2); b = lerp(b, 34, oc2);
    o[0] = r; o[1] = gg; o[2] = b;
    o[3] = clamp(Math.max(pat, m * 0.98 + oc2 * 0.85), 0, 1) * 255;
    return 0.65 - mb[i] * 0.55;
  }, { strength: 6, wrap: false });
  return s;
}
/** petroglyph vocabulary, all in canvas pixels; y grows down, figures stand on y */
function glyphKit(g) {
  const L = (pts, w, o) => g.line(pts, w, o);
  const tf = (x, y, s, rot) => (px, py) => [x + (px * Math.cos(rot) - py * Math.sin(rot)) * s, y + (px * Math.sin(rot) + py * Math.cos(rot)) * s];
  const K = {
    person(x, y, s, pose = 'stand', { ochre = false, dir = 1, rot = 0 } = {}) {
      const T = tf(x, y, s, rot), P = (pts) => L(pts.map(([a, b]) => T(a * dir, b)), Math.max(5, s * 0.075), ochre);
      const head = T(0.02 * dir, -0.93); g.blob(head[0], head[1], s * 0.075, s * 0.085, ochre);
      const lean = pose === 'run' ? 0.12 : 0;
      P([[lean, -0.82], [0, -0.44]]);
      if (pose === 'dance') { P([[lean, -0.76], [0.2, -0.82], [0.24, -1.02]]); P([[lean, -0.76], [-0.2, -0.82], [-0.26, -1.0]]); P([[0, -0.44], [0.16, -0.24], [0.14, 0]]); P([[0, -0.44], [-0.12, -0.3], [-0.24, -0.2]]); }
      else if (pose === 'run') { P([[lean, -0.74], [0.3, -0.62], [0.42, -0.72]]); P([[lean, -0.74], [-0.16, -0.58], [-0.3, -0.5]]); P([[0, -0.44], [0.24, -0.26], [0.36, -0.04]]); P([[0, -0.44], [-0.14, -0.22], [-0.34, -0.18]]); }
      else if (pose === 'carry') { P([[0, -0.76], [0.12, -0.92], [0.06, -1.1]]); P([[0, -0.76], [-0.12, -0.92], [-0.06, -1.1]]); P([[0, -0.44], [0.12, -0.22], [0.14, 0]]); P([[0, -0.44], [-0.1, -0.22], [-0.12, 0]]); }
      else if (pose === 'reach') { P([[0, -0.76], [0.3, -0.72], [0.48, -0.78]]); P([[0, -0.76], [0.22, -0.62], [0.4, -0.6]]); P([[0, -0.44], [0.14, -0.22], [0.2, 0]]); P([[0, -0.44], [-0.08, -0.22], [-0.12, 0]]); }
      else { P([[0, -0.76], [0.2, -0.56], [0.24, -0.4]]); P([[0, -0.76], [-0.2, -0.56], [-0.24, -0.4]]); P([[0, -0.44], [0.12, -0.22], [0.14, 0]]); P([[0, -0.44], [-0.12, -0.22], [-0.14, 0]]); }
      return T;
    },
    antlered(x, y, s, { ochre = true, arms = 'down', w = 1 } = {}) {
      const P = (pts, ww = 0.05) => L(pts.map(([a, b]) => [x + a * s, y + b * s]), Math.max(7, s * ww * w), ochre);
      P([[0, -0.82], [0.01, -0.46]], 0.07);
      P([[0.01, -0.46], [-0.08, -0.22], [-0.06, 0]]); P([[0.01, -0.46], [0.09, -0.24], [0.1, 0]]);
      if (arms === 'down') { P([[0, -0.78], [-0.16, -0.66], [-0.22, -0.4], [-0.25, -0.24]], 0.035); P([[0, -0.78], [0.16, -0.66], [0.23, -0.4], [0.26, -0.22]], 0.035); for (const sx of [-1, 1]) for (const f of [-0.03, 0, 0.03]) P([[sx * 0.25, -0.24], [sx * (0.26 + f), -0.15]], 0.02); }
      else { P([[0, -0.78], [-0.2, -0.86], [-0.34, -0.98]], 0.035); P([[0, -0.78], [0.2, -0.86], [0.34, -0.98]], 0.035); }
      g.blob(x, y - s * 0.88, s * 0.035, s * 0.055, ochre);
      const ant = (px, py, a, l, d) => { if (d > 3) return; const ex = px + Math.cos(a) * l, ey = py + Math.sin(a) * l; L([[px, py], [ex, ey]], Math.max(4, s * 0.03 - d * 1.2), ochre); ant(ex, ey, a - 0.42, l * 0.7, d + 1); ant(ex, ey, a + 0.38, l * 0.62, d + 1); };
      ant(x - s * 0.02, y - s * 0.92, -Math.PI / 2 - 0.55, s * 0.1, 0); ant(x + s * 0.02, y - s * 0.92, -Math.PI / 2 + 0.55, s * 0.1, 0);
    },
    fire(x, y, s) { L([[x - s * 0.5, y], [x - s * 0.25, y - s * 0.6], [x - s * 0.05, y - s * 0.3], [x + s * 0.05, y - s], [x + s * 0.2, y - s * 0.35], [x + s * 0.35, y - s * 0.65], [x + s * 0.5, y]], 8, true); L([[x - s * 0.6, y + 4], [x + s * 0.6, y + 4]], 7); },
    tree(x, y, s) { L([[x, y], [x, y - s]], 6); for (let k = 1; k < 5; k++) { const yy = y - s * (0.25 + k * 0.17), w = s * 0.32 * (1 - k * 0.18); L([[x - w, yy + w * 0.6], [x, yy], [x + w, yy + w * 0.6]], 5); } },
    hut(x, y, s, broken = false) { if (!broken) { g.ring(x, y, s * 0.5, s * 0.5, 7, false, Math.PI, TAU); L([[x - s * 0.55, y], [x + s * 0.55, y]], 6); g.ring(x, y, s * 0.14, s * 0.22, 5, false, Math.PI, TAU); } else { g.ring(x - s * 0.1, y, s * 0.5, s * 0.5, 7, false, Math.PI, Math.PI * 1.35); g.ring(x + s * 0.15, y + s * 0.05, s * 0.45, s * 0.42, 7, false, Math.PI * 1.65, TAU); L([[x - s * 0.1, y - s * 0.3], [x + s * 0.2, y - s * 0.05]], 6); L([[x - s * 0.6, y], [x + s * 0.6, y]], 6); } },
    deer(x, y, s, dir = 1) { const P = (pts, w = 6) => L(pts.map(([a, b]) => [x + a * s * dir, y + b * s]), w); P([[-0.4, -0.5], [0.3, -0.52]], 9); P([[0.3, -0.52], [0.45, -0.8]]); g.blob(x + 0.48 * s * dir, y - 0.82 * s, 6, 5); P([[0.45, -0.85], [0.38, -1.05], [0.3, -1.12]], 4); P([[0.45, -0.85], [0.56, -1.04]], 4); for (const a of [-0.35, -0.25, 0.2, 0.3]) P([[a, -0.5], [a + 0.04, 0]], 5); },
    sun(x, y, r) { g.ring(x, y, r, r, 8, true, Math.PI, TAU); for (let k = 0; k <= 8; k++) { const a = Math.PI + k / 8 * Math.PI; L([[x + Math.cos(a) * r * 1.25, y + Math.sin(a) * r * 1.25], [x + Math.cos(a) * r * 1.65, y + Math.sin(a) * r * 1.65]], 6, true); } L([[x - r * 2, y + 4], [x + r * 2, y + 4]], 6); },
    bird(x, y, s) { L([[x - s, y - s * 0.2], [x - s * 0.5, y - s * 0.45], [x, y]], 6); L([[x, y], [x + s * 0.5, y - s * 0.45], [x + s, y - s * 0.2]], 6); g.blob(x, y + 2, 5, 4); },
    stones(x, y, rx, ry, n = 9) { for (let k = 0; k < n; k++) { const a = k / n * TAU; g.blob(x + Math.cos(a) * rx, y + Math.sin(a) * ry, 9, 12); } },
    spiral(x, y, r, turns = 3, w = 7, ochre = false) { const pts = []; for (let k = 0; k <= turns * 40; k++) { const a = k / 40 * TAU, rr = r * k / (turns * 40); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]); } L(pts, w, ochre); },
    L,
  };
  return K;
}
const STORY = [
  // 0: dance in a circle around a fire; the tall antlered one stands at the centre among them
  (g, K, W, H) => { K.antlered(W / 2, H * 0.62, H * 0.52); K.fire(W / 2, H * 0.74, 46); for (let i = 0; i < 8; i++) { const a = i / 8 * TAU + 0.2, x = W / 2 + Math.cos(a) * W * 0.36, y = H * 0.66 + Math.sin(a) * H * 0.2; K.person(x, y, 70 + Math.sin(a) * 14, 'dance', { dir: i % 2 ? 1 : -1 }); } K.spiral(W * 0.15, H * 0.12, 32); },
  // 1: offerings carried to the antlered figure: a deer held high, a bound one carried, baskets
  (g, K, W, H) => { K.antlered(W * 0.78, H * 0.9, H * 0.66); const T = K.person(W * 0.14, H * 0.9, 120, 'carry'); K.deer(W * 0.14 - 30, H * 0.9 - 132, 60); K.person(W * 0.36, H * 0.9, 116, 'reach'); K.person(W * 0.32, H * 0.72, 46, 'stand', { rot: Math.PI / 2 }); K.L([[W * 0.28, H * 0.75], [W * 0.38, H * 0.69]], 5); K.L([[W * 0.3, H * 0.69], [W * 0.36, H * 0.76]], 5); K.person(W * 0.55, H * 0.9, 110, 'reach', { ochre: false }); g.ring(W * 0.6, H * 0.74, 16, 12, 6, true); void T; },
  // 2: the people flee; the antlered one is now huge, towering over the trees
  (g, K, W, H) => { K.antlered(W * 0.66, H * 0.97, H * 0.94, { w: 1.4 }); for (const [x, s] of [[0.1, 90], [0.24, 80], [0.36, 96], [0.18, 60]]) K.person(W * x, H * (0.9 - (s === 60 ? 0.22 : 0)), s, 'run', { dir: -1 }); for (const x of [0.46, 0.86, 0.95]) K.tree(W * x, H * 0.95, 90); },
  // 3: it stands over a broken settlement; figures lie still around the ruined huts
  (g, K, W, H) => { K.antlered(W * 0.5, H * 0.68, H * 0.6, { arms: 'up' }); K.hut(W * 0.18, H * 0.85, 120, true); K.hut(W * 0.8, H * 0.88, 110, true); K.hut(W * 0.5, H * 0.94, 90, true); for (const [x, y, r] of [[0.3, 0.76, 0.3], [0.7, 0.74, -0.2], [0.15, 0.97, 0.1], [0.86, 0.98, -0.1]]) K.person(W * x, H * y, 62, 'stand', { rot: Math.PI / 2 + r }); },
  // 4: three bearers - fire, horn, spear - walk toward a ring of stones with the antlered one inside
  (g, K, W, H) => { K.stones(W * 0.66, H * 0.5, W * 0.27, H * 0.14, 11); K.antlered(W * 0.66, H * 0.56, H * 0.36); const y = H * 0.94; K.person(W * 0.12, y, 120, 'reach'); K.fire(W * 0.22, y - 108, 28); K.person(W * 0.36, y, 120, 'reach'); K.L([[W * 0.42, y - 92], [W * 0.5, y - 108], [W * 0.54, y - 132]], 12, true); K.person(W * 0.6, y, 120, 'reach'); K.L([[W * 0.56, y - 70], [W * 0.92, y - 140]], 6); K.L([[W * 0.92, y - 140], [W * 0.88, y - 124], [W * 0.95, y - 128], [W * 0.92, y - 140]], 8); },
  // 5: it lies broken and burning; the sun rises; a bird flies away
  (g, K, W, H) => { K.sun(W * 0.72, H * 0.26, 58); K.bird(W * 0.28, H * 0.14, 36); const y = H * 0.8; K.L([[W * 0.12, y], [W * 0.38, y - 18]], 14, true); K.L([[W * 0.46, y + 10], [W * 0.68, y - 6]], 12, true); K.L([[W * 0.74, y + 24], [W * 0.92, y + 4]], 10, true); g.blob(W * 0.08, y - 6, 12, 18, true); const ant = (x0, y0, a, l, d) => { if (d > 3) return; const x1 = x0 + Math.cos(a) * l, y1 = y0 + Math.sin(a) * l; K.L([[x0, y0], [x1, y1]], 6, true); ant(x1, y1, a - 0.45, l * 0.7, d + 1); ant(x1, y1, a + 0.4, l * 0.62, d + 1); }; ant(W * 0.07, y - 20, -2.0, 40, 0); for (const x of [0.25, 0.57, 0.83]) K.fire(W * x, y - 20, 40); },
];
function petroglyph(story) {
  const W = 512, H = 736;
  return carveTex(W, H, 300 + story, (g) => { STORY[story % 6](g, glyphKit(g), W, H); }, { ochreAmt: 1 });
}
def('carvedStone', { size: [1.2, 1.9, 0.6], colliders: [{ x: 0, z: 0, w: 1.15, d: 0.6, h: 1.8 }], notes: "standing stone with a petroglyph on its +Z face; opts.story 0..5; face mesh named 'face'" }, (opts) => {
  const story = clamp(Math.round(opts.story ?? 0), 0, 5), bag = new Bag(), w = 1.08 + (story % 3) * 0.08, h = 1.95 + ((story * 7) % 4) * 0.07, d = 0.5 + (story % 2) * 0.1;
  bag.add('stone', standingStoneGeo(70 + story * 13, w, h, d, { flatFront: true, rough: 1.7 }));
  addRock(bag, 90 + story, [0.4, 0.2, 0.3], [0.55, 0, 0.4], { detail: 2, moss: 0.5 }); addRock(bag, 95 + story, [0.3, 0.15, 0.25], [-0.5, 0, 0.45], { detail: 2, moss: 0.5 });
  const g = bag.build(undefined, { aoMin: 0.6, aoH: 0.5 });
  defMat('glyph' + story, () => decalMat(petroglyph(story), { rough: 0.95, normalScale: 1.2 }));
  const face = mesh(new THREE.PlaneGeometry(w * 0.74, (w * 0.74) * 736 / 512), M('glyph' + story), 'face');
  face.position.set(0, h * 0.5 - 0.25 + 0.02, d / 2 + 0.025); g.add(face);
  return g;
});
defMat('carveSpiral', () => decalMat(carveTex(256, 384, 77, (g) => { const K = glyphKit(g); K.spiral(128, 150, 92, 3.2, 9); g.ring(128, 300, 40, 40, 7); g.ring(128, 300, 18, 18, 6); g.blob(128, 300, 6, 6); for (let k = 0; k < 6; k++) g.blob(40 + k * 35, 368, 7, 7); K.L([[30, 30], [226, 30]], 6); }, { ochreAmt: 0 }), { rough: 0.95, normalScale: 1.3 }));
def('altarStone', { size: [1.5, 0.85, 1.0], colliders: [{ x: 0, z: 0, w: 1.5, d: 1.0, h: 0.85 }], notes: "low flat stone table; 'relic' marker on the top" }, () => {
  const bag = new Bag();
  for (const s of [-1, 1]) addRock(bag, 120 + s, [0.5, 0.75, 0.75], [s * 0.45, 0, 0], { detail: 6, moss: 0.6, facets: 6, amp: 0.12, sink: 0.05 });
  const slab = rockGeo(130, { size: [1.55, 0.26, 1.0], detail: 8, amp: 0.1, facets: 3, flat: 0.5, sink: 0 }); xf(slab, { p: [0, 0.58, 0] }); mossColors(slab, { moss: 0.5, up: 0.7, seed: 4, fn: (x, y, z, ny, m, a) => [a, m * sstep(0.2, 0.5, Math.abs(x)), 0.05] }); bag.add('stone', slab);
  const g = bag.build(undefined, { aoMin: 0.55, aoH: 0.5 });
  const q = new THREE.PlaneGeometry(0.55, 0.82); xf(q, { r: [-Math.PI / 2, 0, Math.PI / 2], p: [0, 0.85, 0] }); g.add(mesh(q, M('carveSpiral')));
  g.add(marker('relic', [0, 0.86, 0])); return g;
});

/** stone brazier/pyre: a ring of stacked stones holding an unlit crib of logs; local origin at its centre */
function pyreInto(bag, seed) {
  const R = rng(seed);
  for (let layer = 0; layer < 2; layer++) for (let i = 0; i < 10; i++) { const a = (i + layer * 0.5) / 10 * TAU, r = 1.05 - layer * 0.08; addRock(bag, seed * 31 + i + layer * 50, [0.62, 0.5, 0.5], [Math.cos(a) * r, layer * 0.38, Math.sin(a) * r], { ry: -a, detail: 2, moss: 0.35, amp: 0.15, facets: 3, sink: 0.05 }); }
  const fill = new THREE.CircleGeometry(0.95, 20); xf(fill, { r: [-Math.PI / 2, 0, 0], p: [0, 0.62, 0] }); bag.add('char', planarUV(fill, 2), [0.7, 0, 0.3]);
  for (let k = 0; k < 4; k++) for (const s of [-1, 1]) { const y = 0.7 + k * 0.17, o = s * 0.42; const a = k % 2 ? [o, y, -0.8] : [-0.8, y, o], b = k % 2 ? [o, y, 0.8] : [0.8, y, o]; addLog(bag, a, b, 0.085, { seed: seed + k * 7 + s, radial: 8, seg: 2, key: 'bark', col: [1, 0.15, 0.1] }); }
  for (let k = 0; k < 7; k++) { const a = k / 7 * TAU + R() * 0.3; addStick(bag, [Math.cos(a) * 0.35, 1.25, Math.sin(a) * 0.35], [Math.cos(a) * 0.05, 1.95 + R() * 0.2, Math.sin(a) * 0.05], 0.035, 'bark', [0.9, 0, 0.1]); }
}
/** deadfall trap frame in local coords (weight hangs over the origin), returns {cols} and adds 'weight'/'trigger' to grp */
function deadfallInto(bag, grp, kind) {
  for (const x of [-2.5, 2.5]) {
    addLog(bag, [x, -0.8, 1.75], [x, 7.25, -0.28], 0.17, { key: 'log', seed: x * 3 + kind, radial: 10, seg: 6, taper: 0.8 });
    addLog(bag, [x, -0.8, -1.75], [x, 7.25, 0.28], 0.17, { key: 'log', seed: x * 5 + kind + 1, radial: 10, seg: 6, taper: 0.8 });
    bag.add('rope', lash([x, 6.45, 0], [0, 0, 1], 0.2, 4, 0.016));
    addLog(bag, [x, 1.6, -1.35], [x, 1.6, 1.35], 0.09, { key: 'log', seed: x + 9, radial: 8, seg: 2 });
  }
  addLog(bag, [-3.1, 6.62, 0], [3.1, 6.62, 0], 0.21, { key: 'log', seed: 40 + kind, radial: 12, seg: 6 });
  bag.add('rope', bend([[0.25, 6.83, 0], [0.6, 6.7, 0.1], [3.85, 0.62, 1.62]], 0.018, { radial: 5, seg: 18 }));
  // the weight: a lashed bundle of spiked logs, or a boulder in a rope net
  const wt = new THREE.Object3D(); wt.name = 'weight'; const wy = kind === 0 ? 4.35 : 4.1; wt.position.set(0, wy, 0);
  const wb = new Bag();
  if (kind === 0) {
    for (const [y, z] of [[0, -0.33], [0, 0.33], [0.5, 0]]) addLog(wb, [-1.6, y, z], [1.6, y, z], 0.33, { key: 'bark', seed: 60 + y * 9 + z * 7, radial: 12, seg: 5, taper: 0.92 });
    for (const x of [-1.1, 0, 1.1]) wb.add('rope', lash([x, 0.15, 0], [1, 0, 0], 0.68, 3, 0.02));
    for (let k = 0; k < 6; k++) { const x = -1.3 + k * 0.52, z = (k % 2 ? 0.2 : -0.2); wb.add('log', rod([x, -0.15, z], [x + 0.05, -0.95, z * 1.3], 0.07, { r1: 0.004, radial: 6 }), [1, 0, 0.1]); }
    wb.add('rope', rope([0, 0.85, 0], [0, 2.1, 0], 0, 0.03, 4));
    wt.userData.drop = wy - 1.0;
  } else {
    addRock(wb, 909, [1.9, 1.6, 1.7], [0, -0.8, 0], { detail: 8, moss: 0.4, facets: 4 });
    for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI; const pts = []; for (let j = 0; j <= 12; j++) { const t = j / 12 * TAU; pts.push([Math.cos(t) * 1.02 * Math.cos(a), Math.sin(t) * 0.86, Math.cos(t) * 0.9 * Math.sin(a)]); } wb.add('rope', bend(pts, 0.02, { radial: 4, seg: 30, cap: false })); }
    wb.add('rope', rope([0, 0.8, 0], [0, 2.35, 0], 0, 0.03, 4));
    wt.userData.drop = wy - 0.85;
  }
  wb.build(wt, { ao: false }); grp.add(wt);
  const tr = new THREE.Object3D(); tr.name = 'trigger'; tr.position.set(3.85, 0, 1.62);
  const tb = new Bag(); addStick(tb, [0, -0.3, 0], [0.03, 0.75, 0], 0.06, 'log'); const wedge = new THREE.BoxGeometry(0.28, 0.16, 0.12); deform(wedge, v => { if (v.x > 0) v.y *= 0.2; }); xf(wedge, { p: [0.12, 0.55, 0] }); tb.add('woodBrown', planarUV(wedge, 3)); tb.add('rope', lash([0.03, 0.62, 0], [0, 1, 0], 0.06, 3, 0.012));
  tb.build(tr, { ao: false }); grp.add(tr);
  return [{ x: -2.5, z: 1.5, r: 0.22, h: 6 }, { x: -2.5, z: -1.5, r: 0.22, h: 6 }, { x: 2.5, z: 1.5, r: 0.22, h: 6 }, { x: 2.5, z: -1.5, r: 0.22, h: 6 }];
}
def('stoneCircle', {
  size: [62, 8, 62], colliders: [],
  notes: "THE ANTLER CLEARING (radius ~27): 12 carved standing stones, 'pyre0'..'pyre2' (each with a 'fire' child, logs unlit), central altar with 'relic', 'deadfall0'/'deadfall1' (children 'weight' (userData.drop = fall distance) and 'trigger'), a leaning monolith. Colliders per stone/pyre/frame.",
}, () => {
  const root = new THREE.Group(), bag = new Bag(), deco = new Bag(), R = rng(1212), cols = [];
  const RING = 26;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU + (R() - 0.5) * 0.08, r = RING + (R() - 0.5) * 1.2, x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = 3 + R() * 3, w = 1.1 + R() * 0.8 + h * 0.08, d = 0.7 + R() * 0.4, ry = Math.atan2(-x, -z);
    const g = standingStoneGeo(500 + i * 17, w, h, d, { flatFront: true }); xf(g, { r: [(R() - 0.5) * 0.08, ry, (R() - 0.5) * 0.1], p: [x, 0, z] }); bag.add('stone', g);
    const q = new THREE.PlaneGeometry(w * 0.55, w * 0.55 * 1.5); xf(q, { p: [0, h * 0.48, d / 2 + 0.03] }); xf(q, { r: [0, ry, 0], p: [x, 0, z] }); deco.add('carveSpiral', q, [1, 1, 1]);
    for (let k = 0; k < 2; k++) addRock(bag, 600 + i * 3 + k, [0.4 + R() * 0.3, 0.25, 0.4], [x + (R() - 0.5) * 2, 0, z + (R() - 0.5) * 2], { detail: 2, moss: 0.6 });
    cols.push({ x, z, w: w * 0.9, d: d * 0.9, h, rot: ry });
  }
  // pyres at 120 degrees
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + i / 3 * TAU, x = Math.cos(a) * 12, z = Math.sin(a) * 12;
    const pb = new Bag(); pyreInto(pb, 700 + i * 9); bagInto(bag, pb, [x, 0, z], [0, -a, 0]);
    const py = marker('pyre' + i, [x, 0, z]); py.add(marker('fire', [0, 1.5, 0])); py.add(marker('light', [0, 1.9, 0], 0, { color: 0xff7a2a, intensity: 4 })); root.add(py);
    cols.push({ x, z, r: 1.35, h: 1.2 });
  }
  // the central altar: a slab on two stones, flanked by antlers
  for (const s of [-1, 1]) addRock(bag, 800 + s, [0.8, 0.8, 1.1], [s * 0.85, 0, 0], { detail: 6, moss: 0.5, facets: 5, amp: 0.12, sink: 0.05 });
  const slab = rockGeo(810, { size: [2.6, 0.32, 1.35], detail: 9, amp: 0.08, facets: 2, flat: 0.5, sink: 0 }); xf(slab, { p: [0, 0.62, 0] }); mossColors(slab, { moss: 0.35, up: 0.8, seed: 8 }); bag.add('stone', slab);
  const aq = new THREE.PlaneGeometry(0.9, 1.6); xf(aq, { r: [-Math.PI / 2, 0, Math.PI / 2], p: [0, 0.95, 0] }); deco.add('carveSpiral', aq, [1, 1, 1]);
  for (const s of [-1, 1]) { const an = antler(820 + s, 1.2, s); xf(an, { r: [0.3, 0, -s * 0.5], p: [s * 1.15, 0.93, -0.3] }); bag.add('bone', an, [0.75, 0.7, 0.6]); }
  root.add(marker('relic', [0, 0.95, 0]));
  cols.push({ x: 0, z: 0, w: 2.6, d: 1.4, h: 0.95 });
  // deadfall traps
  [[Math.PI / 6, 0], [Math.PI * 5 / 6, 1]].forEach(([a, k]) => {
    const x = Math.cos(a) * 16, z = Math.sin(a) * 16, ry = Math.atan2(-x, -z) + Math.PI / 2;
    const grp = new THREE.Group(); grp.name = 'deadfall' + k; grp.position.set(x, 0, z); grp.rotation.y = ry;
    const fb = new Bag(); const c = deadfallInto(fb, grp, k); bagInto(bag, fb, [x, 0, z], [0, ry, 0]);
    cols.push(...placeCols(c, [x, 0, z], ry)); root.add(grp);
  });
  // the great leaning monolith
  const mono = standingStoneGeo(990, 2.2, 8.0, 1.4, { flatFront: true }); xf(mono, { r: [0.12, 0.6, 0.26], p: [-6, 0, -19] }); bag.add('stone', mono);
  const mq = new THREE.PlaneGeometry(1.2, 1.8); xf(mq, { p: [0, 4.4, 0.73] }); xf(mq, { r: [0.12, 0.6, 0.26], p: [-6, 0, -19] }); deco.add('carveSpiral', mq, [1, 1, 1]);
  cols.push({ x: -6.6, z: -18.8, w: 2.6, d: 1.6, h: 7, rot: 0.6 });
  for (let i = 0; i < 16; i++) { const a = R() * TAU, r = 4 + R() * 20; addRock(bag, 1300 + i, [0.3 + R() * 0.5, 0.2 + R() * 0.2, 0.3 + R() * 0.4], [Math.cos(a) * r, 0, Math.sin(a) * r], { detail: 2, moss: 0.7 }); }
  bag.build(root, { aoMin: 0.55, aoH: 1.0 }); deco.build(root, { ao: false });
  root.userData.colliders = cols; PROP_INFO.stoneCircle.colliders = cols;
  return root;
});

/* =========================================================== CAVE MOUTH */
def('caveMouth', {
  size: [15, 8.5, 9],
  colliders: [{ x: -5.3, z: -1.0, w: 6.5, d: 2.5, h: 9 }, { x: 5.3, z: -1.0, w: 6.5, d: 2.5, h: 9 }, { x: -3.6, z: 1.3, r: 1.2, h: 1.8 }, { x: 3.5, z: 1.4, r: 0.9, h: 1.3 }],
  notes: "rock face with a 4 x 3 m opening facing +Z; the tunnel fades to black; 'entrance' marker at the threshold",
}, () => {
  const root = new THREE.Group(), bag = new Bag();
  // the cliff: a displaced, strata-banded rock face that wraps back at the top and sides, with an arched hole
  const CW = 17, CH = 10.6, NX = 84, NY = 54, cols = NX + 1, CP = [], CI = [];
  const isOpen = (x, y) => (y < 2.1 && Math.abs(x) < 2.05) || (x * x / (2.05 * 2.05) + ((y - 2.1) / 1.25) ** 2 < 1);
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const xc = (i / NX - 0.5) * CW, crest = 7.6 + N2.fbm2(xc * 0.16 + 7, 1.3, 3) * 3.2 - Math.max(0, Math.abs(xc) - 4) * 0.45;
    const x = xc, y = j / NY * (crest + 2.6) - 1.2;
    const strata = N1.ridge2(x * 0.18 + 3, y * 0.9, 4), big = N2.fbm2(x * 0.11, y * 0.13, 3), fine = N3.fbm2(x * 0.8, y * 0.8, 3);
    let z = big * 1.5 + strata * 0.7 + fine * 0.22 + Math.floor(y * 0.9 + big) * 0.12;
    const e = Math.hypot(x / 2.35, Math.max(0, y - 2.1) / 1.55);
    z += Math.exp(-(((e - 1.2) / 0.4) ** 2)) * 0.75 * (y < 5 ? 1 : 0.5) + sstep(2.6, 4.2, y) * sstep(6, 4.5, y) * 0.35;
    const top = Math.max(0, y - crest), side = Math.max(0, Math.abs(x) - 6.6);
    z -= top * top * 1.3 + top * 0.8 + side * side * 0.9;
    CP.push(x + N1.n2(y * 0.5, x) * side * 0.3, y - top * top * 0.35 + N3.fbm2(x * 0.5, z * 0.5, 2) * top * 0.5, z);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = j * cols + i, b = a + cols, cx = ((i + 0.5) / NX - 0.5) * CW, cy = (CP[(a) * 3 + 1] + CP[(b + 1) * 3 + 1]) / 2, n = N1.n2(cx * 1.7, cy * 1.7) * 0.22;
    if (isOpen(cx + n, cy + n)) continue;
    CI.push(a, a + 1, b, a + 1, b + 1, b);
  }
  let cliff = new THREE.BufferGeometry(); cliff.setAttribute('position', new THREE.Float32BufferAttribute(CP, 3)); cliff.setIndex(CI); cliff.computeVertexNormals();
  cliff = planarUV(cliff, 0.32, 0.32, -1, [0.3, 0.7]);
  mossColors(cliff, { moss: 0.7, up: 0.55, seed: 21, fn: (x, y, z, ny, m, a) => [a * lerp(0.6, 1, sstep(-1, 1.5, y)) * (isOpen(x * 0.92, y) ? 0.5 : 1), clamp(m * sstep(-0.3, 0.4, N2.fbm2(x * 0.4, y * 0.4 + z, 3)) + sstep(0.4, 0.8, ny) * 0.15, 0, 1), 0.2 * sstep(3, 0, y)] });
  bag.add('stone', cliff);
  // fallen blocks and talus at the foot, framing the way in
  const block = (seed, size, p, ry) => addRock(bag, seed, size, p, { ry, detail: 9, moss: 0.8, facets: 7, amp: 0.2 });
  block(15, [2.8, 2.0, 2.4], [-3.6, 0, 1.3], 0.6); block(16, [2.0, 1.4, 1.8], [3.5, 0, 1.4], -0.4); block(17, [1.4, 0.9, 1.2], [-5.6, 0, 2.2], 1.1);
  for (let i = 0; i < 12; i++) { const R = rng(i + 70); const s = 0.25 + R() * 0.5; addRock(bag, 1400 + i, [s * 1.3, s, s * 1.1], [(R() - 0.5) * 11, 0, 0.9 + R() * 2.8], { detail: 3, moss: 0.6, ry: R() * 3 }); }
  // the tunnel: an arched, jagged throat receding into black
  const K = 22, M = 26, P = [], z0 = 0.35, z1 = -11;
  const ring = (k) => { const t = k / K, z = lerp(z0, z1, t), w = lerp(2.2, 1.5, t), hh = lerp(3.4, 2.2, t), pts = []; for (let j = 0; j < M; j++) { let x, y; if (j <= 18) { const ph = j / 18 * Math.PI; x = Math.cos(ph) * w; y = Math.pow(Math.sin(ph), 0.7) * hh; } else { const s = (j - 18) / 8; x = lerp(-w, w, s); y = -0.08; } const n = N2.fbm3(x * 0.8, y * 0.8, z * 0.5, 3) * 0.45; const d = Math.hypot(x, y - hh * 0.4) || 1; if (j <= 18) { x += x / d * n; y += (y - hh * 0.4) / d * n; } pts.push([x, y, z]); } return pts; };
  const rings = []; for (let k = 0; k <= K; k++) rings.push(ring(k));
  for (let k = 0; k < K; k++) for (let j = 0; j < M; j++) { const a = rings[k][j], b = rings[k][(j + 1) % M], c = rings[k + 1][j], d = rings[k + 1][(j + 1) % M]; P.push(...a, ...c, ...b, ...b, ...c, ...d); }
  const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); tg.computeVertexNormals();
  // make every face look inward
  const pp = tg.attributes.position, va = new THREE.Vector3(), vb = new THREE.Vector3(), vc = new THREE.Vector3(), nn = new THREE.Vector3(), cc = new THREE.Vector3();
  for (let i = 0; i < pp.count; i += 3) { va.fromBufferAttribute(pp, i); vb.fromBufferAttribute(pp, i + 1); vc.fromBufferAttribute(pp, i + 2); nn.subVectors(vb, va).cross(cc.subVectors(vc, va)); const cen = va.clone().add(vb).add(vc).multiplyScalar(1 / 3); const axis = new THREE.Vector3(0, 1.2, cen.z); if (nn.dot(axis.sub(cen)) < 0) { pp.setXYZ(i + 1, vc.x, vc.y, vc.z); pp.setXYZ(i + 2, vb.x, vb.y, vb.z); } }
  tg.computeVertexNormals();
  const tgu = planarUV(tg, 0.45);
  mossColors(tgu, { moss: 0.5, up: 0.3, seed: 5, fn: (x, y, z, ny, m, a) => [a * Math.pow(1 - sstep(1.0, -7.5, z), 1.6), m * sstep(-1.5, 1.2, z), 0.4] });
  bag.add('caveStone', tgu);
  const back = new THREE.PlaneGeometry(4.2, 3.4); xf(back, { p: [0, 1.4, -10.6] }); bag.add('black', back);
  // roots hanging over the lip
  for (let i = 0; i < 9; i++) { const R = rng(i * 13 + 2), x = (R() - 0.5) * 4.2, z = 0.6 + R() * 0.6; bag.add('bark', bend([[x, 3.4, z], [x + (R() - 0.5) * 0.3, 2.9 - R() * 0.3, z + 0.1], [x + (R() - 0.5) * 0.4, 2.3 - R() * 0.8, z + 0.15]], t => lerp(0.035, 0.006, t), { radial: 5, seg: 8 }), [0.6, 0.3, 0.2]); }
  bag.build(root, { aoMin: 0.6, aoH: 1.5 });
  root.add(marker('entrance', [0, 0, -0.6]));
  return root;
});

/* =========================================================== CANNIBAL PROPS */
defMat('hideCover', () => stdMat({ map: T('pelt').map, normalMap: T('pelt').normalMap, color: 0xb8a690, roughness: 0.85, side: THREE.DoubleSide, vertexColors: true }));
/** a pelt draped over a dome: centre direction (azimuth a, elevation e), size in metres */
function domePatch(r, H, a, e, w, h, out = 0.05) {
  const g = new THREE.PlaneGeometry(1, 1, 6, 6), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const az = a + p.getX(i) * w / r, el = clamp(e + p.getY(i) * h / r, 0.02, Math.PI / 2 - 0.02);
    const rr = r + out + N1.n2(p.getX(i) * 3 + a, p.getY(i) * 3) * 0.03;
    p.setXYZ(i, Math.sin(az) * Math.cos(el) * rr, Math.sin(el) * (H / r) * rr, Math.cos(az) * Math.cos(el) * rr);
  }
  g.computeVertexNormals(); return g;
}
/** dome hut of bent saplings under hides and bark, entrance +Z */
function hutInto(bag, seed, { skull = true } = {}) {
  const R = rng(seed), r = 2.0, H = 2.25;
  let dome = new THREE.SphereGeometry(1, 30, 12, 0, TAU, 0, Math.PI / 2).toNonIndexed();
  const p = dome.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); const az = Math.atan2(v.x, v.z), el = Math.asin(clamp(v.y, -1, 1)); const sag = 1 - 0.035 * Math.abs(Math.cos(az * 4)) * Math.sin(el * 2); const n = N1.fbm3(v.x * 2 + seed, v.y * 2, v.z * 2, 3) * 0.05; p.setXYZ(i, v.x * r * (sag + n), v.y * H * (1 + n * 0.5), v.z * r * (sag + n)); }
  dome.computeVertexNormals();
  // split triangles: entrance hole, smoke hole, hide vs bark-slab panels
  const hideT = [], barkT = [], cen = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    cen.set(0, 0, 0); for (let k = 0; k < 3; k++) cen.add(v.fromBufferAttribute(p, i + k)); cen.multiplyScalar(1 / 3);
    if (cen.z > 0.5 && Math.abs(cen.x) < 0.62 && cen.y < 1.45) continue;
    if (cen.y > H * 0.965) continue;
    (N2.n3(cen.x * 0.7 + seed, cen.y * 0.9, cen.z * 0.7) > -0.1 ? hideT : barkT).push(i);
  }
  const pick = (list) => { const P = [], N = []; const nn = dome.attributes.normal; for (const i of list) for (let k = 0; k < 3; k++) { P.push(p.getX(i + k), p.getY(i + k), p.getZ(i + k)); N.push(nn.getX(i + k), nn.getY(i + k), nn.getZ(i + k)); } const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); return g; };
  bag.add('hideCover', planarUV(pick(hideT), 0.6), (x, y) => { const k = lerp(0.55, 1, sstep(0, 1.2, y)); return [k, k * 0.96, k * 0.9]; });
  const bk = planarUV(pick(barkT), 0.7); mossColors(bk, { moss: 0.5, up: 0.5, seed }); bag.add('bark', bk);
  for (let k = 0; k < 4; k++) bag.add('pelt', domePatch(r, H, R() * TAU, 0.35 + R() * 0.6, 1.2 + R() * 0.4, 1.0 + R() * 0.3, 0.06 + k * 0.012), [0.9, 0.9, 0.9]);
  // sapling ribs over the cover and two hoops
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI + 0.25, pts = []; for (let j = 0; j <= 10; j++) { const ph = -Math.PI / 2 + j / 10 * Math.PI, rr = r + 0.07; pts.push([Math.sin(a) * Math.sin(ph) * rr, Math.cos(ph) * (H + 0.1), Math.cos(a) * Math.sin(ph) * rr]); } pts[5][1] += 0.12; bag.add('bark', bend(pts, 0.04, { radial: 6, seg: 20 }), [0.85, 0.2, 0]); }
  for (const y of [0.75, 1.55]) { const rr = (r + 0.08) * Math.cos(Math.asin(y / (H + 0.1))), pts = []; for (let j = 0; j <= 20; j++) { const a = 0.45 + j / 20 * (TAU - 0.9); pts.push([Math.sin(a) * rr, y, Math.cos(a) * rr]); } bag.add('bark', bend(pts, 0.03, { radial: 5, seg: 30, cap: true }), [0.85, 0.2, 0]); }
  // sapling tips poking out of the smoke hole
  for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; addStick(bag, [Math.sin(a) * 0.2, H - 0.15, Math.cos(a) * 0.2], [Math.sin(a) * 0.45, H + 0.45 + R() * 0.2, Math.cos(a) * 0.45], 0.03, 'bark', [0.8, 0, 0]); }
  // entrance: posts, lintel, rolled hide flap
  for (const s of [-1, 1]) addStick(bag, [s * 0.6, -0.2, r * 0.86], [s * 0.56, 1.55, r * 0.8], 0.06, 'bark', [0.9, 0.1, 0]);
  addStick(bag, [-0.8, 1.5, r * 0.84], [0.8, 1.52, r * 0.84], 0.05, 'bark', [0.9, 0.1, 0]);
  bag.add('hideCover', xf(planarUV(new THREE.CylinderGeometry(0.13, 0.13, 1.3, 10), 0.3, 0.3, -1, [0.4, 0.4]), { r: [0, 0, Math.PI / 2], p: [0, 1.62, r * 0.88] }), [0.9, 0.86, 0.8]);
  for (const s of [-1, 1]) bag.add('rope', rope([s * 0.5, 1.75, r * 0.9], [s * 0.5, 1.55, r * 0.95], 0, 0.01, 2));
  // weight stones round the foot, a fur on the floor inside
  for (let k = 0; k < 14; k++) { const a = k / 14 * TAU; if (Math.abs(Math.sin(a / 2)) < 0.18) continue; addRock(bag, seed * 7 + k, [0.35, 0.25, 0.3], [Math.sin(a) * (r + 0.1), 0, Math.cos(a) * (r + 0.1)], { detail: 1, moss: 0.5 }); }
  const fur = new THREE.PlaneGeometry(1.8, 1.6); xf(fur, { r: [-Math.PI / 2, 0, 0.4], p: [0, 0.03, -0.3] }); bag.add('pelt', fur, [0.7, 0.7, 0.7]);
  if (skull) { addStick(bag, [1.05, -0.3, r + 0.55], [1.05, 1.55, r + 0.55], 0.035, 'bark'); addSkull(bag, [1.05, 1.5, r + 0.5], [-0.25, 0.2, 0], 1.3, { seed, antlerScale: 0.6 }); }
}
def('cannibalHut', { size: [4.4, 2.8, 4.8], colliders: [{ x: 0, z: 0, r: 1.95, h: 2.2 }], notes: 'dome hut of bent saplings, hides and bark, entrance +Z' }, (opts) => {
  const bag = new Bag(); hutInto(bag, (opts.seed ?? 1) * 101); return bag.build(undefined, { aoMin: 0.45, aoH: 0.9 });
});
/** stacked flat stones forming an altar; returns top height */
function cairnAltarInto(bag, seed) {
  const R = rng(seed); let y = 0;
  [[1.5, 0.32, 1.0], [1.25, 0.28, 0.85], [1.05, 0.26, 0.75], [1.2, 0.18, 0.85]].forEach(([w, h, d], i) => { const g = rockGeo(seed + i, { size: [w, h, d], detail: 6, amp: 0.1, facets: 3, flat: 0.5, sink: 0 }); xf(g, { p: [(R() - 0.5) * 0.06, y, (R() - 0.5) * 0.06], r: [0, R() * 0.3, 0] }); mossColors(g, { moss: 0.35, up: 0.6, seed: i }); bag.add('stone', g); y += h * 0.86; });
  return y;
}
/** a small antler effigy on a stake (for the shrine) */
function smallEffigyInto(bag, p, seed) {
  addStick(bag, [p[0], -0.3, p[2]], [p[0], 2.3, p[2]], 0.06, 'log');
  addStick(bag, [p[0] - 0.6, 1.75, p[2] + 0.05], [p[0] + 0.6, 1.8, p[2] + 0.05], 0.04, 'log');
  bag.add('rope', lash([p[0], 1.78, p[2] + 0.05], [1, 0, 0], 0.07, 4, 0.012));
  addSkull(bag, [p[0], 2.2, p[2] - 0.05], [-0.15, 0, 0], 1.5, { seed, antlerScale: 0.8 });
  for (const s of [-1, 1]) for (let k = 0; k < 3; k++) { const x = p[0] + s * (0.25 + k * 0.15), y0 = 1.76; bag.add('rope', rod([x, y0, p[2] + 0.06], [x, y0 - 0.3 - k * 0.1, p[2] + 0.06], 0.004, { radial: 3 })); const f = new THREE.PlaneGeometry(0.06, 0.24); xf(f, { p: [x, y0 - 0.42 - k * 0.1, p[2] + 0.06], r: [0, s * 0.5, s * 0.15] }); bag.add('feather', f, [1, 1, 1]); }
}
def('effigy', { size: [1.8, 3.8, 1.0], colliders: [{ x: 0, z: 0, r: 0.35, h: 3.5 }], notes: 'tall stick-and-antler figure of the Wendigo lashed with twine, faces +Z' }, () => {
  const bag = new Bag(), R = rng(4141);
  const st = (a, b, r = 0.04) => bag.add('log', rod(a, b, r, { r1: r * 0.75, radial: 5, seg: 2, k: 2 }), [0.75, 0.1, 0.1]);
  // legs driven into the ground, bundled body, hunched shoulders
  st([-0.3, -0.4, 0.05], [-0.06, 1.65, 0], 0.06); st([0.32, -0.4, -0.04], [0.06, 1.65, 0], 0.06);
  for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; st([Math.cos(a) * 0.08, 1.45, Math.sin(a) * 0.06], [Math.cos(a) * 0.06 + (R() - 0.5) * 0.04, 2.85, Math.sin(a) * 0.05 + 0.12], 0.035); }
  for (const y of [1.6, 2.1, 2.6]) bag.add('rope', lash([0, y, y * 0.04], [0, 1, 0.04], 0.1, 3, 0.01));
  for (let k = 0; k < 4; k++) { const y = 2.0 + k * 0.17, w = 0.32 - k * 0.03; bag.add('log', bend([[-w, y - 0.05, 0.12], [0, y, 0.22], [w, y - 0.05, 0.12]], 0.015, { radial: 4, seg: 8 }), [0.7, 0, 0.1]); }
  st([-0.62, 2.82, 0.08], [0.62, 2.85, 0.1], 0.045); bag.add('rope', lash([0, 2.84, 0.1], [1, 0, 0], 0.06, 4, 0.012));
  // long arms hanging past the knees, ending in splayed twig claws
  for (const s of [-1, 1]) {
    const sh = [s * 0.6, 2.84, 0.1], el = [s * 0.82, 2.0, 0.18], wr = [s * 0.78, 1.0, 0.22];
    st(sh, el, 0.035); st(el, wr, 0.03); bag.add('rope', lash(el, [0, 1, 0], 0.04, 3, 0.01));
    for (let f = 0; f < 4; f++) { const sp = (f - 1.5) * 0.06; bag.add('log', bend([wr, [wr[0] + s * sp, wr[1] - 0.25, wr[2] + 0.04], [wr[0] + s * sp * 1.6, wr[1] - 0.55 - R() * 0.15, wr[2] + 0.12]], t => lerp(0.014, 0.003, t), { radial: 4, seg: 6 }), [0.7, 0, 0.1]); }
  }
  st([0, 2.8, 0.1], [0, 3.15, 0.14], 0.04);
  addSkull(bag, [0, 3.1, 0.06], [-0.1, 0, 0], 1.6, { seed: 3, antlerScale: 1.0 });
  // strips of hide and feathers tied to the arms
  for (let k = 0; k < 6; k++) { const s = k % 2 ? 1 : -1, y = 2.6 - k * 0.22; const f = new THREE.PlaneGeometry(k < 3 ? 0.07 : 0.06, k < 3 ? 0.3 : 0.26); xf(f, { p: [s * (0.7 + k * 0.02), y - 0.14, 0.15], r: [0, s * 0.3, s * 0.1] }); bag.add(k < 3 ? 'feather' : 'hideCover', f, [0.9, 0.9, 0.9]); }
  for (let k = 0; k < 4; k++) addRock(bag, 4200 + k, [0.3, 0.2, 0.28], polar(0.45, k * 1.7), { detail: 1, moss: 0.4 });
  return bag.build(undefined, { aoMin: 0.6, aoH: 1.0 });
});
def('offering', { size: [1.2, 0.4, 1.2], colliders: [], notes: 'flat stone with bundled bones, feathers and a leaf-wrapped meat parcel inside a ring of red-painted pebbles' }, () => {
  const bag = new Bag();
  const slab = rockGeo(3030, { size: [0.95, 0.22, 0.75], detail: 6, amp: 0.1, facets: 2, flat: 0.5, sink: 0.2 }); mossColors(slab, { moss: 0.4, up: 0.7, seed: 3 }); bag.add('stone', slab);
  const top = 0.15;
  for (let k = 0; k < 4; k++) { const g = bone(0.34 - k * 0.03, 0.013, 6); xf(g, { p: [0, -0.16, 0] }); xf(g, { r: [0, 0, Math.PI / 2 + (k - 1.5) * 0.06], p: [-0.18, top + 0.03 + (k % 2) * 0.02, -0.12 + k * 0.03] }); bag.add('bone', g, [0.88, 0.84, 0.74]); }
  for (const x of [-0.27, -0.1]) bag.add('rope', lash([x, top + 0.04, -0.075], [1, 0, 0], 0.045, 3, 0.008));
  const parcel = new THREE.SphereGeometry(0.12, 14, 10); deform(parcel, v => { v.y *= 0.55; v.x *= 1.25; v.x += N1.n3(v.x * 12, v.y * 12, v.z * 12) * 0.01; }); xf(parcel, { p: [0.14, top + 0.06, 0.06], r: [0, 0.5, 0] }); bag.add('leaf', planarUV(parcel, 4), [0.9, 0.9, 0.9]);
  bag.add('rope', xf(new THREE.TorusGeometry(0.13, 0.006, 4, 16), { r: [0, 0.5, 0], p: [0.14, top + 0.06, 0.06] })); bag.add('rope', xf(new THREE.TorusGeometry(0.075, 0.006, 4, 16), { r: [Math.PI / 2, 0, 0.5], p: [0.14, top + 0.06, 0.06] }));
  for (let k = 0; k < 4; k++) { const f = new THREE.PlaneGeometry(0.05, 0.2); xf(f, { r: [-Math.PI / 2 + 0.25, 0, -0.6 + k * 0.35], p: [-0.05 + k * 0.05, top + 0.05, 0.2] }); bag.add('feather', f, [1, 1, 1]); }
  for (let k = 0; k < 11; k++) { const a = k / 11 * TAU, g = rockGeo(3100 + k, { size: [0.11, 0.08, 0.1], detail: 1, amp: 0.3, facets: 2 }); xf(g, { p: [Math.cos(a) * 0.62, 0, Math.sin(a) * 0.55] }); bag.add('ochreStone', g, [0.9, 0.9, 0.9]); }
  return bag.build(undefined, { aoMin: 0.6, aoH: 0.25 });
});
def('totem', { size: [1.3, 3.6, 0.6], colliders: [{ x: 0, z: 0, r: 0.25, h: 3 }], notes: 'carved pole with three stacked faces toward +Z, antlers at the top' }, () => {
  const bag = new Bag(), h = 3.0, r = 0.3, faces = [0.72, 1.5, 2.28];
  let g = cyl(r * 1.06, r * 0.94, h + 0.5, 30, 56, 1.0); g.translate(0, -0.5, 0);
  const p = g.attributes.position;
  const face = (ax, fy) => { const brow = 0.05 * Math.exp(-(((fy - 0.38) / 0.1) ** 2)) * sstep(1, 0.7, Math.abs(ax)); const eye = -0.06 * (Math.exp(-((ax - 0.38) ** 2 + (fy - 0.15) ** 2) / 0.025) + Math.exp(-((ax + 0.38) ** 2 + (fy - 0.15) ** 2) / 0.025)); const nose = 0.06 * Math.exp(-(ax * ax) / 0.025) * sstep(-0.42, -0.25, fy) * sstep(0.32, 0.2, fy); const mouth = -0.05 * Math.exp(-(((fy + 0.6) / 0.09) ** 2)) * sstep(0.6, 0.4, Math.abs(ax)); const sep = -0.035 * Math.exp(-(((Math.abs(fy) - 1) / 0.06) ** 2)); return brow + eye + nose + mouth + sep; };
  const paint = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), a = Math.atan2(x, z), ax = a / 1.0; let dr = 0, col = [0.92, 0.9, 0.86];
    for (const fy0 of faces) { const fy = (y - fy0) / 0.36; if (Math.abs(fy) < 1.2 && Math.abs(ax) < 1.3) { dr += face(ax, fy); const eyeD = Math.min(Math.hypot(ax - 0.38, fy - 0.15), Math.hypot(ax + 0.38, fy - 0.15)); if (eyeD < 0.16) col = [0.12, 0.1, 0.09]; else if (Math.abs(fy + 0.6) < 0.08 && Math.abs(ax) < 0.5) col = [0.62, 0.22, 0.14]; else if (Math.abs(fy - 0.45) < 0.06 && Math.abs(ax) < 0.8) col = [0.25, 0.22, 0.2]; } }
    const fade = 0.75 + 0.25 * N1.n2(x * 9, y * 4); col = col.map((c, k) => lerp(0.92 - k * 0.02, c, fade * 0.9));
    const sag = N2.n3(x * 4, y * 2, z * 4) * 0.012 + Math.max(0, N1.n3(x * 2, y * 9, z * 2)) * -0.015, f = (r + dr * 1.7 + sag) / Math.hypot(x, z);
    p.setXYZ(i, x * f, y, z * f); paint.set(col.map(c => c * lerp(0.6, 1, sstep(-0.3, 0.8, y))), i * 3);
  }
  g.computeVertexNormals(); g.setAttribute('color', new THREE.BufferAttribute(paint, 3)); bag.add('totemWood', g);
  const topCap = new THREE.SphereGeometry(r * 0.95, 14, 6, 0, TAU, 0, Math.PI / 2); xf(topCap, { s: [1, 0.5, 1], p: [0, h, 0] }); bag.add('totemWood', planarUV(topCap, 1.4), [0.8, 0.78, 0.74]);
  for (const s of [-1, 1]) { const an = antler(5000 + s, 1.25, s); xf(an, { r: [0.25, 0, -s * 0.55], p: [s * 0.12, h - 0.08, 0] }); bag.add('bone', an, [0.7, 0.64, 0.54]); }
  for (let k = 0; k < 3; k++) bag.add('rope', lash([0, h - 0.25 - k * 0.04, 0], [0, 1, 0], r * 0.92, 1, 0.012));
  return bag.build(undefined, { aoMin: 0.6, aoH: 0.8 });
});
def('cannibalVillage', {
  size: [36, 4, 36], colliders: [],
  notes: "5 dome huts in a ring around a central fire pit ('fire' + 'light'), drying racks with hides, bone wind-chimes, a palisade fragment of sharpened stakes, and a shrine: stacked-stone altar + antler effigy with a 'relic' marker on top",
}, () => {
  const root = new THREE.Group(), bag = new Bag(), R = rng(2323), cols = [];
  [150, 205, 270, 335, 30].forEach((deg, i) => { const a = deg / 180 * Math.PI, x = Math.cos(a) * 11, z = Math.sin(a) * 11, ry = Math.atan2(-x, -z); const hb = new Bag(); hutInto(hb, 900 + i * 37, { skull: i === 2 || i === 4 }); bagInto(bag, hb, [x, 0, z], [0, ry, 0]); cols.push({ x, z, r: 1.95, h: 2.2 }); });
  // fire pit
  for (let k = 0; k < 13; k++) { const a = k / 13 * TAU; addRock(bag, 2400 + k, [0.36, 0.26, 0.3], [Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95], { ry: -a, detail: 2, moss: 0.1, wet: 0.2 }); }
  const ash = new THREE.CircleGeometry(0.85, 20); xf(ash, { r: [-Math.PI / 2, 0, 0], p: [0, 0.03, 0] }); bag.add('char', planarUV(ash, 2), [0.9, 0, 0.1]);
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; addLog(bag, [Math.cos(a) * 0.75, 0.08, Math.sin(a) * 0.75], [Math.cos(a) * 0.08, 0.42, Math.sin(a) * 0.08], 0.06, { key: 'char', seed: 2500 + k, radial: 7, seg: 2, ends: false }); }
  addStick(bag, [-1.2, -0.3, 0], [-1.15, 1.35, 0], 0.05); addStick(bag, [1.2, -0.3, 0], [1.15, 1.35, 0], 0.05); addStick(bag, [-1.3, 1.3, 0], [1.3, 1.3, 0], 0.035);
  root.add(marker('fire', [0, 0.25, 0])); root.add(marker('light', [0, 1.0, 0], 0, { color: 0xff7a2a, intensity: 4 }));
  // drying racks
  [[120, 6.2], [55, 6.4], [235, 6.0]].forEach(([deg, rr], i) => {
    const a = deg / 180 * Math.PI, x = Math.cos(a) * rr, z = Math.sin(a) * rr, ry = Math.atan2(-x, -z), rb = new Bag();
    for (const s of [-1, 1]) { addStick(rb, [s * 1.2, -0.3, 0], [s * 1.15, 1.95, 0], 0.06); addStick(rb, [s * 1.15, 1.7, 0], [s * 1.35, 2.05, 0.05], 0.03); }
    addStick(rb, [-1.4, 1.9, 0], [1.4, 1.92, 0], 0.045);
    for (let k = 0; k < 2; k++) { const f = new THREE.PlaneGeometry(1.0, 1.3, 4, 4); deform(f, v => { v.z += Math.sin(v.y * 3) * 0.04; }); xf(f, { p: [-0.55 + k * 1.1, 1.25, 0.02 * k], r: [0, 0.1 * k, 0] }); rb.add('peltWind', f, [0.9, 0.9, 0.9]); }
    for (let k = 0; k < 5; k++) rb.add('meat', xf(planarUV(new THREE.BoxGeometry(0.06, 0.45, 0.01), 4), { p: [-1.0 + k * 0.5 + 0.25, 1.65, 0.05] }), [0.45, 0.3, 0.26]);
    bagInto(bag, rb, [x, 0, z], [0, ry, 0]); cols.push({ x, z, w: 2.7, d: 0.4, h: 2, rot: ry });
  });
  // bone wind-chimes
  [[215, 7.2], [320, 7.4]].forEach(([deg, rr], i) => {
    const a = deg / 180 * Math.PI, x = Math.cos(a) * rr, z = Math.sin(a) * rr, cb = new Bag();
    addStick(cb, [0, -0.4, 0], [0.05, 2.5, 0], 0.06); cb.add('log', bend([[0.04, 2.35, 0], [0.5, 2.5, 0.05], [1.2, 2.45, 0.1]], t => lerp(0.04, 0.015, t), { radial: 5, seg: 10 }), [0.8, 0.1, 0]);
    for (let k = 0; k < 7; k++) { const t = 0.25 + k * 0.13, bx = lerp(0.1, 1.15, t), by = 2.47 - 0.02 * k, len = 0.35 + R() * 0.45; cb.add('rope', rod([bx, by, 0.05], [bx, by - len, 0.05], 0.003, { radial: 3 })); const bn = bone(0.18 + R() * 0.12, 0.009, 5); xf(bn, { p: [bx, by - len - 0.22, 0.05], r: [0, R() * 3, (R() - 0.5) * 0.2] }); cb.add('bone', bn, [0.9, 0.86, 0.76]); }
    bagInto(cb.m.size ? bag : bag, cb, [x, 0, z], [0, R() * TAU, 0]);
  });
  // palisade fragment behind the back huts
  for (let k = 0; k < 20; k++) {
    const a = (230 + k * 4) / 180 * Math.PI, x = Math.cos(a) * 16.5, z = Math.sin(a) * 16.5, h = 2.4 + R() * 0.6, lean = 0.06;
    bag.add('log', rod([x, -0.6, z], [x * (1 + lean * 0.02), h - 0.35, z * (1 + lean * 0.02)], 0.12, { r1: 0.11, radial: 8, seg: 2 }), [0.9, 0.3, 0.1]);
    bag.add('log', rod([x * (1 + lean * 0.02), h - 0.35, z * (1 + lean * 0.02)], [x * 1.002, h, z * 1.002], 0.11, { r1: 0.006, radial: 8 }), [1, 0, 0]);
  }
  for (const y of [0.8, 1.7]) { const pts = []; for (let k = 0; k <= 12; k++) { const a = (230 + k * 76 / 12) / 180 * Math.PI; pts.push([Math.cos(a) * 16.3, y + Math.sin(k) * 0.05, Math.sin(a) * 16.3]); } bag.add('log', bend(pts, 0.05, { radial: 5, seg: 40 }), [0.8, 0.2, 0.1]); }
  for (let k = 0; k < 4; k++) { const a0 = 230 / 180 * Math.PI, a1 = 306 / 180 * Math.PI, ac = lerp(a0, a1, (k + 0.5) / 4); cols.push({ x: Math.cos(ac) * 16.5, z: Math.sin(ac) * 16.5, w: 5.6, d: 0.4, h: 2.6, rot: Math.PI / 2 - ac }); }
  // shrine
  const sz = -6.2, sb = new Bag(); const top = cairnAltarInto(sb, 2700); smallEffigyInto(sb, [0, 0, -0.75], 2711);
  for (let k = 0; k < 5; k++) { const a = Math.PI * 0.15 + k / 4 * Math.PI * 0.7; addRock(sb, 2720 + k, [0.13, 0.1, 0.12], [Math.cos(a) * 1.0, 0, Math.sin(a) * 0.8], { detail: 1, key: 'ochreStone', moss: 0 }); }
  bagInto(bag, sb, [0, 0, sz]);
  root.add(marker('relic', [0, top + 0.02, sz])); cols.push({ x: 0, z: sz, w: 1.5, d: 1.0, h: top }, { x: 0, z: sz - 0.75, r: 0.1, h: 2.3 });
  // trampled bones and a few stumps
  for (let i = 0; i < 6; i++) { const a = R() * TAU, d = 3 + R() * 4; addBone(bag, 0.3 + R() * 0.15, 0.013, [Math.cos(a) * d, 0, Math.sin(a) * d], R() * 3, R()); }
  bag.build(root, { aoMin: 0.5, aoH: 0.9 });
  root.userData.colliders = cols; PROP_INFO.cannibalVillage.colliders = cols;
  return root;
});

/* =========================================================== RUINS */
/** a dry-stacked stone wall along X, centred; heights from hFn(x) */
function drystoneWallGeo(len, h0, thick, seed) {
  const R = rng(seed), so = R() * 50;
  let g = new THREE.BoxGeometry(len, 1, thick, Math.ceil(len * 4), 6, 2); g = weld(g);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), ty = p.getY(i) + 0.5, z = p.getZ(i);
    const hx = h0 * clamp(0.62 + 0.55 * N1.fbm2(x * 0.45 + so, seed, 3) + (Math.abs(x) > len / 2 - 0.4 ? -0.2 : 0), 0.25, 1.25);
    const top = ty > 0.99 ? N2.n2(x * 4 + so, z * 4) * 0.08 : 0;
    const bulge = Math.sin(ty * Math.PI) * 0.05 * N1.n2(x * 0.7, so);
    const zz = z * lerp(1.15, 0.85, ty) + Math.sign(z) * (bulge + N3.n3(x * 3, ty * 3, z * 3 + so) * 0.04);
    p.setXYZ(i, x + N1.n3(x * 2, ty * 2, so) * 0.05, ty * hx + top - 0.35, zz);
  }
  g.computeVertexNormals();
  g = planarUV(g, 0.85, 0.85, -1, [R() * 4, R() * 4]);
  mossColors(g, { moss: 0.9, up: 0.4, seed, fn: (x, y, z, ny, m, a) => [a, clamp(m + sstep(0.3, -0.3, y) * 0.4, 0, 1), 0.08] });
  return g;
}
/** a ruined stone house (~6 x 4.5 m, door gap +Z); returns local colliders */
function ruinHouseInto(bag, seed) {
  const R = rng(seed), cols = [];
  const wall = (len, h, x, z, ry) => { const g = drystoneWallGeo(len, h, 0.62, seed + cols.length * 17); xf(g, { r: [0, ry, 0], p: [x, 0, z] }); bag.add('drystone', g); cols.push({ x, z, w: len, d: 0.62, h: h * 0.85, rot: ry }); };
  wall(6.6, 1.3 + R() * 0.5, 0, -2.25, 0); wall(4.3, 0.9 + R() * 0.7, -3.0, 0, Math.PI / 2); wall(4.3, 0.7 + R() * 0.8, 3.0, 0, Math.PI / 2);
  wall(2.6, 0.8 + R() * 0.6, -1.95, 2.25, 0); wall(2.6, 0.5 + R() * 0.6, 1.95, 2.25, 0);
  // collapsed roof beams: rotten and charred
  addLog(bag, [-2.6, 1.3, -2.0], [-0.4, 0.1, 0.8], 0.13, { key: 'char', seed: seed + 1, radial: 8, seg: 4 });
  addLog(bag, [2.8, 0.9, -1.6], [0.2, 0.15, -0.2], 0.12, { key: 'bark', seed: seed + 2, radial: 8, seg: 4, col: [0.7, 0.7, 0.3] });
  addLog(bag, [-1.5, 0.12, 1.2], [1.6, 0.12, 1.4], 0.11, { key: 'char', seed: seed + 3, radial: 8, seg: 4 });
  addLog(bag, [1.2, 0.95, -2.1], [2.9, 0.75, 1.9], 0.1, { key: 'bark', seed: seed + 4, radial: 8, seg: 4, col: [0.7, 0.8, 0.3] });
  // rubble spilling from the walls, and a hearth
  for (let i = 0; i < 12; i++) { const side = R() < 0.5 ? -1 : 1, onX = R() < 0.5, x = onX ? side * (3.0 + (R() - 0.3) * 0.9) : (R() - 0.5) * 5.6, z = onX ? (R() - 0.5) * 4 : side * (2.25 + (R() - 0.3) * 0.9); addRock(bag, seed * 3 + i, [0.3 + R() * 0.3, 0.18 + R() * 0.12, 0.25 + R() * 0.2], [x, 0, z], { ry: R() * 3, detail: 2, moss: 0.8, key: 'stone' }); }
  for (let k = 0; k < 7; k++) { const a = k / 7 * TAU; addRock(bag, seed * 5 + k, [0.26, 0.2, 0.22], [0.8 + Math.cos(a) * 0.45, 0, -0.9 + Math.sin(a) * 0.45], { detail: 1, moss: 0.5, wet: 0.3 }); }
  return cols;
}
def('ruinHouse', { size: [7, 1.8, 5.5], colliders: [], notes: 'ruined ancient dry-stone dwelling, door gap +Z, collapsed roof beams; variants by opts.seed' }, (opts) => {
  const bag = new Bag(); const cols = ruinHouseInto(bag, (opts.seed ?? 1) * 131); const g = bag.build(undefined, { aoMin: 0.55, aoH: 0.7 }); g.userData.colliders = cols; if (!PROP_INFO.ruinHouse.colliders.length) PROP_INFO.ruinHouse.colliders = cols; return g;
});
def('ruinWall', { size: [4.2, 1.6, 1.2], colliders: [{ x: 0, z: 0, w: 4, d: 0.65, h: 1.3 }], notes: 'fragment of an ancient dry-stone wall along X' }, (opts) => {
  const bag = new Bag(), R = rng((opts.seed ?? 1) * 59); bag.add('drystone', drystoneWallGeo(4, 1.5, 0.65, (opts.seed ?? 1) * 59));
  for (let i = 0; i < 7; i++) addRock(bag, 5900 + i, [0.3 + R() * 0.25, 0.18, 0.25 + R() * 0.2], [(R() - 0.5) * 4, 0, (R() < 0.5 ? -1 : 1) * (0.5 + R() * 0.6)], { detail: 2, moss: 0.8 });
  return bag.build(undefined, { aoMin: 0.55, aoH: 0.6 });
});
def('ruinSettlement', { size: [40, 2, 40], colliders: [], notes: '7 ruined houses around a burned clearing with charred posts' }, () => {
  const root = new THREE.Group(), bag = new Bag(), R = rng(7171), cols = [];
  for (let i = 0; i < 7; i++) { const a = i / 7 * TAU + (R() - 0.5) * 0.3, r = 14 + R() * 3, x = Math.cos(a) * r, z = Math.sin(a) * r, ry = Math.atan2(-x, -z) + (R() - 0.5) * 0.4; const hb = new Bag(); const c = ruinHouseInto(hb, 7200 + i * 41); bagInto(bag, hb, [x, 0, z], [0, ry, 0]); cols.push(...placeCols(c, [x, 0, z], ry)); }
  // the burned centre: a blackened disc and a ring of charred posts
  const disc = new THREE.CircleGeometry(6.5, 40, 0, TAU); deform(disc, v => { const a = Math.atan2(v.y, v.x), r = Math.hypot(v.x, v.y); const k = 1 + N1.fbm2(Math.cos(a) * 2, Math.sin(a) * 2, 3) * 0.25 * (r / 6.5); v.x *= k; v.y *= k; }); xf(disc, { r: [-Math.PI / 2, 0, 0], p: [0, 0.03, 0] });
  bag.add('char', planarUV(disc, 0.8), (x, y, z) => [lerp(1, 0.7, Math.hypot(x, z) / 7), 0, 0.3]);
  for (let i = 0; i < 11; i++) {
    const a = i / 11 * TAU, x = Math.cos(a) * 3.6, z = Math.sin(a) * 3.6;
    if (i % 4 === 3) { addLog(bag, [x, 0.12, z], [x + Math.cos(a + 1.2) * 2.2, 0.12, z + Math.sin(a + 1.2) * 2.2], 0.12, { key: 'char', seed: 7300 + i, radial: 8, seg: 3 }); continue; }
    const h = 1.0 + R() * 1.6, g = cyl(0.14, 0.11, h + 0.5, 9, 4, 1.4); deform(g, v => { if (v.y > h + 0.3) v.y = h + 0.3 - Math.abs(N1.n2(v.x * 20, v.z * 20)) * 0.5; v.x += N2.n3(v.x * 5, v.y * 2, v.z * 5) * 0.02; });
    xf(g, { p: [x, -0.5, z], r: [(R() - 0.5) * 0.12, 0, (R() - 0.5) * 0.12] }); mossColors(g, { moss: 0.15, up: 0.6 }); bag.add('char', g); cols.push({ x, z, r: 0.15, h });
  }
  for (let i = 0; i < 9; i++) { const a = R() * TAU, d = R() * 4.5; addBone(bag, 0.25 + R() * 0.2, 0.012, [Math.cos(a) * d, 0.02, Math.sin(a) * d], R() * 3, R(), [0.32, 0.29, 0.26]); }
  bag.build(root, { aoMin: 0.55, aoH: 0.7 }); root.userData.colliders = cols; PROP_INFO.ruinSettlement.colliders = cols;
  return root;
});

/* =========================================================== CROSSINGS, WATERFRONT, TOWER */
def('bridgeRope', { size: [2.2, 3, 20.6], colliders: [{ x: -0.85, z: -10.1, r: 0.15, h: 1.3 }, { x: 0.85, z: -10.1, r: 0.15, h: 1.3 }, { x: -0.85, z: 10.1, r: 0.15, h: 1.3 }, { x: 0.85, z: 10.1, r: 0.15, h: 1.3 }], notes: '20 m rope-and-plank bridge along Z between two pairs of posts; deck y=0 at both ends (z=+-10), sags ~1.4 m mid-span' }, () => {
  const bag = new Bag(), R = rng(2020), sag = 1.4, deckY = (z) => -sag * (1 - (z / 10) ** 2);
  for (const zs of [-1, 1]) for (const xs of [-1, 1]) { addLog(bag, [xs * 0.85, -1.6, zs * 10.1], [xs * 0.85, 1.25, zs * 10.1], 0.13, { key: 'log', seed: zs * 3 + xs, radial: 9, seg: 3, taper: 0.85 }); bag.add('rope', lash([xs * 0.85, 1.05, zs * 10.1], [0, 1, 0], 0.12, 4, 0.016)); bag.add('rope', lash([xs * 0.85, 0.05, zs * 10.1], [0, 1, 0], 0.13, 3, 0.016)); }
  for (const zs of [-1, 1]) addPlank(bag, 2.0, 0.3, 0.05, [0, -0.02, zs * 10.3], [0, 0, 0], { seed: 2100 + zs });
  for (const xs of [-1, 1]) {
    // two deck ropes and a handrail rope on each side
    const deck = [], rail = []; for (let k = 0; k <= 30; k++) { const z = -10 + k * 20 / 30; deck.push([xs * 0.55, deckY(z) - 0.04, z]); rail.push([xs * 0.82, 1.05 - sag * 0.75 * (1 - (z / 10) ** 2), z]); }
    deck[0] = [xs * 0.85, 0.05, -10.1]; deck[30] = [xs * 0.85, 0.05, 10.1];
    bag.add('rope', bend(deck, 0.022, { radial: 5, seg: 90 })); bag.add('rope', bend(rail, 0.02, { radial: 5, seg: 90 }));
    for (let z = -9; z <= 9; z += 1) bag.add('rope', rod([xs * 0.8, 1.05 - sag * 0.75 * (1 - (z / 10) ** 2), z], [xs * 0.56, deckY(z) - 0.02, z], 0.008, { radial: 3 }));
  }
  for (let z = -9.85, i = 0; z < 9.9; z += 0.34, i++) {
    if (R() < 0.07) continue;
    const slope = Math.atan(2 * sag * z / 100), broken = R() < 0.06;
    addPlank(bag, broken ? 0.6 : 1.25, 0.24, 0.04, [broken ? 0.35 : (R() - 0.5) * 0.06, deckY(z) - 0.005, z], [slope, (R() - 0.5) * 0.06, broken ? 0.15 : (R() - 0.5) * 0.04], { seed: 2200 + i, col: [lerp(0.75, 1, R()), 0.2 * R(), 0.15] });
  }
  return bag.build(undefined, { ao: false });
});
def('dock', { size: [2.6, 1.4, 8.6], colliders: [{ x: 0, z: 4, w: 2.0, d: 8, h: 0.55 }], notes: 'small rotten jetty from the shore (z=0) out to z=8 along +Z; deck at y=0.5, pilings to y=-2.5; far end sags' }, () => {
  const bag = new Bag(), R = rng(8080), deckY = (z) => 0.5 - sstep(5.5, 8, z) * 0.32;
  for (let z = 0.2; z <= 8; z += 2.0) for (const xs of [-1, 1]) { const tilt = z > 6 ? 0.08 : 0; addLog(bag, [xs * 0.95, -2.5, z], [xs * 0.95 + tilt, deckY(z) + 0.35, z], 0.13, { key: 'log', seed: z * 7 + xs, radial: 9, seg: 4, taper: 0.9, col: (x, y) => [1, 0.15, sstep(0.2, -0.5, y)] }); }
  for (const xs of [-1, 1]) addPlank(bag, 8.2, 0.2, 0.08, [xs * 0.9, 0.38, 4.0], [0, Math.PI / 2, 0], { seed: 8100 + xs, warp: 0.05 });
  for (let z = 0.1, i = 0; z < 8.1; z += 0.2, i++) {
    if (R() < 0.08 || (z > 6.6 && z < 7.2)) continue;
    const broken = R() < 0.08, len = broken ? 0.9 + R() * 0.4 : 2.05;
    addPlank(bag, len, 0.18, 0.035, [broken ? (R() < 0.5 ? -1 : 1) * (1.0 - len / 2) : (R() - 0.5) * 0.06, deckY(z) + 0.02, z], [(R() - 0.5) * 0.03, (R() - 0.5) * 0.05, broken ? (R() - 0.5) * 0.2 : 0], { seed: 8200 + i, col: [lerp(0.7, 1, R()), 0.3 * R() * sstep(4, 8, z), 0.2] });
  }
  addPlank(bag, 1.2, 0.18, 0.035, [0.6, -0.05, 6.9], [0.3, 0.6, 0.8], { seed: 8300 });
  bag.add('ironDark', xf(planarUV(roundBox(0.28, 0.06, 0.07, 0.02, 2, 1, 1), 3), { p: [0.75, 0.56, 7.4] }), [0.5, 0.42, 0.35]);
  const coil = []; for (let k = 0; k <= 60; k++) { const a = k / 60 * TAU * 4, rr = 0.16 + k * 0.0012; coil.push([-0.55 + Math.cos(a) * rr, 0.55 + k * 0.0006, 2.2 + Math.sin(a) * rr]); } bag.add('rope', bend(coil, 0.014, { radial: 4, seg: 120 }));
  bag.add('rope', bend([[0.75, 0.58, 7.4], [0.95, 0.3, 7.8], [1.2, -0.2, 8.3]], 0.014, { radial: 4, seg: 10 }));
  return bag.build(undefined, { ao: false });
});
def('rowboat', { size: [1.5, 0.7, 3.8], colliders: [{ x: 0, z: 0, w: 1.4, d: 3.6, h: 0.6 }], notes: 'wrecked wooden rowboat lying overturned, bow +Z, a hole stove in its bottom' }, () => {
  const bag = new Bag(), L = 3.6, NZ = 24, NA = 16, P = [], UV = [], idx = [];
  const sec = (t) => { const w = 0.66 * Math.pow(Math.sin(clamp(t, 0, 1) * Math.PI * 0.92 + 0.12), 0.7) * (t < 0.2 ? lerp(0.8, 1, t / 0.2) : 1), d = 0.48 * (0.85 + 0.15 * Math.sin(t * Math.PI)); return [Math.max(0.03, w), d]; };
  for (let i = 0; i <= NZ; i++) { const t = i / NZ, z = lerp(-L / 2, L / 2, t), [w, d] = sec(t), sheer = 0.06 * ((t - 0.5) * 2) ** 2 * 2; for (let j = 0; j <= NA; j++) { const ph = j / NA * Math.PI, x = Math.cos(ph) * w, y = -Math.pow(Math.sin(ph), 0.6) * d + sheer; P.push(x, y, z); UV.push(Math.abs(y) * 4 + j * 0.0, z * 0.42); } }
  for (let i = 0; i < NZ; i++) for (let j = 0; j < NA; j++) { const a = i * (NA + 1) + j, b = a + NA + 1, tc = (i + 0.5) / NZ, jc = (j + 0.5) / NA; if (tc > 0.42 && tc < 0.56 && jc > 0.35 && jc < 0.6) continue; idx.push(a, a + 1, b, b, a + 1, b + 1); }
  let hull = new THREE.BufferGeometry(); hull.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); hull.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); hull.setIndex(idx); hull.computeVertexNormals(); hull = hull.toNonIndexed();
  const strake = (x, y, z) => { const band = Math.floor(Math.abs(y) * 14) % 2; return [lerp(0.75, 1, band), 0.2 * sstep(-0.1, -0.4, y), 0.1]; };
  const flip = (g) => { xf(g, { r: [0, 0, Math.PI] }); xf(g, { r: [0.03, 0.2, 0.12], p: [0, 0.47, 0] }); return g; };
  const outer = flip(hull.clone()); bag.add('wood', outer, (x, y, z) => { const s = strake(x, -y + 0.5, z); return [s[0], 0.5 * sstep(0.35, 0.6, y), 0.1]; });
  const inner = hull.clone(); const ip = inner.attributes.position; for (let i = 0; i < ip.count; i++) { ip.setX(i, ip.getX(i) * 0.95); ip.setY(i, ip.getY(i) * 0.94 + 0.01); } for (let i = 0; i < ip.count; i += 3) { const x = ip.getX(i + 1), y = ip.getY(i + 1), z = ip.getZ(i + 1); ip.setXYZ(i + 1, ip.getX(i + 2), ip.getY(i + 2), ip.getZ(i + 2)); ip.setXYZ(i + 2, x, y, z); }
  inner.computeVertexNormals(); bag.add('woodBrown', flip(inner), [0.55, 0.1, 0.4]);
  bag.add('wood', flip(rod([0, -0.49, -1.75], [0, -0.43, 1.85], 0.04, { radial: 6, seg: 6 })), [0.8, 0.5, 0.1]);
  const tr = new THREE.BoxGeometry(1.0, 0.42, 0.05); xf(tr, { p: [0, -0.2, -L / 2 + 0.02] }); bag.add('wood', flip(planarUV(tr, 1.6, 0.42, 0)), [0.8, 0.3, 0.1]);
  for (let k = 0; k < 3; k++) { const z = -0.9 + k * 0.9, [w] = sec(z / L + 0.5); addPlank(bag, w * 1.9, 0.2, 0.03, [0, 0.24, z], [0, 0, 0.12], { seed: 8800 + k, key: 'woodBrown', col: [0.5, 0, 0.3] }); }
  for (let k = 0; k < 6; k++) { const R = rng(880 + k); addPlank(bag, 0.3 + R() * 0.4, 0.09, 0.02, [(R() - 0.5) * 0.4, 0.5 + R() * 0.08, -0.15 + R() * 0.5], [(R() - 0.5), R() * 3, 0.3 + (R() - 0.5) * 0.6], { seed: 8810 + k }); }
  const oar = mergeGeos([rod([0, 0, 0], [0, 0, 1.4], 0.025, { radial: 6 }), xf(planarUV(new THREE.BoxGeometry(0.14, 0.015, 0.5), 2), { p: [0, 0, 1.6] })]); xf(oar, { r: [0, 1.1, 0.05], p: [-1.1, 0.04, -0.6] }); bag.add('woodBrown', oar, [0.8, 0.4, 0.2]);
  return bag.build(undefined, { aoMin: 0.55, aoH: 0.4 });
});
def('watchtower', {
  size: [4.4, 9.6, 5.2], colliders: [{ x: -1.9, z: -1.9, r: 0.2, h: 7 }, { x: 1.9, z: -1.9, r: 0.2, h: 7 }, { x: -1.9, z: 1.9, r: 0.2, h: 7 }, { x: 1.9, z: 1.9, r: 0.2, h: 7 }],
  notes: "8 m wooden fire-lookout/hunting tower; ladder on the +Z face up to a hatch in the platform (y=7); 'ladder' marker at its foot",
}, () => {
  const root = new THREE.Group(), bag = new Bag(), R = rng(9191), top = 7.0;
  const leg = (sx, sz) => [[sx * 2.0, -1.0, sz * 2.0], [sx * 1.25, top + 1.1, sz * 1.25]];
  const legAt = (sx, sz, y) => { const [a, b] = leg(sx, sz), t = (y - a[1]) / (b[1] - a[1]); return [lerp(a[0], b[0], t), y, lerp(a[2], b[2], t)]; };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const [a, b] = leg(sx, sz); addLog(bag, a, b, 0.17, { key: 'log', seed: sx * 5 + sz, radial: 10, seg: 6, taper: 0.8, col: (x, y) => [1, sstep(0.8, -0.5, y) * 0.8, 0.15] }); }
  // X bracing on all four sides, two storeys, one brace snapped
  const faces = [[[-1, 1], [1, 1]], [[1, 1], [1, -1]], [[1, -1], [-1, -1]], [[-1, -1], [-1, 1]]];
  faces.forEach(([A, B], fi) => { for (const [y0, y1] of [[0.4, 3.6], [3.6, 6.7]]) { const a0 = legAt(A[0], A[1], y0), b1 = legAt(B[0], B[1], y1), b0 = legAt(B[0], B[1], y0), a1 = legAt(A[0], A[1], y1); if (!(fi === 1 && y0 > 1)) addStick(bag, a0, b1, 0.06, 'wood'); else addStick(bag, a0, [lerp(a0[0], b1[0], 0.45), lerp(a0[1], b1[1], 0.45) - 0.1, lerp(a0[2], b1[2], 0.45)], 0.06, 'wood'); addStick(bag, b0, a1, 0.06, 'wood'); addStick(bag, legAt(A[0], A[1], y1), legAt(B[0], B[1], y1), 0.07, 'log'); } });
  // platform: joists, boards with a hatch, railing, cab roof
  const ph = 1.5;
  for (const z of [-1.3, 0, 1.3]) addLog(bag, [-ph - 0.2, top - 0.12, z], [ph + 0.2, top - 0.12, z], 0.09, { key: 'log', seed: z * 11, radial: 8, seg: 3 });
  for (let x = -ph, i = 0; x <= ph + 0.01; x += 0.17, i++) { if (x > 0.25 && x < 0.95) { addPlank(bag, 1.7, 0.16, 0.04, [x, top, -0.6], [0, Math.PI / 2, 0], { seed: 9300 + i }); continue; } if (i === 4) continue; addPlank(bag, ph * 2 + 0.2, 0.16, 0.04, [x, top, 0], [0, Math.PI / 2, 0], { seed: 9300 + i }); }
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of corners) addStick(bag, [sx * ph, top, sz * ph], [sx * ph, top + 2.4, sz * ph], 0.07, 'log');
  for (let k = 0; k < 4; k++) { const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4]; for (const y of [0.5, 1.05]) { if (k === 2 && y > 1 ) { addStick(bag, [ax * ph, top + y, az * ph], [lerp(ax, bx, 0.4) * ph, top + y - 0.3, lerp(az, bz, 0.4) * ph], 0.04, 'wood'); continue; } if (k === 2 && y < 1) continue; addStick(bag, [ax * ph, top + y, az * ph], [bx * ph, top + y, bz * ph], 0.04, 'wood'); } }
  const roofY = top + 2.4, apex = roofY + 1.1;
  for (const [sx, sz] of corners) addStick(bag, [sx * (ph + 0.3), roofY - 0.05, sz * (ph + 0.3)], [0, apex, 0], 0.05, 'log');
  for (let k = 0; k < 4; k++) {
    const [ax, az] = corners[k], [bx, bz] = corners[(k + 1) % 4], e = ph + 0.35;
    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([ax * e, roofY - 0.1, az * e, bx * e, roofY - 0.1, bz * e, 0, apex + 0.05, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, e * 0.66, 0, e * 0.33, 0.55], 2)); tri.computeVertexNormals();
    const nrm = new THREE.Vector3(ax + bx, 1, az + bz); const pa = tri.attributes.normal; if (pa.getY(0) < 0) { const p = tri.attributes.position; const t = [p.getX(1), p.getY(1), p.getZ(1)]; p.setXYZ(1, p.getX(2), p.getY(2), p.getZ(2)); p.setXYZ(2, ...t); tri.computeVertexNormals(); } void nrm;
    mossColors(tri, { moss: 0.7, up: 0.3, seed: k }); bag.add('shingle', tri);
    const under = tri.clone(); const up2 = under.attributes.position; const t2 = [up2.getX(1), up2.getY(1) - 0.03, up2.getZ(1)]; up2.setXYZ(1, up2.getX(2), up2.getY(2) - 0.03, up2.getZ(2)); up2.setXYZ(2, ...t2); up2.setY(0, up2.getY(0) - 0.03); under.computeVertexNormals(); bag.add('woodBrown', under, [0.5, 0, 0.1]);
  }
  // ladder on the +Z face up to the hatch
  const lz0 = 2.75, lz1 = 1.0;
  for (const x of [0.32, 0.88]) addStick(bag, [x, -0.3, lz0], [x, top + 0.9, lz1 - 0.05], 0.045, 'wood');
  for (let y = 0.3, k = 0; y < top; y += 0.32, k++) { if (k === 9 || k === 15) continue; const t = (y + 0.3) / (top + 1.2), z = lerp(lz0, lz1 - 0.05, t); addStick(bag, [0.32, y, z], [0.88, y, z], 0.025, 'wood'); }
  // a rusted lookout's stool and an old fire-finder stand on the platform
  bag.add('rust', rod([-0.8, top, -0.8], [-0.8, top + 1.0, -0.8], 0.04)); bag.add('rust', xf(new THREE.CylinderGeometry(0.28, 0.28, 0.05, 16), { p: [-0.8, top + 1.03, -0.8] }));
  bag.build(root, { aoMin: 0.55, aoH: 1.0 });
  root.add(marker('ladder', [0.6, 0, lz0 + 0.3], Math.PI));
  return root;
});

/* =========================================================== LINEUP (viewer) */
const SMALL = ['crate', 'barrel', 'lantern', 'radio', 'skull', 'bones', 'offering', 'stump', 'rockMedium', 'boulder', 'footprint', 'footprintGiant', 'clawMarks', 'symbolTree', 'tent', 'signpost', 'altarStone', 'humanRemains'];
export function lineup(ctx) {
  const { THREE: T3, scene, arg } = ctx;
  const spin = [];
  const preview = (g) => {
    // viewer only: real lights at 'light' markers and glowing blobs at 'fire' markers
    g.updateMatrixWorld(true);
    const lights = [], fires = [];
    g.traverse(o => { if (o.name === 'light') lights.push(o); if (o.name === 'fire') fires.push(o); });
    for (const o of lights.slice(0, 6)) { const L = new T3.PointLight(o.userData.color || 0xffaa66, (o.userData.intensity || 2) * 3, 14, 1.6); o.add(L); }
    for (const o of fires) { const f = new T3.Mesh(new T3.SphereGeometry(0.12, 10, 8), new T3.MeshBasicMaterial({ color: 0xff8030 })); f.scale.set(1, 1.8, 1); f.position.y = 0.12; o.add(f); }
    g.traverse(o => { if (o.name === 'rotor') spin.push([o, 'y', 30]); if (o.name === 'tailRotor') spin.push([o, 'x', 80]); });
  };
  const frame = (g) => {
    const box = new T3.Box3().setFromObject(g), s = box.getSize(new T3.Vector3()), c = box.getCenter(new T3.Vector3());
    const r = Math.max(s.x, s.y * 1.2, s.z) * 0.62 + 0.4;
    return { cam: [c.x + r * 1.05, c.y + r * 0.55, c.z + r * 1.55], look: [c.x, c.y - s.y * 0.08, c.z] };
  };
  const update = (dt) => { for (const [o, ax, w] of spin) o.rotation[ax] += w * dt; };
  if (arg === 'all') { // build-check every prop: logs errors and triangle counts
    const out = [];
    for (const n of Object.keys(BUILD)) { try { const t0 = performance.now(); const g = createProp(n, {}); out.push(n + ' ' + tris(g) + ' ' + Math.round(performance.now() - t0) + 'ms'); } catch (e) { out.push('FAIL ' + n + ' ' + e.message + ' ' + (e.stack || '').split('\n')[1]); } }
    for (let i = 0; i < out.length; i += 10) window.__log?.(out.slice(i, i + 10).join(' ; '));
    return { cam: [0, 3, 8], look: [0, 0, 0] };
  }
  if (arg === 'stones') {
    for (let i = 0; i < 6; i++) { const g = createProp('carvedStone', { story: i }); g.position.set((i - 2.5) * 1.55, 0, 0); scene.add(g); }
    return { cam: [0, 1.25, 5.0], look: [0, 1.0, 0], update };
  }
  if (arg === 'heli-interior') {
    const g = createProp('helicopter'); scene.add(g); preview(g); g.updateMatrixWorld(true);
    const s = g.getObjectByName('seat0'), p = new T3.Vector3(), q = new T3.Vector3();
    s.getWorldPosition(p); p.y += 0.72; const fwd = new T3.Vector3(0, 0, 1).applyQuaternion(s.getWorldQuaternion(new T3.Quaternion()));
    q.copy(p).addScaledVector(fwd, 2).add(new T3.Vector3(0.6, -0.25, 0));
    return { cam: p.toArray(), look: q.toArray(), update };
  }
  if (arg && BUILD[arg]) {
    const g = createProp(arg, {}); scene.add(g); preview(g);
    const f = frame(g); const info = PROP_INFO[arg];
    console.log(arg, 'tris', tris(g), 'size', info.size.join('x'));
    window.__log?.(arg + ' tris ' + tris(g));
    return { ...f, update };
  }
  // grid of small props
  const names = SMALL.filter(n => BUILD[n]);
  const cols = 6;
  names.forEach((n, i) => {
    const g = createProp(n, {}); const x = (i % cols - (cols - 1) / 2) * 2.6, z = -Math.floor(i / cols) * 3.2;
    g.position.set(x, 0, z); scene.add(g); preview(g);
  });
  return { cam: [0, 6.5, 9.5], look: [0, 0.3, -3.2], update };
}
