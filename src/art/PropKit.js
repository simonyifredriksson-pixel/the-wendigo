/* PropKit.js - shared building blocks for PropArt.js (props, buildings, story objects).

   Textures   pix(w,h,fn) paints per pixel and derives a normal map from the returned height;
              T(name) returns cached painted sets {map, normalMap} for the prop surfaces
              (weathered boards, peeled logs, shingles, fieldstone, drystone, canvas, hide,
              rust, painted drums, bone, rope, glass grime ...).
   Materials  M(key) returns one shared material per surface. All use vertex colours.
              "Mossy" materials (stone, wood, logs, bark, shingles ...) read the vertex colour
              as (R = ambient occlusion, G = moss amount, B = wetness) and blend a moss colour
              in the shader; every other material multiplies the vertex colour as usual.
   Geometry   planarUV, cyl/rod/orient, log, rope, lash, rockGeo, roundBox, plank, antler, bone.
              Every helper emits world-scaled UVs so shared textures never need .repeat.
   Bag        collects geometry per material key and merges it into one mesh per material
              (one draw call per surface), with a ground-contact AO gradient.

   Conventions: metres, +Y up, front +Z, origin on the ground. */
import * as THREE from '../../lib/three.module.js';
import { mergeGeos, xf, tube, lathe, deform } from '../core/Geo.js';
import { rng, Noise, clamp, lerp, sstep, TAU } from '../core/Util.js';
import { tex, makeCanvas, toTex } from '../core/Textures.js';
import { stdMat, windify } from '../core/Shading.js';

export { THREE, mergeGeos, xf, tube, lathe, deform, rng, clamp, lerp, sstep, TAU, tex, makeCanvas, toTex };
export const N1 = new Noise(31337), N2 = new Noise(4711), N3 = new Noise(90210);

/* =========================================================== texture painting */
/** periodic 2D fbm in u,v 0..1 (fx/fy features across the tile) */
export function tn(n, u, v, fx, fy = fx, oct = 4) {
  const f = (a, b) => n.fbm2(a * fx, b * fy, oct);
  const s = lerp(lerp(f(u, v), f(u - 1, v), u), lerp(f(u, v - 1), f(u - 1, v - 1), u), v);
  return s / Math.sqrt((u * u + (1 - u) * (1 - u)) * (v * v + (1 - v) * (1 - v)));
}
/** height field -> normal map canvas (Sobel) */
export function normalCanvas(hf, w, h, strength = 2, wrap = true) {
  const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
  const H = wrap ? (x, y) => hf[((y + h) % h) * w + ((x + w) % w)] : (x, y) => hf[clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1)];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (H(x + 1, y - 1) + 2 * H(x + 1, y) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x - 1, y) + H(x - 1, y + 1));
    const dy = (H(x - 1, y + 1) + 2 * H(x, y + 1) + H(x + 1, y + 1)) - (H(x - 1, y - 1) + 2 * H(x, y - 1) + H(x + 1, y - 1));
    let nx = -dx * strength, ny = dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz);
    const i = (y * w + x) * 4; d[i] = (nx / l * 0.5 + 0.5) * 255; d[i + 1] = (ny / l * 0.5 + 0.5) * 255; d[i + 2] = (nz / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
  }
  g.putImageData(img, 0, 0); return c;
}
/** per-pixel painter: fn(x, y, out[r,g,b,a]) -> height 0..1. Returns {map, normalMap, canvas, hf} */
export function pix(w, h, fn, { strength = 2, wrap = true, after = null } = {}) {
  const c = makeCanvas(w, h), g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data, hf = new Float32Array(w * h);
  const o = [0, 0, 0, 255];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    o[3] = 255; const ht = fn(x, y, o);
    const i = (y * w + x) * 4; d[i] = o[0]; d[i + 1] = o[1]; d[i + 2] = o[2]; d[i + 3] = o[3];
    hf[y * w + x] = ht || 0;
  }
  g.putImageData(img, 0, 0);
  if (after) after(g, w, h, hf);
  return { map: toTex(c, { repeat: wrap }), normalMap: strength ? toTex(normalCanvas(hf, w, h, strength, wrap), { srgb: false, repeat: wrap }) : null, canvas: c, hf };
}
/** a canvas drawn with 2D calls -> float array of its red channel (0..1) */
export function readHeight(c) {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, hf = new Float32Array(c.width * c.height);
  for (let i = 0; i < hf.length; i++) hf[i] = d[i * 4] / 255; return hf;
}
/** periodic jittered cells: returns fn(u,v) -> [d1, d2, id] */
export function cells(nx, ny, seed, jit = 0.85) {
  const r = rng(seed), P = new Float32Array(nx * ny * 3);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; P[k] = i + 0.5 + (r() - 0.5) * jit; P[k + 1] = j + 0.5 + (r() - 0.5) * jit; P[k + 2] = r(); }
  return (u, v) => {
    const x = u * nx, y = v * ny, ix = Math.floor(x), iy = Math.floor(y); let d1 = 9, d2 = 9, id = 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const cx = ix + di, cy = iy + dj, wx = ((cx % nx) + nx) % nx, wy = ((cy % ny) + ny) % ny, k = (wy * nx + wx) * 3;
      const px = P[k] + (cx - wx), py = P[k + 1] + (cy - wy), dd = Math.hypot(px - x, py - y);
      if (dd < d1) { d2 = d1; d1 = dd; id = P[k + 2]; } else if (dd < d2) d2 = dd;
    }
    return [d1, d2, id];
  };
}
const rgbStr = (r, g, b, a = 1) => `rgba(${r | 0},${g | 0},${b | 0},${a})`;
export { rgbStr };

/* ---------------------------------------------------------- painted surfaces */
const TX = new Map();
export function T(name) { if (!TX.has(name)) { const f = PAINT[name]; if (!f) throw new Error('PropKit: no texture ' + name); TX.set(name, f()); } return TX.get(name); }

