/* Island.js - the shape of the island and everything that can be asked about it.

   The terrain is DESIGNED, not random: the same mountains, river, lakes and
   swamp every game, so the island feels like a real place players learn.
   (Resources, encounters and some story placements are randomised elsewhere
   from the per-save world seed.)

   Coordinates: metres, x east, z south (north is -z), y up. Sea level y = 0.
   The heightfield is 513 x 513 samples at 4 m covering -1024..1024.

   Layout (north at the top):
        Antler Peak (240 m) and the northern range; Bone Cave on the west slope
        the Antler Clearing (stone circle) on a plateau below the eastern peak
        Blackwater river runs from the mountains south-east through Mirror Lake to the sea
        Still Lake and Cold Creek in the west feed the south-west swamp
        the ancient ruined settlement and a burned forest in the east, the Deep cave in the east cliffs
        the cannibal village on the west coast, a second camp in the north-east
        the crash site in the southern forest, the hunter's cabin by the river, beaches to the south */
import { Noise, clamp, lerp, sstep, Grid2 } from '../core/Util.js';

export const SIZE = 2048, HALF = 1024, CELL = 4, N = 513;
export const SEA = 0;

const PEAKS = [
  { x: -150, z: -600, h: 235, r: 300 },   // Antler Peak
  { x: 190, z: -540, h: 165, r: 210 },
  { x: -470, z: -420, h: 115, r: 200 },
  { x: 540, z: -250, h: 95, r: 170 },     // east ridge (cliffs, the Deep)
  { x: 310, z: 450, h: 50, r: 160 },
  { x: -560, z: 40, h: 42, r: 150 },
  { x: -180, z: 140, h: 26, r: 140 },     // the watchtower rise
];

/** landmark pads: flattened ground, no trees, a prop placed by World */
export const LANDMARKS = [
  { id: 'crash', name: 'Crash Site', x: -40, z: 260, r: 22, flat: 0.7 },
  { id: 'cabin', name: "Hunter's Cabin", x: 262, z: 318, r: 16, flat: 0.9 },
  { id: 'survey', name: 'Northbound Survey Camp', x: -260, z: -230, r: 18, flat: 0.85 },
  { id: 'beachcamp', name: 'Beach Camp', x: 70, z: 690, r: 12, flat: 0.6 },
  { id: 'tower', name: 'Fire Lookout', x: -190, z: 130, r: 9, flat: 0.8 },
  { id: 'village', name: 'Cannibal Village', x: -600, z: 170, r: 42, flat: 0.85 },
  { id: 'camp2', name: 'Hide Camp', x: 470, z: -430, r: 20, flat: 0.8 },
  { id: 'ruins', name: 'The Old Settlement', x: 410, z: -70, r: 55, flat: 0.75 },
  { id: 'circle', name: 'The Antler Clearing', x: 140, z: -390, r: 48, flat: 1.0 },
  { id: 'dock', name: 'Mirror Lake Jetty', x: 178, z: 172, r: 8, flat: 0.5 },
];

/** caves: the mouth is placed on the slope nearest to (x,z) facing downhill */
export const CAVES = [
  { id: 'hollow', name: 'Hollow Creek Cave', x: -330, z: -40 },
  { id: 'deep', name: 'The Deep', x: 560, z: -160 },
  { id: 'bone', name: 'Bone Cave', x: -360, z: -470 },
];

const RIVERS = [
  { id: 'blackwater', w0: 7, w1: 18, pts: [[-60, -440], [-25, -335], [40, -235], [95, -125], [135, -25], [170, 70], [235, 170], [300, 255], [385, 330], [470, 420], [560, 520], [660, 610], [760, 700]] },
  { id: 'coldcreek', w0: 4, w1: 9, pts: [[-380, -100], [-425, 10], [-470, 140], [-470, 260], [-440, 360]] },
];
export const LAKES = [
  { id: 'mirror', name: 'Mirror Lake', x: 170, z: 70, r: 95 },
  { id: 'still', name: 'Still Lake', x: -380, z: -110, r: 68 },
];
const SWAMP = { x: -430, z: 390, r: 210, level: 1.6 };
const BURN = { x: 420, z: -70, r: 190 };
const AUTUMN = [{ x: 330, z: 120, r: 230 }, { x: -120, z: -120, r: 120 }, { x: 60, z: 420, r: 90 }];

