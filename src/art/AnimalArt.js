/* AnimalArt.js - the island's wildlife, and what the night does to it.

   createAnimal(kind, opts) -> A          kinds: wolf rabbit deer bear bird fish crawler moth
     opts { seed, color, antlers }
     A.root A.kind A.size A.head A.animate(dt, s) A.setCorruption(c) A.dispose()
   lineup(ctx)                            screenshot viewer entry (see _view.html)

   How an animal is made
   ---------------------
   * The body is ONE smooth skinned surface built from "lofts": a centre curve through a
     few key stations, each with a half width and separate top / bottom heights, swept
     with elliptical rings. Torso + neck + head is a single loft so the silhouette has no
     seams; legs, paws, tail, ears and jaw are their own lofts sunk into it.
   * Skin weights come from the key stations (each one names its bone, rings in between
     blend), so joints bend smoothly. The bind pose has the torso at standing height and
     the legs hanging straight down; all bending happens at runtime.
   * Fur: a tiling stroke texture + normal map on the body, vertex colours for the coat
     (dark saddle, pale belly, face mask...), sheen for the soft rim, and a second skinned
     mesh of alpha-tested fur-clump cards rooted on the surface (ruff, back, tail, cheeks)
     that breaks up the silhouette. Cards take the body normal so they light like the skin.
   * Hard parts (nose, teeth, claws, hooves, antlers, beak) are a third skinned mesh.
   * Eyes are rigid spheres on the head bone. Eyeshine is a Points sprite with a minimum
     pixel size, so corrupted eyes read from far away in the dark.

   Corruption - setCorruption(c), 0..1, cheap enough to call every frame
   -------------------------------------------------------------------
   * Geometry: one morph target per mesh holds the corrupted body (legs stretched, ribs
     and spine showing, belly tucked, jaw widened, neck lengthened, antler thorns, fur
     clumps matted or gone). The skeleton's bind positions lerp with the same stretch, so
     rig and mesh stay consistent and the IK really stands the animal taller.
   * Shading: a per-instance uniform darkens and desaturates the coat, opens wet bare-skin
     patches and engraves rib shadows; the eyes gain a pale emissive and eyeshine.
   * Posture: each kind layers a corrupted stance on top of every mode (head hanging low,
     arched spine, bolt-upright rabbit, wrong-angled deer head) and stops its idle "life"
     motion: corrupted animals are too still.

   Animation
   ---------
   Quadrupeds (wolf, deer, bear, rabbit, crawler) share one controller: a gait (walk /
   trot / gallop or hop, blended by speed: per-leg phase offsets, duty factor, stride =
   speed / frequency) places each paw in root space - planted paws move back at exactly
   the ground speed, so feet do not slide - and a 3D two-bone IK with a pole vector bends
   the leg (+ a cannon bone with its own tilt, + a foot bone). Modes write a small set of
   named pose channels; a mode change cross-fades from a snapshot of the last output.
   Birds, fish and moths have small controllers of their own on the same builder.
*/
import * as THREE from '../../lib/three.module.js';
import { rng, Noise, clamp, lerp, sstep, damp } from '../core/Util.js';
import { makeCanvas, toTex } from '../core/Textures.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const NZ = new Noise(5150);
const ONE = new V3(1, 1, 1);
const _e = new THREE.Euler(), _m = new THREE.Matrix4(), _mb = new THREE.Matrix4();
const _qp = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion(), _q4 = new THREE.Quaternion();
const _a = new V3(), _d = new V3(), _f = new V3(), _h = new V3(), _k = new V3(), _p = new V3(), _x = new V3(), _y = new V3(), _z = new V3(), _v = new V3(), _n = new V3();

const frac = x => x - Math.floor(x);
const smooth = u => u * u * (3 - 2 * u);
const bump = (u, a = 0, b = 1) => { const x = (u - a) / (b - a); return x <= 0 || x >= 1 ? 0 : Math.sin(Math.PI * x); };
const cr = (p0, p1, p2, p3, f) => 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
const hash1 = n => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const n1 = (x, s = 0) => NZ.n2(x, s * 7.31 + 0.5);
const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mulc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const fbm = (p, s, o = 0) => NZ.fbm3(p.x * s + o, p.y * s + o * 0.7, p.z * s - o * 0.3, 3);

/* ===================================================================== textures */
const TEX = {};
function sobel(c, strength) {
  const w = c.width, h = c.height, src = c.getContext('2d').getImageData(0, 0, w, h).data;
  const H = (x, y) => src[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  const o = makeCanvas(w, h), g = o.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = H(x + 1, y) - H(x - 1, y), dy = H(x, y + 1) - H(x, y - 1);
    let nx = -dx * strength, ny = dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4; d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return o;
}
/** body fur: short strokes running along v (the loft direction), tiling */
function furTex() {
  if (TEX.fur) return TEX.fur;
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d'), r = rng(11);
  g.fillStyle = '#bdbdbd'; g.fillRect(0, 0, S, S); g.lineCap = 'round';
  for (let i = 0; i < 7000; i++) {
    const x = r() * S, y = r() * S, len = 4 + r() * 12, a = Math.PI / 2 + (r() - 0.5) * 0.45, l = (110 + r() * 145) | 0;
    g.strokeStyle = `rgba(${l},${l},${l},${0.35 + r() * 0.5})`; g.lineWidth = 0.7 + r() * 1.4;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      const X = x + ox, Y = y + oy; if (X < -20 || X > S + 20 || Y < -20 || Y > S + 20) continue;
      g.beginPath(); g.moveTo(X, Y); g.lineTo(X + Math.cos(a) * len, Y + Math.sin(a) * len); g.stroke();
    }
  }
  TEX.fur = { map: toTex(c), normal: toTex(sobel(c, 2.5), { srgb: false }) };
  return TEX.fur;
}
/** fur clump cards: 4 clump shapes side by side, root at the bottom (v=0), alpha */
function cardTex() {
  if (TEX.card) return TEX.card;
  const W = 256, H = 128, c = makeCanvas(W, H), g = c.getContext('2d'), r = rng(23);
  g.clearRect(0, 0, W, H); g.lineCap = 'round';
  for (let k = 0; k < 4; k++) {
    const cx = k * 64 + 32;
    for (let i = 0; i < 140; i++) {
      const rx = cx + (r() - 0.5) * 26, tx = rx + (cx - rx) * 0.4 + (r() - 0.5) * (14 + k * 6), ty = 6 + r() * 60, mx = (rx + tx) / 2 + (r() - 0.5) * 6;
      const l = (150 + r() * 105) | 0, lr = (l * 0.78) | 0;
      const gr = g.createLinearGradient(0, H, 0, ty);
      gr.addColorStop(0, `rgba(${lr},${lr},${lr},1)`); gr.addColorStop(0.6, `rgba(${l},${l},${l},1)`); gr.addColorStop(1, `rgba(${l},${l},${l},0.35)`);
      g.strokeStyle = gr; g.lineWidth = 0.7 + r() * 1.3;
      g.beginPath(); g.moveTo(rx, H + 2); g.quadraticCurveTo(mx, (H + ty) / 2, tx, ty); g.stroke();
    }
  }
  TEX.card = alphaTex(c, 190);
  return TEX.card;
}
/** canvas with alpha -> DataTexture whose fully transparent texels keep a grey colour (no dark
    fringes from filtering), rows flipped so the canvas bottom is v = 0 */
function alphaTex(c, bg) {
  const w = c.width, h = c.height, src = c.getContext('2d').getImageData(0, 0, w, h).data, d = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4, a = src[i + 3] / 255;
    for (let k = 0; k < 3; k++) d[o + k] = a > 0.02 ? src[i + k] : bg;
    d[o + 3] = src[i + 3];
  }
  const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}
/** eye: bands down from the +Y pole (v=1): pupil, iris, sclera. emissive mask = pupil+iris */
function eyeTex(iris, pupil = 0.07, irisEnd = 0.2, sclera = '#1c130d') {
  const key = 'eye' + iris + pupil + irisEnd + sclera;
  if (TEX[key]) return TEX[key];
  const H = 128, c = makeCanvas(4, H), g = c.getContext('2d'), m = makeCanvas(4, H), gm = m.getContext('2d');
  g.fillStyle = sclera; g.fillRect(0, 0, 4, H);
  const gr = g.createLinearGradient(0, pupil * H, 0, irisEnd * H);
  gr.addColorStop(0, iris); gr.addColorStop(0.75, iris); gr.addColorStop(1, '#0b0705');
  g.fillStyle = gr; g.fillRect(0, pupil * H, 4, (irisEnd - pupil) * H);
  g.fillStyle = '#030202'; g.fillRect(0, 0, 4, pupil * H);
  gm.fillStyle = '#000'; gm.fillRect(0, 0, 4, H); gm.fillStyle = '#fff'; gm.fillRect(0, 0, 4, irisEnd * H * 1.05);
  TEX[key] = { map: toTex(c, { repeat: false }), emi: toTex(m, { repeat: false }) };
  return TEX[key];
}
/** bird wing / tail feathers: u along the span, v across the chord (v=1 leading edge) */
function featherTex() {
  if (TEX.feather) return TEX.feather;
  const W = 256, H = 128, c = makeCanvas(W, H), g = c.getContext('2d'), r = rng(31);
  g.clearRect(0, 0, W, H);
  // coverts: solid along the leading half
  g.fillStyle = 'rgb(200,200,200)'; g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H * 0.25); g.quadraticCurveTo(W * 0.5, H * 0.62, 0, H * 0.5); g.closePath(); g.fill();
  // flight feathers: long rounded blades toward the trailing edge, overlapping
  for (let i = 0; i < 26; i++) {
    const u = i / 25, x = u * W, len = H * (0.55 + 0.4 * Math.sin(u * Math.PI * 0.9 + 0.2)), wd = 9 + u * 6, ang = (u - 0.5) * 0.5;
    g.save(); g.translate(x, H * 0.18); g.rotate(ang);
    const l = (150 + r() * 70) | 0; g.fillStyle = `rgb(${l},${l},${l})`;
    g.beginPath(); g.ellipse(0, len * 0.5, wd * 0.5, len * 0.5, 0, 0, TAU); g.fill();
    g.strokeStyle = 'rgba(40,40,40,0.6)'; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, len * 0.95); g.stroke();
    g.restore();
  }
  for (let i = 0; i < 600; i++) { const x = r() * W, y = r() * H; const l = (120 + r() * 100) | 0; g.fillStyle = `rgba(${l},${l},${l},0.25)`; g.fillRect(x, y, 1, 3); }
  TEX.feather = alphaTex(c, 170);
  return TEX.feather;
}
/** moth wing: dusty mottled brown with an eye spot, alpha outline */
function mothTex() {
  if (TEX.moth) return TEX.moth;
  const S = 64, c = makeCanvas(S, S), g = c.getContext('2d'), r = rng(41);
  g.clearRect(0, 0, S, S);
  g.fillStyle = '#9a8a72'; g.beginPath(); g.moveTo(0, S * 0.45); g.quadraticCurveTo(S * 0.4, 0, S, S * 0.1); g.quadraticCurveTo(S * 0.9, S * 0.6, S * 0.5, S * 0.75); g.quadraticCurveTo(S * 0.4, S, 0, S * 0.6); g.closePath(); g.fill();
  for (let i = 0; i < 160; i++) { const l = (90 + r() * 90) | 0; g.fillStyle = `rgba(${l},${(l * 0.9) | 0},${(l * 0.75) | 0},0.35)`; g.fillRect(r() * S, r() * S, 2, 2); }
  g.globalCompositeOperation = 'source-atop';
  g.strokeStyle = 'rgba(60,48,36,0.7)'; g.lineWidth = 2; g.beginPath(); g.arc(S * 0.55, S * 0.4, 7, 0, TAU); g.stroke();
  g.fillStyle = 'rgba(50,40,30,0.8)'; g.beginPath(); g.arc(S * 0.55, S * 0.4, 3, 0, TAU); g.fill();
  TEX.moth = alphaTex(c, 150);
  return TEX.moth;
}
/** fish fin: translucent membrane with bony rays fanning from the base (v=0) */
function finTex() {
  if (TEX.fin) return TEX.fin;
  const W = 64, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(200,190,170,0.62)'; g.beginPath(); g.moveTo(0, H); g.lineTo(W, H); g.quadraticCurveTo(W, 4, W * 0.5, 2); g.quadraticCurveTo(0, 4, 0, H); g.fill();
  g.strokeStyle = 'rgba(120,105,90,0.9)'; g.lineWidth = 1.2;
  for (let i = 0; i <= 10; i++) { const x = (i / 10) * W; g.beginPath(); g.moveTo(W * 0.5 + (x - W * 0.5) * 0.3, H); g.lineTo(x, 6 + Math.abs(i - 5) * 3); g.stroke(); }
  TEX.fin = alphaTex(c, 180);
  return TEX.fin;
}
/** trout skin: scattered dark spots on white, tiling (multiplied with the vertex colours) */
function spotTex() {
  if (TEX.spot) return TEX.spot;
  const S = 128, c = makeCanvas(S, S), g = c.getContext('2d'), r = rng(51);
  g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 26; i++) {
    const x = r() * S, y = r() * S, rad = 5 + r() * 6;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.fillStyle = `rgba(30,24,20,${0.55 + r() * 0.35})`; g.beginPath(); g.arc(x + ox, y + oy, rad, 0, TAU); g.fill(); }
  }
  for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(255,255,255,${r() * 0.25})`; g.fillRect(r() * S, r() * S, 1, 1); }  // scale glints
  TEX.spot = toTex(c);
  return TEX.spot;
}

/* ===================================================================== builder
   Collects skinned surface parts. Weights are Maps boneIndex -> weight. Per-vertex info
   (tag, ring centre, loft direction, ...) is kept so colour / fur / corruption functions
   can reason about where a vertex is. build() returns a BufferGeometry with skinning,
   vertex colours, the aCor attribute (rib mask, bare-patch noise) and the corruption morph. */
function wmix(a, b, f) {
  const m = new Map();
  for (const [k, v] of a) m.set(k, (m.get(k) || 0) + v * (1 - f));
  for (const [k, v] of b) m.set(k, (m.get(k) || 0) + v * f);
  return m;
}
class Builder {
  constructor(bi) { this.bi = bi; this.pos = []; this.nor = []; this.uv = []; this.wt = []; this.inf = []; this.idx = []; this.parts = 0; this.fixedN = false; }
  get n() { return this.pos.length / 3; }
  W(b) {
    if (b instanceof Map) return b;
    if (typeof b === 'string') b = { [b]: 1 };
    const m = new Map();
    for (const k in b) { const i = this.bi[k]; if (i === undefined) throw new Error('AnimalArt: no bone ' + k); if (b[k] > 0) m.set(i, (m.get(i) || 0) + b[k]); }
    return m;
  }
  push(p, uv, w, info, nrm) {
    this.pos.push(p.x, p.y, p.z); this.uv.push(uv[0], uv[1]); this.wt.push(w); this.inf.push(info);
    if (nrm) this.nor.push(nrm.x, nrm.y, nrm.z);
    return this.n - 1;
  }
  P(i) { return new V3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]); }
  setP(i, p) { this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z; }

  /** keys: [{p:[x,y,z], w, t?, b?, bone, tag?, ...extra}] - w = half width, t/b = height above/below the centre line */
  loft(keysIn, o = {}) {
    const { ref = [0, 1, 0], uvs = 0.1, tag = 'body', flow = -1, cap0 = true, cap1 = true, shape = null } = o;
    if (this.skip && this.skip(o, tag)) return { base: this.n, count: 0, part: 0 };
    const res = this.res || 1, rings = Math.max(4, Math.round((o.rings || 16) * res)), radial = Math.max(6, Math.round((o.radial || 12) * Math.sqrt(res)));
    const keys = keysIn.map(k => ({ ...k, t: k.t ?? k.w, b: k.b ?? k.t ?? k.w, sq: k.sq ?? 2, W: this.W(k.bone ?? keysIn[0].bone) }));
    // a key without a bone inherits the previous key's bone
    for (let i = 1; i < keys.length; i++) if (keysIn[i].bone === undefined) keys[i].W = keys[i - 1].W;
    const n = keys.length, part = ++this.parts;
    const curve = new THREE.CatmullRomCurve3(keys.map(k => new V3(k.p[0], k.p[1], k.p[2])), false, 'centripetal');
    const L = curve.getLength(), R = new V3(ref[0], ref[1], ref[2]);
    const RD = []; let maxPer = 0;
    for (let r = 0; r < rings; r++) {
      const u = r / (rings - 1), tt = curve.getUtoTmapping(u);
      const fi = tt * (n - 1), i0 = Math.min(n - 2, Math.floor(fi)), f = fi - i0;
      const K = [keys[Math.max(0, i0 - 1)], keys[i0], keys[i0 + 1], keys[Math.min(n - 1, i0 + 2)]];
      const S = nm => cr(K[0][nm] ?? 0, K[1][nm] ?? 0, K[2][nm] ?? 0, K[3][nm] ?? 0, f);
      const ring = { r, u, f, S, w: Math.max(6e-4, S('w')), t: Math.max(6e-4, S('t')), b: Math.max(6e-4, S('b')),
        c: curve.getPoint(tt), T: curve.getTangent(tt).normalize(), W: wmix(K[1].W, K[2].W, f), tag: (f < 0.5 ? K[1] : K[2]).tag || tag };
      ring.X = new V3().crossVectors(R, ring.T); if (ring.X.lengthSq() < 1e-8) ring.X.set(1, 0, 0); ring.X.normalize();
      ring.Y = new V3().crossVectors(ring.T, ring.X).normalize();
      const a = ring.w, bb = (ring.t + ring.b) / 2;
      maxPer = Math.max(maxPer, Math.PI * (3 * (a + bb) - Math.sqrt((3 * a + bb) * (a + 3 * bb))));
      RD.push(ring);
    }
    const uRep = Math.max(1, Math.round(maxPer / uvs)), base = this.n, rl = radial + 1;
    for (const ring of RD) {
      for (let j = 0; j <= radial; j++) {
        const a = -Math.PI / 2 + (j / radial) * TAU, ca = Math.cos(a), sa = Math.sin(a);
        const e = 2 / Math.max(1.2, ring.S('sq') || 2);      // superellipse: sq > 2 = boxier section
        const cx = Math.sign(ca) * Math.pow(Math.abs(ca), e), sy = Math.sign(sa) * Math.pow(Math.abs(sa), e);
        let lx = ring.w * cx, ly = sy > 0 ? ring.t * sy : ring.b * sy, lz = 0;
        if (shape) { const s = shape(lx, ly, a, ring); lx = s[0]; ly = s[1]; lz = s[2] || 0; }
        const p = ring.c.clone().addScaledVector(ring.X, lx).addScaledVector(ring.Y, ly).addScaledVector(ring.T, lz);
        this.push(p, [(j / radial) * uRep, ring.u * L / uvs], ring.W, { tag: ring.tag, part, s: ring.u, a, ca, sa, c: ring.c, T: ring.T, X: ring.X, flow, ring: ring.r, len: L });
      }
    }
    for (let r = 0; r < rings - 1; r++) for (let j = 0; j < radial; j++) {
      const a = base + r * rl + j, b = a + rl;
      this.idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const cap = (ring, end) => {
      const ext = Math.min(ring.w, (ring.t + ring.b) / 2) * 0.55 * (end ? 1 : -1);
      const p = ring.c.clone().addScaledVector(ring.T, ext);
      const ci = this.push(p, [0, (end ? L : 0) / uvs], ring.W, { tag: ring.tag, part, s: end ? 1 : 0, a: 0, ca: 0, sa: 0, c: ring.c, T: ring.T, X: ring.X, flow, cap: true, len: L });
      const r0 = base + ring.r * rl;
      for (let j = 0; j < radial; j++) { const a = r0 + j; if (end) this.idx.push(ci, a, a + 1); else this.idx.push(ci, a + 1, a); }
    };
    if (cap0) cap(RD[0], false);
    if (cap1) cap(RD[rings - 1], true);
    return { base, count: this.n - base, part };
  }
  /** any three geometry, rigidly weighted (bone name or weight object) */
  geo(g, bone, info = {}) {
    const base = this.n, p = g.attributes.position, uv = g.attributes.uv, W = this.W(bone), part = ++this.parts, nr = g.attributes.normal;
    for (let i = 0; i < p.count; i++) this.push(new V3().fromBufferAttribute(p, i), uv ? [uv.getX(i), uv.getY(i)] : [0, 0], W, { tag: 'hard', ...info, part, s: 0, c: info.c || new V3().fromBufferAttribute(p, i), T: new V3(0, 0, 1), flow: 1 }, this.fixedN && nr ? new V3().fromBufferAttribute(nr, i) : null);
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    return { base, count: this.n - base, part };
  }
  normals(P) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setIndex(this.idx); g.computeVertexNormals();
    const N = g.attributes.normal.array, m = new Map();
    for (let i = 0; i < this.n; i++) {
      const k = this.inf[i].part + ':' + Math.round(P[i * 3] * 2e4) + ',' + Math.round(P[i * 3 + 1] * 2e4) + ',' + Math.round(P[i * 3 + 2] * 2e4);
      let a = m.get(k); if (!a) m.set(k, a = [0, 0, 0, []]);
      a[0] += N[i * 3]; a[1] += N[i * 3 + 1]; a[2] += N[i * 3 + 2]; a[3].push(i);
    }
    for (const a of m.values()) {
      if (a[3].length < 2) continue;
      const l = Math.hypot(a[0], a[1], a[2]) || 1;
      for (const i of a[3]) { N[i * 3] = a[0] / l; N[i * 3 + 1] = a[1] / l; N[i * 3 + 2] = a[2] / l; }
    }
    return N;
  }
  build({ color, aux, morph } = {}) {
    const nv = this.n, g = new THREE.BufferGeometry();
    const P = new Float32Array(this.pos);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    const N = this.fixedN ? new Float32Array(this.nor) : this.normals(P);
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    const SI = new Uint16Array(nv * 4), SW = new Float32Array(nv * 4);
    for (let i = 0; i < nv; i++) {
      const e = [...this.wt[i]].sort((a, b) => b[1] - a[1]).slice(0, 4); let s = 0; for (const x of e) s += x[1];
      e.forEach((x, k) => { SI[i * 4 + k] = x[0]; SW[i * 4 + k] = x[1] / (s || 1); });
    }
    g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
    const p = new V3(), n = new V3();
    const C = new Float32Array(nv * 3), A = new Float32Array(nv * 2), D = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); n.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
      const I = this.inf[i];
      const k = color ? color(p, n, I, i) : [1, 1, 1]; C[i * 3] = k[0]; C[i * 3 + 1] = k[1]; C[i * 3 + 2] = k[2];
      if (aux) { const x = aux(p, n, I, i); A[i * 2] = x[0]; A[i * 2 + 1] = x[1]; }
      if (morph) { const d = morph(p, n, I, i); D[i * 3] = d[0]; D[i * 3 + 1] = d[1]; D[i * 3 + 2] = d[2]; }
    }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.setAttribute('aCor', new THREE.BufferAttribute(A, 2));
    if (morph) {
      g.morphAttributes.position = [new THREE.BufferAttribute(D, 3)];
      if (!this.fixedN) {
        const P2 = new Float32Array(nv * 3); for (let i = 0; i < nv * 3; i++) P2[i] = P[i] + D[i];
        const N2 = this.normals(P2), DN = new Float32Array(nv * 3); for (let i = 0; i < nv * 3; i++) DN[i] = N2[i] - N[i];
        g.morphAttributes.normal = [new THREE.BufferAttribute(DN, 3)];
      }
      g.morphTargetsRelative = true;
    }
    g.computeBoundingBox(); g.computeBoundingSphere();
    g.userData.D = D; g.userData.C = C; g.userData.A = A;
    return g;
  }
}

/** fur clump cards rooted on body vertices. fur(p, n, I) -> [probability, length, width] or 0 */
function buildCards(body, geo, fur, seed, corrupt) {
  const cb = new Builder(body.bi); cb.fixedN = true;
  const r = rng(seed), P = geo.attributes.position.array, N = geo.attributes.normal.array, C = geo.userData.C, A = geo.userData.A, D = geo.userData.D;
  const roots = [];
  const p = new V3(), n = new V3(), dir = new V3(), side = new V3(), fl = new V3(), tipN = new V3();
  for (let i = 0; i < body.n; i++) {
    const I = body.inf[i]; if (I.cap) continue;
    p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); n.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    const f = fur(p, n, I); if (!f || r() > f[0]) continue;
    const len = f[1] * (0.7 + r() * 0.6), wid = f[2] * (0.75 + r() * 0.5);
    fl.copy(I.T).multiplyScalar(I.flow);
    dir.copy(fl).multiplyScalar(0.78).addScaledVector(n, f[3] ?? 0.5); dir.x += (r() - 0.5) * 0.3; dir.y += (r() - 0.5) * 0.2; dir.z += (r() - 0.5) * 0.3; dir.normalize();
    side.crossVectors(n, dir); if (side.lengthSq() < 1e-6) side.set(1, 0, 0); side.normalize();
    const root = p.clone().addScaledVector(n, -0.003), cell = r() * 4 | 0, u0 = cell / 4, u1 = u0 + 0.25;
    tipN.copy(n).addScaledVector(dir, 0.35).normalize();
    const k = 0.92 + r() * 0.16, col = [C[i * 3] * k, C[i * 3 + 1] * k, C[i * 3 + 2] * k];
    const info = { tag: I.tag, root: i, col, part: 0, c: root, T: I.T, flow: I.flow };
    const v = [
      [root.clone().addScaledVector(side, -wid * 0.5), [u0, 0], n, 0, -1],
      [root.clone().addScaledVector(side, wid * 0.5), [u1, 0], n, 0, 1],
      [root.clone().addScaledVector(dir, len).addScaledVector(side, -wid * 0.42), [u0, 1], tipN, 1, -1],
      [root.clone().addScaledVector(dir, len).addScaledVector(side, wid * 0.42), [u1, 1], tipN, 1, 1],
    ];
    const b0 = cb.n;
    for (const [q, uv, nn, tip, sd] of v) cb.push(q, uv, body.wt[i], { ...info, tip, sd, dir: dir.clone(), side: side.clone(), len, wid }, nn);
    cb.idx.push(b0, b0 + 1, b0 + 2, b0 + 2, b0 + 1, b0 + 3);
    roots.push(i);
  }
  return cb.build({
    color: (q, nn, I) => I.col,
    aux: (q, nn, I) => [0, A[I.root * 2 + 1]],
    morph: (q, nn, I) => {
      const ri = I.root, d = [D[ri * 3], D[ri * 3 + 1], D[ri * 3 + 2]];
      const patch = A[ri * 2 + 1];
      if (corrupt && patch > 0.56) {            // bare patch: the clump is gone
        d[0] += I.c.x - q.x; d[1] += I.c.y - q.y; d[2] += I.c.z - q.z;
      } else if (corrupt) {                      // matted: narrow wet spikes
        const s = I.sd * I.wid * (I.tip ? 0.36 : 0.3);
        d[0] -= I.side.x * s; d[1] -= I.side.y * s; d[2] -= I.side.z * s;
        if (I.tip) { d[0] += I.dir.x * I.len * 0.45; d[1] += I.dir.y * I.len * 0.45; d[2] += I.dir.z * I.len * 0.45; }
      }
      return d;
    },
  });
}

/** muscle / bone masses: gaussian bumps pushed out from the loft axis (mirrored to both sides) */
function applyBumps(B, bumps) {
  if (!bumps) return;
  const d = new V3();
  for (let i = 0; i < B.n; i++) {
    const I = B.inf[i]; if (I.cap) continue;
    const p = B.P(i); let push = 0;
    for (const b of bumps) {
      if (b.tags && !b.tags.includes(I.tag)) continue;
      for (const s of b.c[0] === 0 ? [1] : [1, -1]) {
        const dx = (p.x - s * b.c[0]) / b.r[0], dy = (p.y - b.c[1]) / b.r[1], dz = (p.z - b.c[2]) / b.r[2];
        push += b.a * Math.exp(-(dx * dx + dy * dy + dz * dz) * 2);
      }
    }
    if (push) { d.copy(p).sub(I.c); d.addScaledVector(I.T, -d.dot(I.T)); if (d.lengthSq() < 1e-12) continue; d.normalize(); B.setP(i, p.addScaledVector(d, push)); }
  }
}
/** fur shells: a coarse copy of the body, repeated in `layers` copies that the vertex shader
    pushes out along the normal (and combs along the hair flow); strands are cut in the fragment */
function buildShells(SB, opt, layers) {
  const g = SB.build(opt), n = SB.n, P = g.attributes.position.array, N = g.attributes.normal.array;
  const F = new Float32Array(n * 4), p = new V3(), nn = new V3(), fl = new V3();
  for (let i = 0; i < n; i++) {
    const I = SB.inf[i];
    p.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); nn.set(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]);
    const l = I.cap ? 0 : opt.furLen(p, nn, I);
    fl.copy(I.T).multiplyScalar(I.flow); fl.addScaledVector(nn, -fl.dot(nn)); if (fl.lengthSq() > 1e-8) fl.normalize();
    fl.y -= 0.35; // hair hangs a little
    F.set([fl.x, fl.y, fl.z, Math.max(0, l)], i * 4);
  }
  const src = g.index.array, keep = [];
  for (let t = 0; t < src.length; t += 3) { const a = src[t], b = src[t + 1], c = src[t + 2]; if (F[a * 4 + 3] + F[b * 4 + 3] + F[c * 4 + 3] > 0.004) keep.push(a, b, c); }
  const tile = arr => { const o = new arr.constructor(arr.length * layers); for (let l = 0; l < layers; l++) o.set(arr, l * arr.length); return o; };
  const out = new THREE.BufferGeometry();
  for (const k in g.attributes) { const a = g.attributes[k]; out.setAttribute(k, new THREE.BufferAttribute(tile(a.array), a.itemSize, a.normalized)); }
  out.setAttribute('aFur', new THREE.BufferAttribute(tile(F), 4));
  const sh = new Float32Array(n * layers); for (let l = 0; l < layers; l++) sh.fill((l + 1) / layers, l * n, (l + 1) * n);
  out.setAttribute('aShell', new THREE.BufferAttribute(sh, 1));
  for (const k in g.morphAttributes) out.morphAttributes[k] = g.morphAttributes[k].map(a => new THREE.BufferAttribute(tile(a.array), 3));
  out.morphTargetsRelative = true;
  const idx = []; for (let l = 0; l < layers; l++) for (const k of keep) idx.push(k + l * n);
  out.setIndex(idx);
  out.computeBoundingSphere();
  return out;
}

/* ===================================================================== materials */
const FUR_VERT = `#include <common>
attribute vec2 aCor; varying vec2 vCor; varying vec3 vBP; uniform float uCor; uniform float uPatch;
#ifdef WD_SHELL
attribute float aShell; attribute vec4 aFur; varying float vSh; varying vec2 vSU;
#endif`;
const SHELL_VERT = `#include <morphtarget_vertex>
#ifdef WD_SHELL
  transformed += normal * (aFur.w * aShell * mix(1.0, 0.7, uCor)) + aFur.xyz * (aFur.w * aShell * aShell * 0.85);
  vSh = aShell; vSU = uv;
#endif`;
const FUR_FRAG = `#include <common>
uniform float uCor; uniform float uRib; uniform float uRibF; uniform float uDark; uniform float uPatch; uniform vec3 uSkin; uniform vec3 uTint; uniform float uDens; uniform float uUnder;
varying vec2 vCor; varying vec3 vBP; float wdPatch = 0.0;
float wdH(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
#ifdef WD_SHELL
varying float vSh; varying vec2 vSU;
#endif`;
const FUR_COLOR = `#include <color_fragment>
#ifdef WD_SHELL
{
  vec2 g = vSU * uDens * mix(1.0, 0.5, uCor) + vec2(0.0, vSh * 0.35);   // clumps lean along the flow
  vec2 id = floor(g), f = fract(g) - 0.5;
  vec2 o = vec2(wdH(id), wdH(id + 7.31)) - 0.5;
  float hgt = 0.35 + 0.65 * wdH(id + 3.17);
  float rel = vSh / hgt;
  float rad = 0.62 * (1.0 - rel * 0.75);
  float a = (1.0 - smoothstep(rad * 0.45, rad, length((f - o * 0.35) * vec2(1.0, 0.7)))) * step(rel, 1.0);
  float fw = length(fwidth(g));
  a = mix(a, (1.0 - vSh) * 0.75, smoothstep(0.5, 1.4, fw));
  a *= 1.0 - smoothstep(0.54, 0.6, vCor.y) * uCor * uPatch;
  diffuseColor.a = a;
  float tip = wdH(id + 9.7);
  diffuseColor.rgb *= mix(0.62, 1.12, vSh) * (0.8 + 0.4 * tip);
}
#else
  diffuseColor.rgb *= uUnder;
#endif
{
  vec3 col = diffuseColor.rgb * uTint;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, mix(vec3(lum), col, 0.5) * uDark, uCor);
  float rib = vCor.x * uRib;
  float rg = sin((vBP.z + vBP.y * 0.45) * uRibF);
  col *= 1.0 - rib * smoothstep(0.0, 0.9, rg) * 0.62;
  col *= 1.0 + rib * smoothstep(0.5, 1.0, -rg) * 0.3;
  wdPatch = smoothstep(0.54, 0.6, vCor.y) * uCor * uPatch;
  col = mix(col, uSkin * (0.8 + 0.4 * fract(vCor.y * 37.0)), wdPatch);
  diffuseColor.rgb = col;
}`;
/** per-instance fur material; programs are shared through customProgramCacheKey */
function furMat(K, U, mode) {
  const T = furTex(), cards = mode === 'cards', shell = mode === 'shell';
  const m = new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    map: cards ? (K.cardMap ? K.cardMap() : cardTex()) : shell ? null : K.bodyMap ? K.bodyMap() : K.noFurTex ? null : T.map,
    normalMap: cards || shell || K.noFurTex ? null : T.normal,
    normalScale: new THREE.Vector2(K.normalK ?? 0.6, K.normalK ?? 0.6),
    roughness: K.rough ?? 0.86, metalness: K.metal ?? 0,
    sheen: (K.sheen ?? 0.7) * (shell ? 0.4 : 1), sheenRoughness: 0.5, sheenColor: new THREE.Color(K.sheenColor ?? 0x6f6458),
    clearcoat: K.clearcoat ?? 0, clearcoatRoughness: 0.35,
    side: cards || K.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: cards ? (K.cardAlpha ?? 0.4) : shell ? 0.2 : 0, alphaToCoverage: cards || shell,
  });
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    Object.assign(sh.uniforms, U);
    const def = shell ? '#define WD_SHELL\n' : '';
    sh.vertexShader = def + sh.vertexShader.replace('#include <common>', FUR_VERT).replace('#include <begin_vertex>', '#include <begin_vertex>\nvCor = aCor; vBP = position;').replace('#include <morphtarget_vertex>', SHELL_VERT);
    sh.fragmentShader = def + sh.fragmentShader.replace('#include <common>', FUR_FRAG).replace('#include <color_fragment>', FUR_COLOR)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.62, wdPatch);')
      .replace('#include <lights_physical_fragment>', '#include <lights_physical_fragment>\n#ifdef USE_SHEEN\nmaterial.sheenColor *= 1.0 - wdPatch;\n#endif');
    // fur cards carry the body normal: never flip it for back faces
    if (cards) sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('gl_FrontFacing ? 1.0 : - 1.0', '1.0'));
  };
  m.customProgramCacheKey = () => 'wdAnimalFur' + mode + (m.map ? 'm' : '') + (K.doubleSide ? 'd' : '');
  return m;
}
function eyeMat(K) {
  const T = eyeTex(K.eye.iris, K.eye.pupil, K.eye.irisEnd, K.eye.sclera);
  return new THREE.MeshPhysicalMaterial({ map: T.map, emissiveMap: T.emi, emissive: new THREE.Color(K.eye.glow ?? 0xd8ffe4), emissiveIntensity: 0, roughness: 0.15, clearcoat: 1, clearcoatRoughness: 0.03 });
}
function glintMat(color) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uI: { value: 0 }, uCol: { value: new THREE.Color(color) }, uSize: { value: 0.035 }, uScreen: { value: 720 }, uMin: { value: 3.0 } },
    vertexShader: `attribute vec3 aDir; uniform float uSize, uScreen, uMin; varying float vF;
      void main() { vec4 mv = modelViewMatrix * vec4(position, 1.0); vec3 d = normalize(normalMatrix * aDir);
        vF = pow(max(dot(d, normalize(-mv.xyz)), 0.0), 1.5);
        gl_Position = projectionMatrix * mv; float px = uSize * projectionMatrix[1][1] * uScreen * 0.5 / max(-mv.z, 0.01);
        gl_PointSize = max(px, uMin); vF *= clamp(px / uMin, 0.6, 1.0); }`,
    fragmentShader: `uniform float uI; uniform vec3 uCol; varying float vF;
      void main() { vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q); if (r > 1.0) discard;
        float a = exp(-r * 5.0) + exp(-r * 40.0) * 1.5; gl_FragColor = vec4(uCol * a * uI * vF, 1.0); }`,
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false,
  });
  return m;
}

