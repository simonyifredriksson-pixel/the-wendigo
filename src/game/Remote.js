/* Remote.js - your friends, as you see them.

   Each remote player is a full survivor model (PeopleArt, their chosen look)
   driven by the 15 Hz state stream: position/yaw are interpolated ~100 ms
   behind, the animation mode comes from their movement, they hold their
   current item, and their torch or flashlight lights the forest around them
   (through the shared light pool). A small name tag floats over their head
   when they are close and in view. Downed friends show a hold-E revive
   prompt (see Combat.js). */
import * as THREE from '../../lib/three.module.js';
import { itemModel } from './Viewmodel.js';
import { damp, dampAng } from '../core/Util.js';

let PeopleArt = null;
async function art() { if (PeopleArt === null) { try { PeopleArt = await import('../art/PeopleArt.js'); } catch (e) { PeopleArt = false; } } return PeopleArt; }

export class Remotes {
  constructor(game) { this.g = game; this.map = new Map(); art(); this.tags = document.createElement('div'); this.tags.id = 'tags'; document.body.appendChild(this.tags); }
  async join(id, p) {
    if (this.map.has(id) || id === this.g.me) return;
    const A = await art();
    const r = { id, name: p.name || 'Survivor', look: (p.look | 0) % 4, pos: new THREE.Vector3(), target: new THREE.Vector3(), yaw: 0, tyaw: 0, s: null, t: 0, item: null, itemObj: null };
    let body = null;
    if (A && A.createPerson) { try { body = A.createPerson('survivor', { look: r.look }); } catch (e) { window.__log?.('ART person: ' + e.message); } }
    if (!body) {
      const g = new THREE.Group();
      const cols = [0xc8462a, 0x5b6b3a, 0x2a3a6a, 0xd8b030];
      const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 1.1, 6, 12), new THREE.MeshStandardMaterial({ color: cols[r.look], roughness: 0.8 })); m.position.y = 0.9; m.castShadow = true; g.add(m);
      const h = new THREE.Mesh(new THREE.SphereGeometry(0.15, 16, 12), new THREE.MeshStandardMaterial({ color: 0xd0a080 })); h.position.y = 1.65; g.add(h);
      body = { root: g, animate() {}, handR: g, head: h };
    }
    r.body = body; this.g.scene.add(body.root);
    r.tag = document.createElement('div'); r.tag.className = 'tag'; r.tag.textContent = r.name; this.tags.appendChild(r.tag);
    this.map.set(id, r);
  }
  leave(id) { const r = this.map.get(id); if (!r) return; r.body.root.removeFromParent(); r.tag.remove(); this.map.delete(id); }
  state(id, s) {
    const r = this.map.get(id); if (!r) { this.join(id, { name: '...' }); return; }
    const first = !r.s; r.s = s;
    r.target.set(s.x, s.y, s.z); r.tyaw = s.yaw;
    if (first) { r.pos.copy(r.target); r.yaw = s.yaw; }
    if (s.it !== r.item) this._hold(r, s.it);
  }
  _hold(r, name) {
    r.item = name;
    if (r.itemObj) { r.itemObj.removeFromParent(); r.itemObj = null; }
    if (!name) return;
    const m = itemModel(name); m.traverse(o => { if (o.isMesh) o.castShadow = true; });
    (r.body.handR || r.body.root).add(m); r.itemObj = m;
    if (name === 'torch' && this.g.fx) { const f = m.getObjectByName('fire') || m.getObjectByName('tip') || m; r.flame = this.g.fx.flame(f, 0.12); } else r.flame = null;
  }
  /** light sources carried by remote players, for the light pool */
  lights() {
    const out = [];
    for (const r of this.map.values()) {
      if (!r.s || !r.s.l) continue;
      if (r.item === 'torch') out.push({ x: r.pos.x, y: r.pos.y + 1.6, z: r.pos.z, i: 6, r: 15, c: 0xff9050, flicker: true, seed: r.pos.x });
      else if (r.item === 'flashlight') { const f = { x: -Math.sin(r.yaw), z: -Math.cos(r.yaw) }; out.push({ x: r.pos.x + f.x * 4, y: r.pos.y + 1.2, z: r.pos.z + f.z * 4, i: 4, r: 12, c: 0xfff0dc }); }
      else if (r.item === 'lighter') out.push({ x: r.pos.x, y: r.pos.y + 1.4, z: r.pos.z, i: 1.4, r: 6, c: 0xffa050, flicker: true, seed: r.pos.z });
    }
    return out;
  }
  get list() { return [...this.map.values()].filter(r => r.s); }
  update(dt) {
    const cam = this.g.camera;
    for (const r of this.map.values()) {
      if (!r.s) { r.body.root.visible = false; r.tag.style.display = 'none'; continue; }
      const s = r.s;
      r.pos.x = damp(r.pos.x, r.target.x, 10, dt); r.pos.y = damp(r.pos.y, r.target.y, 10, dt); r.pos.z = damp(r.pos.z, r.target.z, 10, dt);
      if (r.pos.distanceToSquared(r.target) > 100) r.pos.copy(r.target);
      r.yaw = dampAng(r.yaw, r.tyaw, 10, dt);
      const vis = !s.cave === !this.g.inCave && (!s.cave || s.cave === this.g.inCave);
      r.body.root.visible = vis;
      r.body.root.position.copy(r.pos); r.body.root.rotation.y = r.yaw + Math.PI;
      const sp = r.prev ? r.prev.distanceTo(r.pos) / Math.max(dt, 1e-3) : 0; r.prev = (r.prev || new THREE.Vector3()).copy(r.pos);
      r.spd = damp(r.spd || 0, sp, 6, dt);
      const mode = s.d ? 'downed' : s.m === 'swim' ? 'swim' : s.c ? (r.spd > 0.3 ? 'carry' : 'idle') : s.a > 0 ? (r.item === 'axe' || r.item === 'axeCrafted' ? 'chop' : 'attack') : s.m === 'crouch' ? 'crouch' : r.spd > 4.2 ? 'run' : r.spd > 0.3 ? 'walk' : 'idle';
      if (mode !== r.mode) { r.mode = mode; r.mt = 0; }
      r.mt += dt;
      r.body.animate?.(dt, { mode, t: r.mt, speed: r.spd, aim: -s.pitch, item: r.item });
      // name tag
      const p = new THREE.Vector3(r.pos.x, r.pos.y + 2.05, r.pos.z), d = p.distanceTo(cam.position);
      p.project(cam);
      const on = vis && p.z < 1 && d < 40 && Math.abs(p.x) < 1.1 && Math.abs(p.y) < 1.1 && this.g.phase === 'play' && !this.g.cutscene;
      r.tag.style.display = on ? 'block' : 'none';
      if (on) { r.tag.style.transform = `translate(${(p.x * 0.5 + 0.5) * innerWidth}px, ${(-p.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -100%)`; r.tag.style.opacity = String(Math.max(0.15, 1 - d / 40)); r.tag.classList.toggle('down', !!s.d); }
    }
  }
}