const PAINT = {
  /** silvery weathered board, grain along v (256 x 1024 covers 0.6 x 2.4 m) */
  greyWood: () => pix(256, 1024, (x, y, o) => {
    const u = x / 256, v = y / 1024;
    const g1 = tn(N1, u, v, 9, 1.5, 3), g2 = tn(N2, u, v, 40, 3, 2), g3 = tn(N3, u, v, 120, 6, 1);
    const crack = Math.pow(clamp(1 - Math.abs(tn(N2, u + 0.3, v, 6, 1.2, 2)) * 1.0, 0, 1), 60);
    const tone = tn(N3, u, v, 2, 1, 2);
    const gr = clamp(0.5 + g1 * 0.45 + g2 * 0.15 + g3 * 0.08, 0, 1);
    const lich = clamp((tn(N1, u + 0.5, v, 6, 3, 3) - 0.38) * 5, 0, 1);
    o[0] = lerp(84, 146, gr) + tone * 22; o[1] = lerp(77, 136, gr) + tone * 16; o[2] = lerp(66, 120, gr) + tone * 8;
    o[0] = lerp(o[0], 140, lich * 0.5); o[1] = lerp(o[1], 146, lich * 0.5); o[2] = lerp(o[2], 118, lich * 0.5);
    o[0] *= 1 - crack * 0.75; o[1] *= 1 - crack * 0.75; o[2] *= 1 - crack * 0.75;
    return 0.55 + g1 * 0.2 + g2 * 0.08 + g3 * 0.04 - crack * 0.5;
  }, { strength: 3 }),
  /** brown, rougher planks (interior, furniture) */
  brownWood: () => pix(256, 1024, (x, y, o) => {
    const u = x / 256, v = y / 1024;
    const g1 = tn(N2, u, v, 8, 1.5, 3), g2 = tn(N1, u, v, 40, 4, 2);
    const knot = Math.max(0, 1 - Math.hypot((u - 0.4) * 7, (v - 0.3) * 3.2) * 1.2);
    const tone = tn(N3, u + 0.2, v, 2, 1, 2);
    const gr = clamp(0.5 + g1 * 0.45 + g2 * 0.15 - knot * 0.4, 0, 1);
    o[0] = lerp(70, 128, gr) + tone * 18; o[1] = lerp(50, 92, gr) + tone * 12; o[2] = lerp(34, 62, gr) + tone * 6;
    return 0.5 + g1 * 0.25 + g2 * 0.1 - knot * 0.2;
  }, { strength: 2.5 }),
  /** peeled, checked old log (u around, v along) */
  logSkin: () => pix(256, 1024, (x, y, o) => {
    const u = x / 256, v = y / 1024;
    const g1 = tn(N1, u, v, 14, 2, 3), g2 = tn(N2, u, v, 50, 6, 2);
    const check = Math.pow(clamp(1 - Math.abs(tn(N3, u, v, 7, 1.0, 2)), 0, 1), 30);
    const bark = clamp((tn(N2, u + 0.7, v, 3, 2.5, 3) - 0.36) * 5, 0, 1) * 0.8;
    const plate = tn(N1, u, v, 16, 6, 3);
    let r = lerp(92, 146, 0.5 + g1 * 0.5) + g2 * 12, gg = lerp(82, 130, 0.5 + g1 * 0.5) + g2 * 10, b = lerp(68, 110, 0.5 + g1 * 0.5) + g2 * 8;
    const br = 0.6 + plate * 0.6;
    r = lerp(r, 74 * br + 22, bark); gg = lerp(gg, 56 * br + 16, bark); b = lerp(b, 40 * br + 12, bark);
    o[0] = r * (1 - check * 0.7); o[1] = gg * (1 - check * 0.7); o[2] = b * (1 - check * 0.7);
    return 0.5 + g1 * 0.2 - check * 0.6 + bark * (0.15 + plate * 0.25);
  }, { strength: 4 }),
  /** rows of cedar shakes, v up the roof (8 rows per tile) */
  shingle: () => {
    const r = rng(17), rows = [];
    for (let i = 0; i < 8; i++) { const cuts = []; let x = r() * 40; while (x < 512) { cuts.push(x); x += 22 + r() * 70; } rows.push({ cuts, tone: [], len: [] }); for (let k = 0; k < cuts.length + 1; k++) { rows[i].tone.push(r()); rows[i].len.push(r() < 0.25 ? r() * 10 : 0); } }
    return pix(512, 512, (x, y, o) => {
      const u = x / 512, v = y / 512, row = Math.floor(y / 64), R = rows[row];
      let k = 0, dmin = 99; for (let i = 0; i < R.cuts.length; i++) { const d = Math.abs(x - R.cuts[i]); if (d < dmin) dmin = d; if (x > R.cuts[i]) k = i + 1; }
      const t = R.tone[k % R.tone.length], short = R.len[k % R.len.length];
      const yy = (y % 64) + short; // some shakes end short, so the butt line is ragged
      const grain = tn(N1, u, v, 30, 2, 2), fine = tn(N2, u, v, 100, 8, 1);
      const gap = dmin < 1.6 ? 1 : 0, missing = yy > 64 ? 1 : 0;
      const shade = lerp(0.45, 1, sstep(0, 16, yy)) * lerp(1, 0.8, sstep(56, 64, yy));
      const moss = clamp((tn(N3, u, v, 5, 5, 3) - 0.15) * 3 + (yy / 64) * 0.35, 0, 1) * (0.5 + 0.5 * clamp(fine * 3 + 0.5, 0, 1));
      let rr = lerp(88, 124, t) + grain * 18 + fine * 10, gg = rr * 0.9, bb = rr * 0.8;
      rr = lerp(rr, 70, moss * 0.7); gg = lerp(gg, 88, moss * 0.7); bb = lerp(bb, 42, moss * 0.7);
      const s = gap || missing ? 0.25 : shade; o[0] = rr * s; o[1] = gg * s; o[2] = bb * s;
      return gap || missing ? 0.1 : (0.25 + (Math.min(yy, 64) / 64) * 0.55 + grain * 0.06 + moss * 0.1);
    }, { strength: 4 });
  },
  /** mortared fieldstone (chimney, piers) */
  fieldstone: () => {
    const C = cells(6, 6, 5);
    return pix(512, 512, (x, y, o) => {
      const u = x / 512, v = y / 512, [d1, d2, id] = C(u, v), e = d2 - d1;
      const n = tn(N1, u, v, 24, 24, 3), n2 = tn(N2, u, v, 6, 6, 2);
      if (e < 0.07) { const m = 108 + n * 20; o[0] = m; o[1] = m * 0.96; o[2] = m * 0.88; return 0.2 + n * 0.05; }
      const base = 70 + id * 70 + n2 * 20, warm = (id * 7.3) % 1;
      o[0] = base * (1 + warm * 0.15) + n * 22; o[1] = base + n * 20; o[2] = base * (0.92 - warm * 0.1) + n * 16;
      return 0.35 + Math.sqrt(clamp((e - 0.07) * 4, 0, 1)) * 0.5 + n * 0.08;
    }, { strength: 5 });
  },
  /** dry-stacked flat stones without mortar (ancient ruins) */
  drystone: () => {
    const C = cells(5, 11, 23, 0.7);
    return pix(512, 512, (x, y, o) => {
      const u = x / 512, v = y / 512, [d1, d2, id] = C(u, v), e = d2 - d1;
      const n = tn(N1, u, v, 30, 30, 3), lich = clamp((tn(N3, u, v, 7, 7, 3) - 0.2) * 4, 0, 1);
      if (e < 0.08) { const m = 26 + n * 10; o[0] = m; o[1] = m * 0.95; o[2] = m * 0.85; return 0; }
      const base = 82 + id * 60 + n * 24;
      o[0] = lerp(base, 150, lich * 0.35); o[1] = lerp(base * 0.98, 152, lich * 0.35); o[2] = lerp(base * 0.92, 120, lich * 0.35);
      return 0.25 + Math.sqrt(clamp((e - 0.08) * 3, 0, 1)) * 0.6 + n * 0.08;
    }, { strength: 6 });
  },
  /** stained khaki canvas */
  canvas: () => pix(512, 512, (x, y, o) => {
    const u = x / 512, v = y / 512, weave = ((x & 3) < 2) !== ((y & 3) < 2) ? 1 : 0.9;
    const n = tn(N1, u, v, 8, 8, 3), stain = tn(N2, u, v, 3, 3, 4), mil = tn(N3, u, v, 40, 40, 2);
    const ring = Math.abs(stain - 0.15) < 0.018 ? 1 : 0;
    let r = 150 + n * 18, g = 140 + n * 16, b = 104 + n * 12;
    const dk = clamp(stain * 1.5, 0, 0.5) + ring * 0.25 + (mil > 0.5 ? 0.35 : 0);
    r *= (1 - dk) * weave; g *= (1 - dk * 0.95) * weave; b *= (1 - dk * 0.9) * weave;
    const seam = Math.abs((y % 256) - 128) < 3 ? 0.8 : 1;
    o[0] = r * seam; o[1] = g * seam; o[2] = b * seam;
    return weave * 0.5 + n * 0.2;
  }, { strength: 1.5 }),
  /** a whole animal hide with an irregular outline (alpha) */
  pelt: () => pix(512, 512, (x, y, o) => {
    const u = x / 512 - 0.5, v = y / 512 - 0.5, a = Math.atan2(v, u), rr = Math.hypot(u * 1.25, v);
    const edge = 0.42 + N1.fbm2(Math.cos(a) * 2 + 3, Math.sin(a) * 2, 3) * 0.06 + Math.max(0, Math.cos(a * 4)) * 0.05;
    const n = N2.fbm2(u * 8, v * 8, 4), hair = N3.fbm2(u * 90, v * 20, 2), spine = Math.exp(-u * u * 120);
    const scrape = clamp((N1.fbm2(u * 4 + 9, v * 4, 3) - 0.1) * 3, 0, 1);
    let r = 118 + n * 30 + hair * 14 - spine * 30, g = 84 + n * 22 + hair * 10 - spine * 24, b = 56 + n * 14 + hair * 6 - spine * 16;
    r = lerp(r, 168, scrape * 0.45); g = lerp(g, 134, scrape * 0.45); b = lerp(b, 98, scrape * 0.45);
    const rim = sstep(edge - 0.03, edge, rr); r *= 1 - rim * 0.5; g *= 1 - rim * 0.5; b *= 1 - rim * 0.5;
    o[0] = r; o[1] = g; o[2] = b; o[3] = rr < edge ? 255 : 0;
    return 0.5 + n * 0.2 + hair * 0.1;
  }, { strength: 2, wrap: false }),
  /** dark birch/pine bark slab colour for hut covers */
  rust: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 8, 8, 4), p = tn(N2, u, v, 50, 50, 2), s = tn(N3, u, v, 3, 3, 3);
    const pit = p > 0.45 ? 1 : 0;
    o[0] = 110 + n * 40 + s * 30 - pit * 50; o[1] = 58 + n * 22 + s * 10 - pit * 30; o[2] = 30 + n * 10 - pit * 14;
    return 0.5 + n * 0.25 - pit * 0.3;
  }, { strength: 3 }),
  /** faded olive paint, chipped to rust (radio, ammo-style boxes) */
  olivePaint: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 6, 6, 4), chip = tn(N2, u, v, 14, 14, 4), f = tn(N3, u, v, 60, 60, 1);
    const rust = sstep(0.28, 0.36, chip), edge = sstep(0.22, 0.28, chip) - rust;
    let r = 78 + n * 14 + f * 6, g = 82 + n * 14 + f * 6, b = 52 + n * 10;
    r = lerp(r, 112 + n * 30, rust); g = lerp(g, 58 + n * 16, rust); b = lerp(b, 30, rust);
    r += edge * 40; g += edge * 36; b += edge * 30;
    o[0] = r; o[1] = g; o[2] = b; return 0.6 - rust * 0.25 + f * 0.05;
  }, { strength: 2 }),
  /** chipped red paint (lantern, fuel can) */
  redPaint: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u + 0.3, v, 6, 6, 4), chip = tn(N2, u, v + 0.4, 12, 12, 4);
    const rust = sstep(0.3, 0.38, chip);
    o[0] = lerp(150 + n * 20, 100 + n * 30, rust); o[1] = lerp(34 + n * 8, 56 + n * 14, rust); o[2] = lerp(28 + n * 6, 30, rust);
    return 0.6 - rust * 0.25;
  }, { strength: 2 }),
  /** a 55-gallon drum wrapped once (u around, v up) */
  drum: () => pix(512, 256, (x, y, o) => {
    const u = x / 512, v = y / 256, n = tn(N1, u, v, 10, 5, 4), s = tn(N2, u, v, 4, 2, 3), f = tn(N3, u, v, 80, 40, 1);
    const ribs = Math.min(Math.abs(v - 0.33), Math.abs(v - 0.66));
    const streak = clamp(tn(N3, u, v, 40, 2, 2) * 2 + (1 - v) * 0.6 - 0.4, 0, 1);
    const rust = clamp(sstep(0.15, 0.4, s + (1 - v) * 0.35 + (ribs < 0.02 ? 0.3 : 0)) + streak * 0.3, 0, 1);
    let r = 52 + n * 10, g = 74 + n * 12, b = 92 + n * 12;
    r = lerp(r, 118 + n * 30 + f * 10, rust); g = lerp(g, 60 + n * 14, rust); b = lerp(b, 32, rust);
    const rib = ribs < 0.012 ? 0.7 : 1;
    o[0] = r * rib; o[1] = g * rib; o[2] = b * rib;
    return 0.5 + (ribs < 0.015 ? 0.3 : 0) - rust * 0.15 + f * 0.04;
  }, {
    strength: 3, after: (g) => {
      g.save(); g.globalAlpha = 0.55; g.fillStyle = '#d8d0b8'; g.font = 'bold 34px Arial'; g.textAlign = 'center';
      g.fillText('GASOLINE', 128, 120); g.font = 'bold 22px Arial'; g.fillText('55 US GAL', 128, 150);
      g.globalCompositeOperation = 'destination-out'; const r = rng(4); for (let i = 0; i < 260; i++) { g.globalAlpha = r(); g.beginPath(); g.arc(60 + r() * 140, 90 + r() * 70, 1 + r() * 4, 0, TAU); g.fill(); }
      g.restore();
    },
  }),
  bone: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 6, 6, 4), f = tn(N2, u, v, 40, 10, 2);
    const crack = Math.pow(clamp(1 - Math.abs(tn(N3, u, v, 5, 12, 2)) * 1.2, 0, 1), 30);
    o[0] = (206 + n * 22 + f * 10) * (1 - crack * 0.5); o[1] = (194 + n * 22 + f * 9) * (1 - crack * 0.5); o[2] = (166 + n * 22 + f * 8) * (1 - crack * 0.5);
    return 0.6 + n * 0.15 - crack * 0.3;
  }, { strength: 1.5 }),
  rope: () => pix(64, 256, (x, y, o) => {
    const t = ((x / 64) * 3 + (y / 256) * 12) % 1, s = Math.sin(t * Math.PI), f = N1.fbm2(x * 0.3, y * 0.3, 2);
    o[0] = (100 + s * 70 + f * 20); o[1] = (84 + s * 58 + f * 16); o[2] = (56 + s * 38 + f * 10);
    return s;
  }, { strength: 2 }),
  /** big leaves overlapping (offering parcel) */
  leafWrap: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 5, 5, 3);
    const vein = Math.abs(Math.sin((u * 2 + v) * TAU * 3 + n * 2)) < 0.05 ? 1 : 0;
    const mid = Math.abs(((u + v * 0.3) * 3) % 1 - 0.5) < 0.012 ? 1 : 0;
    const dry = clamp(tn(N2, u, v, 3, 3, 3) * 2, 0, 1);
    o[0] = lerp(52, 112, dry) + n * 16 + vein * 20 + mid * 30; o[1] = lerp(72, 86, dry) + n * 18 + vein * 18 + mid * 26; o[2] = lerp(30, 40, dry) + n * 6 + vein * 6;
    return 0.5 + n * 0.2 - vein * 0.15 + mid * 0.2;
  }, { strength: 2 }),
  /** dust and streaks for dirty window glass (alpha) */
  glassDirt: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 6, 6, 4), st = tn(N2, u, v, 30, 2, 2);
    const edge = Math.max(Math.abs(u - 0.5), Math.abs(v - 0.5)) * 2;
    const a = clamp(0.28 + n * 0.35 + st * 0.15 + Math.pow(edge, 4) * 0.45 + (1 - v) * 0.12, 0.12, 0.92);
    o[0] = 96 + n * 30; o[1] = 92 + n * 26; o[2] = 76 + n * 20; o[3] = a * 255;
    return 0;
  }, { strength: 0 }),
  /** dark scorched / charred wood */
  char: () => { const C = cells(10, 22, 3, 0.6); return pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, c = C(u, v), n = tn(N1, u, v, 20, 6, 3);
    const crack = c[1] - c[0] < 0.08 ? 1 : 0;
    const ember = clamp((tn(N2, u, v, 6, 6, 3) - 0.35) * 2, 0, 1);
    const b = 20 + n * 10 + (1 - crack) * 12;
    o[0] = b + ember * 30; o[1] = b * 0.9 + ember * 8; o[2] = b * 0.8;
    return crack ? 0.1 : 0.5 + Math.sqrt(clamp(c[1] - c[0], 0, 0.5)) * 0.6;
  }, { strength: 5 }); },
  /** plain noisy mid-grey for metal/plastic */
  grime: () => pix(256, 256, (x, y, o) => {
    const u = x / 256, v = y / 256, n = tn(N1, u, v, 5, 5, 4), f = tn(N2, u, v, 50, 50, 2);
    const s = Math.abs(N3.n2(x * 0.4, y * 0.03)) < 0.015 ? 1 : 0;
    const c = 205 + n * 16 + f * 7 + s * 22; o[0] = c; o[1] = c; o[2] = c;
    return 0.5 + f * 0.1;
  }, { strength: 1 }),
  /** weathered granite: speckled crystals, broad tonal patches, fine fractures, pale lichen rosettes */
  granite: () => pix(512, 512, (x, y, o) => {
    const u = x / 512, v = y / 512, big = tn(N1, u, v, 3, 3, 4), mid = tn(N2, u, v, 12, 12, 3), sp = N3.n2(x * 0.9, y * 0.9), sp2 = N1.n2(x * 0.45 + 50, y * 0.45);
    const frac = Math.pow(clamp(1 - Math.abs(tn(N3, u, v, 2, 5, 2)) * 2.2, 0, 1), 44) * sstep(0.05, 0.35, tn(N1, u + 0.5, v, 2, 2, 2));
    const lich = clamp((tn(N2, u + 0.3, v, 9, 9, 3) - 0.3) * 4, 0, 1) * (0.6 + 0.4 * sp);
    let g = 128 + big * 26 + mid * 12 + (sp > 0.55 ? -40 : sp < -0.6 ? 26 : 0) + sp2 * 8;
    let r = g * 1.02, gg = g, b = g * 0.95;
    const warm = clamp(big * 2 + 0.2, 0, 1) * 0.12; r *= 1 + warm; b *= 1 - warm * 0.6;
    r = lerp(r, 168, lich * 0.55); gg = lerp(gg, 170, lich * 0.55); b = lerp(b, 142, lich * 0.55);
    o[0] = r * (1 - frac * 0.45); o[1] = gg * (1 - frac * 0.45); o[2] = b * (1 - frac * 0.45);
    return 0.5 + big * 0.2 + mid * 0.12 - frac * 0.25 + (sp > 0.55 ? -0.04 : 0) + lich * 0.05;
  }, { strength: 3 }),
  /** quilted seat fabric */
  fabric: () => pix(128, 128, (x, y, o) => {
    const weave = ((x & 1) ^ (y & 1)) ? 1 : 0.9, n = tn(N1, x / 128, y / 128, 6, 6, 3);
    const c = 200 * weave + n * 30; o[0] = c; o[1] = c; o[2] = c;
    return weave * 0.4 + n * 0.3;
  }, { strength: 1.5 }),
};

