/* Physics.js - the solid world for characters: terrain, tree trunks, static
   colliders (props, ruins, boulders, player-built structures) and walkable
   tops (foundations, floors, stairs, rocks you can climb onto).

   Colliders live in a 2D spatial hash. Shapes:
     box  { x, z, w, d, h, y0, rot, walk? }   oriented box (rot about Y)
     cyl  { x, z, r, h, y0, walk? }
   `walk` = its top is ground you can stand on (step-up 0.6 m).
   Everything returns plain numbers; no allocation in the hot paths except
   the raycast result. */
import * as THREE from '../../lib/three.module.js';
import { Grid2 } from '../core/Util.js';

let NEXT = 1;
export class Physics {
  constructor(island, forest) {
    this.island = island; this.forest = forest;
    this.grid = new Grid2(12);
    this.byId = new Map();
    this.cave = null;       // when set (a Cave), characters inside use its SDF instead of the terrain
  }
  add(c) {
    c.id = c.id || 'c' + NEXT++;
    if (c.y0 === undefined) c.y0 = this.island.height(c.x, c.z) - 0.5;
    if (c.r !== undefined) c.rad = c.r; else { c.cos = Math.cos(c.rot || 0); c.sin = Math.sin(c.rot || 0); c.rad = Math.hypot(c.w, c.d) / 2; }
    // register in every cell it overlaps
    const r = c.rad, cell = this.grid.cell;
    c._cells = [];
    for (let x = Math.floor((c.x - r) / cell); x <= Math.floor((c.x + r) / cell); x++)
      for (let z = Math.floor((c.z - r) / cell); z <= Math.floor((c.z + r) / cell); z++) {
        const k = (x + 4096) * 8192 + (z + 4096);
        let a = this.grid.map.get(k); if (!a) this.grid.map.set(k, a = []); a.push(c); c._cells.push(k);
      }
    this.byId.set(c.id, c);
    return c;
  }
  remove(id) {
    const c = typeof id === 'object' ? id : this.byId.get(id); if (!c) return;
    for (const k of c._cells) { const a = this.grid.map.get(k); if (!a) continue; const i = a.indexOf(c); if (i >= 0) a.splice(i, 1); }
    this.byId.delete(c.id);
  }
  /** add colliders from a prop's userData.colliders, placed by an Object3D transform (x,y,z,rotY,scale) */
  addProp(list, x, y, z, rot = 0, scale = 1, tag) {
    const out = [], cs = Math.cos(rot), sn = Math.sin(rot);
    for (const c of list || []) {
      const lx = (c.x || 0) * scale, lz = (c.z || 0) * scale;
      // three: rotating by +rot about Y maps (x,z) -> (x cos + z sin, -x sin + z cos)
      const wx = x + lx * cs + lz * sn, wz = z - lx * sn + lz * cs;
      const base = { x: wx, z: wz, h: (c.h || 3) * scale, y0: y + (c.y || 0) * scale - (c.y === undefined ? 0.4 : 0), walk: !!c.walk, tag };
      if (c.r !== undefined) out.push(this.add({ ...base, r: c.r * scale }));
      else out.push(this.add({ ...base, w: c.w * scale, d: c.d * scale, rot: (c.rot || 0) + rot }));
    }
    return out;
  }
  _each(x, z, r, fn) {
    const cell = this.grid.cell, seen = this._seen || (this._seen = new Set()); seen.clear();
    for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++)
      for (let j = Math.floor((z - r) / cell); j <= Math.floor((z + r) / cell); j++) {
        const a = this.grid.map.get((i + 4096) * 8192 + (j + 4096)); if (!a) continue;
        for (const c of a) { if (seen.has(c)) continue; seen.add(c); fn(c); }
      }
  }
  /** ground height under (x,z) for a character whose feet are at y (walkable tops count if reachable) */
  ground(x, z, y = Infinity) {
    if (this.cave && this.cave.contains(x, y, z)) return this.cave.floor(x, y, z);
    let g = this.island.height(x, z);
    this._each(x, z, 0.5, (c) => {
      if (!c.walk) return;
      const top = c.y0 + c.h;
      if (top <= g || top > y + 0.65) return;
      if (this._inside(c, x, z, 0.05)) g = top;
    });
    return g;
  }
  _inside(c, x, z, pad) {
    if (c.r !== undefined) return (x - c.x) ** 2 + (z - c.z) ** 2 < (c.r + pad) ** 2;
    const dx = x - c.x, dz = z - c.z, lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
    return Math.abs(lx) < c.w / 2 + pad && Math.abs(lz) < c.d / 2 + pad;
  }
  /**
   * Push a vertical capsule (feet y, height ht, radius rad) out of trees and colliders.
   * Returns [x, z]. Walkable colliders only block if their top is above the step height.
   */
  collide(x, z, y, rad = 0.35, ht = 1.75, opts = {}) {
    if (!opts.noTrees) [x, z] = this.forest.collide(x, z, rad);
    for (let pass = 0; pass < 2; pass++) this._each(x, z, rad + 0.5, (c) => {
      if (c.noBlock) return;
      const top = c.y0 + c.h;
      if (y + ht < c.y0 || y > top - 0.01) return;              // above or below it
      if (c.walk && top - y < 0.62) return;                      // step up onto it
      if (c.r !== undefined) {
        const dx = x - c.x, dz = z - c.z, d = Math.hypot(dx, dz), rr = c.r + rad;
        if (d < rr && d > 1e-5) { x = c.x + dx / d * rr; z = c.z + dz / d * rr; }
      } else {
        const dx = x - c.x, dz = z - c.z;
        let lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
        const hw = c.w / 2 + rad, hd = c.d / 2 + rad;
        if (Math.abs(lx) < hw && Math.abs(lz) < hd) {
          // push out along the shallowest axis
          const px = hw - Math.abs(lx), pz = hd - Math.abs(lz);
          if (px < pz) lx = Math.sign(lx || 1) * hw; else lz = Math.sign(lz || 1) * hd;
          x = c.x + lx * c.cos + lz * c.sin; z = c.z - lx * c.sin + lz * c.cos;
        }
      }
    });
    if (this.cave && this.cave.contains(x, y, z)) [x, z] = this.cave.collide(x, y, z, rad);
    return [x, z];
  }
  /** is the segment a->b blocked (line of sight)? checks terrain and tall colliders, trees optional */
  blocked(a, b, { trees = true, step = 2 } = {}) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz), n = Math.ceil(L / step);
    for (let i = 1; i < n; i++) {
      const t = i / n, x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
      if (this.island.height(x, z) > y) return true;
    }
    if (trees) {
      const hit = this.forest.raycast(a, _d.set(dx / L, dy / L, dz / L), L);
      if (hit && hit.dist < L - 0.5) return true;
    }
    return false;
  }
  /** ray against terrain (marching) + colliders; returns {point, dist, collider?} */
  ray(o, d, maxD) {
    let best = null;
    // terrain
    let prev = 0;
    for (let t = 0.5; t <= maxD; t += 0.5) {
      const y = o.y + d.y * t;
      if (this.island.height(o.x + d.x * t, o.z + d.z * t) > y) {
        // refine
        let lo = prev, hi = t;
        for (let k = 0; k < 8; k++) { const m = (lo + hi) / 2; if (this.island.height(o.x + d.x * m, o.z + d.z * m) > o.y + d.y * m) hi = m; else lo = m; }
        best = { dist: hi, point: new THREE.Vector3(o.x + d.x * hi, o.y + d.y * hi, o.z + d.z * hi), terrain: true };
        break;
      }
      prev = t;
    }
    // colliders (2D slab test against boxes/cylinders, vertical range check)
    const steps = Math.ceil(maxD / 6);
    for (let s = 0; s <= steps; s++) {
      const px = o.x + d.x * s * 6, pz = o.z + d.z * s * 6;
      this._each(px, pz, 6, (c) => {
        const t = this._rayHit(c, o, d);
        if (t !== null && t >= 0 && t <= maxD && (!best || t < best.dist)) best = { dist: t, point: new THREE.Vector3(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t), collider: c };
      });
    }
    return best;
  }
  _rayHit(c, o, d) {
    let tmin, tmax;
    if (c.r !== undefined) {
      const ox = o.x - c.x, oz = o.z - c.z, a = d.x * d.x + d.z * d.z; if (a < 1e-8) return null;
      const b = 2 * (ox * d.x + oz * d.z), cc = ox * ox + oz * oz - c.r * c.r, disc = b * b - 4 * a * cc; if (disc < 0) return null;
      tmin = (-b - Math.sqrt(disc)) / (2 * a); tmax = (-b + Math.sqrt(disc)) / (2 * a);
    } else {
      const ox = o.x - c.x, oz = o.z - c.z;
      const lox = ox * c.cos - oz * c.sin, loz = ox * c.sin + oz * c.cos, ldx = d.x * c.cos - d.z * c.sin, ldz = d.x * c.sin + d.z * c.cos;
      tmin = -Infinity; tmax = Infinity;
      for (const [p, v, h] of [[lox, ldx, c.w / 2], [loz, ldz, c.d / 2]]) {
        if (Math.abs(v) < 1e-8) { if (Math.abs(p) > h) return null; continue; }
        let t1 = (-h - p) / v, t2 = (h - p) / v; if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return null;
      }
    }
    // vertical slab
    const y0 = c.y0, y1 = c.y0 + c.h;
    if (Math.abs(d.y) < 1e-8) { if (o.y < y0 || o.y > y1) return null; }
    else { let t1 = (y0 - o.y) / d.y, t2 = (y1 - o.y) / d.y; if (t1 > t2) [t1, t2] = [t2, t1]; tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); }
    if (tmin > tmax || tmax < 0) return null;
    return Math.max(0, tmin);
  }
}
const _d = new THREE.Vector3();