const _RD = { none: { d: Infinity, p: null }, v: { d: 0, p: null } };

export class Island {
  constructor(baked) {
    this.n = new Noise(1);
    this.n2 = new Noise(2);
    this.H = new Float32Array(N * N);
    this.forest = new Float32Array(N * N);   // tree density 0..1
    this.wet = new Float32Array(N * N);      // mud/swamp 0..1
    this.burn = new Float32Array(N * N);     // burned ground 0..1
    this.autumn = new Float32Array(N * N);   // maple/birch share 0..1
    this.meadow = new Float32Array(N * N);   // open grass 0..1
    this.lakes = LAKES.map(l => ({ ...l }));
    this.swamp = SWAMP;
    this.landmarks = LANDMARKS.map(l => ({ ...l, y: 0 }));
    this.caves = CAVES.map(c => ({ ...c }));
    if (baked) this._load(baked); else this._build();
  }

  /* ------------------------------------------------------------ baked data (tools/bakeIsland.mjs) */
  /** -> { bin: ArrayBuffer, meta: object } */
  toData() {
    const M = N * N, buf = new ArrayBuffer(M * 4 + M * 5 + M * 2), H = new Float32Array(buf, 0, M), R = new Int16Array(buf, M * 4, M), B = new Uint8Array(buf, M * 6, M * 5);
    H.set(this.H);
    const masks = [this.forest, this.wet, this.burn, this.autumn, this.meadow];
    masks.forEach((A, k) => { for (let i = 0; i < M; i++) B[k * M + i] = Math.round(clamp(A[i], 0, 1) * 255); });
    for (let i = 0; i < M; i++) R[i] = this.ridx[i];
    const meta = { lakes: this.lakes, caves: this.caves, landmarks: this.landmarks, rivers: this.rivers.map(r => ({ id: r.id, dense: r.dense })) };
    return { bin: buf, meta };
  }
  _load({ bin, meta }) {
    const M = N * N;
    this.H = new Float32Array(bin, 0, M).slice();
    const B = new Uint8Array(bin, M * 6, M * 5);
    [this.forest, this.wet, this.burn, this.autumn, this.meadow].forEach((A, k) => { for (let i = 0; i < M; i++) A[i] = B[k * M + i] / 255; });
    this.ridx = new Int32Array(new Int16Array(bin, M * 4, M));
    this.lakes = meta.lakes; this.caves = meta.caves; this.landmarks = meta.landmarks;
    this.riverPts = []; this.riverGrid = new Grid2(48);
    this.rivers = meta.rivers.map(r => { for (const p of r.dense) { this.riverPts.push(p); this.riverGrid.add(p, p.x, p.z); } return r; });
  }