/* =========================================================== materials */
const MATS = new Map();
/** blend moss in the shader: vertex colour = (ao, moss, wet) */
function mossify(mat, col = [0.07, 0.1, 0.022]) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.uniforms.uMossCol = { value: new THREE.Vector3(...col) };
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', 'uniform vec3 uMossCol;\nvoid main() {').replace('#include <color_fragment>', `
      #if defined( USE_COLOR )
        float wdAo = vColor.r, wdMoss = vColor.g, wdWet = vColor.b;
        diffuseColor.rgb *= mix(1.0, 0.45, wdWet);
        float wdL = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
        float wdM = clamp(wdMoss * 1.35, 0.0, 1.0); wdM = smoothstep(0.0, 1.0, wdM) * (0.8 + 0.5 * wdL);
        diffuseColor.rgb = mix(diffuseColor.rgb, uMossCol * (0.45 + wdL * 2.2), clamp(wdM, 0.0, 1.0));
        diffuseColor.rgb *= wdAo;
      #endif`);
  };
  mat.customProgramCacheKey = () => 'wdmoss';
  mat.userData.mossy = true;
  return mat;
}
const ts = (name) => ({ map: T(name).map, normalMap: T(name).normalMap });
const tc = (name) => ({ map: tex(name).map, normalMap: tex(name).normalMap });
const DEF = {
  // weathered building timber / logs / stone - all mossy
  wood: () => mossify(stdMat({ ...ts('greyWood'), roughness: 0.93, vertexColors: true })),
  woodBrown: () => mossify(stdMat({ ...ts('brownWood'), roughness: 0.85, vertexColors: true })),
  log: () => mossify(stdMat({ ...ts('logSkin'), roughness: 0.92, vertexColors: true })),
  bark: () => mossify(stdMat({ ...tc('barkPine'), roughness: 0.95, vertexColors: true })),
  logEnd: () => mossify(stdMat({ ...tc('logEnd'), color: 0x8a7c6c, roughness: 0.9, vertexColors: true })),
  stone: () => mossify(stdMat({ ...ts('granite'), roughness: 0.9, vertexColors: true })),
  caveStone: () => mossify(stdMat({ ...tc('caveRock'), roughness: 0.95, vertexColors: true, normalScale: new THREE.Vector2(1.4, 1.4) })),
  shingle: () => mossify(stdMat({ ...ts('shingle'), roughness: 0.95, vertexColors: true })),
  fieldstone: () => mossify(stdMat({ ...ts('fieldstone'), roughness: 0.92, vertexColors: true })),
  drystone: () => mossify(stdMat({ ...ts('drystone'), roughness: 0.94, vertexColors: true })),
  char: () => mossify(stdMat({ ...ts('char'), roughness: 0.98, vertexColors: true })),
  // everything else multiplies the vertex colour
  canvas: () => stdMat({ ...ts('canvas'), roughness: 0.95, side: THREE.DoubleSide, vertexColors: true }),
  tarp: () => windify(stdMat({ ...ts('canvas'), color: 0x8a9a78, roughness: 0.9, side: THREE.DoubleSide, vertexColors: true }), { mode: 'foliage', height: 3, bend: 2 }),
  pelt: () => stdMat({ ...ts('pelt'), roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true }),
  peltWind: () => windify(stdMat({ ...ts('pelt'), roughness: 0.85, side: THREE.DoubleSide, alphaTest: 0.5, vertexColors: true }), { mode: 'foliage', height: 3, bend: 1 }),
  rust: () => stdMat({ ...ts('rust'), roughness: 0.9, metalness: 0.3, vertexColors: true }),
  olive: () => stdMat({ ...ts('olivePaint'), roughness: 0.7, metalness: 0.25, vertexColors: true }),
  redPaint: () => stdMat({ ...ts('redPaint'), roughness: 0.6, metalness: 0.3, vertexColors: true }),
  drum: () => stdMat({ ...ts('drum'), roughness: 0.75, metalness: 0.35, vertexColors: true }),
  ironDark: () => stdMat({ map: T('grime').map, color: 0x2b2a28, roughness: 0.7, metalness: 0.55, vertexColors: true }),
  alu: () => stdMat({ map: T('grime').map, color: 0x9a9c9c, roughness: 0.45, metalness: 0.7, vertexColors: true }),
  bone: () => stdMat({ ...ts('bone'), roughness: 0.75, vertexColors: true }),
  rope: () => stdMat({ ...ts('rope'), roughness: 0.95, vertexColors: true }),
  leaf: () => stdMat({ ...ts('leafWrap'), roughness: 0.7, side: THREE.DoubleSide, vertexColors: true }),
  meat: () => stdMat({ color: 0x6e2a24, roughness: 0.45, vertexColors: true }),
  ochre: () => stdMat({ map: T('grime').map, color: 0x9a3a22, roughness: 0.9, vertexColors: true }),
  mud: () => stdMat({ ...tc('mud'), roughness: 0.96, vertexColors: true }),
  soil: () => stdMat({ ...tc('forest'), roughness: 0.96, vertexColors: true }),
  blanket: () => stdMat({ ...ts('fabric'), color: 0x6a3a30, roughness: 0.95, vertexColors: true }),
  ticking: () => stdMat({ ...ts('canvas'), color: 0xc8c0b0, roughness: 0.95, vertexColors: true }),
  glass: () => stdMat({ color: 0x1b2328, roughness: 0.06, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide, vertexColors: true }),
  glassDirty: () => stdMat({ map: T('glassDirt').map, roughness: 0.3, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide, vertexColors: true }),
  glassLamp: () => stdMat({ color: 0xc8b48a, roughness: 0.1, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide, vertexColors: true }),
  black: () => new THREE.MeshBasicMaterial({ color: 0x000000 }),
  plain: () => stdMat({ map: T('grime').map, roughness: 0.8, vertexColors: true }),
  paper: () => stdMat({ color: 0xcfc4a6, roughness: 0.95, vertexColors: true }),
};
const NO_SHADOW = new Set(['glass', 'glassDirty', 'glassLamp', 'black']);
export function M(key) {
  if (MATS.has(key)) return MATS.get(key);
  const f = DEF[key]; if (!f) throw new Error('PropKit: no material ' + key);
  const m = f(); m.name = key; MATS.set(key, m); return m;
}
/** register a material made elsewhere (PropArt's livery, carvings, decals) */
export function defMat(key, make) { if (!DEF[key]) DEF[key] = make; }
export const isMossy = (key) => !!M(key).userData.mossy;
export const castsShadow = (key) => !NO_SHADOW.has(key) && !M(key).userData.noShadow;

