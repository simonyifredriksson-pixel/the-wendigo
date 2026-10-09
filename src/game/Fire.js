/* Fire.js - fires and the lights in the dark.

   Fires: campfires, fire pits, torch stands, the signal pyre, the wreck's
   smouldering fuel, the cannibals' fires, the finale's pyres, flares. Each
   has fuel (seconds), burns down, and can be fed (sticks +60 s, logs +240 s).
   A lit fire warms whoever stands near it (player.nearFire), keeps corrupted
   animals back, and makes the Wendigo hesitate - but only hesitate.

   Lights: the scene has a FIXED pool of point lights (shader cost does not
   change as fires come and go). Every frame the brightest/nearest sources
   (fires, torches in anyone's hand, flares) are assigned to the pool with
   a flicker. The local player also has their own flashlight (spot) and a
   hand light (lighter/torch). One pool light may cast shadows on high
   quality: firelight throwing tree shadows is the whole mood. */
import * as THREE from '../../lib/three.module.js';
import { clamp, damp } from '../core/Util.js';

const POOL = 6;
let FID = 1;

export class Fires {
  constructor(game) {
    this.g = game;
    this.list = [];
    this.pool = [];
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xff9a50, 0, 18, 1.6);
      if (i === 0) { l.castShadow = true; l.shadow.mapSize.set(512, 512); l.shadow.camera.near = 0.3; l.shadow.camera.far = 22; l.shadow.bias = -0.003; }
      game.scene.add(l); this.pool.push(l);
    }
    // the local player's own lights
    this.flash = new THREE.SpotLight(0xfff0dc, 0, 42, 0.42, 0.45, 1.4);
    this.flash.castShadow = true; this.flash.shadow.mapSize.set(1024, 1024); this.flash.shadow.camera.near = 0.2; this.flash.shadow.camera.far = 42; this.flash.shadow.bias = -0.0008;
    this.flashTarget = new THREE.Object3D();
    game.scene.add(this.flash, this.flashTarget); this.flash.target = this.flashTarget;
    this.hand = new THREE.PointLight(0xffa860, 0, 12, 1.5);
    game.scene.add(this.hand);
    this.t = 0;
  }
  /** add a fire: {x,y,z,size,fuel,kind,parent?,id?,persistent?} -> fire */
  add(o) {
    const f = { id: o.id || 'f' + FID++, x: o.x, y: o.y, z: o.z, size: o.size || 1, fuel: o.fuel ?? 300, max: o.max || 900, lit: o.lit ?? true, kind: o.kind || 'camp', persistent: !!o.persistent, warm: o.warm ?? 6, cook: !!o.cook, smoke: 0, emb: 0, obj: o.obj || null };
    const holder = new THREE.Group(); holder.position.set(f.x, f.y, f.z); this.g.scene.add(holder); f.holder = holder;
    f.flame = this.g.fx?.flame(holder, f.size) || null;
    this.list.push(f);
    this._vis(f);
    return f;
  }
  remove(f) { if (!f) return; f.flame?.remove(); f.holder.removeFromParent(); const i = this.list.indexOf(f); if (i >= 0) this.list.splice(i, 1); }
  byId(id) { return this.list.find(f => f.id === id); }
  nearest(x, z, r = 3) { let best = null, bd = r; for (const f of this.list) { const d = Math.hypot(f.x - x, f.z - z); if (d < bd) { bd = d; best = f; } } return best; }
  light(f) { if (f.lit) return; f.lit = true; if (f.fuel < 30) f.fuel = 60; this.g.audio.fireIgnite?.(f); this.g.fx?.sparks({ x: f.x, y: f.y + 0.3, z: f.z }, 14); this._vis(f); }
  feed(f, secs) { f.fuel = Math.min(f.max, f.fuel + secs); if (!f.lit) this.light(f); this.g.fx?.embers({ x: f.x, y: f.y + 0.4, z: f.z }, 10, 0.5); }
  douse(f) { f.lit = false; this._vis(f); this.g.fx?.smoke({ x: f.x, y: f.y + 0.3, z: f.z }, 8, 0.4, 1); }
  _vis(f) { const k = f.lit ? clamp(f.fuel / 60, 0.25, 1) : 0; f.flame?.setSize(f.size * k); }
  /** warmth at a point (0..1) */
  warmthAt(x, y, z) {
    let w = 0;
    for (const f of this.list) { if (!f.lit) continue; const d = Math.hypot(f.x - x, f.z - z, (f.y - y) * 0.5); if (d < f.warm) w = Math.max(w, 1 - d / f.warm); }
    return w;
  }
  /** how lit a point is by fires (used by AI: things avoid firelight) */
  lightAt(x, z) {
    let w = 0;
    for (const f of this.list) { if (!f.lit) continue; const d = Math.hypot(f.x - x, f.z - z), r = 7 + f.size * 6; if (d < r) w = Math.max(w, 1 - d / r); }
    return w;
  }
  update(dt) {
    const g = this.g, fx = g.fx;
    this.t += dt;
    const host = g.isHost;
    for (const f of this.list) {
      if (!f.lit) continue;
      if (host && !f.persistent) { f.fuel -= dt; if (f.fuel <= 0) { f.fuel = 0; f.lit = false; this._vis(f); g.sync?.fireOut?.(f); continue; } }
      if (g.atmos.out.rain > 0.7 && f.kind === 'camp' && !f.roofed) f.fuel -= dt * 0.5;
      const k = clamp(f.fuel / 60, 0.25, 1);
      f.flame?.setSize(f.size * k * (0.92 + 0.08 * Math.sin(this.t * 9 + f.x)));
      // particles only near the camera
      const dc = Math.hypot(f.x - g.camera.position.x, f.z - g.camera.position.z);
      if (fx && dc < 70) {
        f.smoke -= dt; f.emb -= dt;
        if (f.smoke <= 0) { f.smoke = 0.35 / f.size; fx.smoke({ x: f.x, y: f.y + 0.9 * f.size, z: f.z }, 1, 0.18, 0.6 * f.size); }
        if (f.emb <= 0) { f.emb = 0.12 / f.size; fx.embers({ x: f.x, y: f.y + 0.4 * f.size, z: f.z }, 1, 0.4 * f.size); }
      }
    }
    // the player's warmth from fires
    const p = g.player;
    p.nearFire = this.warmthAt(p.pos.x, p.pos.y, p.pos.z);
    this._lights(dt);
  }
  _lights(dt) {
    const g = this.g, cam = g.camera.position;
    const src = [];
    for (const f of this.list) if (f.lit) src.push({ x: f.x, y: f.y + 0.9 * f.size, z: f.z, i: 6 * f.size * clamp(f.fuel / 60, 0.3, 1), r: 12 + f.size * 8, c: 0xff8a40, seed: f.x * 3.1, fire: true });
    // torches carried by other players / flares in flight
    for (const s of g.remotes?.lights?.() || []) src.push(s);
    for (const s of g.combat?.lights?.() || []) src.push(s);
    for (const s of g.extraLights || []) src.push(s);
    for (const s of src) s.d = Math.hypot(s.x - cam.x, s.y - cam.y, s.z - cam.z) - s.r * 0.5;
    src.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL; i++) {
      const l = this.pool[i], s = src[i];
      if (!s || s.d > 120) { l.intensity = 0; continue; }
      const fl = s.fire || s.flicker ? 0.82 + 0.1 * Math.sin(this.t * 13 + s.seed) + 0.08 * Math.sin(this.t * 31 + s.seed * 2) : 1;
      l.position.set(s.x, s.y, s.z); l.color.set(s.c); l.intensity = s.i * fl; l.distance = s.r;
    }
    // own lights
    const p = g.player, inv = g.inventory, held = inv?.held;
    const vm = g.viewmodel;
    const on = g.lightOn && !p.downed;
    const fl = held === 'flashlight' && on && inv.battery > 0;
    this.flash.intensity = damp(this.flash.intensity, fl ? 26 * (inv.battery < 0.1 ? (Math.random() < 0.1 ? 0.2 : 0.7) : 1) : 0, 20, dt);
    if (this.flash.intensity > 0.01) {
      const e = g.camera.position, f = p.forward;
      this.flash.position.set(e.x + Math.cos(p.yaw) * 0.25, e.y - 0.25, e.z - Math.sin(p.yaw) * 0.25);
      this.flashTarget.position.set(e.x + f.x * 10, e.y + f.y * 10, e.z + f.z * 10);
    }
    const torch = held === 'torch' && on, lighter = held === 'lighter' && on;
    const want = torch ? 7 : lighter ? 1.6 : 0;
    const flick = 0.8 + 0.12 * Math.sin(this.t * 14) + 0.08 * Math.sin(this.t * 37);
    this.hand.intensity = damp(this.hand.intensity, want * flick, 15, dt);
    this.hand.distance = torch ? 16 : 7;
    if (this.hand.intensity > 0.01) { const e = g.camera.position; this.hand.position.set(e.x + Math.cos(p.yaw) * 0.3 - Math.sin(p.yaw) * 0.3, e.y - 0.15, e.z - Math.sin(p.yaw) * 0.3 - Math.cos(p.yaw) * 0.3); }
    void vm;
  }
  /** shadow casting is fixed per quality level (changing it recompiles every shader) */
  setQuality(q) { this.pool[0].castShadow = q === 'high'; this.flash.castShadow = q !== 'low'; }
  save(W) { W.fires = this.list.filter(f => f.saveId).map(f => ({ id: f.saveId, fuel: f.fuel, lit: f.lit })); }
}
