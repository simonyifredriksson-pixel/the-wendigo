/* Textures.js - every surface texture is painted in code at boot.

   tex(name) returns a cached { map, normalMap, roughnessMap? } set.
   Height fields are painted first, then turned into normal maps with a
   Sobel filter, so bark plates, rock cracks and needle litter all catch
   the low sun correctly. Cards (branches, leaves, ferns) carry alpha. */
import * as THREE from '../../lib/three.module.js';
import { Noise, rng, clamp, lerp } from './Util.js';

const N = new Noise(77);
const N2 = new Noise(4242);
const cache = new Map();
let aniso = 4;
export function setAniso(a) { aniso = a; }

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function toTex(c, { repeat = true, srgb = true, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}
/** periodic noise: sample 4D-ish by blending wrapped coords so textures tile seamlessly */
function tileNoise(n, x, y, w, h, fx, fy, oct = 4) {
  // anisotropic fbm made seamless by blending the four wrapped copies;
  // fx/fy are feature counts across the tile (fx > fy = narrow tall features)
  const u = x / w, v = y / h;
  const f = (a, b) => n.fbm2(a * fx, b * fy, oct);
  const s = lerp(lerp(f(u, v), f(u - 1, v), u), lerp(f(u, v - 1), f(u - 1, v - 1), u), v);
  // the blend flattens contrast in the middle of the tile; restore it
  const k = 1 / Math.sqrt((u * u + (1 - u) * (1 - u)) * (v * v + (1 - v) * (1 - v)));
  return s * k;
}
// cheaper 2D tiling via 4-corner blend
function tn2(n, x, y, w, h, sc, oct = 4) {
  const u = x / w, v = y / h;
  const s00 = n.fbm2(u * sc, v * sc, oct), s10 = n.fbm2((u - 1) * sc, v * sc, oct), s01 = n.fbm2(u * sc, (v - 1) * sc, oct), s11 = n.fbm2((u - 1) * sc, (v - 1) * sc, oct);
  const k = 1 / Math.sqrt((u * u + (1 - u) * (1 - u)) * (v * v + (1 - v) * (1 - v)));
  return lerp(lerp(s00, s10, u), lerp(s01, s11, u), v) * k;
}

/** height (Float32Array w*h, 0..1) -> normal map canvas */
function normalFromHeight(hf, w, h, strength = 2) {
  const c = canvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const H = (x, y) => hf[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const i = (y * w + x) * 4; d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}
function paint(w, h, fn) {
  const c = canvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data, hf = new Float32Array(w * h);
  const out = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[3] = 255;
    const ht = fn(x, y, out);
    const i = (y * w + x) * 4; d[i] = clamp(out[0], 0, 255); d[i + 1] = clamp(out[1], 0, 255); d[i + 2] = clamp(out[2], 0, 255); d[i + 3] = clamp(out[3], 0, 255);
    hf[y * w + x] = ht || 0;
  }
  g.putImageData(img, 0, 0);
  return { c, hf };
}

/* ======================================================= bark */
function barkPine(w = 256, h = 512) {
  return paint(w, h, (x, y, o) => {
    const u = x / w, v = y / h;
    // long vertical plates separated by deep furrows
    const plates = tileNoise(N, x, y, w, h, 7, 2.2, 3);
    const furrow = Math.pow(1 - Math.abs(plates), 6);
    const flake = tn2(N2, x, y, w, h, 24, 3);
    const cross = Math.abs(Math.sin(v * Math.PI * 22 + tileNoise(N2, x, y, w, h, 3, 3, 2) * 6));
    const ht = clamp(0.62 - furrow * 0.65 + flake * 0.18 - (cross < 0.12 ? 0.18 : 0) * (1 - furrow), 0, 1);
    const warm = 0.5 + tn2(N, x + 50, y, w, h, 3, 2) * 0.5;
    o[0] = lerp(46, 128, ht) * lerp(0.92, 1.08, warm); o[1] = lerp(40, 108, ht) * lerp(0.95, 1.0, warm); o[2] = lerp(34, 90, ht);
    // grey lichen patches on the plate tops
    const lich = clamp((N2.fbm2(u * 9, v * 6, 3) - 0.25) * 3, 0, 1) * ht;
    o[0] = lerp(o[0], 118, lich * 0.45); o[1] = lerp(o[1], 122, lich * 0.45); o[2] = lerp(o[2], 104, lich * 0.45);
    void u;
    return ht;
  });
}
function barkBirch(w = 256, h = 512) {
  const r = rng(9); const marks = [];
  for (let i = 0; i < 90; i++) marks.push({ x: r() * w, y: r() * h, l: 6 + r() * 40, t: 1 + r() * 3.5 });
  return paint(w, h, (x, y, o) => {
    const v = y / h;
    let ht = 0.8 + tn2(N, x, y, w, h, 8, 3) * 0.08;
    let col = 218 + tn2(N2, x, y, w, h, 12, 2) * 18;
    for (const m of marks) { const dy = Math.abs(((y - m.y + h * 1.5) % h) - h * 0.5); const dx = Math.abs(((x - m.x + w * 1.5) % w) - w * 0.5); if (dy < m.t && dx < m.l * (1 - dy / m.t * 0.5)) { col = 40 + dy * 8; ht = 0.35; } }
    const base = clamp(1 - v * 6, 0, 1); // dark base
    o[0] = col * (1 - base * 0.6); o[1] = col * 0.98 * (1 - base * 0.62); o[2] = col * 0.93 * (1 - base * 0.65);
    return ht;
  });
}
function barkOak(w = 256, h = 512) {
  return paint(w, h, (x, y, o) => {
    const p = tileNoise(N2, x, y, w, h, 9, 4, 4);
    const ridge = 1 - Math.pow(Math.abs(p), 0.5);
    const ht = clamp(0.3 + ridge * 0.6 + tn2(N, x, y, w, h, 30, 2) * 0.1, 0, 1);
    o[0] = lerp(30, 92, ht); o[1] = lerp(26, 80, ht); o[2] = lerp(22, 66, ht);
    return ht;
  });
}

/* ======================================================= ground */
function groundGrass(w = 512) {
  const r = rng(21);
  const res = paint(w, w, (x, y, o) => {
    const n = tn2(N, x, y, w, w, 6, 4), n2 = tn2(N2, x, y, w, w, 22, 3);
    const dry = clamp(tn2(N2, x + 9, y + 3, w, w, 3, 2) * 1.6 + 0.2, 0, 1);
    o[0] = lerp(52, 96, dry) + n * 18 + n2 * 10; o[1] = lerp(78, 92, dry) + n * 22 + n2 * 12; o[2] = lerp(30, 44, dry) + n * 8;
    return 0.5 + n2 * 0.3;
  });
  // blade strokes
  const g = res.c.getContext('2d');
  for (let i = 0; i < 9000; i++) {
    const x = r() * w, y = r() * w, l = 3 + r() * 9, a = -Math.PI / 2 + (r() - 0.5) * 1.2;
    const k = r(); g.strokeStyle = `rgba(${(60 + k * 70) | 0},${(85 + k * 60) | 0},${(30 + k * 25) | 0},${0.35 + r() * 0.4})`;
    g.lineWidth = 0.6 + r() * 0.9; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return res;
}
function groundForest(w = 512) {
  // needle litter, twigs, moss, small cones - the floor of the reference forest
  const r = rng(33);
  const res = paint(w, w, (x, y, o) => {
    const n = tn2(N, x, y, w, w, 5, 4), n2 = tn2(N2, x, y, w, w, 30, 3);
    const moss = clamp(tn2(N2, x + 77, y, w, w, 4, 3) * 2.2 + 0.25, 0, 1);
    o[0] = lerp(84, 62, moss) + n * 18 + n2 * 14; o[1] = lerp(66, 84, moss) + n * 14 + n2 * 10; o[2] = lerp(42, 34, moss) + n * 8;
    return 0.45 + n2 * 0.25 + n * 0.1;
  });
  const g = res.c.getContext('2d');
  for (let i = 0; i < 14000; i++) {
    const x = r() * w, y = r() * w, l = 3 + r() * 8, a = r() * Math.PI * 2, k = r();
    g.strokeStyle = `rgba(${(90 + k * 80) | 0},${(60 + k * 45) | 0},${(30 + k * 25) | 0},${0.3 + r() * 0.5})`;
    g.lineWidth = 0.5 + r() * 0.6; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  for (let i = 0; i < 120; i++) { // twigs
    const x = r() * w, y = r() * w, l = 12 + r() * 30, a = r() * Math.PI * 2;
    g.strokeStyle = `rgba(${(50 + r() * 30) | 0},${(38 + r() * 20) | 0},25,0.8)`; g.lineWidth = 1 + r() * 1.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  return res;
}
function groundRock(w = 512) {
  return paint(w, w, (x, y, o) => {
    const p = tileNoise(N, x, y, w, w, 5, 5, 5);
    const cr = Math.pow(1 - Math.abs(tileNoise(N2, x, y, w, w, 7, 3, 3)), 12);
    const ht = clamp(0.55 + p * 0.4 - cr * 0.5, 0, 1);
    const g = lerp(70, 132, ht) + tn2(N2, x, y, w, w, 40, 2) * 10;
    const lich = clamp(tn2(N, x + 31, y, w, w, 6, 3) * 2 - 0.4, 0, 1);
    o[0] = g * lerp(1, 0.75, lich) + lich * 30; o[1] = g * lerp(0.98, 0.95, lich) + lich * 34; o[2] = g * lerp(0.94, 0.6, lich);
    return ht;
  });
}
function groundSand(w = 512) {
  return paint(w, w, (x, y, o) => {
    const n = tn2(N, x, y, w, w, 30, 3), rip = Math.sin((y / w) * Math.PI * 40 + tn2(N2, x, y, w, w, 4, 2) * 8) * 0.5 + 0.5;
    o[0] = 176 + n * 22 + rip * 8; o[1] = 158 + n * 20 + rip * 7; o[2] = 120 + n * 16;
    return 0.5 + rip * 0.2 + n * 0.2;
  });
}
function groundMud(w = 512) {
  return paint(w, w, (x, y, o) => {
    const n = tn2(N, x, y, w, w, 8, 4), wet = clamp(tn2(N2, x, y, w, w, 5, 3) * 2, 0, 1);
    o[0] = 58 + n * 16 - wet * 18; o[1] = 50 + n * 12 - wet * 12; o[2] = 36 + n * 8 - wet * 6;
    return 0.5 + n * 0.3 - wet * 0.2;
  });
}
function groundSnow(w = 256) {
  return paint(w, w, (x, y, o) => { const n = tn2(N, x, y, w, w, 10, 3); o[0] = 222 + n * 20; o[1] = 228 + n * 18; o[2] = 236 + n * 14; return 0.5 + n * 0.3; });
}
function caveRock(w = 512) {
  return paint(w, w, (x, y, o) => {
    const p = tileNoise(N2, x, y, w, w, 6, 6, 5);
    const strata = Math.sin((y / w) * Math.PI * 18 + p * 3) * 0.5 + 0.5;
    const ht = clamp(0.5 + p * 0.35 + strata * 0.15, 0, 1);
    const g = lerp(40, 98, ht);
    const wet = clamp(tn2(N, x, y, w, w, 5, 2) * 2, 0, 1);
    o[0] = g * 1.02 - wet * 10; o[1] = g * 0.94 - wet * 8; o[2] = g * 0.86 - wet * 4;
    return ht;
  });
}

/* ======================================================= wood */
function planks(w = 256, h = 512) {
  return paint(w, h, (x, y, o) => {
    const plank = Math.floor(x / (w / 4));
    const grain = Math.sin((x * 0.4 + plank * 13) + tileNoise(N, x, y, w, h, 2, 12, 3) * 10) * 0.5 + 0.5;
    const seam = (x % (w / 4)) < 2 ? 0.25 : 1;
    const ht = (0.5 + grain * 0.3) * seam;
    const tone = 0.85 + ((plank * 7919) % 13) / 60;
    o[0] = (98 + grain * 40) * seam * tone; o[1] = (70 + grain * 28) * seam * tone; o[2] = (44 + grain * 18) * seam * tone;
    return ht;
  });
}
function logEnd(w = 256) {
  return paint(w, w, (x, y, o) => {
    const dx = x - w / 2, dy = y - w / 2, r = Math.hypot(dx, dy) / (w / 2);
    const ring = Math.sin(r * 60 + N.n2(x * 0.05, y * 0.05) * 3) * 0.5 + 0.5;
    const bark = r > 0.9;
    if (bark) { o[0] = 60; o[1] = 42; o[2] = 30; return 0.3; }
    const crack = Math.abs(Math.atan2(dy, dx) - 0.7) < 0.02 * (1 - r) ? 0.4 : 1;
    o[0] = (196 + ring * 30 - r * 30) * crack; o[1] = (152 + ring * 24 - r * 26) * crack; o[2] = (96 + ring * 16 - r * 20) * crack;
    return 0.5 + ring * 0.2;
  });
}
function freshWood(w = 256) {
  return paint(w, w, (x, y, o) => {
    const grain = Math.sin(y * 0.35 + tn2(N, x, y, w, w, 4, 3) * 6) * 0.5 + 0.5;
    const chip = tn2(N2, x, y, w, w, 20, 2);
    o[0] = 214 + grain * 24 + chip * 20; o[1] = 176 + grain * 20 + chip * 16; o[2] = 118 + grain * 14 + chip * 10;
    return 0.5 + grain * 0.2 + chip * 0.3;
  });
}

/* ======================================================= cards (alpha) */
function firBranch(w = 256, h = 512) {
  // one spruce branch seen from above, tip at the top of the canvas (v = 1).
  // A woody stem, side twigs that shorten toward the tip, and thousands of
  // short needle strokes packed densely enough that the card reads as a
  // solid frond (sparse cards make conifers look like fishbones).
  const c = canvas(w, h), g = c.getContext('2d'), r = rng(5);
  g.clearRect(0, 0, w, h);
  const cx = w / 2;
  const stem = (x0, y0, x1, y1, wd, col) => { g.strokeStyle = col; g.lineWidth = wd; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
  const needles = (x0, y0, ang, len, dens, scale, shade) => {
    for (let i = 0; i < dens; i++) {
      const t = Math.pow(r(), 0.9), px = x0 + Math.cos(ang) * len * t, py = y0 + Math.sin(ang) * len * t;
      const side = r() < 0.5 ? -1 : 1, na = ang + side * (0.45 + r() * 0.75), nl = (10 + r() * 12) * scale * (1 - t * 0.35);
      const k = r() * shade;
      g.strokeStyle = `rgba(${(24 + k * 46) | 0},${(50 + k * 70) | 0},${(24 + k * 26) | 0},1)`;
      g.lineWidth = 1.6 + r() * 1.4;
      g.beginPath(); g.moveTo(px, py); g.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl); g.stroke();
    }
  };
  stem(cx, h, cx, 6, 5, '#3b2a1c');
  // under-layer of darker needles gives the frond depth, then the lit top layer
  for (const shade of [0.45, 1]) {
    needles(cx, h, -Math.PI / 2, h - 8, 1300, 1.25, shade);
    for (let i = 0; i < 18; i++) {
      const t = 0.04 + i / 18 * 0.9, y = h - t * (h - 8), side = i % 2 ? 1 : -1;
      const len = Math.pow(1 - t, 0.8) * w * 0.48 + 14, ang = -Math.PI / 2 + side * (0.95 + r() * 0.3);
      if (shade < 1) stem(cx, y, cx + Math.cos(ang) * len, y + Math.sin(ang) * len, 2.4, '#3e2c1d');
      needles(cx, y, ang, len, 240 * (1 - t * 0.5) * (shade < 1 ? 0.6 : 1), 1, shade);
    }
  }
  return { c, hf: null };
}
function leafCluster(palette, seed = 7, w = 512) {
  const c = canvas(w, w), g = c.getContext('2d'), r = rng(seed);
  g.clearRect(0, 0, w, w);
  // twigs
  g.strokeStyle = '#3a2a1e'; g.lineWidth = 3;
  for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(w / 2, w); const a = -Math.PI / 2 + (r() - 0.5) * 2.2; g.lineTo(w / 2 + Math.cos(a) * w * 0.45, w + Math.sin(a) * w * 0.85); g.stroke(); }
  for (let i = 0; i < 520; i++) {
    const a = r() * Math.PI * 2, rad = Math.sqrt(r()) * w * 0.44;
    const x = w / 2 + Math.cos(a) * rad, y = w * 0.48 + Math.sin(a) * rad * 0.9;
    const s = 9 + r() * 12, rot = r() * Math.PI * 2;
    const col = palette[Math.floor(r() * palette.length)];
    const sh = 0.7 + r() * 0.45 - (rad / (w * 0.44)) * 0.1 + (y < w * 0.4 ? 0.12 : -0.05);
    g.fillStyle = `rgb(${(col[0] * sh) | 0},${(col[1] * sh) | 0},${(col[2] * sh) | 0})`;
    g.save(); g.translate(x, y); g.rotate(rot); g.beginPath(); g.ellipse(0, 0, s, s * 0.55, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-s, 0); g.lineTo(s, 0); g.stroke(); g.restore();
  }
  return { c, hf: null };
}
function fernCard(w = 256, h = 512) {
  const c = canvas(w, h), g = c.getContext('2d'), r = rng(12);
  g.clearRect(0, 0, w, h);
  // a frond: a curved rachis with paired pinnae; each pinna is a long tapered
  // blade with toothed (lobed) edges, lighter toward the tip
  const rach = (t) => [w / 2 + Math.sin(t * 2.2) * 8 * t, h - t * (h - 10)];
  g.strokeStyle = '#4a5e26'; g.lineWidth = 4; g.beginPath();
  for (let i = 0; i <= 20; i++) { const [x, y] = rach(i / 20); if (i) g.lineTo(x, y); else g.moveTo(x, y); } g.stroke();
  for (let i = 0; i < 30; i++) {
    const t = 0.05 + i / 30 * 0.92, [x0, y0] = rach(t);
    const len = (Math.sin(Math.min(1, t * 1.15) * Math.PI) * 0.8 + 0.2) * w * 0.47;
    for (const s of [-1, 1]) {
      const ang = -Math.PI / 2 + s * (1.15 - t * 0.35), dx = Math.cos(ang), dy = Math.sin(ang), nx = -dy, ny = dx;
      const k2 = r(), wd = 7 * (1 - t * 0.4);
      g.fillStyle = `rgb(${(46 + k2 * 26 + t * 20) | 0},${(88 + k2 * 40 + t * 30) | 0},${(26 + k2 * 16) | 0})`;
      g.beginPath(); g.moveTo(x0, y0);
      const lobes = 7;
      for (let k = 0; k <= lobes; k++) { const tt = k / lobes, lw = wd * (1 - tt) * (k % 2 ? 1.25 : 0.8); g.lineTo(x0 + dx * len * tt + nx * lw, y0 + dy * len * tt + ny * lw); }
      for (let k = lobes; k >= 0; k--) { const tt = k / lobes, lw = wd * (1 - tt) * (k % 2 ? 1.25 : 0.8); g.lineTo(x0 + dx * len * tt - nx * lw, y0 + dy * len * tt - ny * lw); }
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(30,50,15,0.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x0 + dx * len, y0 + dy * len); g.stroke();
    }
  }
  return { c, hf: null };
}
function bushCard(w = 256) { return leafCluster([[52, 84, 34], [64, 100, 40], [40, 70, 30], [78, 108, 46]], 31, w); }

/* ======================================================= misc */
function cloth(w = 256) {
  return paint(w, w, (x, y, o) => { const weave = ((x % 4 < 2) ^ (y % 4 < 2)) ? 1 : 0.9; const n = tn2(N, x, y, w, w, 10, 2); o[0] = 200 * weave + n * 20; o[1] = 196 * weave + n * 20; o[2] = 190 * weave + n * 20; return weave * 0.5 + n * 0.2; });
}
function metalPaint(w = 256) {
  return paint(w, w, (x, y, o) => {
    const n = tn2(N, x, y, w, w, 6, 4), scratch = Math.abs(N2.n2(x * 0.5, y * 0.02)) < 0.02 ? 1 : 0;
    const rust = clamp(tn2(N2, x, y, w, w, 8, 3) * 2 - 0.5, 0, 1);
    o[0] = lerp(210, 120, rust) + n * 10 + scratch * 30; o[1] = lerp(210, 64, rust) + n * 10 + scratch * 30; o[2] = lerp(214, 36, rust) + n * 10 + scratch * 30;
    return 0.5 + n * 0.1 - rust * 0.2;
  });
}
function noiseTile(w = 256) {
  return paint(w, w, (x, y, o) => { const n = tn2(N, x, y, w, w, 8, 4) * 0.5 + 0.5; o[0] = o[1] = o[2] = n * 255; return n; });
}

const MAKERS = {
  barkPine: () => barkPine(), barkBirch: () => barkBirch(), barkOak: () => barkOak(),
  grass: () => groundGrass(), forest: () => groundForest(), rock: () => groundRock(), sand: () => groundSand(), mud: () => groundMud(), snow: () => groundSnow(),
  caveRock: () => caveRock(), planks: () => planks(), logEnd: () => logEnd(), freshWood: () => freshWood(), cloth: () => cloth(), metal: () => metalPaint(), noise: () => noiseTile(),
  firBranch: () => firBranch(),
  leavesAutumn: () => leafCluster([[196, 92, 24], [214, 128, 30], [168, 64, 20], [226, 156, 52], [150, 50, 22]], 7),
  leavesGreen: () => leafCluster([[78, 112, 40], [96, 130, 48], [60, 92, 34], [118, 146, 60]], 8),
  leavesBirch: () => leafCluster([[150, 160, 60], [120, 140, 46], [176, 170, 70], [98, 120, 40]], 9),
  fern: () => fernCard(), bush: () => bushCard(),
};
const NORMAL_STRENGTH = { barkPine: 5, barkBirch: 2, barkOak: 5, grass: 1.5, forest: 2.5, rock: 4, sand: 1.2, mud: 1.5, snow: 1, caveRock: 5, planks: 2.5, logEnd: 2, freshWood: 2.5, cloth: 1.5, metal: 1, noise: 2 };

/** tex(name) -> { map, normalMap } (normalMap null for alpha cards) */
export function tex(name) {
  if (cache.has(name)) return cache.get(name);
  const mk = MAKERS[name]; if (!mk) throw new Error('no texture ' + name);
  const { c, hf } = mk();
  const set = { map: toTex(c, { repeat: true }), normalMap: null, canvas: c };
  if (hf) { set.normalMap = toTex(normalFromHeight(hf, c.width, c.height, NORMAL_STRENGTH[name] || 2), { srgb: false }); }
  else { set.map.wrapS = set.map.wrapT = THREE.ClampToEdgeWrapping; }
  cache.set(name, set);
  return set;
}
/** a canvas texture from a draw function (signs, carvings, notes) */
export function drawTex(w, h, draw, opts = {}) { const c = canvas(w, h); draw(c.getContext('2d'), w, h); return toTex(c, { repeat: false, ...opts }); }
export { canvas as makeCanvas, toTex };