/* =========================================================== geometry helpers */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3(), _t = new THREE.Vector3();
export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const vec = (p) => (p.isVector3 ? p.clone() : new THREE.Vector3(p[0], p[1], p[2]));
export { vec };

/** per-triangle planar projection; ku/kv texture units per metre; lenAxis (0,1,2) forces that axis onto v */
export function planarUV(geo, ku = 1, kv = ku, lenAxis = -1, off = [0, 0]) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.attributes.position, uv = new Float32Array(p.count * 2), comp = [0, 0, 0];
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i); _b.fromBufferAttribute(p, i + 1); _c.fromBufferAttribute(p, i + 2);
    _n.subVectors(_c, _b).cross(_t.subVectors(_a, _b));
    const ax = Math.abs(_n.x), ay = Math.abs(_n.y), az = Math.abs(_n.z);
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    let U = axis === 0 ? 2 : 0, W = axis === 1 ? 2 : 1;
    if (lenAxis >= 0 && lenAxis !== axis && W !== lenAxis) { U = W; W = lenAxis; }
    for (let k = 0; k < 3; k++) {
      p.getX(i + k); comp[0] = p.getX(i + k); comp[1] = p.getY(i + k); comp[2] = p.getZ(i + k);
      uv[(i + k) * 2] = comp[U] * ku + off[0]; uv[(i + k) * 2 + 1] = comp[W] * kv + off[1];
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
/** merge vertices that share a position (smooth normals on polyhedra) - drops uv */
export function weld(geo, eps = 1e-4) {
  const p = geo.attributes.position, map = new Map(), pos = [], idx = [];
  for (let i = 0; i < p.count; i++) {
    const k = Math.round(p.getX(i) / eps) + ',' + Math.round(p.getY(i) / eps) + ',' + Math.round(p.getZ(i) / eps);
    let j = map.get(k); if (j === undefined) { j = pos.length / 3; map.set(k, j); pos.push(p.getX(i), p.getY(i), p.getZ(i)); }
    idx.push(j);
  }
  const src = geo.index ? Array.from(geo.index.array).map(i => idx[i]) : idx;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(src); g.computeVertexNormals();
  return g;
}
/** cylinder along +Y from 0 to len, world-scaled uv (u around, v along) */
export function cyl(r0, r1, len, radial = 10, seg = 1, k = 1, caps = false) {
  const g = new THREE.CylinderGeometry(r1, r0, len, radial, seg, !caps); g.translate(0, len / 2, 0);
  const uv = g.attributes.uv, circ = TAU * (r0 + r1) / 2;
  if (!caps) for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * circ * k, uv.getY(i) * len * k);
  return g;
}
const _Y = new THREE.Vector3(0, 1, 0), _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _Q2 = new THREE.Quaternion(), _ONE = new THREE.Vector3(1, 1, 1);
/** geometry modelled along +Y from the origin -> placed from a toward b */
export function orient(geo, a, b, roll = 0) {
  const A = vec(a), d = vec(b).sub(A).normalize();
  _Q.setFromUnitVectors(_Y, d); if (roll) _Q.multiply(_Q2.setFromAxisAngle(_Y, roll));
  geo.applyMatrix4(_M.compose(A, _Q, _ONE)); return geo;
}
/** a straight round bar from a to b */
export function rod(a, b, r, { r1 = r, radial = 8, seg = 1, k = 1, caps = false } = {}) {
  const len = vec(a).distanceTo(vec(b));
  return orient(cyl(r, r1, len, radial, seg, k, caps), a, b);
}
/** smooth tube through points with world-scaled uv */
export function bend(points, r, { radial = 8, seg = 16, k = 1, cap = true } = {}) {
  const pts = points.map(vec); let len = 0; for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  const g = tube(pts, r, { radial, seg, cap });
  const rr = typeof r === 'function' ? r(0.5) : r, uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * TAU * rr * k, uv.getY(i) * len * k);
  return g;
}
/** sagging rope between two points */
export function rope(a, b, sag = 0.1, r = 0.012, seg = 10) {
  const A = vec(a), B = vec(b), pts = [];
  for (let i = 0; i <= seg; i++) { const t = i / seg; pts.push(A.clone().lerp(B, t).add(V(0, -sag * 4 * t * (1 - t), 0))); }
  return bend(pts, r, { radial: 5, seg: seg * 2, k: 6, cap: false });
}
/** a few turns of lashing around an axis at point p */
export function lash(p, dir, r, turns = 3, w = 0.012) {
  const parts = [], d = vec(dir).normalize();
  for (let i = 0; i < turns; i++) {
    const t = new THREE.TorusGeometry(r + w, w, 4, 12); t.rotateX(Math.PI / 2); t.translate(0, (i - (turns - 1) / 2) * w * 2.1, 0);
    parts.push(t);
  }
  const g = mergeGeos(parts); _Q.setFromUnitVectors(_Y, d); g.applyMatrix4(_M.compose(vec(p), _Q, _ONE));
  return g;
}