/* ===================================================================== skeleton + rig
   bones: [[name, parentName|null, [x,y,z] bind (model space), regionTag]]. Bind rotations are
   identity, so a bone inverse is just a translation; corrupted bind = bind + stretch(bind). */
function stretchFn(regions) {
  return (p, tag) => {
    let dx = 0, dy = 0, dz = 0;
    if (regions) for (const R of regions) {
      if (!R.tags.includes(tag)) continue;
      const d = (p.x - R.base[0]) * R.axis[0] + (p.y - R.base[1]) * R.axis[1] + (p.z - R.base[2]) * R.axis[2];
      const s = clamp(d, 0, R.len ?? 99) * R.k;
      dx += R.axis[0] * s; dy += R.axis[1] * s; dz += R.axis[2] * s;
    }
    return [dx, dy, dz];
  };
}
function skeletonDef(bones, regions) {
  const names = bones.map(b => b[0]), bi = {}; names.forEach((n, i) => (bi[n] = i));
  const par = bones.map(b => (b[1] ? bi[b[1]] : -1));
  const bind = bones.map(b => new V3(...b[2])), region = bones.map(b => b[3] || 'torso');
  const st = stretchFn(regions);
  const bindC = bind.map((p, i) => { const d = st(p, region[i]); return p.clone().add(new V3(d[0], d[1], d[2])); });
  return { names, bi, par, bind, bindC, region, stretch: st };
}
class Rig {
  constructor(S) {
    this.S = S; const n = S.names.length;
    this.bones = S.names.map(nm => { const b = new THREE.Bone(); b.name = nm; return b; });
    this.lp = S.bind.map(() => new V3());
    this.mp = S.bind.map(p => p.clone());
    const inv = S.bind.map(p => new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    for (let i = 0; i < n; i++) if (S.par[i] >= 0) this.bones[S.par[i]].add(this.bones[i]);
    this.skeleton = new THREE.Skeleton(this.bones, inv);
    this.setC(0);
  }
  setC(c) {
    const S = this.S;
    for (let i = 0; i < S.names.length; i++) {
      this.mp[i].lerpVectors(S.bind[i], S.bindC[i], c);
      const m = this.mp[i]; this.skeleton.boneInverses[i].makeTranslation(-m.x, -m.y, -m.z);
    }
    for (let i = 0; i < S.names.length; i++) {
      const pi = S.par[i];
      if (pi >= 0) this.lp[i].subVectors(this.mp[i], this.mp[pi]); else this.lp[i].copy(this.mp[i]);
      this.bones[i].position.copy(this.lp[i]);
    }
  }
}
function basisQ(xa, ya, out) {
  _x.copy(xa).addScaledVector(ya, -xa.dot(ya)).normalize();
  _z.crossVectors(_x, ya);
  _mb.makeBasis(_x, ya, _z);
  return out.setFromRotationMatrix(_mb);
}

/* ===================================================================== quadruped definitions
   A quadruped spec is plain data + a few functions; finishQuad() turns it into a cached kind
   (skeleton, geometries) and createQuad() makes instances. */
function quadBones(sp) {
  const B = [];
  B.push(['body', null, [0, sp.body, 0], 'torso']);
  B.push(['spineB', 'body', [0, sp.spineB[0], sp.spineB[1]], 'torso']);
  B.push(['spineF', 'body', [0, sp.spineF[0], sp.spineF[1]], sp.spineFReg || 'torso']);
  sp.tail.forEach((t, i) => B.push(['tail' + (i + 1), i ? 'tail' + i : 'spineB', [0, t[0], t[1]], 'tail']));
  sp.neck.forEach((t, i) => B.push(['neck' + (i + 1), i ? 'neck' + i : 'spineF', [0, t[0], t[1]], 'neck']));
  B.push(['head', 'neck' + sp.neck.length, [0, sp.head[0], sp.head[1]], 'head']);
  B.push(['jaw', 'head', [0, sp.jaw[0], sp.jaw[1]], 'jaw']);
  if (sp.ear) for (const s of [1, -1]) B.push([s > 0 ? 'earL' : 'earR', 'head', [s * sp.ear[0], sp.ear[1], sp.ear[2]], 'ear']);
  for (const [fh, L] of [['F', sp.legF], ['H', sp.legH]]) for (const s of [1, -1]) {
    const id = (s > 0 ? 'L' : 'R') + fh, par = fh === 'F' ? 'spineF' : 'spineB', reg = 'leg' + fh; let y = L.y;
    B.push([id + 'u', par, [s * L.x, y, L.z], reg]); y -= L.L[0];
    B.push([id + 'l', id + 'u', [s * L.x, y, L.z], reg]); y -= L.L[1];
    B.push([id + 'c', id + 'l', [s * L.x, y, L.z], reg]); y -= L.L[2];
    B.push([id + 'f', id + 'c', [s * L.x, y, L.z], reg]);
  }
  return B;
}
/** leg loft hanging straight down from the top joint. prof rows: [d, w, t(front), b(back), zOff, bone, xOff]
    bone: 'P' parent spine | 'u' | 'l' | 'c' | 'f' | [boneA, boneB, f] blend */
function legLoft(B, sp, fh, s, prof, o = {}) {
  const L = fh === 'F' ? sp.legF : sp.legH, id = (s > 0 ? 'L' : 'R') + fh, par = fh === 'F' ? 'spineF' : 'spineB';
  const nm = k => (k === 'P' ? par : id + k);
  const keys = prof.map(([d, w, t, b, zo = 0, bone = 'u', xo = 0]) => ({
    p: [s * (L.x + xo), L.y - d, L.z + zo], w, t, b,
    bone: typeof bone === 'string' ? nm(bone) : { [nm(bone[0])]: 1 - bone[2], [nm(bone[1])]: bone[2] },
  }));
  return B.loft(keys, { rings: o.rings || 16, radial: o.radial || 10, ref: [0, 0, 1], uvs: o.uvs || 0.08, tag: 'leg' + fh, flow: 1, cap0: false, cap1: o.cap1 ?? false });
}
/** paw / hoof base under the foot bone, pointing +Z */
function pawLoft(B, sp, fh, s, o) {
  const L = fh === 'F' ? sp.legF : sp.legH, id = (s > 0 ? 'L' : 'R') + fh;
  const fy = L.y - L.L[0] - L.L[1] - L.L[2], x = s * L.x, z = L.z, h = o.h, w = o.w;
  const keys = [
    { p: [x, fy + h * 0.25, z - o.back], w: w * 0.55, t: h * 0.35, b: h * 0.3, bone: id + 'f' },
    { p: [x, fy - h * 0.1, z - o.back * 0.2], w: w * 0.95, t: h * 0.55, b: h * 0.55 },
    { p: [x, fy - h * 0.2, z + o.len * 0.55], w, t: h * 0.42, b: h * 0.45 },
    { p: [x, fy - h * 0.3, z + o.len], w: w * 0.45, t: h * 0.2, b: h * 0.18 },
  ];
  return B.loft(keys, { rings: o.rings || 7, radial: o.radial || 10, uvs: 0.05, tag: 'paw' + fh, flow: 1 });
}
/** an ear loft standing up from its base, cupped toward the front */
function earLoft(B, base, tip, w, o = {}) {
  const k = o.keys || [[0, 1, 0.34, 0.5], [0.45, 0.82, 0.28, 0.36], [0.82, 0.42, 0.16, 0.2], [1, 0.05, 0.05, 0.05]];
  const keys = k.map(([u, ww, tt, bb]) => ({ p: [lerp(base[0], tip[0], u) + (o.bend || 0) * Math.sin(u * Math.PI) * Math.sign(base[0]), lerp(base[1], tip[1], u), lerp(base[2], tip[2], u)], w: w * ww, t: w * tt, b: w * bb, cup: (o.cup ?? 0.5) * w * ww, bone: o.bone }));
  return B.loft(keys, {
    rings: o.rings || 6, radial: o.radial || 10, ref: o.ref || [0, 0, 1], uvs: 0.04, tag: 'ear', flow: 1, cap0: false,
    shape: (lx, ly, a, ring) => { const ca = Math.cos(a); if (ly > 0) ly = ly - ring.S('cup') * (1 - ca * ca); return [lx, ly]; },
  });
}

/* gaits: per gait [speed m/s, stride frequency Hz, duty factor]; offsets [LF, RF, LH, RH] */
function gaitAt(G, v) {
  const gs = [G.walk, G.trot, G.gallop], offs = [G.offWalk, G.offTrot, G.offGallop];
  let g;
  if (v <= gs[0][0]) g = 0; else if (v <= gs[1][0]) g = smooth((v - gs[0][0]) / (gs[1][0] - gs[0][0])); else if (v <= gs[2][0]) g = 1 + smooth((v - gs[1][0]) / (gs[2][0] - gs[1][0])); else g = 2;
  const i = Math.min(1, Math.floor(g)), f = g - i, A = gs[i], Bq = gs[i + 1];
  let freq;
  if (v <= gs[0][0]) freq = gs[0][1] * Math.max(0.35, Math.sqrt(v / gs[0][0]));
  else if (v > gs[2][0]) freq = gs[2][1] * Math.pow(v / gs[2][0], 0.3);
  else { const j = v <= gs[1][0] ? 0 : 1; const u = (v - gs[j][0]) / (gs[j + 1][0] - gs[j][0]); freq = lerp(gs[j][1], gs[j + 1][1], u); }
  const off = [0, 1, 2, 3].map(k => { const a = offs[i][k]; let d = (offs[i + 1][k] - a) % 1; if (d > 0.5) d -= 1; if (d < -0.5) d += 1; return a + d * f; });
  return { g, f: freq, duty: lerp(A[2], Bq[2], f), off, lift: lerp(G.lift[i], G.lift[i + 1], f), bob: lerp(G.bob[i], G.bob[i + 1], f), gal: clamp(g - 1, 0, 1) };
}

const KINDS = {};
const CACHE = new Map();

function finishQuad(spec) {
  // quadrupeds get the standard rig from spec.sp; birds/fish/moths pass their own spec.bones + spec.Ctrl
  const S = skeletonDef(spec.bones || quadBones(spec.sp), spec.stretch);
  const K = { ...spec, S, quad: !spec.Ctrl };
  // legs
  K.legs = [];
  if (spec.leg) for (const fh of ['F', 'H']) for (const s of [1, -1]) {
    const id = (s > 0 ? 'L' : 'R') + fh, L = fh === 'F' ? spec.sp.legF : spec.sp.legH, cfg = spec.leg[fh];
    const iu = S.bi[id + 'u'], il = S.bi[id + 'l'], ic = S.bi[id + 'c'], ifo = S.bi[id + 'f'];
    K.legs.push({ id, front: fh === 'F', side: s, iu, il, ic, if: ifo, x: s * L.x * (cfg.footX ?? 0.9), z: L.z, top: L.y, L0: L.L.slice(), ...cfg,
      pole: new V3(...(cfg.pole || (fh === 'F' ? [0, 0, -1] : [0, 0, 1]))).multiply(new V3(s, 1, 1)) });
  }
  // the four legs are LF RF LH RH in that order
  const ix = { body: S.bi.body, spineB: S.bi.spineB, spineF: S.bi.spineF, head: S.bi.head, jaw: S.bi.jaw, earL: S.bi.earL ?? -1, earR: S.bi.earR ?? -1, tail: [], neck: [] };
  for (let i = 1; S.bi['tail' + i] !== undefined; i++) ix.tail.push(S.bi['tail' + i]);
  for (let i = 1; S.bi['neck' + i] !== undefined; i++) ix.neck.push(S.bi['neck' + i]);
  K.ix = ix;
  // ---- body surface
  const B = new Builder(S.bi);
  spec.body(B, spec.sp);
  applyBumps(B, spec.bumps);
  if (spec.post) spec.post(B);
  // eyes: find the head surface along a ray, carve a socket around the eyeball
  K.eyes = [];
  if (spec.eye) for (const s of [1, -1]) {
    const E = spec.eye, from = new V3(E.from[0] * s, E.from[1], E.from[2]), dir = new V3(E.dir[0] * s, E.dir[1], E.dir[2]).normalize();
    let best = 0;
    for (let i = 0; i < B.n; i++) {
      if (B.inf[i].tag !== 'head') continue;
      const q = B.P(i).sub(from), t = q.dot(dir); if (t <= 0) continue;
      if (q.addScaledVector(dir, -t).length() < E.r * 1.6) best = Math.max(best, t);
    }
    const ctr = from.clone().addScaledVector(dir, best - E.r * (E.sink ?? 0.45));
    K.eyes.push({ c: ctr, dir, r: E.r });
    for (let i = 0; i < B.n; i++) {
      if (B.inf[i].tag !== 'head') continue;
      const q = B.P(i), dv = q.clone().sub(ctr), dl = dv.length(), R = E.r * (E.lid ?? 1.12);
      if (dl < R * 1.5 && dv.dot(dir) > -E.r * 0.2) { const k = dl < R ? R / Math.max(dl, 1e-4) : 1 + (1 - (dl - R) / (R * 0.5)) * 0.04; B.setP(i, ctr.clone().addScaledVector(dv, k)); }
    }
  }
  const morph = (p, n, I) => { const d = S.stretch(p, I.tag); const e = spec.corrupt ? spec.corrupt(p, n, I) : [0, 0, 0]; return [d[0] + e[0], d[1] + e[1], d[2] + e[2]]; };
  K.bodyGeo = B.build({ color: spec.color, aux: spec.aux || (() => [0, 0.5]), morph });
  K.bodyTris = B.idx.length / 3;
  K.cardGeo = spec.fur ? buildCards(B, K.bodyGeo, spec.fur, 77, !spec.noCorrupt) : null;
  if (spec.cards) {   // hand-built alpha surfaces: wings, tail fans, fins
    const CB = new Builder(S.bi); CB.fixedN = true; spec.cards(CB);
    K.cardGeo = CB.build({ color: (p, n, I) => I.col || [1, 1, 1], aux: () => [0, 0.5], morph: (p, n, I) => (I.rag ? [I.rag.x, I.rag.y, I.rag.z] : [0, 0, 0]) });
  }
  if (spec.furLen) {
    const SB = new Builder(S.bi); SB.res = spec.shellRes ?? 0.5;
    SB.skip = (o, tag) => (spec.shellSkip || []).includes(tag);
    spec.body(SB, spec.sp); applyBumps(SB, spec.bumps); if (spec.post) spec.post(SB);
    const eyeK = (p) => { let k = 1; for (const E of K.eyes) k *= sstep(E.r * 1.4, E.r * 3.2, p.distanceTo(E.c)); return k; };
    K.shellGeo = buildShells(SB, { color: spec.color, aux: spec.aux || (() => [0, 0.5]), morph, furLen: (p, n, I) => spec.furLen(p, n, I) * eyeK(p) }, spec.shellLayers ?? 5);
  }
  const H = new Builder(S.bi);
  if (spec.hard) spec.hard(H, spec.sp, K);
  // hard parts: stretch with their region; "grow" parts (corruption thorns) are stored collapsed and the morph unfolds them
  K.hardGeo = H.n ? H.build({ color: (p, n, I) => I.col || [0.05, 0.04, 0.04], morph: (p, n, I) => { const d = S.stretch(p, I.region || I.tag); if (I.grow) { d[0] += I.grow.x; d[1] += I.grow.y; d[2] += I.grow.z; } return d; } }) : null;
  // eyes geometry (model space, re-parented to the head bone at runtime)
  if (K.eyes.length) {
    const eg = [];
    for (const E of K.eyes) {
      const g = new THREE.SphereGeometry(E.r, ...(spec.eye.seg || [10, 7]));
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), E.dir)); g.translate(E.c.x, E.c.y, E.c.z); eg.push(g);
    }
    K.eyeGeo = mergeIndexed(eg);
    // morph: each eyeball swells about its own centre (corrupted rabbits)
    const grow = spec.eye.grow ?? 0, ep = K.eyeGeo.attributes.position, ed = new Float32Array(ep.count * 3), per = ep.count / K.eyes.length;
    for (let i = 0; i < ep.count; i++) { const E = K.eyes[Math.floor(i / per)]; ed[i * 3] = (ep.getX(i) - E.c.x) * grow; ed[i * 3 + 1] = (ep.getY(i) - E.c.y) * grow; ed[i * 3 + 2] = (ep.getZ(i) - E.c.z) * grow; }
    K.eyeGeo.morphAttributes.position = [new THREE.BufferAttribute(ed, 3)]; K.eyeGeo.morphTargetsRelative = true;
    const gp = new Float32Array(K.eyes.length * 3), gd = new Float32Array(K.eyes.length * 3);
    K.eyes.forEach((E, i) => { const q = E.c.clone().addScaledVector(E.dir, E.r * (1 + grow) * 0.97); gp.set([q.x, q.y, q.z], i * 3); gd.set([E.dir.x, E.dir.y, E.dir.z], i * 3); });
    K.glintGeo = new THREE.BufferGeometry(); K.glintGeo.setAttribute('position', new THREE.BufferAttribute(gp, 3)); K.glintGeo.setAttribute('aDir', new THREE.BufferAttribute(gd, 3));
    K.glintGeo.boundingSphere = new THREE.Sphere(K.eyes[0].c.clone(), 1);
  }
  const tc = g => (g ? g.index.count / 3 : 0);
  K.triInfo = `body ${K.bodyTris} shell ${tc(K.shellGeo)} cards ${tc(K.cardGeo)} hard ${tc(K.hardGeo)} eyes ${tc(K.eyeGeo)}`;
  K.tris = K.bodyTris + (K.cardGeo ? K.cardGeo.index.count / 3 : 0) + (K.shellGeo ? K.shellGeo.index.count / 3 : 0) + (K.hardGeo ? K.hardGeo.index.count / 3 : 0) + (K.eyeGeo ? K.eyeGeo.index.count / 3 : 0);
  return K;
}
function mergeIndexed(list) {
  let nv = 0, ni = 0; for (const g of list) { nv += g.attributes.position.count; ni += g.index.count; }
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), U = new Float32Array(nv * 2), I = [];
  let o = 0;
  for (const g of list) {
    P.set(g.attributes.position.array, o * 3); N.set(g.attributes.normal.array, o * 3); U.set(g.attributes.uv.array, o * 2);
    for (let i = 0; i < g.index.count; i++) I.push(g.index.getX(i) + o);
    o += g.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.BufferAttribute(U, 2)); g.setIndex(I);
  g.computeBoundingSphere();
  return g;
}
/** hard-part helpers (model space) */
function hEllip(H, c, s, bone, col, info = {}, seg = [10, 8]) { const g = new THREE.SphereGeometry(1, seg[0], seg[1]); g.scale(s[0], s[1], s[2]); g.translate(c[0], c[1], c[2]); return H.geo(g, bone, { col, ...info }); }
function hCone(H, base, dir, r, len, bone, col, info = {}, seg = 5) {
  const g = new THREE.ConeGeometry(r, len, seg, 1); g.translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), new V3(...dir).normalize())); g.translate(base[0], base[1], base[2]);
  return H.geo(g, bone, { col, ...info });
}
/** a lofted hard part (antler beam, finger, beak) */
function hLoft(H, keys, o, col, info = {}) {
  const r = H.loft(keys, o);
  for (let i = r.base; i < H.n; i++) Object.assign(H.inf[i], { col, ...info });
  return r;
}
/** a thorn that only exists when corrupted: built collapsed onto its base, the morph target grows it */
function hThorn(H, base, dir, r, len, bone, col, info = {}) {
  const res = hCone(H, base, dir, r, len, bone, col, info, 4), b = new V3(...base);
  for (let i = res.base; i < H.n; i++) { H.inf[i].grow = H.P(i).sub(b); H.setP(i, b); }
  return res;
}