  /* ------------------------------------------------------------ generation */
  coastR(x, z) {
    const a = Math.atan2(z, x);
    const c = Math.cos(a), s = Math.sin(a);
    return 800 + 95 * this.n.fbm2(c * 1.4 + 3, s * 1.4 + 3, 3) + 40 * this.n.n2(c * 4.1, s * 4.1)
      + (x > 300 && Math.abs(z + 150) < 400 ? 30 : 0);
  }
  _raw(x, z) {
    const n = this.n, n2 = this.n2;
    const d = Math.hypot(x, z) / this.coastR(x, z);
    const land = 1 - sstep(0.82, 1.0, d);
    // rolling lowland
    let h = 5 + n.fbm2(x * 0.0022, z * 0.0022, 5) * 14 + n2.fbm2(x * 0.009, z * 0.009, 3) * 3;
    // hills everywhere, stronger to the north
    const north = sstep(200, -500, z);
    h += n.ridge2(x * 0.0035 + 7, z * 0.0035, 4) * (10 + 28 * north);
    // mountains: smooth gaussian masses with ridged detail on top
    for (const p of PEAKS) {
      const dx = x - p.x, dz = z - p.z, g = Math.exp(-(dx * dx + dz * dz) / (p.r * p.r));
      if (g < 0.002) continue;
      const rid = n.ridge2(x * 0.006 + p.x, z * 0.006, 5);
      h += p.h * g * (0.72 + 0.45 * rid);
    }
    // east cliffs: the coast drops away steeply
    const east = sstep(380, 560, x) * sstep(-560, -300, z) * sstep(260, 0, z);
    h = h * land;
    if (east > 0) h += east * sstep(0.84, 0.94, d) * -40;
    // beaches and sea floor
    const shore = sstep(0.86, 0.97, d);
    h = lerp(h, Math.min(h, 1.2 + n2.fbm2(x * 0.02, z * 0.02, 2) * 0.8), shore * (1 - east));
    h = lerp(h, -16, sstep(0.97, 1.08, d));
    return h;
  }
  _build() {
    const H = this.H;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = this._raw(i * CELL - HALF, j * CELL - HALF);
    this._lakes();
    this._rivers();
    this._pads();
    this._swamp();
    this._smooth(1);
    this._masks();
    this._caves();
    for (const l of this.landmarks) l.y = this.height(l.x, l.z);
  }
  _lakes() {
    for (const L of this.lakes) {
      // water level a little under the lowest point of the rim
      let rim = Infinity;
      for (let a = 0; a < 32; a++) { const t = a / 32 * Math.PI * 2; rim = Math.min(rim, this.heightRaw(L.x + Math.cos(t) * L.r * 1.15, L.z + Math.sin(t) * L.r * 1.15)); }
      L.level = Math.max(SEA + 2, rim - 1.2);
      this._each(L.x, L.z, L.r * 1.8, (i, j, x, z) => {
        const d = Math.hypot(x - L.x, z - L.z) * (1 + 0.12 * this.n.n2(x * 0.02, z * 0.02));
        let target;
        if (d < L.r) target = L.level - 1 - 7 * (1 - (d / L.r) ** 2);
        else target = L.level - 1 + (d - L.r) / (0.8 * L.r) * 6;
        const k = j * N + i; this.H[k] = Math.min(this.H[k], target);
      });
    }
  }
  _rivers() {
    this.riverPts = []; this.riverGrid = new Grid2(48);
    for (const R of RIVERS) {
      // dense samples along a Catmull-Rom-ish path
      const P = R.pts, dense = [];
      for (let s = 0; s < P.length - 1; s++) {
        const p0 = P[Math.max(0, s - 1)], p1 = P[s], p2 = P[s + 1], p3 = P[Math.min(P.length - 1, s + 2)];
        const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), steps = Math.ceil(len / 4);
        for (let k = 0; k < steps; k++) {
          const t = k / steps, t2 = t * t, t3 = t2 * t;
          const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          dense.push([cr(p0[0], p1[0], p2[0], p3[0]), cr(p0[1], p1[1], p2[1], p3[1])]);
        }
      }
      dense.push(P[P.length - 1]);
      // water level: never rises downstream; lakes pin it
      let level = Infinity; const pts = [];
      dense.forEach(([x, z], i) => {
        const t = i / (dense.length - 1);
        let h = this.heightRaw(x, z) - 1.6;
        for (const L of this.lakes) if (Math.hypot(x - L.x, z - L.z) < L.r * 1.05) h = Math.min(h, L.level);
        level = Math.min(level, h);
        const w = lerp(R.w0, R.w1, t) * (1 + 0.25 * this.n.n2(x * 0.01, z * 0.01));
        pts.push({ x, z, w, level: Math.max(level, SEA - 0.3), river: R.id, t });
      });
      R.dense = pts;
      for (const p of pts) { this.riverPts.push(p); this.riverGrid.add(p, p.x, p.z); }
      this._stampRiver(pts);
      // carve the bed
      for (const p of pts) {
        this._each(p.x, p.z, p.w * 2.8, (i, j, x, z) => {
          const d = Math.hypot(x - p.x, z - p.z);
          const bed = p.level - 1.4 * (1 - sstep(0, p.w * 0.5, d)) - 0.5;
          const bank = p.level + 0.3 + sstep(p.w * 0.5, p.w * 2.8, d) * 6;
          const target = d < p.w * 0.5 ? bed : Math.min(bank, lerp(bed, bank, sstep(p.w * 0.4, p.w * 0.9, d)));
          const k = j * N + i; this.H[k] = Math.min(this.H[k], target);
        });
      }
    }
    this.rivers = RIVERS;
  }
  /** distance field to the nearest river sample (4 m cells, 70 m reach) - makes riverDist O(1) */
  _stampRiver(pts) {
    if (!this.rdist) { this.rdist = new Float32Array(N * N).fill(1e4); this.ridx = new Int32Array(N * N).fill(-1); }
    const base = this.riverPts.length - pts.length;
    pts.forEach((p, k) => this._each(p.x, p.z, 70, (i, j, x, z) => {
      const d = Math.hypot(x - p.x, z - p.z), c = j * N + i;
      if (d < this.rdist[c]) { this.rdist[c] = d; this.ridx[c] = base + k; }
    }));
  }
  _pads() {
    for (const l of this.landmarks) {
      // average height over the pad, then pull the ground toward it
      let s = 0, c = 0;
      this._each(l.x, l.z, l.r, (i, j) => { s += this.H[j * N + i]; c++; });
      const avg = s / Math.max(1, c);
      this._each(l.x, l.z, l.r * 1.7, (i, j, x, z) => {
        const d = Math.hypot(x - l.x, z - l.z), k = j * N + i;
        const w = (1 - sstep(l.r * 0.8, l.r * 1.7, d)) * l.flat;
        this.H[k] = lerp(this.H[k], avg + this.n2.n2(x * 0.05, z * 0.05) * 0.25, w);
      });
    }
  }
  _swamp() {
    const S = this.swamp;
    this._each(S.x, S.z, S.r * 1.3, (i, j, x, z) => {
      const d = Math.hypot(x - S.x, z - S.z) / S.r;
      const w = 1 - sstep(0.7, 1.25, d + this.n.n2(x * 0.01, z * 0.01) * 0.2);
      if (w <= 0) return;
      const k = j * N + i;
      const pools = this.n2.fbm2(x * 0.03, z * 0.03, 3);
      const target = S.level + 0.2 + pools * 1.4;
      this.H[k] = lerp(this.H[k], Math.min(this.H[k], target), w);
    });
  }
  _smooth(passes) {
    const H = this.H, T = new Float32Array(N * N);
    for (let p = 0; p < passes; p++) {
      for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        T[k] = H[k] * 0.5 + (H[k - 1] + H[k + 1] + H[k - N] + H[k + N]) * 0.125;
      }
      for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) H[j * N + i] = T[j * N + i];
    }
  }
  _masks() {
    const n = this.n, n2 = this.n2;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, x = i * CELL - HALF, z = j * CELL - HALF, h = this.H[k];
      const slope = this.slopeAt(i, j);
      // swamp / wet ground
      const sd = Math.hypot(x - SWAMP.x, z - SWAMP.z) / SWAMP.r;
      let wet = 1 - sstep(0.6, 1.15, sd + n.n2(x * 0.01, z * 0.01) * 0.2);
      const riv = this.riverDist(x, z);
      if (riv.p) wet = Math.max(wet, (1 - sstep(riv.p.w * 0.6, riv.p.w * 1.6, riv.d)) * 0.8);
      for (const L of this.lakes) wet = Math.max(wet, (1 - sstep(L.r * 0.95, L.r * 1.25, Math.hypot(x - L.x, z - L.z))) * 0.55);
      this.wet[k] = wet;
      // burned forest around the ruins
      const bd = Math.hypot(x - BURN.x, z - BURN.z) / BURN.r;
      this.burn[k] = 1 - sstep(0.55, 1.05, bd + n2.n2(x * 0.012, z * 0.012) * 0.25);
      // autumn groves
      let au = 0;
      for (const A of AUTUMN) au = Math.max(au, 1 - sstep(0.4, 1.0, Math.hypot(x - A.x, z - A.z) / A.r + n.n2(x * 0.008, z * 0.008) * 0.3));
      au = Math.max(au, sstep(0.55, 0.8, n2.fbm2(x * 0.004 + 9, z * 0.004, 3)) * 0.5);
      this.autumn[k] = au;
      // meadows: open clearings scattered through the forest
      let mead = sstep(0.18, 0.42, n.fbm2(x * 0.0045 + 40, z * 0.0045 - 12, 4));
      mead = Math.max(mead, sstep(0.3, 0.55, n2.n2(x * 0.0016, z * 0.0016)) * 0.6);
      this.meadow[k] = mead;
      // forest density
      let f = 0.85 - mead * 0.95;
      f -= sstep(0.6, 1.1, slope) * 0.8;              // cliffs and steep slopes
      f -= sstep(150, 205, h) * 0.95;                 // tree line
      f *= sstep(1.2, 3.5, h);                         // beaches and water
      f *= 1 - sstep(0.85, 1.0, wet) * 0.6;
      f += n2.fbm2(x * 0.03, z * 0.03, 2) * 0.15;      // patchiness
      for (const l of this.landmarks) { const d = Math.hypot(x - l.x, z - l.z); if (d < l.r * 1.25) f *= sstep(l.r * 0.75, l.r * 1.25, d); }
      this.forest[k] = clamp(f, 0, 1);
    }
  }
  _caves() {
    // put each cave mouth on the steepest nearby slope, facing downhill
    for (const c of this.caves) {
      let best = null;
      for (let a = 0; a < 48; a++) for (let r = 0; r <= 90; r += 10) {
        const t = a / 48 * Math.PI * 2, x = c.x + Math.cos(t) * r, z = c.z + Math.sin(t) * r;
        const g = this.grad(x, z), s = Math.hypot(g.x, g.z), h = this.height(x, z);
        if (h < 4) continue;
        const score = Math.min(s, 1.1) - r * 0.002;
        if (!best || score > best.score) best = { x, z, score, g };
      }
      c.x = best.x; c.z = best.z;
      c.dir = Math.atan2(-best.g.x, -best.g.z);        // heading facing downhill (out of the hill)
      // carve a small flat apron in front of the mouth
      const fx = c.x + Math.sin(c.dir) * 6, fz = c.z + Math.cos(c.dir) * 6, fy = this.height(fx, fz);
      this._each(fx, fz, 14, (i, j, x, z) => {
        const d = Math.hypot(x - fx, z - fz), k = j * N + i;
        this.H[k] = lerp(this.H[k], fy, (1 - sstep(6, 14, d)) * 0.8);
      });
      c.y = this.height(c.x, c.z);
      // keep trees off the apron
      this._each(c.x, c.z, 20, (i, j) => { this.forest[j * N + i] *= 0.1; });
    }
  }
  _each(cx, cz, r, fn) {
    const i0 = Math.max(0, Math.floor((cx - r + HALF) / CELL)), i1 = Math.min(N - 1, Math.ceil((cx + r + HALF) / CELL));
    const j0 = Math.max(0, Math.floor((cz - r + HALF) / CELL)), j1 = Math.min(N - 1, Math.ceil((cz + r + HALF) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = i * CELL - HALF, z = j * CELL - HALF;
      if ((x - cx) * (x - cx) + (z - cz) * (z - cz) <= r * r) fn(i, j, x, z);
    }
  }

  /* ------------------------------------------------------------ queries */
  heightRaw(x, z) { return this._sample(this.H, x, z); }
  _sample(A, x, z) {
    const fx = clamp((x + HALF) / CELL, 0, N - 1.001), fz = clamp((z + HALF) / CELL, 0, N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, k = j * N + i;
    // triangle interpolation matching the rendered mesh (diagonal from (i,j+1) to (i+1,j))
    if (u + v <= 1) return A[k] + (A[k + 1] - A[k]) * u + (A[k + N] - A[k]) * v;
    return A[k + N + 1] + (A[k + N] - A[k + N + 1]) * (1 - u) + (A[k + 1] - A[k + N + 1]) * (1 - v);
  }
  /** ground height at a world point */
  height(x, z) { return this._sample(this.H, x, z); }
  grad(x, z) { const e = 2; return { x: (this.height(x + e, z) - this.height(x - e, z)) / (2 * e), z: (this.height(x, z + e) - this.height(x, z - e)) / (2 * e) }; }
  normal(x, z, out) { const g = this.grad(x, z); const l = Math.hypot(g.x, 1, g.z); out.set(-g.x / l, 1 / l, -g.z / l); return out; }
  slopeAt(i, j) {
    const H = this.H, a = H[j * N + Math.min(N - 1, i + 1)] - H[j * N + Math.max(0, i - 1)], b = H[Math.min(N - 1, j + 1) * N + i] - H[Math.max(0, j - 1) * N + i];
    return Math.hypot(a, b) / (2 * CELL);
  }
  forestAt(x, z) { return this._sample(this.forest, x, z); }
  wetAt(x, z) { return this._sample(this.wet, x, z); }
  burnAt(x, z) { return this._sample(this.burn, x, z); }
  autumnAt(x, z) { return this._sample(this.autumn, x, z); }
  meadowAt(x, z) { return this._sample(this.meadow, x, z); }
  /** nearest river sample within ~100 m: {d, p} */
  riverDist(x, z) {
    const i = Math.round(clamp((x + HALF) / CELL, 0, N - 1)), j = Math.round(clamp((z + HALF) / CELL, 0, N - 1)), c = j * N + i;
    const k = this.ridx[c]; if (k < 0) return _RD.none;
    const p = this.riverPts[k];
    _RD.v.d = Math.hypot(p.x - x, p.z - z); _RD.v.p = p; return _RD.v;
  }
  /** water surface height at (x,z), or -Infinity when there is no water here */
  waterLevel(x, z) {
    let lvl = -Infinity;
    const r2 = x * x + z * z;
    if (r2 > 500 * 500) lvl = SEA;                 // the sea (land covers it where the ground is higher)
    for (const L of this.lakes) if (Math.hypot(x - L.x, z - L.z) < L.r * 1.35) lvl = Math.max(lvl, L.level);
    const rv = this.riverDist(x, z);
    if (rv.p && rv.d < rv.p.w * 1.4) lvl = Math.max(lvl, rv.p.level);
    if (Math.hypot(x - SWAMP.x, z - SWAMP.z) < SWAMP.r * 1.2) lvl = Math.max(lvl, SWAMP.level);
    if (lvl === -Infinity && this.height(x, z) < SEA) lvl = SEA;
    return lvl;
  }
  /** depth of water at the point (0 when dry) */
  waterDepth(x, z) { const l = this.waterLevel(x, z); if (l === -Infinity) return 0; return Math.max(0, l - this.height(x, z)); }
  /** what the ground is made of, for footsteps and the terrain shader */
  surface(x, z) {
    const h = this.height(x, z);
    if (h < 2.2 && Math.hypot(x, z) > 600) return 'sand';
    if (h > 205) return 'snow';
    const g = this.grad(x, z); if (Math.hypot(g.x, g.z) > 0.85) return 'rock';
    if (this.wetAt(x, z) > 0.6) return 'mud';
    if (this.forestAt(x, z) > 0.45) return 'forest';
    if (this.autumnAt(x, z) > 0.6) return 'leaves';
    return 'grass';
  }
  landmark(id) { return this.landmarks.find(l => l.id === id); }
  cave(id) { return this.caves.find(c => c.id === id); }
  /** is this point on the island (not open sea)? */
  onLand(x, z) { return this.height(x, z) > SEA + 0.5; }
  /** find a dry, gentle spot near (x,z) - for spawning */
  findGround(x, z, r = 30, rand = Math.random, maxSlope = 0.5) {
    for (let k = 0; k < 40; k++) {
      const a = rand() * Math.PI * 2, d = rand() * r, px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const h = this.height(px, pz); if (h < 1.5 || this.waterDepth(px, pz) > 0.2) continue;
      const g = this.grad(px, pz); if (Math.hypot(g.x, g.z) > maxSlope) continue;
      return { x: px, y: h, z: pz };
    }
    return { x, y: this.height(x, z), z };
  }
}