/** rounded box from a subdivided box: w,h,d sizes, rad corner radius */
export function roundBox(w, h, d, rad = 0.05, sx = 4, sy = 4, sz = 4) {
  const g = new THREE.BoxGeometry(w, h, d, sx, sy, sz), p = g.attributes.position;
  const ix = w / 2 - rad, iy = h / 2 - rad, iz = d / 2 - rad;
  for (let i = 0; i < p.count; i++) {
    _a.fromBufferAttribute(p, i);
    _b.set(clamp(_a.x, -ix, ix), clamp(_a.y, -iy, iy), clamp(_a.z, -iz, iz));
    _c.subVectors(_a, _b); if (_c.lengthSq() > 1e-10) _c.setLength(rad);
    p.setXYZ(i, _b.x + _c.x, _b.y + _c.y, _b.z + _c.z);
  }
  g.computeVertexNormals(); return g;
}

/** a board along X (len), thickness Y (t), width Z (w); grain along X */
export function plank(len, w, t, { seed = 1, warp = 0.0, seg = 3, uv = 'grey', twist = 0 } = {}) {
  const r = rng(seed);
  let g = new THREE.BoxGeometry(len, t, w, seg, 1, 1);
  if (warp || twist) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i) / len; p.setY(i, p.getY(i) + Math.sin((x + 0.5) * Math.PI) * warp + p.getZ(i) * twist * x); } }
  g = planarUV(g, 1.6, 0.42, 0, [r() * 10, r() * 10]);
  g.computeVertexNormals();
  return g;
}