/* ===================================================================== quadruped controller */
function newPose() {
  return { bx: 0, by: 0, bz: 0, bp: 0, byaw: 0, br: 0, sbP: 0, sbY: 0, sbR: 0, sfP: 0, sfY: 0, sfR: 0, n1P: 0, n1Y: 0, n2P: 0, n2Y: 0, hP: 0, hY: 0, hR: 0, jaw: 0,
    earP: 0, earL: 0, earR: 0, earOut: 0, tailP: 0, tailY: 0, tailC: 0, life: 1, look: 0.5,
    legs: [0, 1, 2, 3].map(() => ({ ik: true, x: 0, y: 0, z: 0, tilt: 0, fp: 0, pole: null, fk: [0, 0, 0, 0], fky: 0, fkz: 0 })) };
}
class QuadCtrl {
  constructor(K, rig, seed) {
    this.K = K; this.rig = rig; const n = K.S.names.length;
    const mk = () => Array.from({ length: n }, () => new THREE.Quaternion());
    this.q = mk(); this.qs = mk(); this.qo = mk();
    this.M = Array.from({ length: n }, () => new THREE.Matrix4());
    this.p = new V3(); this.ps = new V3(); this.po = new V3();
    this.mode = ''; this.fadeT = 1; this.fadeD = 0.25; this.lastT = 0; this.first = true;
    this.phase = hash1(seed) ; this.spd = 0; this.c = 0; this.time = hash1(seed + 3) * 100; this.seed = seed;
    this.lookY = 0; this.lookP = 0; this.P = newPose();
    this.len = K.legs.map(l => l.L0.slice()); this.standDY = 0; this.standP = 0;
    this.jk = { seg: -1, a: [0, 0, 0, 0, 0], b: [0, 0, 0, 0, 0] };
  }
  setC(c) {
    this.c = c; const K = this.K, S = K.S;
    const dh = [];
    K.legs.forEach((lg, i) => {
      const m = this.rig.mp; const a = m[lg.iu], b = m[lg.il], cc = m[lg.ic], f = m[lg.if];
      this.len[i][0] = a.distanceTo(b); this.len[i][1] = b.distanceTo(cc); this.len[i][2] = cc.distanceTo(f);
      const sum0 = lg.L0[0] + lg.L0[1] + lg.L0[2], sum = this.len[i][0] + this.len[i][1] + this.len[i][2];
      dh[i] = (sum - sum0) * (K.tallK ?? 0.92);
    });
    const df = (dh[0] + dh[1]) / 2, dhh = (dh[2] + dh[3]) / 2, zF = K.legs[0].z, zH = K.legs[2].z;
    this.standDY = (df + dhh) / 2; this.standP = Math.atan2(dhh - df, zF - zH);
    void S;
  }
  animate(dt, s, root) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    const mode = s.mode || 'idle', t = s.t || 0;
    if (mode !== this.mode || t < this.lastT - 1e-4) {
      if (!this.first) {
        for (let i = 0; i < this.q.length; i++) this.qs[i].copy(this.qo[i]); this.ps.copy(this.po); this.fadeT = 0;
        const slow = m => m === 'dead' || m === 'sleep' || m === 'howl';
        this.fadeD = mode === 'jerk' || mode === 'hurt' ? 0.08 : mode === 'attack' ? 0.12 : slow(mode) || slow(this.mode) ? 0.6 : 0.28;
      }
      this.mode = mode;
    }
    this.lastT = t; this.time += dt;
    this.pose(dt, s, root);
    this.fadeT += dt;
    const w = this.first ? 1 : smooth(clamp(this.fadeT / this.fadeD, 0, 1));
    const B = this.rig.bones;
    for (let i = 0; i < this.q.length; i++) { this.qo[i].slerpQuaternions(this.qs[i], this.q[i], w); B[i].quaternion.copy(this.qo[i]); }
    this.po.lerpVectors(this.ps, this.p, w); B[0].position.copy(this.po);
    this.first = false;
  }
  setE(i, x, y, z) { if (i >= 0) this.q[i].setFromEuler(_e.set(x, y, z, 'YXZ')); }
  fk() {
    const K = this.K, M = this.M, par = K.S.par, lp = this.rig.lp;
    for (let i = 0; i < M.length; i++) {
      _m.compose(i === 0 ? this.p : lp[i], this.q[i], ONE);
      if (par[i] < 0) M[i].copy(_m); else M[i].multiplyMatrices(M[par[i]], _m);
    }
  }
  ik(i) {
    const K = this.K, lg = K.legs[i], L = this.P.legs[i], M = this.M, len = this.len[i], L1 = len[0], L2 = len[1], L3 = len[2];
    const par = K.S.par[lg.iu];
    const H = _h.copy(this.rig.lp[lg.iu]).applyMatrix4(M[par]);
    _qp.setFromRotationMatrix(M[par]);
    const F = _f.set(L.x, L.y, L.z);
    const A = _a.set(0, Math.cos(L.tilt), -Math.sin(L.tilt)).multiplyScalar(L3).add(F);
    _d.subVectors(A, H); let dist = _d.length(); const dir = _d.divideScalar(dist || 1);
    const maxD = (L1 + L2) * 0.998, minD = Math.abs(L1 - L2) + 0.01 * (L1 + L2);
    if (dist > maxD) { dist = maxD; A.copy(H).addScaledVector(dir, dist); } else if (dist < minD) { dist = minD; A.copy(H).addScaledVector(dir, dist); }
    const pole = _p.copy(L.pole || lg.pole); pole.addScaledVector(dir, -pole.dot(dir)); if (pole.lengthSq() < 1e-8) pole.set(0, 0, lg.front ? -1 : 1); pole.normalize();
    const ca = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1), sa = Math.sqrt(1 - ca * ca);
    const Kn = _k.copy(H).addScaledVector(dir, L1 * ca).addScaledVector(pole, L1 * sa);
    const hinge = _n; if (lg.front) hinge.crossVectors(dir, pole); else hinge.crossVectors(pole, dir); hinge.normalize();
    basisQ(hinge, _y.subVectors(H, Kn).normalize(), _q1);
    basisQ(hinge, _y.subVectors(Kn, A).normalize(), _q2);
    _v.subVectors(A, F); if (_v.lengthSq() < 1e-10) _v.set(0, 1, 0);
    basisQ(hinge, _y.copy(_v).normalize(), _q3);
    _q4.setFromEuler(_e.set(L.fp, 0, 0, 'YXZ'));
    this.q[lg.iu].copy(_qp).invert().multiply(_q1);
    this.q[lg.il].copy(_q1).invert().multiply(_q2);
    this.q[lg.ic].copy(_q2).invert().multiply(_q3);
    this.q[lg.if].copy(_q3).invert().multiply(_q4);
  }
  pose(dt, s, root) {
    const K = this.K, P = newPoseReset(this.P, K), c = this.c, mode = this.mode, t = s.t || 0, G0 = K.gait, T = this.time;
    const loco = mode === 'walk' || mode === 'run' || mode === 'hop';
    this.spd = damp(this.spd, loco ? Math.max(0, s.speed || 0) : 0, 10, dt);
    const v = this.spd, G = gaitAt(G0, v);
    const legK = Math.sqrt((K.legs[0].L0[0] + K.legs[0].L0[1] + K.legs[0].L0[2]) / (this.len[0][0] + this.len[0][1] + this.len[0][2]));
    const freq = G.f * legK;
    if (v > 0.01) this.phase = frac(this.phase + freq * dt);
    const lw = clamp(v / (G0.walk[0] * 0.3), 0, 1);
    const stride = v / Math.max(freq, 0.05);
    P.by = this.standDY; P.bp = this.standP;
    for (let i = 0; i < 4; i++) {
      const lg = K.legs[i], L = P.legs[i], ph = frac(this.phase + G.off[i]), legLen = this.len[i][0] + this.len[i][1] + this.len[i][2];
      const zN = lg.z + (lg.zoff || 0) + (lg.zgal || 0) * G.gal, reach = stride * G.duty;
      if (ph < G.duty) { const u = ph / G.duty; L.z = zN + reach * (0.5 - u); L.y = lg.pawH; L.tilt = lg.tilt + (u - 0.5) * 0.4 * lw; L.fp = (lg.toeOff ?? 0.4) * sstep(0.72, 1, u) * lw; }
      else {
        const u = (ph - G.duty) / (1 - G.duty);
        L.z = zN + reach * (smooth(u) - 0.5); L.y = lg.pawH + G.lift * legLen * bump(u) * lw;
        L.tilt = lg.tilt + lg.flex * bump(u, 0, 0.85) * lw; L.fp = lg.footFlex * bump(u, 0, 0.9) * lw;
      }
    }
    // body motion of the gait
    const ph = this.phase * TAU;
    P.by += (-G.bob * Math.cos(2 * ph) * (1 - G.gal) + G.gal * G.bob * Math.sin(ph + 0.6)) * lw;
    P.bp += G.gal * (K.galPitch ?? 0.07) * Math.sin(ph + 0.3) * lw;
    const flex = G.gal * (K.galFlex ?? 0.12) * Math.sin(ph - 0.9) * lw;
    P.sfP += flex; P.sbP -= flex;
    P.br += 0.025 * Math.sin(ph) * lw * (1 - G.gal);
    if (K.hopH) {   // hopping animals leave the ground once per stride, nose dipping as the forefeet land
      P.by += K.hopH * Math.pow(Math.max(0, Math.sin(ph - TAU * (K.hopPh ?? 0.22))), 1.5) * lw * (0.6 + 0.4 * clamp(v / G0.trot[0], 0, 1));
      P.bp += 0.22 * Math.sin(ph - 0.6) * lw;
    }
    P.n1P += (0.04 * Math.sin(2 * ph + 1) * (1 - G.gal) + G.gal * 0.08 * Math.sin(ph + 2)) * lw + G.gal * (K.galHead ?? 0.25) * lw;
    P.tailY += 0.12 * Math.sin(ph) * lw * (1 - G.gal); P.tailP += G.gal * 0.15 * lw;
    P.earP -= G.gal * 0.5 * lw;
    // idle life: breathing, glances, ear flicks, tail sway
    P.sfP += 0.012 * Math.sin(T * 2.1); P.by += 0.002 * Math.sin(T * 2.1);
    P.n1Y += 0.32 * n1(T * 0.13, this.seed) * (1 - lw); P.hP += 0.08 * n1(T * 0.21, this.seed + 1); P.hR += 0.06 * n1(T * 0.17, this.seed + 2);
    P.earL += 0.5 * Math.max(0, n1(T * 0.9, this.seed + 3) - 0.55) * 2; P.earR += 0.5 * Math.max(0, n1(T * 0.9, this.seed + 4) - 0.55) * 2;
    P.tailY += 0.1 * Math.sin(T * 1.1) * (1 - lw);

    const life = P; void life;
    switch (mode) {
      case 'eat': {
        const e = K.eat || [0.7, 0.4, 0.3];
        P.n1P += e[0]; P.n2P += e[1]; P.hP += e[2] + 0.05 * Math.sin(t * 2.3);
        P.hY += 0.2 * n1(t * 0.35, this.seed); P.jaw = 0.04 + 0.05 * Math.max(0, Math.sin(t * 7));
        P.legs[0].z += 0.04; P.legs[1].z += 0.06; P.sfP += 0.04; P.earP += 0.15;
        break;
      }
      case 'alert': {
        P.n1P -= 0.32; P.n2P -= 0.12; P.hP += 0.05; P.earP += 0.4; P.tailP += 0.15; P.life = 0; P.look = 0.9;
        P.n1Y = 0.25 * n1(this.seed * 3, 2);
        break;
      }
      case 'stare': { P.life = 0; P.look = 1; P.earP += 0.3; P.n1P -= 0.1; P.n1Y = 0; break; }
      case 'sleep': this.lie(P, t, false); break;
      case 'dead': this.lie(P, t, true); break;
      case 'howl': if (K.howl) K.howl(P, t, this); break;
      case 'attack': (K.attack || atkBite)(P, t, this); break;
      case 'hurt': {
        const e = Math.exp(-t * 5) * sstep(0, 0.05, t);
        P.bz -= 0.12 * e * K.size / 1.5; P.br += 0.2 * e; P.bp -= 0.1 * e; P.n1P -= 0.4 * e; P.hY += 0.5 * e; P.hR += 0.3 * e; P.earP -= 1.0 * e; P.tailP -= 0.5 * e; P.jaw = 0.2 * e; P.look = 0;
        break;
      }
      case 'jerk': this.jerk(P, t); break;
      default: break;
    }
    if (K.modeHook) K.modeHook(P, mode, t, this);
    // corrupted posture, and the stillness that comes with it
    if (c > 0 && K.posture) K.posture(P, c, mode, t, this);
    // look at a world point
    let wantY = 0, wantP = 0, lwgt = 0;
    if (s.lookAt && root && P.look > 0) {
      _v.copy(s.lookAt); root.worldToLocal(_v);
      const hb = this.rig.mp[K.ix.head]; _v.x -= hb.x; _v.y -= hb.y + P.by; _v.z -= hb.z;
      wantY = Math.atan2(_v.x, _v.z); wantP = -Math.atan2(_v.y, Math.hypot(_v.x, _v.z));
      lwgt = P.look * (1 - sstep(1.6, 2.4, Math.abs(wantY)));
      wantY = clamp(wantY, -1.5, 1.5);
    }
    const kL = mode === 'stare' || mode === 'jerk' ? 16 : 5;
    this.lookY = damp(this.lookY, wantY * lwgt, kL, dt);
    const acc = P.bp + P.sfP + P.n1P + P.n2P + P.hP + (K.restPitch ?? 0);
    this.lookP = damp(this.lookP, lwgt > 0 ? clamp(wantP - acc, -1.1, 1.1) * lwgt : 0, kL, dt);
    P.n1Y += 0.3 * this.lookY; P.n2Y += 0.3 * this.lookY; P.hY += 0.4 * this.lookY;
    P.n2P += 0.35 * this.lookP; P.hP += 0.65 * this.lookP;
    // write channels
    const I = K.ix;
    this.p.set(P.bx, K.S.bind[0].y + P.by, P.bz);
    this.setE(I.body, P.bp, P.byaw, P.br);
    this.setE(I.spineB, P.sbP, P.sbY, P.sbR);
    this.setE(I.spineF, P.sfP, P.sfY, P.sfR);
    const nn = I.neck.length;
    if (nn === 1) this.setE(I.neck[0], P.n1P + P.n2P, P.n1Y + P.n2Y, 0);
    else { this.setE(I.neck[0], P.n1P, P.n1Y, 0); this.setE(I.neck[1], P.n2P, P.n2Y, 0); for (let k = 2; k < nn; k++) this.setE(I.neck[k], 0, 0, 0); }
    this.setE(I.head, P.hP, P.hY, P.hR);
    this.setE(I.jaw, P.jaw, 0, 0);
    this.setE(I.earL, P.earP + P.earL, 0, P.earOut);
    this.setE(I.earR, P.earP + P.earR, 0, -P.earOut);
    I.tail.forEach((b, k) => this.setE(b, (k === 0 ? P.tailP : 0) + P.tailC / I.tail.length, P.tailY * (k === 0 ? 1 : 0.6), 0));
    for (let i = 0; i < 4; i++) {
      const L = P.legs[i], lg = K.legs[i];
      if (!L.ik) { this.setE(lg.iu, L.fk[0], L.fky * lg.side, L.fkz * lg.side); this.setE(lg.il, L.fk[1], 0, 0); this.setE(lg.ic, L.fk[2], 0, 0); this.setE(lg.if, L.fk[3], 0, 0); }
    }
    this.fk();
    for (let i = 0; i < 4; i++) if (P.legs[i].ik) this.ik(i);
  }
  /** lying down: curled asleep, or on its side dead */
  lie(P, t, dead) {
    const K = this.K, bodyY = K.S.bind[0].y + this.standDY;
    P.life = dead ? 0 : 0.3; P.look = 0;
    if (dead) {
      P.by = (K.deadY ?? 0.15) - K.S.bind[0].y; P.bp = 0; P.br = Math.PI / 2 * 0.97; P.tailY = -0.3; P.tailP = 0; P.jaw = 0.12;
      P.n1P = -0.15; P.n2P = 0.0; P.hP = 0.1; P.n1Y = -0.15; P.hY = -0.25; P.earP = -0.6; P.sfP = 0.0; P.sbP = 0;
      for (const L of P.legs) { L.ik = false; }
      const fr = K.deadLegs || [[-0.35, 0.3, 0.25, 0.4], [-0.15, 0.5, -0.2, 0.3]];
      P.legs[0].fk = fr[0].slice(); P.legs[1].fk = fr[0].map((a, i) => a + [0.25, -0.1, 0.1, 0][i]);
      P.legs[2].fk = fr[1].slice(); P.legs[3].fk = fr[1].map((a, i) => a + [0.2, 0.1, -0.1, 0][i]);
    } else {
      const ly = K.lieY ?? 0.2, br = Math.sin(t * 1.6) * 0.004;
      P.by = ly - K.S.bind[0].y + br; P.bp = 0.04; P.br = K.lieRoll ?? 0.3;
      // curled into a crescent: spine bent sideways, head brought back along the flank, tail over the nose
      const cu = K.curl ?? 1;
      P.sfY = 0.42 * cu; P.sbY = -0.38 * cu; P.n1Y = 0.7 * cu; P.n2Y = 0.6 * cu; P.hY = 0.4 * cu; P.n1P = 0.3; P.n2P = 0.25; P.hP = 0.3; P.hR = 0.3;
      P.earP = -0.6; P.tailY = 1.25 * cu; P.tailP = -0.3; P.tailC = 0.25; P.jaw = 0;
      // legs folded under (FK): forelegs tucked forward, hind legs folded in a Z beside the belly
      const lf = K.lieLegs || [[-1.25, 0.5, 0.7, 0.2], [-1.35, 2.35, -1.5, 0.4]];
      for (let i = 0; i < 4; i++) {
        const L = P.legs[i], lg = K.legs[i]; L.ik = false;
        L.fk = (lg.front ? lf[0] : lf[1]).map((a, k) => a + (i % 2 ? [0.15, -0.1, 0.05, 0][k] : 0));
        L.fky = lg.front ? -0.15 : -0.3;
      }
    }
    void bodyY;
  }
  /** night twitch: frozen, then the head and body snap to new wrong angles */
  jerk(P, t) {
    const J = this.jk, rate = 1.7, segF = t * rate + hash1(this.seed) * 3, seg = Math.floor(segF), u = segF - seg;
    if (seg !== J.seg) {
      J.a = J.b.slice(); J.seg = seg;
      const h = k => hash1(seg * 13.1 + k + this.seed * 7.3) * 2 - 1;
      const big = hash1(seg * 3.7 + this.seed) > 0.45;
      J.b = [h(1) * (big ? 1.1 : 0.35), h(2) * (big ? 0.9 : 0.25), h(3) * 0.55, h(4) * 0.12, h(5) * 0.6];
    }
    const k = sstep(0, 0.05, u) - 0.03 * Math.sin(u * 60) * Math.exp(-u * 12);
    const v = i => lerp(J.a[i], J.b[i], k);
    P.life = 0; P.look = 0.6;
    P.hR += v(0); P.n1Y += v(1) * 0.5; P.hY += v(1) * 0.5; P.hP += v(2); P.sfR += v(3); P.br += v(3) * 0.5; P.jaw = Math.max(0, v(4)) * 0.4; P.earP += v(2) * 0.6;
  }
}
const _poles = [new V3(), new V3(), new V3(), new V3()]; let _pi = 0;
function _tmpPole(lg, out, up, fwd) { const p = _poles[_pi++ & 3]; return p.set(out * lg.side, up, fwd).normalize(); }
function newPoseReset(P, K) {
  for (const k in P) if (typeof P[k] === 'number') P[k] = 0;
  P.life = 1; P.look = 0.5;
  for (let i = 0; i < 4; i++) {
    const L = P.legs[i], lg = K.legs[i];
    L.ik = true; L.x = lg.x; L.y = lg.pawH; L.z = lg.z + (lg.zoff || 0); L.tilt = lg.tilt; L.fp = 0; L.pole = null; L.fk[0] = L.fk[1] = L.fk[2] = L.fk[3] = 0; L.fky = 0; L.fkz = 0;
  }
  return P;
}
/** generic attack: crouch, lunge, bite, recover (~0.8 s) */
function atkBite(P, t, ctl) {
  const K = ctl.K, sz = K.size;
  const load = sstep(0, 0.15, t) * (1 - sstep(0.15, 0.28, t)), lunge = sstep(0.12, 0.3, t) * (1 - sstep(0.5, 0.8, t)), snap = sstep(0.3, 0.38, t);
  P.by -= 0.06 * sz * load - 0.03 * sz * lunge; P.bz += 0.25 * sz * lunge - 0.06 * sz * load; P.bp += 0.12 * lunge - 0.08 * load;
  P.n1P += 0.15 * load - 0.25 * lunge; P.hP += 0.25 * lunge; P.n2P -= 0.1 * lunge;
  P.jaw = (0.55 * sstep(0.1, 0.25, t) * (1 - snap)) + 0.05; P.earP -= 0.8 * (load + lunge); P.tailP += 0.3 * lunge; P.look = 0.8;
  P.hR += 0.25 * Math.sin(t * 40) * sstep(0.36, 0.42, t) * (1 - sstep(0.5, 0.6, t));
  for (let i = 0; i < 2; i++) { const L = P.legs[i]; L.z += 0.3 * sz * lunge; L.y += 0.12 * sz * bump(t, 0.15, 0.45); L.tilt += -1.2 * bump(t, 0.15, 0.45); }
  for (let i = 2; i < 4; i++) P.legs[i].z += 0.08 * sz * lunge;
  P.life = 0;
}

