/* Util.js - small maths helpers, a seeded random generator and noise.
   Everything that builds the island takes its randomness from rng(seed) so the
   same world seed always gives the same island on every player's machine. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
export const dampAng = (a, b, k, dt) => a + angDiff(a, b) * (1 - Math.exp(-k * dt));
export const dist2 = (ax, az, bx, bz) => { const dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; };
export const TAU = Math.PI * 2;

/** mulberry32 - returns () => [0,1) */
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  const f = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.range = (lo, hi) => lo + f() * (hi - lo);
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1));
  f.pick = (arr) => arr[Math.floor(f() * arr.length)];
  f.chance = (p) => f() < p;
  f.shuffle = (arr) => { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(f() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
  return f;
}
export const hashStr = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
/** a stable 0..1 hash of integer coordinates */
export const hash2 = (x, y, s = 0) => { let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

/* ---- 2D/3D simplex noise (Gustavson), seeded by permutation ---- */
export class Noise {
  constructor(seed = 1) {
    const r = rng(seed), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.perm = new Uint8Array(512); this.pm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) { this.perm[i] = p[i & 255]; this.pm12[i] = this.perm[i] % 12; }
  }
  n2(xin, yin) {
    const F2 = 0.3660254037844386, G2 = 0.21132486540518713, perm = this.perm, pm = this.pm12;
    const s = (xin + yin) * F2, i = Math.floor(xin + s), j = Math.floor(yin + s), t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0; if (t0 > 0) { const g = G3[pm[ii + perm[jj]]]; t0 *= t0; n0 = t0 * t0 * (g[0] * x0 + g[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1; if (t1 > 0) { const g = G3[pm[ii + i1 + perm[jj + j1]]]; t1 *= t1; n1 = t1 * t1 * (g[0] * x1 + g[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2; if (t2 > 0) { const g = G3[pm[ii + 1 + perm[jj + 1]]]; t2 *= t2; n2 = t2 * t2 * (g[0] * x2 + g[1] * y2); }
    return 70 * (n0 + n1 + n2);
  }
  n3(x, y, z) {
    const F3 = 1 / 3, G3c = 1 / 6, perm = this.perm, pm = this.pm12;
    const s = (x + y + z) * F3, i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3c, x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) { if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; } else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; } }
    else { if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; } else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; } else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } }
    const x1 = x0 - i1 + G3c, y1 = y0 - j1 + G3c, z1 = z0 - k1 + G3c, x2 = x0 - i2 + 2 * G3c, y2 = y0 - j2 + 2 * G3c, z2 = z0 - k2 + 2 * G3c;
    const x3 = x0 - 1 + 0.5, y3 = y0 - 1 + 0.5, z3 = z0 - 1 + 0.5;
    const ii = i & 255, jj = j & 255, kk = k & 255;
    const c = (tt, gi, xx, yy, zz) => { if (tt < 0) return 0; const g = G3[gi]; tt *= tt; return tt * tt * (g[0] * xx + g[1] * yy + g[2] * zz); };
    return 32 * (c(0.6 - x0 * x0 - y0 * y0 - z0 * z0, pm[ii + perm[jj + perm[kk]]], x0, y0, z0)
      + c(0.6 - x1 * x1 - y1 * y1 - z1 * z1, pm[ii + i1 + perm[jj + j1 + perm[kk + k1]]], x1, y1, z1)
      + c(0.6 - x2 * x2 - y2 * y2 - z2 * z2, pm[ii + i2 + perm[jj + j2 + perm[kk + k2]]], x2, y2, z2)
      + c(0.6 - x3 * x3 - y3 * y3 - z3 * z3, pm[ii + 1 + perm[jj + 1 + perm[kk + 1]]], x3, y3, z3));
  }
  fbm2(x, y, oct = 5, lac = 2, gain = 0.5) { let a = 1, f = 1, s = 0, n = 0; for (let i = 0; i < oct; i++) { s += a * this.n2(x * f, y * f); n += a; a *= gain; f *= lac; } return s / n; }
  ridge2(x, y, oct = 5) { let a = 1, f = 1, s = 0, n = 0; for (let i = 0; i < oct; i++) { const v = 1 - Math.abs(this.n2(x * f, y * f)); s += a * v * v; n += a; a *= 0.5; f *= 2.03; } return s / n; }
  fbm3(x, y, z, oct = 4) { let a = 1, f = 1, s = 0, n = 0; for (let i = 0; i < oct; i++) { s += a * this.n3(x * f, y * f, z * f); n += a; a *= 0.5; f *= 2; } return s / n; }
}
const G3 = [[1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]];

/** a shared noise for art code that just wants "some" noise */
export const NOISE = new Noise(1337);

/** fixed-size spatial hash for 2D points (x,z) */
export class Grid2 {
  constructor(cell = 16) { this.cell = cell; this.map = new Map(); }
  key(x, z) { return (Math.floor(x / this.cell) + 4096) * 8192 + (Math.floor(z / this.cell) + 4096); }
  add(item, x, z) { const k = this.key(x, z); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push(item); item._gk = k; }
  remove(item) { const a = this.map.get(item._gk); if (!a) return; const i = a.indexOf(item); if (i >= 0) a.splice(i, 1); }
  move(item, x, z) { const k = this.key(x, z); if (k === item._gk) return; this.remove(item); this.add(item, x, z); }
  /** calls fn(item) for items in cells overlapping the radius (no exact distance test) */
  near(x, z, r, fn) {
    const c = this.cell, x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c), z0 = Math.floor((z - r) / c), z1 = Math.floor((z + r) / c);
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) { const a = this.map.get((i + 4096) * 8192 + (j + 4096)); if (a) for (let k = 0; k < a.length; k++) fn(a[k]); }
  }
}

export const fmtTime = (h) => { const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60); return String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'); };