/** log between two points: { side (bark/log material), ends (logEnd material) } */
export function log(a, b, r, { seed = 1, radial = 12, seg = 6, taper = 0.9, wob = 0.05, ends = true, k = 1.2, sag = 0 } = {}) {
  const A = vec(a), B = vec(b), len = A.distanceTo(B), R = rng(seed), so = R() * 50;
  const side = cyl(r, r * taper, len, radial, seg, k);
  const p = side.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ang = Math.atan2(z, x);
    const f = 1 + wob * (0.5 + 0.5 * N1.n3(Math.cos(ang) * 1.3 + so, y * 0.9, Math.sin(ang) * 1.3));
    p.setXYZ(i, x * f + sag * Math.sin(y / len * Math.PI), y, z * f);
  }
  side.computeVertexNormals();
  const uvo = R() * 10; const uv = side.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) + uvo);
  orient(side, A, B, R() * TAU);
  let endG = null;
  if (ends) {
    const c0 = new THREE.CircleGeometry(r * 1.01, radial); c0.rotateX(Math.PI / 2);
    const c1 = new THREE.CircleGeometry(r * taper * 1.01, radial); c1.rotateX(-Math.PI / 2); c1.translate(0, len, 0);
    endG = orient(mergeGeos([c0, c1]), A, B);
  }
  return { side, ends: endG };
}