/* ===================================================================== WOLF */
KINDS.wolf = () => {
  const sp = {
    body: 0.63, spineB: [0.62, -0.24], spineF: [0.65, 0.22],
    tail: [[0.6, -0.48], [0.49, -0.59], [0.37, -0.635]],
    neck: [[0.68, 0.4], [0.74, 0.52]],
    head: [0.79, 0.625], jaw: [0.765, 0.675], ear: [0.045, 0.84, 0.675],
    legF: { x: 0.075, y: 0.6, z: 0.3, L: [0.25, 0.245, 0.095] },
    legH: { x: 0.078, y: 0.585, z: -0.36, L: [0.23, 0.245, 0.15] },
  };
  const LF = sp.legF, LH = sp.legH;
  const W = { dark: lin(0x2a2622), saddle: lin(0x3e3833), grey: lin(0x8e877c), tawny: lin(0x9c886b), cream: lin(0xddd6c8), black: lin(0x14110f), mouth: lin(0x4e2523), lip: lin(0x1a1412) };
  const RIBF = TAU / 0.055;
  return {
    kind: 'wolf', size: 1.4, sp, uvs: 0.09, sheenColor: 0x7d7264, normalK: 0.7,
    leg: {
      F: { pawH: 0.035, tilt: 0.25, flex: -1.75, footFlex: 1.3, zoff: 0.03, toeOff: 0.45 },
      H: { pawH: 0.035, tilt: 0.38, flex: 0.55, footFlex: 0.7, zoff: -0.03, toeOff: 0.35 },
    },
    stretch: [
      { tags: ['legF', 'pawF', 'clawF'], base: [0, LF.y, 0], axis: [0, -1, 0], k: 0.6, len: LF.L[0] + LF.L[1] + LF.L[2] },
      { tags: ['legH', 'pawH', 'clawH'], base: [0, LH.y, 0], axis: [0, -1, 0], k: 0.6, len: LH.L[0] + LH.L[1] + LH.L[2] },
    ],
    gait: { walk: [1.5, 1.75, 0.6], trot: [4, 2.7, 0.38], gallop: [9, 3.2, 0.24],
      offWalk: [0.25, 0.75, 0, 0.5], offTrot: [0.5, 0, 0, 0.5], offGallop: [0.5, 0.6, 0, 0.1], lift: [0.1, 0.17, 0.24], bob: [0.008, 0.018, 0.05] },
    eat: [0.75, 0.45, 0.25], lieY: 0.2, deadY: 0.14, restPitch: 0.15,
    eye: { from: [0, 0.802, 0.715], dir: [0.7, 0.32, 0.64], r: 0.0125, iris: '#b98a2e', pupil: 0.07, irisEnd: 0.24, glow: 0xd6ffe2 },
    shellRes: 0.42, shellLayers: 4, shellSkip: ['jaw', 'pawF', 'pawH', 'ear'], furDens: 7, under: 0.7,
    // muscle and bone masses that the lofts alone do not give: scapula, point of shoulder, triceps,
    // ribcage barrel, haunch and hamstrings, cheek ruff, brow and cheekbones
    bumps: [
      { c: [0.1, 0.655, 0.25], r: [0.05, 0.1, 0.085], a: 0.013, tags: ['torso'] },
      { c: [0.11, 0.53, 0.33], r: [0.045, 0.06, 0.06], a: 0.012, tags: ['torso', 'legF'] },
      { c: [0.08, 0.47, 0.26], r: [0.04, 0.07, 0.05], a: 0.012, tags: ['legF', 'torso'] },
      { c: [0.12, 0.55, 0.08], r: [0.05, 0.1, 0.15], a: 0.007, tags: ['torso'] },
      { c: [0.085, 0.545, -0.37], r: [0.05, 0.1, 0.09], a: 0.016, tags: ['legH', 'torso'] },
      { c: [0.075, 0.49, -0.44], r: [0.04, 0.08, 0.04], a: 0.012, tags: ['legH'] },
      { c: [0.06, 0.775, 0.655], r: [0.03, 0.035, 0.04], a: 0.01, tags: ['head'] },
      { c: [0.028, 0.828, 0.715], r: [0.02, 0.014, 0.02], a: 0.005, tags: ['head'] },
      { c: [0.062, 0.792, 0.7], r: [0.02, 0.018, 0.04], a: 0.005, tags: ['head'] },
    ],
    furLen(p, n, I) {
      const tag = I.tag;
      if (tag === 'torso') return n.y < -0.5 ? 0.012 : 0.02 + 0.012 * Math.max(0, n.y) + 0.02 * sstep(0.18, 0.4, p.z);
      if (tag === 'neck') return n.y > 0 ? 0.045 : 0.038;
      if (tag === 'head') return p.z < 0.69 ? 0.03 : p.z < 0.76 ? 0.01 : 0.003;
      if (tag === 'tail') return 0.05 + 0.03 * bump(I.s, 0.05, 1.1);
      if (tag === 'legF') return p.y > 0.42 ? 0.016 + (n.z < 0 ? 0.01 : 0) : 0.005;
      if (tag === 'legH') return p.y > 0.38 ? 0.024 : 0.006;
      return 0;
    },
    body(B) {
      // torso + neck + head as one loft, tail root -> nose
      B.loft([
        { p: [0, 0.6, -0.5], w: 0.03, bone: 'spineB' },
        { p: [0, 0.605, -0.465], w: 0.088, t: 0.055, b: 0.1 },
        { p: [0, 0.615, -0.38], w: 0.118, t: 0.068, b: 0.155 },
        { p: [0, 0.618, -0.26], w: 0.108, t: 0.06, b: 0.13 },
        { p: [0, 0.62, -0.13], w: 0.098, t: 0.056, b: 0.118, bone: { spineB: 0.5, body: 0.5 } },
        { p: [0, 0.625, 0.0], w: 0.112, t: 0.06, b: 0.175, bone: 'body' },
        { p: [0, 0.64, 0.12], w: 0.13, t: 0.075, b: 0.24, bone: { body: 0.5, spineF: 0.5 } },
        { p: [0, 0.655, 0.235], w: 0.135, t: 0.1, b: 0.268, bone: 'spineF' },
        { p: [0, 0.66, 0.33], w: 0.124, t: 0.1, b: 0.24, bone: 'spineF' },
        { p: [0, 0.69, 0.43], w: 0.112, t: 0.09, b: 0.17, bone: { spineF: 0.3, neck1: 0.7 }, tag: 'neck' },
        { p: [0, 0.745, 0.53], w: 0.1, t: 0.076, b: 0.13, bone: 'neck2', tag: 'neck' },
        { p: [0, 0.785, 0.605], w: 0.084, t: 0.064, b: 0.09, bone: { neck2: 0.3, head: 0.7 }, tag: 'head' },
        { p: [0, 0.797, 0.665], w: 0.084, t: 0.062, b: 0.064, bone: 'head', tag: 'head', sq: 2.3 },
        { p: [0, 0.795, 0.722], w: 0.066, t: 0.05, b: 0.05, tag: 'head', sq: 2.3 },
        { p: [0, 0.777, 0.768], w: 0.048, t: 0.038, b: 0.042, tag: 'head', sq: 2.7 },
        { p: [0, 0.772, 0.815], w: 0.04, t: 0.033, b: 0.035, tag: 'head', sq: 2.8 },
        { p: [0, 0.771, 0.855], w: 0.033, t: 0.029, b: 0.029, tag: 'head', sq: 2.6 },
        { p: [0, 0.772, 0.884], w: 0.022, t: 0.021, b: 0.019, tag: 'head' },
      ], { rings: 38, radial: 18, uvs: 0.07, tag: 'torso', flow: -1 });
      // lower jaw
      B.loft([
        { p: [0, 0.762, 0.665], w: 0.045, t: 0.02, b: 0.028, bone: 'jaw', tag: 'jaw' },
        { p: [0, 0.753, 0.74], w: 0.034, t: 0.015, b: 0.021 },
        { p: [0, 0.75, 0.81], w: 0.026, t: 0.012, b: 0.017 },
        { p: [0, 0.752, 0.852], w: 0.018, t: 0.009, b: 0.012 },
        { p: [0, 0.754, 0.868], w: 0.006, t: 0.004, b: 0.005 },
      ], { rings: 8, radial: 10, uvs: 0.05, tag: 'jaw', flow: -1 });
      // ears
      for (const s of [1, -1]) earLoft(B, [s * 0.05, 0.83, 0.665], [s * 0.07, 0.94, 0.645], 0.05, { bone: s > 0 ? 'earL' : 'earR', cup: 0.75, bend: 0.008, rings: 5, ref: [s * 0.55, 0, 0.84] });
      // tail: thick at the root, fullest a third down, tapering to a point
      B.loft([
        { p: [0, 0.615, -0.43], w: 0.04, bone: 'spineB' },
        { p: [0, 0.598, -0.495], w: 0.04, bone: { spineB: 0.4, tail1: 0.6 } },
        { p: [0, 0.54, -0.565], w: 0.046, bone: 'tail1' },
        { p: [0, 0.455, -0.615], w: 0.05, bone: { tail1: 0.3, tail2: 0.7 } },
        { p: [0, 0.36, -0.645], w: 0.044, bone: { tail2: 0.4, tail3: 0.6 } },
        { p: [0, 0.28, -0.655], w: 0.026, bone: 'tail3' },
        { p: [0, 0.235, -0.655], w: 0.006 },
      ], { rings: 12, radial: 9, uvs: 0.08, tag: 'tail', flow: 1, cap0: false });
      for (const s of [1, -1]) {
        legLoft(B, sp, 'F', s, [
          // shoulder mass, upper arm, elbow (olecranon behind), forearm muscle tapering to the wrist,
          // carpal knob, slanted pastern
          [-0.1, 0.05, 0.065, 0.065, 0.0, 'P'], [-0.04, 0.06, 0.085, 0.088, 0, ['P', 'u', 0.5]], [0.05, 0.058, 0.078, 0.085, -0.005, 'u'],
          [0.16, 0.046, 0.056, 0.074, -0.01, 'u'], [0.235, 0.038, 0.043, 0.06, -0.012, ['u', 'l', 0.5]], [0.28, 0.035, 0.042, 0.038, 0, 'l'],
          [0.36, 0.028, 0.032, 0.027, 0, 'l'], [0.45, 0.021, 0.023, 0.021, 0, 'l'], [0.49, 0.023, 0.025, 0.028, -0.002, ['l', 'c', 0.5]],
          [0.53, 0.018, 0.02, 0.019, 0, 'c'], [0.585, 0.021, 0.023, 0.022, 0, ['c', 'f', 0.5]],
        ], { rings: 15, radial: 9 });
        legLoft(B, sp, 'H', s, [
          // haunch and hamstrings, stifle, gaskin with the calf behind, long slim shank, hock point, metatarsus
          [-0.05, 0.055, 0.08, 0.08, 0, 'P'], [0.0, 0.068, 0.1, 0.1, -0.004, ['P', 'u', 0.45]], [0.07, 0.068, 0.106, 0.1, 0.0, 'u'],
          [0.15, 0.052, 0.08, 0.08, 0.008, 'u'], [0.225, 0.038, 0.047, 0.048, 0.004, ['u', 'l', 0.5]], [0.285, 0.035, 0.036, 0.058, -0.006, 'l'],
          [0.37, 0.025, 0.023, 0.034, -0.002, 'l'], [0.45, 0.019, 0.019, 0.026, 0, 'l'], [0.475, 0.02, 0.02, 0.034, -0.004, ['l', 'c', 0.5]],
          [0.55, 0.016, 0.018, 0.018, 0, 'c'], [0.62, 0.02, 0.022, 0.022, 0, ['c', 'f', 0.5]],
        ], { rings: 15, radial: 9 });
        pawLoft(B, sp, 'F', s, { h: 0.044, w: 0.027, len: 0.058, back: 0.025, rings: 6, radial: 10 });
        pawLoft(B, sp, 'H', s, { h: 0.042, w: 0.025, len: 0.054, back: 0.025, rings: 6, radial: 10 });
      }
    },
    hard(H) {
      const blk = lin(0x0c0a09), tooth = lin(0xd8d0bc), claw = lin(0x2a2420);
      hEllip(H, [0, 0.776, 0.889], [0.022, 0.017, 0.014], 'head', blk, { tag: 'nose' }, [8, 6]);
      for (const s of [1, -1]) {
        hCone(H, [s * 0.02, 0.758, 0.84], [0, -1, 0.1], 0.005, 0.02, 'head', tooth);
        hCone(H, [s * 0.018, 0.752, 0.828], [0, 1, 0.15], 0.0045, 0.018, 'jaw', tooth);
        for (let k = 0; k < 2; k++) hCone(H, [s * 0.024, 0.757, 0.81 - k * 0.024], [0, -1, 0], 0.004, 0.009, 'head', tooth, {}, 4);
        for (const [fh, L] of [['F', LF], ['H', LH]]) {
          const fy = L.y - L.L[0] - L.L[1] - L.L[2], id = (s > 0 ? 'L' : 'R') + fh;
          for (let k = 0; k < 4; k++) { const x = s * L.x + (k - 1.5) * 0.011; hCone(H, [x, fy - 0.022, L.z + 0.05 - Math.abs(k - 1.5) * 0.008], [0, -0.6, 1], 0.003, 0.016, id + 'f', claw, { tag: 'claw' + fh }); }
        }
      }
    },
    color(p, n, I) {
      const gz = fbm(p, 22), big = fbm(p, 4, 3), up = n.y, tag = I.tag;
      let c = W.grey;
      if (tag === 'torso' || tag === 'neck') {
        c = mixc(W.grey, W.tawny, sstep(0.3, -0.35, up) * 0.65);
        const sad = sstep(0.05, 0.75, up) * sstep(-0.5, -0.32, p.z) * sstep(0.62, 0.35, p.z);
        c = mixc(c, W.saddle, sad * (0.75 + big * 0.4));
        c = mixc(c, W.cream, sstep(-0.3, -0.8, up));
        if (tag === 'neck' || p.z > 0.28) c = mixc(c, W.cream, sstep(0.05, -0.55, up) * 0.85);
        if (tag === 'neck') c = mixc(c, W.dark, sstep(0.4, 0.9, up) * 0.4);
      } else if (tag === 'head') {
        const dy = p.y - I.c.y;
        c = mixc(W.grey, W.tawny, 0.35);
        c = mixc(c, W.dark, sstep(0.5, 0.95, up) * sstep(0.62, 0.75, p.z) * 0.4);          // forehead
        const cheek = sstep(0.35, 0.7, Math.abs(n.x)) * sstep(0.02, -0.02, dy + 0.005) * sstep(0.6, 0.66, p.z);
        c = mixc(c, W.cream, Math.max(cheek, sstep(-0.1, -0.6, up)) * 0.92);                 // cheeks, throat
        c = mixc(c, W.cream, sstep(0.78, 0.84, p.z) * sstep(0.2, -0.2, up) * 0.8);            // muzzle sides
        const brow = Math.exp(-((p.z - 0.715) ** 2) / 0.0002 - ((p.y - 0.823) ** 2) / 0.00005) * sstep(0.02, 0.04, Math.abs(p.x));
        c = mixc(c, W.cream, brow * 0.8);
        const eyeRim = Math.exp(-((p.z - 0.725) ** 2) / 0.0004 - ((p.y - 0.808) ** 2) / 0.00012) * sstep(0.5, 0.8, Math.abs(n.x));
        c = mixc(c, W.dark, eyeRim * 0.6);
        c = mixc(c, W.lip, sstep(-0.25, -0.6, up) * sstep(0.72, 0.78, p.z) * 0.85);
        if (p.z > 0.87) c = mixc(c, W.dark, sstep(0.87, 0.9, p.z) * 0.75);
      } else if (tag === 'jaw') {
        c = up > 0.25 ? W.mouth : mixc(W.cream, W.lip, sstep(0.15, 0.4, Math.abs(n.x)) * sstep(0, 0.2, up) * 0.8);
      } else if (tag === 'ear') {
        c = n.z < -0.2 ? mixc(W.tawny, W.dark, 0.35 + I.s * 0.4) : mixc(W.cream, W.dark, Math.abs(I.ca) * 0.8 + I.s * 0.3);
      } else if (tag === 'tail') {
        c = mixc(W.tawny, W.saddle, sstep(-0.2, 0.6, n.z < 0 ? -n.z : up) * 0.7);
        c = mixc(c, W.black, sstep(0.72, 0.88, I.s));
      } else if (tag === 'legF' || tag === 'legH') {
        const inner = -n.x * Math.sign(p.x);
        c = mixc(W.tawny, W.cream, sstep(-0.1, 0.5, inner) * 0.8);
        c = mixc(c, W.grey, sstep(0.45, 0.62, p.y) * 0.6);
        if (tag === 'legF') c = mixc(c, W.saddle, sstep(0.5, 0.9, n.z) * sstep(0.35, 0.15, p.y) * sstep(0.0, 0.08, p.y) * 0.0);
      } else if (tag.startsWith('paw')) {
        c = mixc(W.tawny, W.cream, 0.25);
        const xl = (p.x - I.c.x) / 0.026, groove = sstep(0.82, 1, Math.abs(Math.cos(TAU * xl))) * sstep(0.35, 0.6, I.s) * sstep(-0.2, 0.3, n.y + n.z);
        c = mixc(c, W.dark, groove * 0.8);
        c = mixc(c, W.black, sstep(-0.35, -0.65, up));                                        // pads
      }
      // grizzle: banded guard hairs give the coat a broken, salt-and-pepper value
      const gr = fbm(p, 40, 7);
      return mulc(c, 0.8 + gz * 0.3 + big * 0.12 + gr * 0.1);
    },
    aux(p, n, I) {
      const rib = I.tag === 'torso' ? sstep(-0.1, -0.02, p.z) * sstep(0.32, 0.22, p.z) * sstep(0.3, 0.6, Math.abs(n.x)) * sstep(0.08, -0.02, p.y - I.c.y) : 0;
      return [rib, clamp(0.5 + fbm(p, 6.5, 11) * 0.9, 0, 1)];
    },
    corrupt(p, n, I) {
      const d = [0, 0, 0], tag = I.tag, C = I.c, dy = p.y - C.y;
      if (tag === 'torso') {
        const z = p.z, em = sstep(-0.45, -0.3, z) * sstep(0.42, 0.28, z);
        d[0] += (C.x - p.x) * 0.18 * em;
        if (dy < 0) d[1] += -dy * (0.32 * sstep(-0.32, -0.15, z) * sstep(0.14, -0.02, z) + 0.12 * em);
        const rib = sstep(-0.08, 0.0, z) * sstep(0.32, 0.22, z) * sstep(0.3, 0.6, Math.abs(n.x)) * sstep(0.08, -0.02, dy);
        const g = Math.sin((z + p.y * 0.45) * RIBF) * 0.009 * rib;
        d[0] += n.x * g; d[1] += n.y * g; d[2] += n.z * g;
        if (n.y > 0.75) { const k = Math.pow(Math.max(0, Math.sin(z * TAU / 0.05)), 3) * 0.013 * em; d[0] += n.x * k; d[1] += n.y * k; d[2] += n.z * k; }
        const hip = Math.exp(-((z + 0.33) ** 2) / 0.002 - ((Math.abs(p.x) - 0.07) ** 2) / 0.001) * sstep(0, 0.04, dy) * 0.018;
        d[0] += n.x * hip; d[1] += n.y * hip;
        d[1] -= 0.035 * sstep(0.1, 0.3, z) * sstep(0.2, 0.6, n.y);                 // shoulder blades drop: the spine arches above them
      }
      if (tag === 'neck') { d[0] += (C.x - p.x) * 0.15; d[1] += (C.y - p.y) * 0.1; }
      if (tag === 'legF' || tag === 'legH') { const k = 0.25 + 0.3 * sstep(0.3, 0.55, p.y); d[0] += (C.x - p.x) * k; d[2] += (C.z - p.z) * k; }
      if (tag === 'jaw') { d[0] += p.x * 0.38; d[1] -= 0.006; d[2] += 0.006; }
      if (tag === 'head') {
        if (dy < 0 && p.z > 0.64) d[0] += p.x * 0.16 * sstep(0.64, 0.7, p.z);
        if (p.z < 0.76 && Math.abs(n.x) > 0.5 && dy > -0.02) d[0] -= p.x * 0.12;  // gaunt temples
      }
      return d;
    },
    fur(p, n, I) {
      const tag = I.tag;
      // only where the silhouette needs breaking up; the shells do the rest
      if (tag === 'tail') return [0.35, 0.065, 0.035, 0.4];
      if (tag === 'neck') return [0.6, 0.08, 0.04, 0.5];
      if (tag === 'torso') { if (p.z > 0.26 && n.y > -0.2) return [0.3, 0.06, 0.035]; if (n.y > 0.55) return [0.12, 0.045, 0.03]; return 0; }
      if (tag === 'head') { if (p.z < 0.7 && Math.abs(n.x) > 0.45 && p.y < I.c.y + 0.015) return [0.7, 0.045, 0.03, 0.75]; return 0; }
      if (tag === 'legH' && p.y > 0.4 && n.z < -0.3) return [0.3, 0.045, 0.03];
      return 0;
    },
    howl(P, t) {
      P.life = 0.4; P.look = 0;
      P.by -= 0.2; P.bp -= 0.42; P.n1P -= 0.75; P.n2P -= 0.45; P.hP -= 0.25; P.jaw = 0.2 + 0.1 * Math.sin(t * 1.3) * sstep(0.3, 1, t); P.earP -= 0.35; P.tailP -= 0.5;
      for (let i = 2; i < 4; i++) { const L = P.legs[i]; L.z += 0.16; L.tilt = 1.35; L.pole = null; }
      for (let i = 0; i < 2; i++) P.legs[i].z -= 0.02;
    },
    posture(P, c, mode, t) {
      // head hangs low and forward, back arched, tail dead, and it stops moving like a living thing
      const k = mode === 'sleep' || mode === 'dead' ? 0 : c;
      P.n1P += 0.55 * k; P.n2P += 0.3 * k; P.hP -= 0.55 * k; P.sfP += 0.1 * k; P.sbP -= 0.16 * k; P.by += 0.03 * k;
      P.tailP -= 0.45 * k; P.tailY *= 1 - k; P.earP -= 0.25 * k; P.jaw += 0.07 * k;
      P.n1Y *= 1 - 0.8 * k; P.hR *= 1 - 0.8 * k; P.earL *= 1 - k; P.earR *= 1 - k;
      if (mode === 'idle' || mode === 'stare') P.hR += 0.14 * k;
      void t;
    },
  };
};

