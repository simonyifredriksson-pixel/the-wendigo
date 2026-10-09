/* Items.js - things lying in the world that you can pick up.

   Natural resources are scattered per 32 m tile from the WORLD SEED (so a
   new game has different resources but every player sees the same ones):
   sticks and stones everywhere, plant fibre in meadows, berry bushes at
   forest edges, mushrooms under trees, herbs by water, feathers, bones.
   They are streamed in around the camera. Taken ones are remembered
   (W.taken). Dropped things (logs you cut, things you put down, animal
   meat) are W.drops and travel over the network. Loot placed at landmarks
   by Story.js uses the same mechanism with fixed ids. */
import * as THREE from '../../lib/three.module.js';
import { hash2, rng } from '../core/Util.js';
import { itemModel } from './Viewmodel.js';
import { label } from '../data/Items.js';

const TILE = 32, RADIUS = 70;
let DROP = 1;

const NATURAL = [
  // name, per-tile tries, where(x,z,isl) -> weight 0..1, amount
  ['stick', 7, (x, z, I) => 0.2 + I.forestAt(x, z) * 0.8, 1],
  ['stone', 4, (x, z, I) => 0.3 + Math.min(1, Math.hypot(I.grad(x, z).x, I.grad(x, z).z)) * 0.7 + (I.wetAt(x, z) > 0.4 ? 0.4 : 0), 1],
  ['fiber', 3, (x, z, I) => I.meadowAt(x, z) * 0.9 + I.wetAt(x, z) * 0.3, 2],
  ['berries', 1.2, (x, z, I) => (1 - Math.abs(I.forestAt(x, z) - 0.4) * 2) * 0.8, 3],
  ['mushroom', 1.4, (x, z, I) => I.forestAt(x, z) * 0.7 + I.wetAt(x, z) * 0.3, 2],
  ['herbs', 0.6, (x, z, I) => I.wetAt(x, z) * 0.8 + I.meadowAt(x, z) * 0.2, 1],
  ['feather', 0.7, (x, z, I) => 0.4, 2],
  ['leaves', 1.2, (x, z, I) => I.autumnAt(x, z) * 0.9 + I.forestAt(x, z) * 0.2, 3],
  ['resin', 0.5, (x, z, I) => I.forestAt(x, z) * 0.6, 1],
  ['bone', 0.25, (x, z, I) => 0.3 + I.burnAt(x, z) * 0.7, 1],
];