/** granite-like rock: noise + random facet planes, smooth normals, planar uv. size [x,y,z] */
export function rockGeo(seed, { size = [1, 1, 1], detail = 3, amp = 0.22, freq = 1.1, facets = 5, flat = 0.35, sharp = 0.5, k = 0.45, sink = 0.15 } = {}) {
  const R = rng(seed), so = R() * 100;
  let g = weld(new THREE.IcosahedronGeometry(1, detail));
  const planes = []; for (let i = 0; i < facets; i++) { const n = V(R() - 0.5, (R() - 0.5) * 1.2, R() - 0.5).normalize(); planes.push([n, 0.7 + R() * 0.22]); }
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    _a.fromBufferAttribute(p, i);
    const n = N2.fbm3(_a.x * freq + so, _a.y * freq, _a.z * freq, 4), rd = 1 - Math.abs(N1.n3(_a.x * freq * 2.2 + so, _a.y * freq * 2.2, _a.z * freq * 2.2));
    _a.multiplyScalar(1 + n * amp + rd * rd * amp * sharp * 0.5);
    for (const [pn, d] of planes) { const t = _a.dot(pn); if (t > d) _a.addScaledVector(pn, -(t - d) * 0.92); }
    _a.x *= size[0] / 2; _a.y *= size[1] / 2; _a.z *= size[2] / 2;
    const fb = -size[1] * flat; if (_a.y < fb) _a.y = lerp(_a.y, fb, 0.85);
    _a.y += size[1] / 2 - sink * size[1];
    p.setXYZ(i, _a.x, _a.y, _a.z);
  }
  g.computeVertexNormals();
  g = planarUV(g, k, k, -1, [R() * 5, R() * 5]);
  return g;
}
/** moss/ao/wet vertex colours for mossy materials, from normals + noise */
export function mossColors(geo, { moss = 0.6, up = 0.45, wet = 0, seed = 0, ao = 1, fn = null } = {}) {
  const p = geo.attributes.position; if (!geo.attributes.normal) geo.computeVertexNormals();
  const nn = geo.attributes.normal, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), ny = nn.getY(i);
    const nz = N3.fbm3(x * 1.3 + seed, y * 1.3, z * 1.3, 3), nf = N1.n3(x * 6 + seed, y * 6, z * 6);
    let m = sstep(up - 0.25, up + 0.3, ny + nz * 0.7) * moss * (0.75 + nf * 0.35);
    let a = ao * lerp(0.8, 1.05, 0.5 + nz * 0.5);
    if (fn) { const o = fn(x, y, z, ny, m, a); if (o) { m = o[1]; a = o[0]; } }
    c[i * 3] = a; c[i * 3 + 1] = clamp(m, 0, 1); c[i * 3 + 2] = wet;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); return geo;
}