/* ===================================================================== DEER (opts.antlers = stag) */
KINDS.deer = (opts) => {
  const sp = {
    body: 0.95, spineB: [0.95, -0.36], spineF: [0.97, 0.3],
    tail: [[0.97, -0.66], [0.9, -0.71]],
    neck: [[1.02, 0.46], [1.2, 0.6]],
    head: [1.42, 0.72], jaw: [1.37, 0.78], ear: [0.05, 1.47, 0.74],
    legF: { x: 0.095, y: 0.9, z: 0.36, L: [0.28, 0.31, 0.27] },
    legH: { x: 0.095, y: 0.93, z: -0.5, L: [0.31, 0.34, 0.31] },
  };
  const LF = sp.legF, LH = sp.legH, ant = !!opts.antlers;
  const neckDir = new V3(0, 0.42, 0.3).normalize();
  const D = { coat: lin(0x7e6047), back: lin(0x5c4431), white: lin(0xe9e3d6), dark: lin(0x2b241f), leg: lin(0x6c513a), ear: lin(0x8a6e55), nose: lin(0x1c1715), mouth: lin(0x4a2a26) };
  const RIBF = TAU / 0.07;
  return {
    kind: 'deer', size: 1.8, sp, sheenColor: 0x806a55, normalK: 0.35, sheen: 0.5, rough: 0.8, ribSpacing: 0.07,
    shellRes: 0.38, shellLayers: 3, shellSkip: ['jaw', 'pawF', 'pawH', 'ear'], furDens: 9, under: 0.88,
    leg: {
      F: { pawH: 0.05, tilt: 0.18, flex: -1.7, footFlex: 1.0, zoff: 0.03, toeOff: 0.4 },
      H: { pawH: 0.05, tilt: 0.24, flex: 0.6, footFlex: 0.6, zoff: -0.02, toeOff: 0.35 },
    },
    stretch: [
      { tags: ['legF', 'pawF', 'hoofF'], base: [0, LF.y, 0], axis: [0, -1, 0], k: 0.4, len: LF.L[0] + LF.L[1] + LF.L[2] },
      { tags: ['legH', 'pawH', 'hoofH'], base: [0, LH.y, 0], axis: [0, -1, 0], k: 0.4, len: LH.L[0] + LH.L[1] + LH.L[2] },
      { tags: ['neck', 'head', 'jaw', 'ear', 'antler', 'nose'], base: [0, 1.0, 0.42], axis: neckDir.toArray(), k: 0.55, len: 0.52 },
    ],
    gait: { walk: [1.4, 1.35, 0.62], trot: [3.6, 2.0, 0.42], gallop: [12, 2.5, 0.24],
      offWalk: [0.25, 0.75, 0, 0.5], offTrot: [0.5, 0, 0, 0.5], offGallop: [0.6, 0.7, 0, 0.1], lift: [0.09, 0.16, 0.26], bob: [0.01, 0.02, 0.06] },
    eat: [1.05, 0.55, 0.35], lieY: 0.3, deadY: 0.2, restPitch: 0.55, galHead: 0.1, galFlex: 0.16,
    eye: { from: [0, 1.43, 0.8], dir: [0.88, 0.3, 0.32], r: 0.017, iris: '#2a1a10', pupil: 0.16, irisEnd: 0.42, sclera: '#120c08', glow: 0xe2fff0 },
    bumps: [
      { c: [0.13, 0.98, 0.27], r: [0.05, 0.12, 0.1], a: 0.014, tags: ['torso'] },        // scapula
      { c: [0.13, 0.78, 0.36], r: [0.05, 0.08, 0.07], a: 0.014, tags: ['torso', 'legF'] }, // point of shoulder
      { c: [0.12, 0.9, -0.48], r: [0.06, 0.13, 0.11], a: 0.02, tags: ['torso', 'legH'] },  // haunch
      { c: [0.1, 1.04, -0.42], r: [0.04, 0.04, 0.05], a: 0.01, tags: ['torso'] },          // hip bone
      { c: [0.045, 1.465, 0.79], r: [0.02, 0.016, 0.03], a: 0.005, tags: ['head'] },       // brow
    ],
    furLen(p, n, I) {
      const t = I.tag;
      if (t === 'neck') return n.y < 0 ? 0.02 : 0.012;
      if (t === 'torso') return 0.009;
      if (t === 'tail') return 0.025;
      if (t === 'head') return p.z < 0.8 ? 0.006 : 0.002;
      if (t === 'legF' || t === 'legH') return p.y > 0.6 ? 0.006 : 0.003;
      return 0;
    },
    body(B) {
      B.loft([
        { p: [0, 0.97, -0.71], w: 0.03, bone: 'spineB' },
        { p: [0, 0.975, -0.66], w: 0.1, t: 0.07, b: 0.12 },
        { p: [0, 0.97, -0.55], w: 0.14, t: 0.1, b: 0.2 },
        { p: [0, 0.96, -0.38], w: 0.142, t: 0.1, b: 0.21 },
        { p: [0, 0.945, -0.2], w: 0.15, t: 0.1, b: 0.235, bone: { spineB: 0.5, body: 0.5 } },
        { p: [0, 0.95, 0.0], w: 0.158, t: 0.11, b: 0.255, bone: 'body' },
        { p: [0, 0.97, 0.17], w: 0.152, t: 0.12, b: 0.27, bone: { body: 0.5, spineF: 0.5 } },
        { p: [0, 0.99, 0.31], w: 0.138, t: 0.13, b: 0.27, bone: 'spineF' },
        { p: [0, 1.0, 0.41], w: 0.115, t: 0.12, b: 0.21, bone: 'spineF' },
        { p: [0, 1.09, 0.51], w: 0.095, t: 0.088, b: 0.15, bone: { spineF: 0.3, neck1: 0.7 }, tag: 'neck' },
        { p: [0, 1.22, 0.6], w: 0.07, t: 0.066, b: 0.095, bone: 'neck2', tag: 'neck' },
        { p: [0, 1.36, 0.665], w: 0.06, t: 0.058, b: 0.068, bone: { neck2: 0.4, head: 0.6 }, tag: 'neck' },
        { p: [0, 1.44, 0.735], w: 0.064, t: 0.058, b: 0.058, bone: 'head', tag: 'head', sq: 2.2 },
        { p: [0, 1.425, 0.8], w: 0.058, t: 0.048, b: 0.054, tag: 'head', sq: 2.2 },
        { p: [0, 1.38, 0.865], w: 0.044, t: 0.04, b: 0.046, tag: 'head', sq: 2.4 },
        { p: [0, 1.33, 0.93], w: 0.035, t: 0.033, b: 0.037, tag: 'head', sq: 2.5 },
        { p: [0, 1.295, 0.985], w: 0.029, t: 0.028, b: 0.03, tag: 'head', sq: 2.3 },
        { p: [0, 1.285, 1.01], w: 0.018, t: 0.017, b: 0.018, tag: 'head' },
      ], { rings: 44, radial: 18, uvs: 0.06, tag: 'torso', flow: -1 });
      B.loft([
        { p: [0, 1.37, 0.76], w: 0.04, t: 0.016, b: 0.022, bone: 'jaw', tag: 'jaw' },
        { p: [0, 1.32, 0.86], w: 0.03, t: 0.012, b: 0.018 },
        { p: [0, 1.28, 0.95], w: 0.021, t: 0.01, b: 0.014 },
        { p: [0, 1.267, 0.99], w: 0.008, t: 0.004, b: 0.005 },
      ], { rings: 7, radial: 8, uvs: 0.05, tag: 'jaw', flow: -1 });
      // big mule-like ears, held out to the sides
      for (const s of [1, -1]) earLoft(B, [s * 0.05, 1.47, 0.745], [s * 0.19, 1.58, 0.7], 0.066, { bone: s > 0 ? 'earL' : 'earR', cup: 0.8, bend: 0.012, rings: 5, radial: 10, ref: [s * 0.7, 0.2, 0.7],
        keys: [[0, 0.55, 0.3, 0.4], [0.35, 1, 0.26, 0.3], [0.75, 0.75, 0.16, 0.18], [1, 0.08, 0.05, 0.05]] });
      // short tail, white underneath
      B.loft([
        { p: [0, 0.975, -0.66], w: 0.035, bone: 'spineB' },
        { p: [0, 0.96, -0.71], w: 0.045, t: 0.025, b: 0.03, bone: 'tail1' },
        { p: [0, 0.9, -0.745], w: 0.04, t: 0.022, b: 0.03, bone: 'tail2' },
        { p: [0, 0.84, -0.755], w: 0.01 },
      ], { rings: 6, radial: 8, uvs: 0.06, tag: 'tail', flow: 1, cap0: false });
      for (const s of [1, -1]) {
        legLoft(B, sp, 'F', s, [
          [-0.12, 0.06, 0.08, 0.08, 0, 'P'], [-0.04, 0.07, 0.1, 0.1, 0, ['P', 'u', 0.5]], [0.08, 0.062, 0.085, 0.09, -0.005, 'u'],
          [0.2, 0.046, 0.055, 0.07, -0.01, 'u'], [0.275, 0.034, 0.04, 0.05, -0.012, ['u', 'l', 0.5]], [0.33, 0.03, 0.036, 0.03, 0, 'l'],
          [0.45, 0.022, 0.026, 0.02, 0, 'l'], [0.57, 0.018, 0.02, 0.018, 0, 'l'], [0.595, 0.021, 0.022, 0.024, 0, ['l', 'c', 0.5]],
          [0.7, 0.014, 0.016, 0.015, 0, 'c'], [0.83, 0.016, 0.018, 0.02, 0, 'c'], [0.86, 0.02, 0.024, 0.024, 0, ['c', 'f', 0.5]],
        ], { rings: 17, radial: 9, uvs: 0.06 });
        legLoft(B, sp, 'H', s, [
          [-0.06, 0.06, 0.09, 0.09, 0, 'P'], [0.0, 0.08, 0.13, 0.13, -0.01, ['P', 'u', 0.45]], [0.1, 0.075, 0.13, 0.12, 0, 'u'],
          [0.22, 0.05, 0.08, 0.075, 0.01, 'u'], [0.305, 0.036, 0.045, 0.045, 0.005, ['u', 'l', 0.5]], [0.37, 0.034, 0.034, 0.06, -0.008, 'l'],
          [0.5, 0.022, 0.022, 0.032, -0.004, 'l'], [0.62, 0.016, 0.016, 0.022, 0, 'l'], [0.65, 0.018, 0.018, 0.034, -0.006, ['l', 'c', 0.5]],
          [0.78, 0.014, 0.017, 0.016, 0, 'c'], [0.92, 0.016, 0.018, 0.02, 0, 'c'], [0.95, 0.02, 0.024, 0.024, 0, ['c', 'f', 0.5]],
        ], { rings: 17, radial: 9, uvs: 0.06 });
      }
    },
    hard(H) {
      const hoof = lin(0x161211), horn = lin(0x8a7458), tip = lin(0xd9cdb5), tooth = lin(0xd0c6ae);
      hEllip(H, [0, 1.288, 1.005], [0.02, 0.016, 0.014], 'head', lin(0x111010), { tag: 'nose', region: 'head' }, [8, 6]);
      for (const s of [1, -1]) {
        for (const [fh, L] of [['F', LF], ['H', LH]]) {
          const fy = L.y - L.L[0] - L.L[1] - L.L[2], id = (s > 0 ? 'L' : 'R') + fh;
          for (const k of [-1, 1]) hEllip(H, [s * L.x + k * 0.011, fy - 0.026, L.z + 0.012], [0.012, 0.026, 0.024], id + 'f', hoof, { tag: 'hoof' + fh }, [7, 5]);
          hCone(H, [s * L.x, fy + 0.03, L.z - 0.02], [0, -0.6, -1], 0.006, 0.02, id + 'c', hoof, { tag: 'hoof' + fh }, 4);   // dewclaw
        }
        if (ant) {
          // a 4-point antler: brow tine, main beam sweeping back-up-forward, two upper tines
          const b = [s * 0.04, 1.5, 0.77];
          const beam = [b, [s * 0.1, 1.6, 0.72], [s * 0.18, 1.72, 0.72], [s * 0.21, 1.84, 0.79], [s * 0.18, 1.93, 0.89]];
          const R = [0.02, 0.017, 0.014, 0.011, 0.004];
          hLoft(H, beam.map((p, i) => ({ p, w: R[i], bone: 'head' })), { rings: 9, radial: 7, tag: 'antler', flow: 1 }, horn, { region: 'antler' });
          const tine = (a, c2, r) => hLoft(H, [{ p: a, w: r, bone: 'head' }, { p: [(a[0] + c2[0]) / 2, (a[1] + c2[1]) / 2 + 0.01, (a[2] + c2[2]) / 2], w: r * 0.75 }, { p: c2, w: 0.003 }], { rings: 5, radial: 6, tag: 'antler', flow: 1, cap0: false }, horn, { region: 'antler' });
          tine([s * 0.06, 1.54, 0.755], [s * 0.075, 1.62, 0.87], 0.011);
          tine([s * 0.165, 1.7, 0.72], [s * 0.17, 1.86, 0.66], 0.01);
          tine([s * 0.2, 1.81, 0.77], [s * 0.25, 1.95, 0.75], 0.009);
          // corruption thorns: hooked spikes all along the beam
          const th = [[0.08, 1.58, 0.72, 0.8, -0.2, -0.3], [0.13, 1.66, 0.72, 0.6, 0.2, 0.6], [0.19, 1.76, 0.73, 1, -0.3, 0.1], [0.21, 1.86, 0.82, 0.5, 0.4, 0.8], [0.15, 1.65, 0.71, -0.3, 0.4, -1], [0.2, 1.9, 0.86, 0.2, 1, 0.3], [0.11, 1.63, 0.73, 0.2, -1, 0.4]];
          for (const [x, y, z, dx, dy, dz] of th) hThorn(H, [s * x, y, z], [s * dx, dy, dz], 0.006, 0.07, 'head', tip, { tag: 'antler', region: 'antler' });
        }
        hCone(H, [s * 0.015, 1.265, 0.955], [0, 1, 0.3], 0.004, 0.012, 'jaw', tooth, { region: 'jaw' }, 4);
      }
    },
    color(p, n, I) {
      const gz = fbm(p, 18), big = fbm(p, 3.5, 5), up = n.y, t = I.tag;
      let c = D.coat;
      if (t === 'torso' || t === 'neck') {
        c = mixc(D.coat, D.back, sstep(0.3, 0.9, up) * 0.8);
        c = mixc(c, D.white, sstep(-0.45, -0.8, up));
        const rump = sstep(-0.5, -0.62, p.z) * sstep(-0.6, 0.2, -n.z) * sstep(0.85, 0.95, p.y + 0.0);
        c = mixc(c, D.white, rump * 0.9);
        if (t === 'neck') c = mixc(c, D.white, sstep(1.2, 1.3, p.y) * sstep(-0.3, -0.7, n.y + n.z * 0.3) * 0.9);  // throat patch
      } else if (t === 'head') {
        c = mixc(D.coat, D.back, sstep(0.6, 0.95, up) * 0.3);
        c = mixc(c, D.white, sstep(-0.3, -0.7, up) * sstep(0.8, 0.86, p.z) * 0.8);                // chin / under-muzzle
        c = mixc(c, D.dark, sstep(0.975, 0.995, p.z) * 0.9);                                      // nose pad surround
        c = mixc(c, D.white, bump(p.z, 0.93, 0.98) * sstep(0.0, 0.5, Math.abs(n.x)) * 0.6);       // pale muzzle band
        const ring = Math.exp(-((p.z - 0.805) ** 2) / 0.0006 - ((p.y - 1.44) ** 2) / 0.0005) * sstep(0.4, 0.8, Math.abs(n.x));
        c = mixc(c, D.white, ring * 0.8);                                                         // eye ring
        c = mixc(c, D.back, sstep(0.75, 0.95, up) * sstep(0.78, 0.9, p.z) * 0.5);                 // dark forehead blaze
      } else if (t === 'jaw') c = up > 0.3 ? D.mouth : mixc(D.white, D.dark, sstep(0.95, 0.99, p.z));
      else if (t === 'ear') c = n.z < -0.1 ? mixc(D.ear, D.dark, I.s * 0.5 + Math.abs(I.ca) * 0.3) : mixc(D.white, D.dark, Math.abs(I.ca) * 0.9 + I.s * 0.2);
      else if (t === 'tail') c = n.y > 0.2 ? D.back : D.white;
      else if (t === 'legF' || t === 'legH') {
        const inner = -n.x * Math.sign(p.x);
        c = mixc(D.leg, D.white, sstep(0.2, 0.7, inner) * sstep(0.45, 0.75, p.y) * 0.8);
        c = mixc(c, D.dark, sstep(0.25, 0.08, p.y) * 0.25);
        c = mixc(c, D.coat, sstep(0.65, 0.85, p.y));
      }
      return mulc(c, 0.84 + gz * 0.25 + big * 0.1);
    },
    aux(p, n, I) {
      const rib = I.tag === 'torso' ? sstep(-0.1, 0.0, p.z) * sstep(0.32, 0.22, p.z) * sstep(0.3, 0.6, Math.abs(n.x)) * sstep(0.06, -0.04, p.y - I.c.y) : 0;
      return [rib, clamp(0.5 + fbm(p, 5, 21) * 0.9, 0, 1)];
    },
    corrupt(p, n, I) {
      const d = [0, 0, 0], t = I.tag, C = I.c, dy = p.y - C.y;
      if (t === 'torso') {
        const em = sstep(-0.62, -0.45, p.z) * sstep(0.45, 0.32, p.z);
        d[0] += (C.x - p.x) * 0.14 * em;
        if (dy < 0) d[1] += -dy * 0.2 * sstep(-0.45, -0.2, p.z) * sstep(0.15, -0.05, p.z);
        const rib = sstep(-0.1, 0.0, p.z) * sstep(0.32, 0.22, p.z) * sstep(0.3, 0.6, Math.abs(n.x)) * sstep(0.06, -0.04, dy);
        const g = Math.sin((p.z + p.y * 0.45) * RIBF) * 0.01 * rib; d[0] += n.x * g; d[1] += n.y * g; d[2] += n.z * g;
        if (n.y > 0.75) { const k = Math.pow(Math.max(0, Math.sin(p.z * TAU / 0.06)), 3) * 0.014 * em; d[1] += k; }
      }
      if (t === 'neck') { d[0] += (C.x - p.x) * 0.25; d[2] += (C.z - p.z) * 0.1; }
      if (t === 'legF' || t === 'legH') { const k = 0.32 + 0.25 * sstep(0.5, 0.8, p.y); d[0] += (C.x - p.x) * k; d[2] += (C.z - p.z) * k; }
      if (t === 'head' && Math.abs(n.x) > 0.5 && p.z < 0.85) d[0] -= p.x * 0.1;
      return d;
    },
    attack(P, t, ctl) {
      // head down, antlers (or forehead) driven forward, then a jab with a forefoot
      const load = sstep(0, 0.2, t) * (1 - sstep(0.55, 0.8, t)), thrust = bump(t, 0.2, 0.55);
      P.n1P += 0.75 * load; P.n2P += 0.35 * load; P.hP += 0.45 * load; P.bz += 0.3 * thrust; P.by -= 0.05 * load; P.earP -= 0.6 * load; P.look = 0.5;
      const L = P.legs[0]; L.y += 0.25 * bump(t, 0.35, 0.75); L.z += 0.25 * bump(t, 0.35, 0.75); L.tilt -= 1.4 * bump(t, 0.35, 0.75);
      P.life = 0; void ctl;
    },
    modeHook(P, mode, t) { if (mode === 'alert') { P.legs[0].y += 0.12; P.legs[0].tilt -= 1.3; P.legs[0].z += 0.05; P.tailP += 0.6; } void t; },
    posture(P, c, mode) {
      // neck held too high and rigid, head cocked at a wrong angle, ears splayed, never blinking, never moving
      const k = mode === 'sleep' || mode === 'dead' ? 0 : c;
      P.n1P -= 0.15 * k; P.hP += 0.15 * k; P.hR += 0.55 * k; P.earOut += 0.6 * k; P.earP -= 0.3 * k; P.tailP -= 0.3 * k;
      P.n1Y *= 1 - 0.9 * k; P.earL *= 1 - k; P.earR *= 1 - k; P.sfP += 0.06 * k;
    },
  };
};

