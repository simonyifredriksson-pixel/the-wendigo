/* Interact.js - "press E" on whatever you are looking at.

   Systems register interactables: { id, x, y, z, r, text(): string|null,
   hold?: seconds, act(), when?(): bool }. Pickups come from Items.js.
   Each frame the one closest to the centre of the view (within reach and
   not hidden behind a trunk) is chosen; the HUD shows its prompt, with a
   ring that fills for hold-to-use actions (reviving a friend, lighting a
   pyre, feeding a fire). */
import * as THREE from '../../lib/three.module.js';

export class Interact {
  constructor(game) { this.g = game; this.list = new Map(); this.cur = null; this.holdT = 0; this._v = new THREE.Vector3(); }
  add(o) { this.list.set(o.id, o); return o; }
  remove(id) { this.list.delete(id); }
  _score(x, y, z, r, o, f) {
    const dx = x - o.x, dy = y - o.y, dz = z - o.z, d = Math.hypot(dx, dy, dz);
    if (d > 3.2 + r) return -1;
    const dot = (dx * f.x + dy * f.y + dz * f.z) / (d || 1);
    const need = Math.cos(Math.min(0.6, Math.atan2(r + 0.25, d)));
    if (dot < need) return -1;
    return dot - d * 0.02;
  }
  update(dt) {
    const g = this.g, p = g.player, I = g.input;
    if (g.phase !== 'play' || g.ui.modal || p.downed || g.cutscene || g.build?.active) { g.hud.prompt?.(null); this.cur = null; this.holdT = 0; return; }
    const o = g.camera.position, f = p.forward;
    let best = null, bs = -1;
    for (const it of this.list.values()) {
      if (it.when && !it.when()) continue;
      const s = this._score(it.x, it.y, it.z, it.r || 0.4, o, f);
      if (s > bs) { bs = s; best = it; }
    }
    g.items?.near(o.x, o.z, 3.5, (it) => {
      const s = this._score(it.x, it.y + 0.1, it.z, it.name === 'log' ? 0.9 : 0.3, o, f);
      if (s > bs) { bs = s; best = { pickup: it }; }
    });
    // a trunk between us and it?
    if (best) {
      const t = best.pickup || best;
      const d = Math.hypot(t.x - o.x, t.z - o.z);
      const hit = g.forest.raycast(o, this._v.set(t.x - o.x, (t.y || o.y) - o.y, t.z - o.z).normalize(), d);
      if (hit && hit.dist < d - 0.5) best = null;
    }
    if (best?.pickup) {
      g.hud.prompt?.(g.items.describe(best.pickup), 0, false);
      if (I.pressed('KeyE')) { g.items.pickUp(best.pickup); g.viewmodel?.gesture?.('reach'); }
      this.cur = best; this.holdT = 0;
      return;
    }
    const text = best ? best.text() : null;
    if (!best || !text) { g.hud.prompt?.(null); this.cur = null; this.holdT = 0; return; }
    if (best !== this.cur) this.holdT = 0;
    this.cur = best;
    if (best.hold) {
      if (I.held('KeyE')) { this.holdT += dt; if (this.holdT >= best.hold) { this.holdT = 0; best.act(); } }
      else this.holdT = 0;
      g.hud.prompt?.(text, this.holdT / best.hold, true);
    } else {
      g.hud.prompt?.(text, 0, false);
      if (I.pressed('KeyE')) best.act();
    }
  }
}