/** a deer antler (one side) rooted at origin, growing up/back; mirror = +1 right, -1 left */
export function antler(seed, s = 1, mirror = 1, { radial = 6, points = 4 } = {}) {
  const R = rng(seed), parts = [];
  const beam = [V(0, 0, 0), V(0.07, 0.1, -0.03), V(0.17, 0.26, -0.1), V(0.24, 0.44, -0.1), V(0.24, 0.6, -0.02), V(0.2, 0.72, 0.06)]
    .map(v => V(v.x * mirror * s * (0.9 + R() * 0.2), v.y * s, v.z * s));
  const curve = new THREE.CatmullRomCurve3(beam);
  parts.push(bend(beam, t => s * lerp(0.032, 0.01, t), { radial, seg: 12 }));
  // brow tine forward, then tines up along the beam
  const tines = [[0.1, V(0.03 * mirror, 0.08, 0.17), 0.8]];
  for (let i = 0; i < points - 1; i++) tines.push([0.35 + i * 0.2 + R() * 0.05, V((0.02 + R() * 0.05) * mirror, 0.16 + R() * 0.06, 0.04 + R() * 0.06), 0.9]);
  for (const [t, d, rr] of tines) {
    const o = curve.getPointAt(t), e = o.clone().add(d.clone().multiplyScalar(s * (0.9 + R() * 0.4))), m = o.clone().lerp(e, 0.5).add(V(0, 0.02 * s, 0));
    parts.push(bend([o, m, e], tt => s * lerp(0.02 * rr, 0.006, tt), { radial: Math.max(4, radial - 2), seg: 6 }));
  }
  // burr at the base
  const burr = new THREE.TorusGeometry(0.036 * s, 0.012 * s, 4, 8); burr.rotateX(Math.PI / 2); parts.push(burr);
  return mergeGeos(parts);
}
/** a long bone along +Y, knobbed ends */
export function bone(len, r = 0.02, seg = 8) {
  const prof = [[0.001, 0], [r * 1.7, 0.005], [r * 2.0, len * 0.04], [r * 1.5, len * 0.1], [r, len * 0.25], [r * 0.9, len * 0.5], [r, len * 0.75], [r * 1.5, len * 0.9], [r * 2.1, len * 0.96], [r * 1.6, len * 0.995], [0.001, len]];
  const g = lathe(prof, seg); const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 0.3, uv.getY(i) * len * 2);
  return g;
}

/* =========================================================== Bag */
/**
 * Collects geometry per material key; build() merges each list into one mesh.
 * col: [r,g,b] constant, fn(x,y,z,i) -> [r,g,b], or omitted (keeps an existing colour attribute).
 * For mossy materials the colour channels mean (ao, moss, wet).
 */
export class Bag {
  constructor() { this.m = new Map(); }
  add(key, geo, col) {
    if (!geo) return this;
    if (!geo.attributes.uv) { const n = geo.attributes.position.count; geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2)); }
    if (col !== undefined || !geo.attributes.color) {
      const p = geo.attributes.position, c = new Float32Array(p.count * 3);
      const base = col === undefined ? (isMossy(key) ? [1, 0, 0] : [1, 1, 1]) : col;
      for (let i = 0; i < p.count; i++) {
        const k = typeof base === 'function' ? base(p.getX(i), p.getY(i), p.getZ(i), i) : base;
        c[i * 3] = k[0]; c[i * 3 + 1] = k[1]; c[i * 3 + 2] = k[2];
      }
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    if (!this.m.has(key)) this.m.set(key, []);
    this.m.get(key).push(geo); return this;
  }
  /** merge into meshes under parent. ao: darken toward aoY (ground contact) */
  build(parent = new THREE.Group(), { ao = true, aoY = 0, aoMin = 0.5, aoH = 0.7 } = {}) {
    for (const [key, list] of this.m) {
      const g = mergeGeos(list);
      if (ao) {
        const p = g.attributes.position, c = g.attributes.color, mossy = isMossy(key);
        for (let i = 0; i < p.count; i++) {
          const f = lerp(aoMin, 1, sstep(aoY - 0.15, aoY + aoH, p.getY(i)));
          if (mossy) c.setX(i, c.getX(i) * f); else c.setXYZ(i, c.getX(i) * f, c.getY(i) * f, c.getZ(i) * f);
        }
      }
      const mesh = new THREE.Mesh(g, M(key)); mesh.name = 'mesh:' + key;
      mesh.castShadow = castsShadow(key); mesh.receiveShadow = true;
      if (M(key).transparent) mesh.renderOrder = 2;
      parent.add(mesh);
    }
    return parent;
  }
}
/** a named empty marker */
export function marker(name, p = [0, 0, 0], ry = 0, userData = {}) {
  const o = new THREE.Object3D(); o.name = name; o.position.set(p[0], p[1], p[2]); o.rotation.y = ry; Object.assign(o.userData, userData); return o;
}
/** triangles under an object */
export function tris(obj) {
  let n = 0; obj.traverse(o => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return Math.round(n);
}