/* ===================================================================== BEAR */
KINDS.bear = () => {
  const sp = {
    body: 0.97, spineB: [0.96, -0.5], spineF: [1.0, 0.38],
    tail: [[0.95, -0.86]],
    neck: [[1.0, 0.68], [0.99, 0.84]],
    head: [1.0, 0.97], jaw: [0.93, 1.04], ear: [0.1, 1.12, 1.03],
    legF: { x: 0.17, y: 0.85, z: 0.46, L: [0.33, 0.38, 0.12] },
    legH: { x: 0.17, y: 0.88, z: -0.6, L: [0.4, 0.38, 0.2] },
  };
  const LF = sp.legF, LH = sp.legH;
  const C = { base: lin(0x3b2a1d), tip: lin(0x76563a), leg: lin(0x271c14), muzzle: lin(0x8c6c4c), dark: lin(0x1a130e), mouth: lin(0x4a2524), claw: lin(0x3a342c) };
  return {
    kind: 'bear', size: 2.2, sp, sheenColor: 0x6e553e, normalK: 0.8, sheen: 0.8, rough: 0.9, skinColor: 0x2c2321, dark: 0.5,
    shellRes: 0.4, shellLayers: 4, shellSkip: ['jaw', 'pawF', 'pawH'], furDens: 6, under: 0.65, ribSpacing: 0.08,
    leg: {
      F: { pawH: 0.06, tilt: 0.5, flex: -1.3, footFlex: 0.8, zoff: 0.04, toeOff: 0.3, footX: 0.95 },
      H: { pawH: 0.06, tilt: 1.25, flex: 0.35, footFlex: 0.3, zoff: 0.02, toeOff: 0.4, footX: 0.95 },
    },
    stretch: [
      { tags: ['legF', 'pawF', 'clawF'], base: [0, LF.y, 0], axis: [0, -1, 0], k: 0.15, len: LF.L[0] + LF.L[1] + LF.L[2] },
      { tags: ['legH', 'pawH', 'clawH'], base: [0, LH.y, 0], axis: [0, -1, 0], k: 0.15, len: LH.L[0] + LH.L[1] + LH.L[2] },
    ],
    gait: { walk: [1.3, 1.0, 0.65], trot: [3.5, 1.7, 0.45], gallop: [10, 2.4, 0.3],
      offWalk: [0.1, 0.6, 0, 0.5], offTrot: [0.5, 0, 0, 0.5], offGallop: [0.55, 0.65, 0, 0.1], lift: [0.1, 0.15, 0.22], bob: [0.015, 0.03, 0.07] },
    eat: [0.75, 0.3, 0.3], lieY: 0.36, deadY: 0.3, restPitch: 0.25, galPitch: 0.06, galFlex: 0.14, galHead: 0.15, curl: 0.7, sizeVar: 0.12,
    lieLegs: [[-1.3, 0.4, 0.6, 0.3], [-1.2, 2.1, -1.2, 0.3]],
    eye: { from: [0, 1.03, 1.11], dir: [0.55, 0.42, 0.72], r: 0.012, iris: '#2c1a0e', pupil: 0.12, irisEnd: 0.4, sclera: '#100a07', glow: 0xd9ffe0 },
    bumps: [
      { c: [0, 1.25, 0.36], r: [0.16, 0.1, 0.2], a: 0.06, tags: ['torso'] },              // shoulder hump
      { c: [0.25, 0.95, 0.4], r: [0.08, 0.15, 0.13], a: 0.025, tags: ['torso', 'legF'] },  // shoulder mass
      { c: [0.24, 0.9, -0.6], r: [0.09, 0.17, 0.16], a: 0.03, tags: ['torso', 'legH'] },   // haunch
      { c: [0.12, 1.03, 1.04], r: [0.06, 0.06, 0.06], a: 0.02, tags: ['head'] },           // cheek / jaw muscle
    ],
    furLen(p, n, I) {
      const t = I.tag;
      if (t === 'torso') return n.y < -0.5 ? 0.035 : 0.05 + 0.025 * sstep(0.2, 0.45, p.z) * Math.max(0, n.y);
      if (t === 'neck') return 0.06;
      if (t === 'head') return p.z < 1.1 ? 0.035 : p.z < 1.2 ? 0.012 : 0.004;
      if (t === 'ear') return 0.012;
      if (t === 'tail') return 0.04;
      if (t === 'legF' || t === 'legH') return p.y > 0.5 ? 0.045 : 0.028;
      return 0;
    },
    body(B) {
      B.loft([
        { p: [0, 0.95, -0.87], w: 0.05, bone: 'spineB' },
        { p: [0, 0.96, -0.81], w: 0.2, t: 0.14, b: 0.22 },
        { p: [0, 0.97, -0.62], w: 0.3, t: 0.16, b: 0.32 },
        { p: [0, 0.965, -0.36], w: 0.31, t: 0.13, b: 0.37, bone: { spineB: 0.6, body: 0.4 } },
        { p: [0, 0.97, -0.06], w: 0.33, t: 0.14, b: 0.42, bone: 'body' },
        { p: [0, 0.99, 0.22], w: 0.32, t: 0.22, b: 0.42, bone: { body: 0.4, spineF: 0.6 } },
        { p: [0, 1.0, 0.42], w: 0.28, t: 0.27, b: 0.39, bone: 'spineF' },
        { p: [0, 0.98, 0.6], w: 0.24, t: 0.19, b: 0.31, bone: { spineF: 0.5, neck1: 0.5 }, tag: 'neck' },
        { p: [0, 0.96, 0.75], w: 0.2, t: 0.15, b: 0.22, bone: 'neck1', tag: 'neck' },
        { p: [0, 0.96, 0.88], w: 0.185, t: 0.15, b: 0.17, bone: { neck2: 0.6, head: 0.4 }, tag: 'neck' },
        { p: [0, 0.98, 0.97], w: 0.18, t: 0.15, b: 0.15, bone: 'head', tag: 'head', sq: 2.3 },
        { p: [0, 0.99, 1.06], w: 0.16, t: 0.13, b: 0.13, tag: 'head', sq: 2.3 },
        { p: [0, 0.97, 1.14], w: 0.115, t: 0.1, b: 0.105, tag: 'head', sq: 2.4 },
        { p: [0, 0.945, 1.22], w: 0.082, t: 0.074, b: 0.08, tag: 'head', sq: 2.6 },
        { p: [0, 0.93, 1.29], w: 0.066, t: 0.06, b: 0.062, tag: 'head', sq: 2.6 },
        { p: [0, 0.925, 1.34], w: 0.05, t: 0.048, b: 0.045, tag: 'head', sq: 2.3 },
        { p: [0, 0.925, 1.365], w: 0.03, t: 0.03, b: 0.027, tag: 'head' },
      ], { rings: 36, radial: 20, uvs: 0.1, tag: 'torso', flow: -1 });
      B.loft([
        { p: [0, 0.915, 1.02], w: 0.09, t: 0.035, b: 0.05, bone: 'jaw', tag: 'jaw' },
        { p: [0, 0.89, 1.14], w: 0.07, t: 0.03, b: 0.04 },
        { p: [0, 0.88, 1.26], w: 0.05, t: 0.022, b: 0.03 },
        { p: [0, 0.885, 1.32], w: 0.03, t: 0.014, b: 0.02 },
        { p: [0, 0.887, 1.34], w: 0.01, t: 0.006, b: 0.008 },
      ], { rings: 8, radial: 10, uvs: 0.06, tag: 'jaw', flow: -1 });
      for (const s of [1, -1]) earLoft(B, [s * 0.1, 1.11, 1.03], [s * 0.14, 1.2, 1.02], 0.05, { bone: s > 0 ? 'earL' : 'earR', cup: 0.5, rings: 4, radial: 8, ref: [s * 0.4, 0, 0.9],
        keys: [[0, 0.9, 0.4, 0.5], [0.5, 1, 0.35, 0.4], [0.85, 0.7, 0.25, 0.25], [1, 0.15, 0.1, 0.1]] });
      B.loft([{ p: [0, 0.96, -0.82], w: 0.05, bone: 'spineB' }, { p: [0, 0.93, -0.88], w: 0.045, bone: 'tail1' }, { p: [0, 0.88, -0.9], w: 0.015 }], { rings: 4, radial: 8, uvs: 0.08, tag: 'tail', flow: 1, cap0: false });
      for (const s of [1, -1]) {
        legLoft(B, sp, 'F', s, [
          [-0.12, 0.13, 0.15, 0.15, 0, 'P'], [-0.03, 0.13, 0.16, 0.17, 0, ['P', 'u', 0.5]], [0.1, 0.12, 0.14, 0.15, -0.01, 'u'],
          [0.25, 0.1, 0.11, 0.12, -0.01, 'u'], [0.33, 0.085, 0.09, 0.1, -0.015, ['u', 'l', 0.5]], [0.42, 0.082, 0.095, 0.08, 0.005, 'l'],
          [0.56, 0.066, 0.075, 0.062, 0, 'l'], [0.69, 0.06, 0.066, 0.06, 0, 'l'], [0.73, 0.062, 0.066, 0.07, 0, ['l', 'c', 0.5]], [0.83, 0.06, 0.06, 0.06, 0, ['c', 'f', 0.5]],
        ], { rings: 14, radial: 10, uvs: 0.1 });
        legLoft(B, sp, 'H', s, [
          [-0.1, 0.13, 0.16, 0.16, 0, 'P'], [0.0, 0.14, 0.19, 0.19, -0.01, ['P', 'u', 0.45]], [0.14, 0.13, 0.17, 0.17, 0, 'u'],
          [0.3, 0.095, 0.11, 0.11, 0.01, 'u'], [0.4, 0.08, 0.085, 0.09, 0, ['u', 'l', 0.5]], [0.5, 0.075, 0.075, 0.095, -0.01, 'l'],
          [0.68, 0.06, 0.06, 0.07, 0, 'l'], [0.78, 0.062, 0.062, 0.07, 0, ['l', 'c', 0.5]], [0.9, 0.06, 0.07, 0.06, 0.0, 'c'], [0.98, 0.06, 0.06, 0.06, 0, ['c', 'f', 0.5]],
        ], { rings: 14, radial: 10, uvs: 0.1 });
        pawLoft(B, sp, 'F', s, { h: 0.08, w: 0.07, len: 0.12, back: 0.06, rings: 6, radial: 10 });
        pawLoft(B, sp, 'H', s, { h: 0.075, w: 0.065, len: 0.11, back: 0.05, rings: 6, radial: 10 });
      }
    },
    hard(H) {
      hEllip(H, [0, 0.94, 1.36], [0.038, 0.027, 0.02], 'head', lin(0x0d0b0a), { tag: 'nose' }, [8, 6]);
      const tooth = lin(0xd6cdb4);
      for (const s of [1, -1]) {
        hCone(H, [s * 0.035, 0.9, 1.29], [0, -1, 0.1], 0.009, 0.035, 'head', tooth);
        hCone(H, [s * 0.032, 0.89, 1.27], [0, 1, 0.15], 0.008, 0.03, 'jaw', tooth);
        for (const [fh, L, cl] of [['F', LF, 0.06], ['H', LH, 0.035]]) {
          const fy = L.y - L.L[0] - L.L[1] - L.L[2], id = (s > 0 ? 'L' : 'R') + fh;
          for (let k = 0; k < 5; k++) { const x = s * L.x + (k - 2) * 0.026; hCone(H, [x, fy - 0.045, L.z + 0.1 - Math.abs(k - 2) * 0.012], [0, -0.5, 1], 0.007, cl, id + 'f', C.claw, { tag: 'claw' + fh }); }
        }
      }
    },
    color(p, n, I) {
      const gz = fbm(p, 12), big = fbm(p, 2.5, 9), up = n.y, t = I.tag;
      let c = C.base;
      if (t === 'torso' || t === 'neck') {
        c = mixc(C.base, C.tip, sstep(0.2, 0.9, up) * sstep(0.0, 0.5, p.z) * 0.8 + big * 0.25);   // sun-bleached hump
        c = mixc(c, C.leg, sstep(-0.2, -0.8, up) * 0.6);
      } else if (t === 'head') {
        c = mixc(C.base, C.tip, 0.35);
        c = mixc(c, C.muzzle, sstep(1.18, 1.26, p.z) * 0.85);
        c = mixc(c, C.dark, sstep(1.33, 1.37, p.z) * 0.8);
        c = mixc(c, C.dark, Math.exp(-((p.z - 1.14) ** 2) / 0.001 - ((p.y - 1.06) ** 2) / 0.0006) * 0.5);
      } else if (t === 'jaw') c = up > 0.3 ? C.mouth : mixc(C.muzzle, C.base, sstep(1.2, 1.05, p.z));
      else if (t === 'ear') c = mixc(C.base, C.dark, 0.4);
      else if (t === 'legF' || t === 'legH' || t.startsWith('paw')) c = mixc(C.leg, C.base, sstep(0.45, 0.8, p.y));
      else if (t === 'tail') c = C.base;
      return mulc(c, 0.82 + gz * 0.3);
    },
    aux(p, n, I) { return [0, clamp(0.5 + fbm(p, 3.5, 31) * 1.0, 0, 1)]; },
    corrupt(p, n, I) {
      const d = [0, 0, 0], t = I.tag;
      if (t === 'torso') {   // the hump rises into a hard ridge, the flanks fall in
        const hump = Math.exp(-((p.z - 0.4) ** 2) / 0.03) * sstep(0.3, 0.8, n.y);
        d[1] += 0.11 * hump; d[0] += (I.c.x - p.x) * 0.1 * sstep(0.8, 0.0, p.z);
        if (n.y > 0.7) d[1] += Math.pow(Math.max(0, Math.sin(p.z * TAU / 0.09)), 3) * 0.025;
      }
      if (t === 'jaw') { d[1] -= 0.01; d[0] += p.x * 0.15; }
      return d;
    },
    fur(p, n, I) {
      const t = I.tag;
      if (t === 'neck' || (t === 'torso' && p.z > 0.2 && n.y > 0)) return [0.4, 0.1, 0.06, 0.45];
      if ((t === 'legF' || t === 'legH') && n.z < -0.3 && p.y > 0.3) return [0.35, 0.08, 0.05, 0.3];
      if (t === 'head' && p.z < 1.08 && Math.abs(n.x) > 0.4) return [0.4, 0.06, 0.045, 0.6];
      return 0;
    },
    attack(P, t, ctl) {
      // rears onto the hind legs, roars, rakes down with a forepaw
      const up = sstep(0, 0.3, t) * (1 - sstep(0.6, 0.85, t)), swipe = bump(t, 0.3, 0.6);
      P.bp -= 0.95 * up; P.by += 0.22 * up; P.bz -= 0.1 * up; P.n1P += 0.55 * up; P.hP += 0.3 * up; P.jaw = 0.45 * up; P.earP -= 0.7 * up; P.look = 0.7;
      for (let i = 0; i < 2; i++) {
        const L = P.legs[i];
        if (up > 0.2) { L.ik = false; const sw = i === 1 ? swipe : 0; L.fk = [-0.9 * up - 1.4 * sw + 0.6 * sstep(0.45, 0.6, t), 0.6 * up - 0.4 * sw, -0.5 * up, 0.6]; L.fky = 0.3 * sw; }
      }
      for (let i = 2; i < 4; i++) P.legs[i].z += 0.18 * up;
      P.life = 0; void ctl;
    },
    posture(P, c, mode) {
      // shoulders hunched up, head hanging and swinging low, jaw slack and open
      const k = mode === 'sleep' || mode === 'dead' ? 0 : c;
      P.sfP -= 0.08 * k; P.n1P += 0.4 * k; P.hP -= 0.15 * k; P.jaw += 0.3 * k; P.earP -= 0.5 * k; P.by -= 0.04 * k;
      P.n1Y *= 1 - 0.7 * k; P.hR += 0.12 * k;
    },
  };
};

/* ===================================================================== RABBIT */
KINDS.rabbit = () => {
  const sp = {
    body: 0.15, spineB: [0.15, -0.07], spineF: [0.145, 0.06],
    tail: [[0.155, -0.15]],
    neck: [[0.165, 0.1]],
    head: [0.2, 0.135], jaw: [0.182, 0.17], ear: [0.016, 0.232, 0.142],
    legF: { x: 0.028, y: 0.115, z: 0.07, L: [0.045, 0.05, 0.025] },
    legH: { x: 0.042, y: 0.13, z: -0.08, L: [0.06, 0.07, 0.075] },
  };
  const LF = sp.legF, LH = sp.legH;
  const R = { coat: lin(0x86735e), back: lin(0x5f5040), grey: lin(0x8c857a), belly: lin(0xe2dccf), white: lin(0xf2efe8), dark: lin(0x2a2420), ear: lin(0xb08c80), rust: lin(0x9a6a45) };
  return {
    kind: 'rabbit', size: 0.4, sp, sheenColor: 0x9a8f80, normalK: 0.3, sheen: 0.9, rough: 0.9, sizeVar: 0.14,
    furDens: 16,
    hopH: 0.07, hopPh: 0.22, tallK: 0.95,
    leg: {
      F: { pawH: 0.008, tilt: 0.35, flex: -1.2, footFlex: 0.6, zoff: 0.015, toeOff: 0.3 },
      H: { pawH: 0.008, tilt: 1.38, flex: 0.1, footFlex: 0.4, zoff: 0.05, toeOff: 0.6 },
    },
    stretch: [
      { tags: ['torso', 'neck', 'head', 'jaw', 'ear', 'legF', 'pawF', 'nose'], base: [0, 0, -0.06], axis: [0, 0, 1], k: 0.45, len: 0.12 },
      { tags: ['ear'], base: [0, 0.23, 0], axis: [0, 1, 0], k: 0.6, len: 0.12 },
      { tags: ['legH', 'pawH'], base: [0, LH.y, 0], axis: [0, -1, 0], k: 0.25, len: LH.L[0] + LH.L[1] + LH.L[2] },
    ],
    gait: { walk: [0.7, 2.0, 0.42], trot: [3, 3.0, 0.3], gallop: [8, 3.6, 0.2],
      offWalk: [0.45, 0.52, 0, 0.04], offTrot: [0.45, 0.53, 0, 0.04], offGallop: [0.42, 0.52, 0, 0.06], lift: [0.25, 0.3, 0.3], bob: [0, 0, 0] },
    eat: [0.5, 0.0, 0.35], lieY: 0.075, deadY: 0.05, restPitch: 0.25, galPitch: 0.1, galFlex: 0.25, galHead: 0.1, curl: 0.2,
    lieLegs: [[-1.0, 0.6, 0.4, 0], [-1.0, 2.4, -1.4, 0]],
    eye: { from: [0, 0.205, 0.165], dir: [0.9, 0.38, 0.2], r: 0.0085, iris: '#3a2414', pupil: 0.2, irisEnd: 0.45, sclera: '#120b07', corrupt: 'black', grow: 0.7, glow: 0xe8f4ff, seg: [8, 6] },
    fur(p, n, I) {   // a few soft tufts break the outline; at this size shells cost more than they give
      const t = I.tag;
      if (t === 'torso' && n.y > -0.2) return [0.12, 0.016, 0.014, 0.5];
      if (t === 'tail') return [0.9, 0.018, 0.016, 0.8];
      if (t === 'neck' || (t === 'head' && p.z < 0.17)) return [0.25, 0.012, 0.012, 0.5];
      return 0;
    },
    furLenUnused(p, n, I) {
      const t = I.tag;
      if (t === 'torso') return n.y < -0.4 ? 0.008 : 0.011;
      if (t === 'neck') return 0.012;
      if (t === 'head') return p.z < 0.19 ? 0.008 : 0.004;
      if (t === 'tail') return 0.016;
      if (t === 'legH') return p.y > 0.06 ? 0.01 : 0.005;
      return 0;
    },
    body(B) {
      B.loft([
        { p: [0, 0.14, -0.165], w: 0.02, bone: 'spineB' },
        { p: [0, 0.15, -0.145], w: 0.05, t: 0.042, b: 0.048 },
        { p: [0, 0.16, -0.1], w: 0.068, t: 0.06, b: 0.07 },
        { p: [0, 0.158, -0.04], w: 0.066, t: 0.058, b: 0.07, bone: { spineB: 0.5, body: 0.5 } },
        { p: [0, 0.152, 0.02], w: 0.058, t: 0.052, b: 0.066, bone: { body: 0.5, spineF: 0.5 } },
        { p: [0, 0.152, 0.07], w: 0.048, t: 0.046, b: 0.058, bone: 'spineF' },
        { p: [0, 0.168, 0.105], w: 0.04, t: 0.04, b: 0.048, bone: { spineF: 0.3, neck1: 0.7 }, tag: 'neck' },
        { p: [0, 0.195, 0.135], w: 0.038, t: 0.036, b: 0.04, bone: 'head', tag: 'head' },
        { p: [0, 0.204, 0.165], w: 0.036, t: 0.033, b: 0.033, tag: 'head', sq: 2.2 },
        { p: [0, 0.196, 0.195], w: 0.027, t: 0.026, b: 0.027, tag: 'head', sq: 2.2 },
        { p: [0, 0.186, 0.218], w: 0.018, t: 0.019, b: 0.019, tag: 'head' },
        { p: [0, 0.181, 0.232], w: 0.009, t: 0.009, b: 0.008, tag: 'head' },
      ], { rings: 26, radial: 16, uvs: 0.03, tag: 'torso', flow: -1 });
      B.loft([
        { p: [0, 0.18, 0.165], w: 0.018, t: 0.008, b: 0.012, bone: 'jaw', tag: 'jaw' },
        { p: [0, 0.172, 0.2], w: 0.012, t: 0.006, b: 0.009 },
        { p: [0, 0.172, 0.222], w: 0.004, t: 0.003, b: 0.004 },
      ], { rings: 4, radial: 6, uvs: 0.02, tag: 'jaw', flow: -1 });
      // long ears, laid slightly back, deep cups
      for (const s of [1, -1]) earLoft(B, [s * 0.016, 0.228, 0.142], [s * 0.03, 0.33, 0.112], 0.021, { bone: s > 0 ? 'earL' : 'earR', cup: 0.8, rings: 5, radial: 8, ref: [s * 0.35, 0, 0.94],
        keys: [[0, 0.6, 0.35, 0.45], [0.3, 1, 0.3, 0.35], [0.75, 0.9, 0.22, 0.25], [1, 0.25, 0.1, 0.1]] });
      // cotton tail
      B.loft([{ p: [0, 0.165, -0.145], w: 0.012, bone: 'tail1' }, { p: [0, 0.168, -0.165], w: 0.024 }, { p: [0, 0.166, -0.185], w: 0.003 }], { rings: 5, radial: 8, uvs: 0.02, tag: 'tail', flow: 1 });
      for (const s of [1, -1]) {
        legLoft(B, sp, 'F', s, [
          [-0.02, 0.018, 0.02, 0.02, 0, 'P'], [0.01, 0.017, 0.02, 0.02, 0, ['P', 'u', 0.5]], [0.045, 0.012, 0.013, 0.014, 0, ['u', 'l', 0.5]],
          [0.09, 0.009, 0.01, 0.01, 0, 'l'], [0.11, 0.011, 0.012, 0.012, 0, ['c', 'f', 0.5]],
        ], { rings: 6, radial: 6, uvs: 0.02 });
        legLoft(B, sp, 'H', s, [
          [-0.03, 0.03, 0.045, 0.045, 0, 'P'], [0.01, 0.036, 0.055, 0.052, 0, ['P', 'u', 0.4]], [0.05, 0.03, 0.045, 0.04, 0, 'u'],
          [0.065, 0.02, 0.025, 0.026, 0, ['u', 'l', 0.5]], [0.11, 0.013, 0.014, 0.016, 0, 'l'], [0.13, 0.012, 0.012, 0.018, 0, ['l', 'c', 0.5]],
          [0.17, 0.011, 0.012, 0.012, 0, 'c'], [0.205, 0.013, 0.014, 0.012, 0, ['c', 'f', 0.5]],
        ], { rings: 8, radial: 7, uvs: 0.02 });
        pawLoft(B, sp, 'F', s, { h: 0.012, w: 0.01, len: 0.018, back: 0.006, rings: 4, radial: 6 });
        pawLoft(B, sp, 'H', s, { h: 0.012, w: 0.012, len: 0.03, back: 0.006, rings: 4, radial: 6 });
      }
    },
    hard(H) {
      hEllip(H, [0, 0.188, 0.23], [0.006, 0.004, 0.003], 'head', lin(0x6e4a44), { tag: 'nose' }, [6, 4]);
      for (const s of [1, -1]) hCone(H, [s * 0.003, 0.176, 0.224], [0, -1, 0.2], 0.0025, 0.007, 'head', lin(0xe8e2d4), {}, 4);
    },
    color(p, n, I) {
      const gz = fbm(p, 70), big = fbm(p, 14, 3), up = n.y, t = I.tag;
      let c = R.coat;
      if (t === 'torso' || t === 'neck') {
        c = mixc(R.coat, R.back, sstep(0.4, 0.95, up) * 0.6);
        c = mixc(c, R.grey, sstep(0.0, -0.4, up) * 0.4);
        c = mixc(c, R.belly, sstep(-0.35, -0.75, up));
        if (t === 'neck') c = mixc(c, R.rust, sstep(0.3, 0.8, up) * 0.6);   // rusty nape
      } else if (t === 'head') {
        c = mixc(R.coat, R.belly, sstep(-0.2, -0.6, up) * 0.8);
        const ring = Math.exp(-((p.z - 0.166) ** 2) / 0.00012 - ((p.y - 0.207) ** 2) / 0.0001) * sstep(0.4, 0.8, Math.abs(n.x));
        c = mixc(c, R.belly, ring * 0.7);
        c = mixc(c, R.belly, sstep(0.2, 0.226, p.z) * sstep(0.1, -0.3, up) * 0.6);
      } else if (t === 'ear') c = n.z > 0.1 ? mixc(R.ear, R.dark, Math.abs(I.ca) * 0.5) : mixc(R.coat, R.dark, sstep(0.75, 1, I.s));
      else if (t === 'tail') c = n.y > 0.5 ? R.back : R.white;
      else if (t === 'jaw') c = R.belly;
      else if (t.startsWith('leg') || t.startsWith('paw')) { c = mixc(R.coat, R.belly, sstep(0.1, 0.7, -n.x * Math.sign(p.x) - n.y * 0.5) * 0.7); if (t === 'pawH') c = mixc(c, R.belly, 0.5); }
      return mulc(c, 0.84 + gz * 0.22 + big * 0.1);
    },
    aux(p) { return [0, clamp(0.5 + fbm(p, 25, 4) * 0.9, 0, 1)]; },
    corrupt(p, n, I) {
      const d = [0, 0, 0];
      if (I.tag === 'torso') { d[0] += (I.c.x - p.x) * 0.2; }
      if (I.tag === 'head' && p.z > 0.18) d[2] += 0.006;
      return d;
    },
    posture(P, c, mode) {
      // sits bolt upright, unnaturally tall, forepaws hanging, head level and staring
      const k = mode === 'idle' || mode === 'alert' || mode === 'stare' || mode === 'jerk' || mode === 'eat' ? c : c * 0.3;
      P.bp -= 1.3 * k; P.by += 0.075 * k; P.bz -= 0.03 * k; P.sfP -= 0.2 * k;
      P.n1P += 1.15 * k; P.hP += 0.3 * k; P.earP += 0.35 * k;
      for (let i = 0; i < 2; i++) { const L = P.legs[i]; if (k > 0.3) { L.ik = false; L.fk = [0.9 * k, 0.6 * k, 0.6 * k, 0.4]; } }
      P.n1Y *= 1 - k; P.earL *= 1 - k; P.earR *= 1 - k; P.life *= 1 - k;
    },
  };
};