export class Items {
  constructor(game) {
    this.g = game;
    this.group = new THREE.Group(); this.group.name = 'pickups'; game.scene.add(this.group);
    this.live = new Map();     // id -> { id, name, n, x, y, z, obj }
    this.tiles = new Set();
    this._last = new THREE.Vector3(1e9, 0, 0);
  }
  begin(W) {
    for (const it of this.live.values()) it.obj?.removeFromParent();
    this.live.clear(); this.tiles.clear(); this._last.set(1e9, 0, 0);
    for (const d of W.drops || []) this._add(d);
    DROP = 1 + (W.drops || []).reduce((m, d) => Math.max(m, +String(d.id).slice(1) || 0), 0);
  }
  _add(d) {
    if (this.live.has(d.id)) return this.live.get(d.id);
    const it = { ...d };
    const obj = itemModel(d.name);
    obj.position.set(d.x, d.y, d.z); obj.rotation.set(d.name === 'log' || d.name === 'stick' ? 0 : 0, d.r ?? hash2(d.x | 0, d.z | 0, 3) * 6.28, d.name === 'log' || d.name === 'stick' ? 0 : 0);
    if (['stick', 'log', 'spear', 'axe', 'club', 'bow', 'rifle', 'torch', 'flashlight', 'boneClub', 'arrow', 'flare'].includes(d.name)) obj.rotation.x = Math.PI / 2, obj.position.y += d.name === 'log' ? 0.2 : 0.04;
    obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    obj.userData.pickup = it;
    this.group.add(obj); it.obj = obj;
    this.live.set(d.id, it);
    return it;
  }
  /** host: drop an item into the world (shared) */
  spawn(name, x, z, n = 1, y) {
    const gy = y ?? this.g.physics.ground(x, z) + 0.02;
    const d = { id: 'd' + DROP++, name, n, x: +x.toFixed(2), y: +gy.toFixed(2), z: +z.toFixed(2), r: Math.random() * 6.28 };
    this.g.W.drops.push(d);
    this.g.emit({ k: 'drop', d });
    return d;
  }
  /** local: put something down in front of me */
  dropAt(name, n = 1) {
    const p = this.g.player, f = p.forward;
    this.g.act({ k: 'spawnItem', name, n, x: p.pos.x + f.x * 1.2, z: p.pos.z + f.z * 1.2 });
  }
  onEvent(e) {
    if (e.k === 'drop') this._add(e.d);
    else if (e.k === 'take') { const it = this.live.get(e.id); if (it) { it.obj?.removeFromParent(); this.live.delete(e.id); } this.g.W.taken[e.id] = 1; }
  }
  /** local: try to pick something up (the host confirms and hands it over) */
  pickUp(it) {
    const inv = this.g.inventory;
    if (inv.cap(it.name) - inv.count(it.name) <= 0) { inv.add(it.name, 1); return; } // shows the "can't carry" toast
    this.g.act({ k: 'take', id: it.id });
  }
  /** host: someone took an item */
  take(a, from) {
    const it = this.live.get(a.id); if (!it || this.g.W.taken[a.id]) return;
    this.g.W.taken[a.id] = 1;
    this.g.W.drops = this.g.W.drops.filter(d => d.id !== a.id);
    this.g.emit({ k: 'take', id: a.id });
    this.g.sync?.give(from, it.name, it.n);
  }
  /* ---------------- streaming natural resources */
  update(dt) {
    const c = this.g.camera.position;
    if (this._last.distanceToSquared(c) < 64) return;
    this._last.copy(c);
    const W = this.g.W; if (!W) return;
    const I = this.g.island, seed = W.seed;
    const t0x = Math.floor((c.x - RADIUS) / TILE), t1x = Math.floor((c.x + RADIUS) / TILE), t0z = Math.floor((c.z - RADIUS) / TILE), t1z = Math.floor((c.z + RADIUS) / TILE);
    const want = new Set();
    for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
      const key = tx + ',' + tz; want.add(key);
      if (this.tiles.has(key)) continue;
      this.tiles.add(key);
      const r = rng(hash2(tx, tz, seed & 0xffff) * 4294967296);
      for (const [name, tries, where, amt] of NATURAL) {
        const n = Math.floor(tries + r());
        for (let i = 0; i < n; i++) {
          const x = (tx + r()) * TILE, z = (tz + r()) * TILE, id = 'n' + tx + '_' + tz + '_' + name + i;
          if (W.taken[id]) continue;
          const y = I.height(x, z);
          if (y < 1.4 || I.waterDepth(x, z) > 0.05 || r() > where(x, z, I)) continue;
          if (y > 200 && name !== 'stone') continue;
          this._add({ id, name, n: amt, x, y: y + 0.02, z, tile: key });
        }
      }
    }
    // unload far tiles
    for (const key of [...this.tiles]) if (!want.has(key)) {
      this.tiles.delete(key);
      for (const [id, it] of this.live) if (it.tile === key) { it.obj?.removeFromParent(); this.live.delete(id); }
    }
  }
  /** pickups near a point (for the interaction ray) */
  near(x, z, r, fn) { for (const it of this.live.values()) { if (Math.abs(it.x - x) < r && Math.abs(it.z - z) < r) fn(it); } }
  describe(it) { return 'Pick up ' + label(it.name).toLowerCase() + (it.n > 1 ? ' (' + it.n + ')' : ''); }
}