/* ===================================================================== CRAWLER
   Something that lives under the island: a starved, hairless, eyeless thing the size of a
   man, walking on all fours on limbs far too long for it - elbows and knees ride above its
   spine. Always like this (no corruption blend). */
KINDS.crawler = () => {
  const sp = {
    body: 0.95, spineB: [0.95, -0.38], spineF: [0.97, 0.26],
    tail: [],
    neck: [[0.975, 0.4], [0.955, 0.52]],
    head: [0.93, 0.62], jaw: [0.895, 0.68], ear: null,
    legF: { x: 0.19, y: 0.97, z: 0.3, L: [0.55, 0.52, 0.1] },
    legH: { x: 0.13, y: 0.93, z: -0.44, L: [0.56, 0.52, 0.19] },
  };
  const LF = sp.legF, LH = sp.legH;
  const S = { skin: lin(0xcbc4b7), shade: lin(0x9d9b9c), dirt: lin(0x6c6257), socket: lin(0x3e3835), lip: lin(0x5b3b3b), mouth: lin(0x2a1414), vein: lin(0x8c96a8) };
  const ribF = TAU / 0.045;
  return {
    kind: 'crawler', size: 1.8, sp, noFurTex: true, noCorrupt: true, rough: 0.5, sheen: 0.25, sheenColor: 0xd8b8b0, clearcoat: 0.25, ribAlways: 1, ribSpacing: 0.045,
    leg: {
      F: { pawH: 0.022, tilt: 1.32, flex: -0.5, footFlex: 0.5, zoff: 0.05, toeOff: 0.2, footX: 2.3, pole: [0.55, 1, -0.25] },
      H: { pawH: 0.025, tilt: 1.3, flex: 0.3, footFlex: 0.4, zoff: 0.12, toeOff: 0.3, footX: 2.6, pole: [0.5, 1, 0.3] },
    },
    gait: { walk: [0.8, 0.8, 0.72], trot: [2.5, 1.25, 0.55], gallop: [6, 1.85, 0.4],
      offWalk: [0.25, 0.75, 0, 0.5], offTrot: [0.5, 0, 0, 0.5], offGallop: [0.5, 0.6, 0, 0.1], lift: [0.1, 0.13, 0.17], bob: [0.006, 0.015, 0.04] },
    eat: [0.6, 0.4, 0.4], lieY: 0.12, deadY: 0.12, restPitch: 0.35, curl: 0.4, tallK: 0.9,
    lieLegs: [[-0.6, 2.2, 0.5, 0], [-1.4, 2.4, -1.2, 0]],
    bumps: [
      { c: [0.09, 1.02, 0.17], r: [0.05, 0.03, 0.08], a: 0.016, tags: ['torso'] },    // shoulder blades
      { c: [0.13, 0.97, 0.3], r: [0.04, 0.04, 0.04], a: 0.014, tags: ['torso'] },     // shoulder knob
      { c: [0.12, 0.99, -0.39], r: [0.04, 0.03, 0.04], a: 0.015, tags: ['torso'] },   // iliac crest
      { c: [0.031, 0.94, 0.79], r: [0.019, 0.014, 0.016], a: -0.012, tags: ['head'] }, // empty eye sockets
      { c: [0, 0.982, 0.7], r: [0.05, 0.02, 0.04], a: 0.006, tags: ['head'] },         // brow ridge
      { c: [0.05, 0.915, 0.765], r: [0.015, 0.012, 0.02], a: 0.005, tags: ['head'] },  // cheekbones
    ],
    post(B) {
      // ribs, spine knobs and a caved belly, carved straight into the surface
      for (let i = 0; i < B.n; i++) {
        const I = B.inf[i]; if (I.tag !== 'torso' || I.cap) continue;
        const p = B.P(i), d = p.clone().sub(I.c); d.addScaledVector(I.T, -d.dot(I.T)); const l = d.length(); if (l < 1e-5) continue; d.divideScalar(l);
        const side = Math.abs(d.x), top = d.y;
        const rib = sstep(-0.16, -0.05, p.z) * sstep(0.28, 0.18, p.z) * sstep(0.25, 0.6, side) * sstep(-0.7, -0.2, top);
        let push = Math.sin((p.z + p.y * 0.5) * ribF) * 0.007 * rib;
        if (top > 0.8) push += Math.pow(Math.max(0, Math.sin(p.z * TAU / 0.04)), 4) * 0.014 * sstep(-0.45, -0.35, p.z);
        if (top < -0.4) push -= 0.03 * sstep(-0.3, -0.15, p.z) * sstep(0.05, -0.08, p.z);   // sunken belly
        B.setP(i, p.addScaledVector(d, push));
      }
    },
    body(B) {
      B.loft([
        { p: [0, 0.955, -0.53], w: 0.03, bone: 'spineB' },
        { p: [0, 0.955, -0.49], w: 0.12, t: 0.07, b: 0.08 },
        { p: [0, 0.955, -0.4], w: 0.15, t: 0.06, b: 0.09 },
        { p: [0, 0.96, -0.26], w: 0.11, t: 0.05, b: 0.075, bone: { spineB: 0.6, body: 0.4 } },
        { p: [0, 0.962, -0.1], w: 0.125, t: 0.055, b: 0.1, bone: 'body' },
        { p: [0, 0.966, 0.06], w: 0.15, t: 0.06, b: 0.13, bone: { body: 0.5, spineF: 0.5 } },
        { p: [0, 0.97, 0.2], w: 0.17, t: 0.065, b: 0.12, bone: 'spineF' },
        { p: [0, 0.972, 0.31], w: 0.14, t: 0.058, b: 0.085, bone: 'spineF' },
        { p: [0, 0.97, 0.4], w: 0.05, t: 0.045, b: 0.05, bone: { spineF: 0.4, neck1: 0.6 }, tag: 'neck' },
        { p: [0, 0.955, 0.5], w: 0.04, t: 0.04, b: 0.044, bone: 'neck2', tag: 'neck' },
        { p: [0, 0.94, 0.58], w: 0.045, t: 0.046, b: 0.05, bone: { neck2: 0.4, head: 0.6 }, tag: 'head' },
        { p: [0, 0.945, 0.64], w: 0.07, t: 0.075, b: 0.058, bone: 'head', tag: 'head' },
        { p: [0, 0.945, 0.7], w: 0.073, t: 0.072, b: 0.062, tag: 'head' },
        { p: [0, 0.932, 0.755], w: 0.066, t: 0.055, b: 0.07, tag: 'head', sq: 2.2 },
        { p: [0, 0.915, 0.79], w: 0.052, t: 0.04, b: 0.066, tag: 'head', sq: 2.3 },
        { p: [0, 0.905, 0.806], w: 0.03, t: 0.022, b: 0.04, tag: 'head' },
      ], { rings: 40, radial: 18, uvs: 0.08, tag: 'torso', flow: -1 });
      B.loft([
        { p: [0, 0.885, 0.68], w: 0.05, t: 0.018, b: 0.024, bone: 'jaw', tag: 'jaw' },
        { p: [0, 0.872, 0.74], w: 0.044, t: 0.016, b: 0.02 },
        { p: [0, 0.865, 0.785], w: 0.03, t: 0.013, b: 0.018 },
        { p: [0, 0.866, 0.8], w: 0.01, t: 0.005, b: 0.006 },
      ], { rings: 6, radial: 10, uvs: 0.05, tag: 'jaw', flow: -1 });
      for (const s of [1, -1]) {
        legLoft(B, sp, 'F', s, [
          [-0.06, 0.05, 0.05, 0.05, 0, 'P'], [0.0, 0.048, 0.05, 0.05, 0, ['P', 'u', 0.5]], [0.08, 0.04, 0.044, 0.046, 0, 'u'],
          [0.3, 0.03, 0.032, 0.03, 0, 'u'], [0.5, 0.025, 0.027, 0.029, 0, 'u'], [0.55, 0.029, 0.027, 0.036, -0.004, ['u', 'l', 0.5]],
          [0.62, 0.026, 0.028, 0.026, 0, 'l'], [0.85, 0.02, 0.022, 0.018, 0, 'l'], [1.05, 0.016, 0.018, 0.013, 0, 'l'],
          [1.07, 0.02, 0.02, 0.015, 0, ['l', 'c', 0.5]], [1.13, 0.022, 0.016, 0.01, 0, 'c'], [1.17, 0.022, 0.014, 0.01, 0, ['c', 'f', 0.5]],
        ], { rings: 18, radial: 8, uvs: 0.06, cap1: true });
        legLoft(B, sp, 'H', s, [
          [-0.06, 0.07, 0.07, 0.07, 0, 'P'], [0.0, 0.062, 0.068, 0.068, 0, ['P', 'u', 0.5]], [0.1, 0.05, 0.056, 0.056, 0, 'u'],
          [0.35, 0.038, 0.04, 0.04, 0, 'u'], [0.56, 0.036, 0.042, 0.034, 0.004, ['u', 'l', 0.5]], [0.66, 0.03, 0.028, 0.04, -0.004, 'l'],
          [0.9, 0.02, 0.02, 0.022, 0, 'l'], [1.07, 0.02, 0.022, 0.03, -0.006, ['l', 'c', 0.5]], [1.17, 0.024, 0.018, 0.016, 0, 'c'], [1.26, 0.022, 0.014, 0.01, 0, ['c', 'f', 0.5]],
        ], { rings: 16, radial: 8, uvs: 0.06, cap1: true });
        // long fingers and toes, splayed
        for (const [fh, L, nf, len, spr] of [['F', LF, 5, 0.14, 0.022], ['H', LH, 4, 0.08, 0.018]]) {
          const fy = L.y - L.L[0] - L.L[1] - L.L[2], id = (s > 0 ? 'L' : 'R') + fh;
          for (let k = 0; k < nf; k++) {
            const u = k - (nf - 1) / 2, thumb = fh === 'F' && k === nf - 1, dx = s * u * spr * (thumb ? 1.6 : 1);
            const ln = len * (thumb ? 0.55 : 1 - Math.abs(u) * 0.12), x0 = s * L.x + dx * 0.5;
            B.loft([
              { p: [x0, fy - 0.006, L.z + 0.005], w: 0.009, bone: id + 'f' },
              { p: [x0 + dx * 0.6, fy - 0.012, L.z + ln * 0.5], w: 0.0065 },
              { p: [x0 + dx * 0.9, fy - 0.018, L.z + ln * 0.88], w: 0.0055 },
              { p: [x0 + dx, fy - 0.022, L.z + ln], w: 0.003 },
            ], { rings: 5, radial: 5, uvs: 0.02, tag: 'hand', flow: 1, cap0: false });
          }
        }
      }
    },
    hard(H) {
      const nail = lin(0x4a4038), tooth = lin(0xb9ad92);
      for (const s of [1, -1]) {
        for (let k = 0; k < 4; k++) {
          const x = s * (0.012 + k * 0.011);
          hCone(H, [x, 0.892, 0.77 - k * 0.01], [0, -1, 0.15], 0.0035, 0.012, 'head', tooth, {}, 4);
          hCone(H, [x * 0.95, 0.875, 0.762 - k * 0.01], [0, 1, 0.15], 0.0032, 0.01, 'jaw', tooth, {}, 4);
        }
        void nail;
      }
    },
    color(p, n, I) {
      const gz = fbm(p, 16), vein = Math.pow(1 - Math.abs(fbm(p, 9, 13)), 14), up = n.y, t = I.tag;
      let c = mixc(S.skin, S.shade, sstep(0.1, -0.7, up) * 0.6);
      c = mixc(c, S.vein, vein * 0.5);
      if (t === 'hand' || t.startsWith('paw')) c = mixc(c, S.dirt, 0.7);
      if (t === 'legF' || t === 'legH') c = mixc(c, S.dirt, sstep(0.25, -0.15, p.y) * 0.6 + Math.exp(-((p.y - (t === 'legF' ? LF.y - LF.L[0] : LH.y - LH.L[0])) ** 2) / 0.003) * 0.4);
      if (t === 'head') {
        const sock = Math.exp(-((Math.abs(p.x) - 0.031) ** 2) / 0.00025 - ((p.y - 0.94) ** 2) / 0.00015 - ((p.z - 0.785) ** 2) / 0.0002);
        c = mixc(c, S.socket, sock * 0.85);
        c = mixc(c, S.lip, sstep(-0.3, -0.7, up) * sstep(0.74, 0.78, p.z) * 0.8);
        c = mixc(c, S.socket, Math.exp(-(p.x ** 2) / 0.0001 - ((p.y - 0.91) ** 2) / 0.0001 - ((p.z - 0.806) ** 2) / 0.0002) * 0.8);  // nasal pit
      }
      if (t === 'jaw') c = up > 0.3 ? S.mouth : mixc(c, S.lip, sstep(0.2, 0.5, up));
      return mulc(c, 0.86 + gz * 0.2);
    },
    aux(p, n, I) {
      const rib = I.tag === 'torso' ? sstep(-0.16, -0.05, p.z) * sstep(0.28, 0.18, p.z) * sstep(0.25, 0.6, Math.abs(n.x)) * sstep(0.04, -0.06, p.y - I.c.y) : 0;
      return [rib, 0];
    },
    modeHook(P, mode, t, ctl) {
      // the head is never quite still: slow wrong tilts and tiny tremors
      P.hR += 0.35 * n1(ctl.time * 0.2, ctl.seed) + 0.02 * Math.sin(ctl.time * 31);
      P.n1P += 0.35; P.hP -= 0.15; P.jaw = Math.max(P.jaw, 0.05 + 0.04 * Math.max(0, n1(ctl.time * 0.5, 3)));
      if (mode !== 'dead' && mode !== 'sleep') { P.sfP += 0.22; P.sbP -= 0.18; P.by -= 0.12; }   // back hunched, carried low between the limbs
      if (mode === 'alert' || mode === 'stare') { P.n1P -= 0.2; P.hR += 0.3; }
    },
    attack(P, t) {
      // rears up off the arms and lunges, mouth stretched open, hands reaching
      const up = sstep(0, 0.22, t) * (1 - sstep(0.6, 0.85, t)), lunge = bump(t, 0.2, 0.6);
      P.bp -= 0.5 * up; P.by += 0.1 * up; P.bz += 0.45 * lunge; P.n1P -= 0.3 * up; P.hP -= 0.2 * up; P.jaw = 0.9 * up; P.look = 0.6;
      for (let i = 0; i < 2; i++) { const L = P.legs[i]; if (up > 0.15) { L.ik = false; L.fk = [-1.6 * up - 0.3 * lunge, -0.5 * up + 0.4 * lunge, -0.3, 0.3]; L.fky = 0.4; } }
      P.life = 0;
    },
  };
};

/* ===================================================================== small creatures: shared bits */
/** a grid of alpha-card quads: pos(u,v) -> V3, wt(u,v) -> bone weights; info.rag(u,v) -> corrupted offset */
function cardGrid(CB, nu, nv, pos, wt, info = {}) {
  const base = CB.n, nrm = info.normal || new V3(0, 1, 0);
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv, p = pos(u, v);
    CB.push(p, info.uv ? info.uv(u, v) : [u, v], CB.W(wt(u, v)), { tag: info.tag || 'card', col: info.col, rag: info.rag ? info.rag(u, v, p) : null, part: 0, c: p, T: new V3(0, 0, 1), flow: 1 }, nrm);
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) { const a = base + j * (nu + 1) + i, b = a + nu + 1; CB.idx.push(a, a + 1, b, b, a + 1, b + 1); }
}
/** controller for the small rigs: every bone gets target euler angles each frame, damped toward them */
class SimpleCtrl {
  constructor(K, rig, seed) {
    this.K = K; this.rig = rig; this.seed = seed; const n = K.S.names.length;
    this.cur = Array.from({ length: n }, () => [0, 0, 0]); this.tgt = Array.from({ length: n }, () => [0, 0, 0]); this.kb = new Float32Array(n);
    this.p = new V3(); this.pc = new V3(); this.time = hash1(seed) * 50; this.c = 0; this.first = true; this.lk = [0, 0];
  }
  setC(c) { this.c = c; }
  E(name, x = 0, y = 0, z = 0, k = 0) { const i = this.K.S.bi[name]; const e = this.tgt[i]; e[0] = x; e[1] = y; e[2] = z; if (k) this.kb[i] = k; return e; }
  look(s, root, w, k, dt) {   // yaw / pitch toward s.lookAt, relative to the root
    let y = 0, p = 0;
    if (s.lookAt && root && w > 0) { _v.copy(s.lookAt); root.worldToLocal(_v); const hb = this.rig.mp[this.K.S.bi.head]; _v.sub(hb); y = clamp(Math.atan2(_v.x, _v.z), -1.6, 1.6) * w; p = clamp(-Math.atan2(_v.y, Math.hypot(_v.x, _v.z)), -1, 1) * w; }
    this.lk[0] = damp(this.lk[0], y, k, dt); this.lk[1] = damp(this.lk[1], p, k, dt);
    return this.lk;
  }
  animate(dt, s, root) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1); this.time += dt;
    for (const e of this.tgt) e[0] = e[1] = e[2] = 0;
    this.kb.fill(this.k = 10); this.p.set(0, 0, 0);
    this.pose(dt, s || {}, root);
    const B = this.rig.bones;
    for (let i = 0; i < B.length; i++) {
      const a = this.first ? 1 : 1 - Math.exp(-this.kb[i] * dt), e = this.cur[i], g = this.tgt[i];
      e[0] += (g[0] - e[0]) * a; e[1] += (g[1] - e[1]) * a; e[2] += (g[2] - e[2]) * a;
      B[i].quaternion.setFromEuler(_e.set(e[0], e[1], e[2], 'YXZ'));
    }
    this.pc.lerp(this.p, this.first ? 1 : 1 - Math.exp(-this.kb[0] * dt));
    B[0].position.copy(this.rig.lp[0]).add(this.pc);
    this.first = false;
  }
}

/* ===================================================================== BIRD (crow / raven sized; opts.color 'brown' for a brown bird) */
class BirdCtrl extends SimpleCtrl {
  pose(dt, s, root) {
    const m = s.mode || 'perch', t = s.t || 0, T = this.time, c = this.c, sd = this.seed;
    // folded: the arm swings back along the flank, the wing plane tips down over the side like a cloak
    const fold = (k = 1, droop = 0) => { this.E('wL1', -0.95 * k, 1.42 * k, 0.12 * k - droop); this.E('wL2', 0, 0.12 * k, 0); this.E('wR1', -0.95 * k, -1.42 * k, -0.12 * k + droop); this.E('wR2', 0, -0.12 * k, 0); };
    const legsDown = (bend = 0) => { this.E('lgL', bend, 0, 0); this.E('lgR', bend, 0, 0); };
    const flying = m === 'fly' || m === 'glide' || m === 'run';
    // head: birds look around in sudden snaps, not sweeps
    const seg = Math.floor(T * 1.3 + hash1(sd) * 5), hy = (hash1(seg * 7.7 + sd) - 0.5) * 1.8, hp = (hash1(seg * 3.1 + sd) - 0.5) * 0.4;
    let still = c * 0.8;
    if (flying) {
      const glide = m === 'glide', f = 4.2, ph = T * f * TAU;
      if (glide) {
        const w = 0.04 * Math.sin(T * 1.3);
        this.E('wL1', 0.05, 0, 0.14 + w, 8); this.E('wL2', 0, 0, -0.06, 8); this.E('wR1', 0.05, 0, -0.14 - w, 8); this.E('wR2', 0, 0, 0.06, 8);
        this.E('body', 0.05, 0, 0.18 * Math.sin(T * 0.7));
      } else {
        const down = Math.sin(ph) * (Math.sin(ph) > 0 ? 1 : 0.8);
        this.E('wL1', 0.15 * Math.cos(ph), 0.1 * Math.cos(ph), 0.2 + 0.85 * down, 60); this.E('wL2', 0, -0.15 * Math.cos(ph), 0.45 * Math.sin(ph - 0.8), 60);
        this.E('wR1', 0.15 * Math.cos(ph), -0.1 * Math.cos(ph), -0.2 - 0.85 * down, 60); this.E('wR2', 0, 0.15 * Math.cos(ph), -0.45 * Math.sin(ph - 0.8), 60);
        this.E('body', 0.12, 0, 0); this.p.y = -0.012 * Math.sin(ph); this.kb[0] = 40;
      }
      this.E('lgL', 1.25); this.E('lgR', 1.25); this.E('tail', -0.05);
      this.E('neck', -0.1); this.E('head', 0.0, 0, 0);
    } else if (m === 'dead') {
      fold(0.5); this.E('wL1', -0.6, 0.6, -0.5); this.E('wR1', -0.6, -0.6, 0.5);
      this.E('body', 0, 0, Math.PI * 0.95, 4); this.p.y = -0.075; this.E('lgL', -0.4, 0, 0.3); this.E('lgR', -0.4, 0, -0.3); this.E('neck', 0.3, 0.4); this.E('head', 0.2, 0.3, 0.4);
    } else if (m === 'sleep') {
      fold(1.05); this.E('body', -0.1, 0, 0, 3); this.p.y = -0.03; legsDown(0.6); this.E('neck', 0.2, 1.3, 0, 3); this.E('head', 0.4, 1.3, 0, 3); this.E('tail', -0.1);
    } else {
      fold(1, 0.25 * c);
      let bp = -0.55, np = 0.3, hpp = 0.25;
      if (m === 'eat') { const pk = Math.max(0, Math.sin(t * 7)) ** 3; bp = 0.35; np = 0.5; hpp = 0.45 + 0.5 * pk; this.kb[this.K.S.bi.head] = 25; }
      if (m === 'alert') { bp = -0.65; np = -0.1; hpp = 0.1; still = 1; }
      if (m === 'hop' || m === 'walk') { const u = frac(t * 1.7); this.p.y = 0.045 * bump(u, 0, 0.45); legsDown(0.5 * bump(u, 0.4, 0.9)); this.kb[0] = 30; this.E('tail', 0.25 * bump(u, 0, 0.5)); }
      else legsDown(0.15);
      this.E('body', bp, 0, 0); this.E('neck', np, hy * 0.45 * (1 - still), 0, 25); this.E('head', hpp + hp * (1 - still), hy * 0.5 * (1 - still), 0, 25);
      if (m === 'idle' || m === 'perch') this.E('tail', 0.12 * Math.max(0, Math.sin(T * 1.7)) * (1 - still));
      if (m === 'attack') { const l = bump(t, 0.05, 0.5); this.E('body', 0.4 * l - 0.3, 0, 0, 25); this.E('neck', 0.5 * l, 0, 0, 25); this.E('head', 0.3 * l); this.E('wL1', -0.6, 0.4, 0.6 * l, 25); this.E('wR1', -0.6, -0.4, -0.6 * l, 25); this.p.z = 0.06 * l; }
      if (m === 'hurt') { const e = Math.exp(-t * 6); this.E('wL1', -0.8, 0.6, 0.8 * e, 30); this.E('wR1', -0.8, -0.6, -0.8 * e, 30); this.E('body', -0.6 * e - 0.3, 0, 0.4 * e, 30); }
      if (m === 'jerk' || m === 'stare') {
        const lk = this.look(s, root, 1, 18, dt); this.E('neck', np, lk[0] * 0.5, 0, 30); this.E('head', hpp + lk[1], lk[0] * 0.5, 0, 30);
        if (m === 'jerk') { const sg = Math.floor(t * 2 + hash1(sd)), j = hash1(sg * 9.1 + sd) * 2 - 1; this.E('head', hpp, lk[0] * 0.5, j * 1.2, 60); }
      } else if (s.lookAt) { const lk = this.look(s, root, 0.7, 6, dt); this.tgt[this.K.S.bi.head][1] += lk[0]; }
    }
    if (c > 0 && m !== 'dead') this.tgt[this.K.S.bi.head][2] += 0.5 * c;   // head cocked too far
  }
}
KINDS.bird = (opts) => {
  const brown = opts.color === 'brown';
  const F = brown ? { base: lin(0x4a3a2c), light: lin(0x7a6248), dark: lin(0x2a2018) } : { base: lin(0x1d1d22), light: lin(0x34343c), dark: lin(0x0e0e11) };
  const bones = [
    ['body', null, [0, 0.115, 0]], ['neck', 'body', [0, 0.14, 0.05]], ['head', 'neck', [0, 0.158, 0.077]], ['tail', 'body', [0, 0.12, -0.055]],
    ['wL1', 'body', [0.03, 0.14, 0.015]], ['wL2', 'wL1', [0.14, 0.142, 0.005]], ['wR1', 'body', [-0.03, 0.14, 0.015]], ['wR2', 'wR1', [-0.14, 0.142, 0.005]],
    ['lgL', 'body', [0.012, 0.097, 0.005]], ['lgR', 'body', [-0.012, 0.097, 0.005]],
  ];
  return {
    kind: 'bird', size: 0.3, bones, Ctrl: BirdCtrl,
    modes: [['perch'], ['hop'], ['fly', 0, 0.5], ['glide', 0, 0.5], ['eat'], ['alert'], ['sleep'], ['attack'], ['dead'], ['stare'], ['jerk'], ['hurt']], sheenColor: brown ? 0x6a5a48 : 0x343850, sheen: 0.55, rough: 0.6, normalK: 0.25, dark: 0.55, patch: 0,
    cardMap: featherTex, cardAlpha: 0.35,
    eye: { from: [0, 0.163, 0.09], dir: [0.9, 0.25, 0.35], r: 0.0042, iris: brown ? '#3a2410' : '#140e0a', pupil: 0.3, irisEnd: 0.55, sclera: '#0c0806', glow: 0xe6ffe8, seg: [8, 6] },
    body(B) {
      B.loft([
        { p: [0, 0.12, -0.075], w: 0.008, bone: 'tail' },
        { p: [0, 0.12, -0.055], w: 0.025, t: 0.02, b: 0.025, bone: { tail: 0.5, body: 0.5 } },
        { p: [0, 0.122, -0.02], w: 0.038, t: 0.033, b: 0.04, bone: 'body' },
        { p: [0, 0.126, 0.02], w: 0.04, t: 0.035, b: 0.045 },
        { p: [0, 0.136, 0.046], w: 0.03, t: 0.03, b: 0.035, bone: { body: 0.5, neck: 0.5 }, tag: 'neck' },
        { p: [0, 0.15, 0.066], w: 0.025, t: 0.025, b: 0.026, bone: 'neck', tag: 'neck' },
        { p: [0, 0.16, 0.082], w: 0.024, t: 0.025, b: 0.022, bone: 'head', tag: 'head' },
        { p: [0, 0.162, 0.099], w: 0.02, t: 0.02, b: 0.018, tag: 'head' },
        { p: [0, 0.158, 0.112], w: 0.011, t: 0.01, b: 0.01, tag: 'head' },
      ], { rings: 16, radial: 11, uvs: 0.012, tag: 'torso', flow: -1 });
    },
    cards(CB) {
      for (const s of [1, -1]) {
        const w1 = s > 0 ? 'wL1' : 'wR1', w2 = s > 0 ? 'wL2' : 'wR2', r = rng(s > 0 ? 3 : 4);
        const ragv = Array.from({ length: 9 }, () => (r() - 0.45) * 0.05);
        const le = u => new V3(s * lerp(0.028, 0.3, u), 0.14 + 0.012 * Math.sin(Math.PI * u), 0.02 - 0.05 * Math.pow(u, 1.5));
        const chord = u => lerp(0.1, 0.07, u) + 0.035 * bump(u, 0.35, 1.05) - 0.03 * sstep(0.85, 1, u);
        cardGrid(CB, 8, 2, (u, v) => { const p = le(u); p.z -= chord(u) * (1 - v); p.y -= 0.004 * (1 - v); return p; },
          u => (u < 0.4 ? w1 : u > 0.6 ? w2 : { [w1]: (0.6 - u) / 0.2, [w2]: (u - 0.4) / 0.2 }),
          { col: F.base, tag: 'wing', uv: (u, v) => [u, v], rag: (u, v) => new V3(0, 0, v < 0.5 ? ragv[Math.round(u * 8)] * (1 - v) : 0) });
      }
      cardGrid(CB, 3, 2, (u, v) => new V3((u - 0.5) * lerp(0.07, 0.022, v), 0.118 + 0.004 * (1 - v), lerp(-0.165, -0.05, v)), () => 'tail',
        { col: F.base, tag: 'tailfan', uv: (u, v) => [u * 0.5 + 0.25, v], rag: (u, v) => new V3(0, 0, v < 0.5 ? (hash1(u * 13) - 0.4) * 0.05 : 0) });
    },
    hard(H) {
      const beak = lin(0x161618), leg = lin(0x1a1a1c);
      hLoft(H, [{ p: [0, 0.158, 0.106], w: 0.009, t: 0.009, b: 0.007, bone: 'head' }, { p: [0, 0.156, 0.128], w: 0.005, t: 0.006, b: 0.004 }, { p: [0, 0.151, 0.148], w: 0.001, t: 0.001, b: 0.001 }], { rings: 4, radial: 6, tag: 'beak' }, beak);
      for (const s of [1, -1]) {
        const lg = s > 0 ? 'lgL' : 'lgR', x = s * 0.013;
        hLoft(H, [{ p: [x, 0.1, 0.005], w: 0.004, bone: lg }, { p: [x, 0.05, 0.009], w: 0.0025 }, { p: [x, 0.008, 0.012], w: 0.002 }], { rings: 3, radial: 4, tag: 'leg', cap0: false }, leg);
        for (const [dx, dz] of [[-0.008, 0.026], [0, 0.03], [0.008, 0.026], [0, -0.018]]) hCone(H, [x, 0.006, 0.012], [dx, -0.05, dz], 0.0018, Math.hypot(dx, dz), lg, leg, {}, 3);
      }
    },
    color(p, n, I) {
      const g = fbm(p, 120);
      let c = mixc(F.base, F.light, sstep(-0.2, -0.8, n.y) * 0.35);
      if (I.tag === 'head') c = mixc(c, F.dark, 0.3);
      return mulc(c, 0.85 + g * 0.3);
    },
    aux(p) { return [0, clamp(0.5 + fbm(p, 60, 2) * 0.9, 0, 1)]; },
    fur: null,
  };
};

/* ===================================================================== FISH (brown trout) */
class FishCtrl extends SimpleCtrl {
  pose(dt, s) {
    const m = s.mode || 'swim', T = this.time, sp = clamp(s.speed ?? (m === 'swim' ? 0.6 : 0.1), 0, 3), t = s.t || 0;
    if (m === 'dead') { this.E('body', 0, 0, Math.PI * 0.92, 3); this.E('sp2', 0, 0.1); this.E('sp3', 0, 0.15); return; }
    const f = 0.8 + sp * 2.2, ph = T * f * TAU, a = m === 'swim' || m === 'run' ? 0.5 + 0.5 * clamp(sp / 1.2, 0, 1) : 0.25;
    const amp = [0.04, 0.12, 0.22, 0.34];
    this.E('body', 0, -amp[0] * a * Math.sin(ph + 1.2), 0, 30);
    this.E('sp1', 0, amp[1] * a * Math.sin(ph), 0, 30); this.E('sp2', 0, amp[2] * a * Math.sin(ph - 0.9), 0, 30); this.E('sp3', 0, amp[3] * a * Math.sin(ph - 1.8), 0, 30);
    this.E('head', 0, amp[0] * a * Math.sin(ph + 2.2), 0, 30);
    const fl = Math.sin(T * 5) * 0.4;
    this.E('finL', 0, 0.3 + fl, 0, 30); this.E('finR', 0, -0.3 - fl, 0, 30);
    if (m === 'hurt' || m === 'attack') { const e = bump(t, 0, 0.5); this.E('sp2', 0, 0.6 * e, 0, 40); this.E('sp3', 0, 0.8 * e, 0, 40); }
  }
}
KINDS.fish = () => {
  const bones = [
    ['body', null, [0, 0, 0.04]], ['head', 'body', [0, 0, 0.11]], ['jaw', 'head', [0, -0.012, 0.17]],
    ['sp1', 'body', [0, 0, -0.04]], ['sp2', 'sp1', [0, 0, -0.11]], ['sp3', 'sp2', [0, 0, -0.17]],
    ['finL', 'body', [0.026, -0.022, 0.115]], ['finR', 'body', [-0.026, -0.022, 0.115]],
  ];
  const C = { back: lin(0x3e4629), side: lin(0xbcaa76), band: lin(0xc0705c), belly: lin(0xf0e8d6), gill: lin(0x6a5a44), fin: lin(0xc2aa82) };
  return {
    kind: 'fish', size: 0.45, bones, Ctrl: FishCtrl, noCorrupt: true,
    modes: [['swim', 0.3, 0.3], ['swim', 1.5, 0.3], ['idle', 0, 0.3], ['dead', 0, 0.3]], noFurTex: true, bodyMap: spotTex, rough: 0.32, metal: 0.25, clearcoat: 0.9, sheen: 0, patch: 0,
    cardMap: finTex, cardAlpha: 0.25,
    eye: { from: [0, 0.008, 0.17], dir: [0.95, 0.15, 0.25], r: 0.0075, iris: '#b48c34', pupil: 0.24, irisEnd: 0.6, sclera: '#3a2a12', seg: [8, 6] },
    body(B) {
      B.loft([
        { p: [0, 0.005, -0.205], w: 0.004, t: 0.012, b: 0.01, bone: 'sp3' },
        { p: [0, 0.005, -0.185], w: 0.008, t: 0.016, b: 0.013 },
        { p: [0, 0.004, -0.14], w: 0.016, t: 0.026, b: 0.022, bone: { sp2: 0.5, sp3: 0.5 } },
        { p: [0, 0.002, -0.08], w: 0.026, t: 0.042, b: 0.036, bone: { sp1: 0.5, sp2: 0.5 } },
        { p: [0, 0, -0.02], w: 0.033, t: 0.052, b: 0.046, bone: 'sp1' },
        { p: [0, 0, 0.05], w: 0.036, t: 0.055, b: 0.05, bone: 'body' },
        { p: [0, -0.002, 0.11], w: 0.033, t: 0.048, b: 0.044, bone: { body: 0.5, head: 0.5 }, tag: 'head' },
        { p: [0, -0.004, 0.16], w: 0.026, t: 0.035, b: 0.033, bone: 'head', tag: 'head' },
        { p: [0, -0.006, 0.2], w: 0.016, t: 0.022, b: 0.02, tag: 'head' },
        { p: [0, -0.008, 0.222], w: 0.005, t: 0.006, b: 0.005, tag: 'head' },
      ], { rings: 22, radial: 13, uvs: 0.05, tag: 'torso', flow: -1, ref: [0, 1, 0] });
    },
    cards(CB) {
      const side = { normal: new V3(1, 0, 0), col: C.fin };
      // forked tail
      cardGrid(CB, 4, 1, (u, v) => { const k = Math.abs(2 * u - 1); return new V3(0, (2 * u - 1) * (0.01 + 0.055 * v), -0.19 - 0.075 * v * (0.72 + 0.28 * k)); }, () => 'sp3', side);
      cardGrid(CB, 2, 1, (u, v) => new V3(0, 0.052 + 0.045 * v * (1 - 0.45 * u), lerp(0.02, -0.05, u) - 0.022 * v), u => (u < 0.5 ? 'body' : 'sp1'), side);    // dorsal
      cardGrid(CB, 1, 1, (u, v) => new V3(0, 0.028 + 0.012 * v, lerp(-0.115, -0.135, u) - 0.008 * v), () => 'sp2', side);                                  // adipose
      cardGrid(CB, 2, 1, (u, v) => new V3(0, -0.034 - 0.03 * v * (1 - 0.4 * u), lerp(-0.07, -0.11, u) - 0.012 * v), () => 'sp2', side);                   // anal
      for (const s of [1, -1]) {
        cardGrid(CB, 1, 1, (u, v) => new V3(s * (0.024 + 0.035 * v), -0.024 - 0.012 * v, lerp(0.125, 0.105, u) - 0.025 * v), () => (s > 0 ? 'finL' : 'finR'), { normal: new V3(0, 1, 0), col: C.fin });   // pectoral
        cardGrid(CB, 1, 1, (u, v) => new V3(s * (0.012 + 0.02 * v), -0.042 - 0.015 * v, lerp(0.01, -0.01, u) - 0.022 * v), () => 'body', { normal: new V3(0, 1, 0), col: C.fin });            // pelvic
      }
    },
    color(p, n, I) {
      const y = n.y, g = fbm(p, 60);
      let c = mixc(C.side, C.back, sstep(0.0, 0.7, y));
      c = mixc(c, C.belly, sstep(-0.3, -0.8, y));
      c = mixc(c, C.band, Math.exp(-(y * y) / 0.04) * sstep(-0.18, -0.1, p.z) * sstep(0.17, 0.1, p.z) * 0.6);
      if (I.tag === 'head') c = mixc(c, C.gill, bump(p.z, 0.105, 0.125) * sstep(0.3, 0.7, Math.abs(n.x)) * 0.7);
      return mulc(c, 0.9 + g * 0.2);
    },
  };
};

/* ===================================================================== MOTH */
class MothCtrl extends SimpleCtrl {
  pose(dt, s) {
    const m = s.mode || 'fly', T = this.time;
    if (m === 'fly' || m === 'idle' || m === 'run' || m === 'walk') {
      const w = Math.sin(T * TAU * 16) * 1.0 + 0.25;
      this.E('wL', 0, 0.1, w, 80); this.E('wR', 0, -0.1, -w, 80);
      this.p.set(0.01 * n1(T * 3, this.seed), 0.012 * n1(T * 2.5, this.seed + 1), 0.006 * n1(T * 4, this.seed + 2)); this.kb[0] = 30;
      this.E('body', 0.2 * n1(T * 2, this.seed + 3), 0.4 * n1(T * 1.5, this.seed + 4), 0.3 * n1(T * 2.2, this.seed + 5), 20);
    } else {   // resting: wings swept back flat, the tent shape of a sitting moth
      this.E('wL', 0, 0.7, -0.15); this.E('wR', 0, -0.7, 0.15);
      if (m === 'dead') this.E('body', 0, 0, Math.PI * 0.9);
    }
  }
}
KINDS.moth = () => ({
  kind: 'moth', size: 0.08, Ctrl: MothCtrl, noCorrupt: true, modes: [['fly', 0, 0.06], ['idle', 0, 0.06], ['perch', 0, 0.003], ['dead', 0, 0.003]], rough: 0.9, sheen: 0.6, sheenColor: 0xaa9a80, normalK: 0.2, patch: 0, cardMap: mothTex, cardAlpha: 0.3,
  bones: [['body', null, [0, 0, 0]], ['head', 'body', [0, 0, 0.008]], ['wL', 'body', [0.002, 0.002, 0.004]], ['wR', 'body', [-0.002, 0.002, 0.004]]],
  body(B) {
    B.loft([{ p: [0, 0, -0.016], w: 0.0015, bone: 'body' }, { p: [0, 0, -0.004], w: 0.0035 }, { p: [0, 0.001, 0.006], w: 0.003, bone: 'head', tag: 'head' }, { p: [0, 0.001, 0.011], w: 0.0012, tag: 'head' }],
      { rings: 5, radial: 4, uvs: 0.01, tag: 'torso', flow: -1 });
  },
  cards(CB) {
    for (const s of [1, -1]) {
      const wb = s > 0 ? 'wL' : 'wR';
      cardGrid(CB, 1, 1, (u, v) => new V3(s * (0.002 + u * 0.04), 0.002, 0.008 - v * 0.026 - u * u * 0.012), () => wb, { col: lin(0xb8a888), uv: (u, v) => [u, 1 - v] });
    }
  },
  color(p, n, I) { return I.tag === 'head' ? lin(0x6a5a48) : lin(0x8a7a62); },
});

/* ===================================================================== instances */
function getKind(kind, opts) {
  const key = kind + '|' + (opts.color || '') + '|' + (opts.antlers ? 1 : 0);
  if (CACHE.has(key)) return CACHE.get(key);
  const mk = KINDS[kind]; if (!mk) throw new Error('AnimalArt: unknown kind ' + kind);
  const spec = mk(opts);
  const K = spec.custom ? spec.custom() : finishQuad(spec);
  CACHE.set(key, K);
  return K;
}
function skinned(geo, mat, skeleton, shadow, R) {
  const m = new THREE.SkinnedMesh(geo, mat);
  m.bind(skeleton, new THREE.Matrix4());
  m.castShadow = shadow; m.receiveShadow = true;
  m.boundingSphere = new THREE.Sphere(new V3(0, R * 0.4, 0), R);
  return m;
}
function createQuad(K, opts) {
  const seed = (opts.seed ?? 1) >>> 0, r = rng(seed * 31 + 7);
  const A = { kind: K.kind, size: K.size, root: new THREE.Group() };
  const rig = new Rig(K.S);
  A.root.add(rig.bones[0]);
  const U = { uCor: { value: 0 }, uRib: { value: K.ribAlways ?? 0 }, uRibF: { value: TAU / (K.ribSpacing ?? 0.055) }, uDark: { value: K.dark ?? 0.42 }, uPatch: { value: K.patch ?? 1 },
    uSkin: { value: new THREE.Color(K.skinColor ?? 0x3a2e2e) }, uTint: { value: new THREE.Color(1, 1, 1).multiplyScalar(0.94 + r() * 0.12) },
    uDens: { value: K.furDens ?? 16 }, uUnder: { value: K.shellGeo ? K.under ?? 0.78 : 1 } };
  U.uTint.value.r *= 0.97 + r() * 0.06;
  const mats = [];
  const R = K.size * 1.25;
  const body = skinned(K.bodyGeo, furMat(K, U, 'body'), rig.skeleton, true, R); mats.push(body.material); A.root.add(body);
  const meshes = [body];
  if (K.shellGeo) { const m = skinned(K.shellGeo, furMat(K, U, 'shell'), rig.skeleton, false, R); mats.push(m.material); A.root.add(m); meshes.push(m); }
  if (K.cardGeo) { const m = skinned(K.cardGeo, furMat(K, U, 'cards'), rig.skeleton, false, R); mats.push(m.material); A.root.add(m); meshes.push(m); }
  if (K.hardGeo) {
    if (!K.hardMat) K.hardMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: K.hardRough ?? 0.4, metalness: 0 });
    const m = skinned(K.hardGeo, K.hardMat, rig.skeleton, true, R); A.root.add(m); meshes.push(m);
  }
  const head = rig.bones[K.S.bi.head];
  let eye = null, glint = null;
  if (K.eyeGeo) {
    eye = new THREE.Mesh(K.eyeGeo, eyeMat(K)); mats.push(eye.material); head.add(eye);
    glint = new THREE.Points(K.glintGeo, glintMat(K.eye.glow ?? 0xd6ffe2)); mats.push(glint.material); head.add(glint);
    glint.frustumCulled = false;
    const sz = new THREE.Vector2();
    glint.onBeforeRender = (renderer) => { renderer.getDrawingBufferSize(sz); glint.material.uniforms.uScreen.value = sz.y; };
  }
  const ctl = new (K.Ctrl || QuadCtrl)(K, rig, seed % 997 + r() * 10);
  const sc = 1 + (r() - 0.5) * (K.sizeVar ?? 0.1);
  A.root.scale.setScalar(sc);
  A.head = head; A.rig = rig;
  let cur = -1;
  A.setCorruption = (c) => {
    c = K.noCorrupt ? 0 : clamp(c, 0, 1); if (Math.abs(c - cur) < 1e-4) return; cur = c;
    rig.setC(c); ctl.setC(c);
    for (const m of meshes) if (m.morphTargetInfluences) m.morphTargetInfluences[0] = c;
    U.uCor.value = c; U.uRib.value = Math.max(K.ribAlways ?? 0, c);
    const hb = rig.mp[K.S.bi.head];
    if (eye) {
      eye.position.set(-hb.x, -hb.y, -hb.z); glint.position.copy(eye.position);
      const style = K.eye.corrupt || 'pale';
      if (style === 'pale') { eye.material.emissiveIntensity = c * 1.6; eye.material.color.setRGB(1, 1, 1).lerp(new THREE.Color(0xc8d8cc), c); }
      else { eye.material.emissiveIntensity = 0; eye.material.color.setRGB(1, 1, 1).lerp(new THREE.Color(0x050505), c); eye.material.roughness = lerp(0.15, 0.04, c); eye.morphTargetInfluences[0] = c; }
      glint.material.uniforms.uI.value = sstep(0.15, 0.6, c) * (style === 'pale' ? 2.2 : 1.2);
      glint.material.uniforms.uSize.value = K.eye.r * (style === 'pale' ? 2.4 : 1.4);
      glint.visible = c > 0.1;
    }
  };
  A.setCorruption(0);
  A.animate = (dt, s = {}) => ctl.animate(dt, s, A.root);
  A.dispose = () => { for (const m of mats) m.dispose(); A.root.removeFromParent(); };
  A.tris = K.tris;
  return A;
}

/** createAnimal(kind, { seed, color, antlers }) */
export function createAnimal(kind, opts = {}) {
  const K = getKind(kind, opts);
  return K.create ? K.create(K, opts) : createQuad(K, opts);
}

/* ===================================================================== lineup for _view.html */
const ALL = ['wolf', 'rabbit', 'deer', 'bear', 'bird', 'fish', 'crawler', 'moth'];
export function lineup(ctx) {
  const { scene, camera } = ctx;
  const arg = ctx.arg || '';
  const items = [];
  const add = (kind, opts, x, z, ry, c, s) => {
    const A = createAnimal(kind, opts); A.root.position.set(x, s.y || 0, z); A.root.rotation.y = ry; A.setCorruption(c); scene.add(A.root);
    items.push({ A, s: { mode: 'idle', t: 0, speed: 0, lookAt: null, ...s }, loop: s.loop }); return A;
  };
  const kinds = ALL.filter(k => KINDS[k]);
  if (!arg) {
    // every kind in a row (idle), its corrupted twin right behind it
    const w = k => Math.max(0.55, getKind(k, { antlers: true }).size * 0.85);
    let x = -kinds.reduce((a, k) => a + w(k), 0) / 2;
    for (const k of kinds) {
      x += w(k) / 2;
      const extra = k === 'bird' ? { mode: 'perch' } : k === 'fish' ? { mode: 'swim', speed: 0.4, y: 0.35 } : k === 'moth' ? { mode: 'fly', y: 0.9 } : {};
      add(k, { seed: 3, antlers: true }, x, 1.0, 1.0, 0, extra);
      add(k, { seed: 4, antlers: true }, x, -1.4, 1.0, 1, extra);
      x += w(k) / 2;
    }
    return { cam: [0, 2.4, 9.5], look: [0, 0.6, 0], update: tick };
  }
  if (arg === 'night') {
    const cam = new V3(0, 1.6, 7);
    [[-2.2, -3, 0.2], [0.4, -6, -0.1], [2.5, -2, -0.4], [-4.5, -9, 0.3], [5, -11, -0.3]].forEach(([x, z, ry], i) =>
      add('wolf', { seed: 10 + i }, x, z, ry, 1, { mode: 'stare', lookAt: cam }));
    return { cam: [0, 1.6, 7], look: [0, 0.8, -4], update: tick };
  }
  const [kind, single] = arg.split(':');
  if (!KINDS[kind]) throw new Error('lineup: unknown kind ' + kind);
  const K = getKind(kind, {});
  const sz = K.size;
  if (typeof window !== 'undefined' && window.__log) window.__log(kind + ' tris ' + K.tris + ' (' + (K.triInfo || '') + ')');
  if (single) {           // one mode, normal and corrupted, close up
    const [mode, sp] = single.split('@');
    const s = { mode, speed: +(sp || 0), loop: mode === 'attack' || mode === 'hurt' ? 1.4 : 0 };
    add(kind, { seed: 3, antlers: true }, -sz * 0.7, 0, Math.PI / 2, 0, s);
    add(kind, { seed: 4, antlers: true }, sz * 0.7, 0, Math.PI / 2, 1, s);
    return { cam: [0, sz * 0.55, sz * 2.4], look: [0, sz * 0.35, 0], update: tick };
  }
  const modes = K.modes || [['idle'], ['walk', 1.5], ['run', 4], ['run', 9], ['eat'], ['alert'], ['sleep'], ['attack'], ['dead'], ['stare'], ['howl'], ['jerk']];
  // grid of cells, 4 per row; each cell = the normal animal (left) and the corrupted one (right)
  const cols = 4, rows = Math.ceil(modes.length / cols), cw = sz * 1.75, ch = sz * 1.9;
  const camPos = new V3(0, sz * 3.2, sz * 4.6);
  modes.forEach(([mode, speed, y], i) => {
    const x = ((i % cols) - (cols - 1) / 2) * cw, z = -Math.floor(i / cols) * ch;
    for (const c of [0, 1]) add(kind, { seed: 3 + i + c * 50, antlers: true }, x + c * sz * 0.15, z - c * sz * 0.75, Math.PI / 2, c, { mode, speed: speed || 0, y: y || 0, loop: mode === 'attack' || mode === 'hurt' ? 1.4 : 0, lookAt: mode === 'stare' ? camPos : null });
  });
  return { cam: camPos.toArray(), look: [0, 0, -(rows - 1) * ch * 0.5 - sz * 0.3], update: tick };
  function tick(dt, t) {
    for (const it of items) {
      it.s.t = it.loop ? t % it.loop : t;
      it.A.animate(dt, it.s);
    }
    void camera;
  }
}
