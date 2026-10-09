/* Viewmodel.js - your hands and what is in them.

   Drawn in a little scene of its own on top of the world (a tool never
   sinks into a tree), lit to match where you stand: sun and sky by day,
   moonlight at night, orange when a fire or your torch is close.

   Actions (left mouse):
     melee tools   swing: wind-up, strike, follow-through; the hit lands at
                   the strike moment (Chop.js for trees, Combat.js for creatures)
     spear         thrust
     bow           hold to draw, release to loose an arrow
     rifle/flare   fire (right mouse aims the rifle)
     bone horn     blow it
   F toggles the light (flashlight, lighter, torch). G drops a log.
   Logs you carry ride on your shoulder at the edge of the screen. */
import * as THREE from '../../lib/three.module.js';
import { ITEMS } from '../data/Items.js';
import { damp, clamp, lerp } from '../core/Util.js';

let ItemArt = null, PeopleArt = null;
export async function loadHandArt() {
  try { ItemArt = await import('../art/ItemArt.js'); } catch (e) { ItemArt = null; }
  try { PeopleArt = await import('../art/PeopleArt.js'); } catch (e) { PeopleArt = null; }
}
export function itemModel(name) {
  if (ItemArt) { try { return ItemArt.createItem(name); } catch (e) { /* fall through */ } }
  // stand-in: a stick with a coloured head
  const g = new THREE.Group();
  const h = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.8, 8), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.8 })); h.position.y = 0.2; g.add(h);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.1, 0.03), new THREE.MeshStandardMaterial({ color: name === 'axe' ? 0xa02018 : 0x777777, metalness: 0.6, roughness: 0.4 })); head.position.y = 0.55; g.add(head);
  const tip = new THREE.Object3D(); tip.name = 'tip'; tip.position.y = 0.6; g.add(tip);
  return g;
}

export class Viewmodel {
  constructor(game) {
    this.g = game;
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.01, 10);
    this.overlay = { scene: this.scene, camera: this.cam };
    this.hemi = new THREE.HemisphereLight(0xbfd0e0, 0x302820, 1); this.scene.add(this.hemi);
    this.key = new THREE.DirectionalLight(0xffffff, 1); this.key.position.set(-1, 2, 1); this.scene.add(this.key);
    this.warm = new THREE.PointLight(0xff9040, 0, 3, 1.5); this.warm.position.set(0.25, -0.05, -0.45); this.scene.add(this.warm);
    this.rig = new THREE.Group(); this.scene.add(this.rig);
    this.models = {}; this.cur = null;
    this.swing = 0; this.swingDur = 0.8; this.hitDone = true; this.draw = 0; this.recoil = 0; this.eatT = 0; this.drawT = 1; this.blowT = 0;
    this.sway = { x: 0, y: 0 }; this.actT = 0;
    this.logMesh = null;
    this._built = false;
  }
  async init() {
    await loadHandArt();
    if (PeopleArt?.createFPArms) {
      try {
        this.arms = PeopleArt.createFPArms(this.g.profile.look);
        this.rig.add(this.arms.root);
        this.handR = this.arms.handR; this.handL = this.arms.handL;
      } catch (e) { window.__log?.('ART arms: ' + e.message); this.arms = null; }
    }
    if (!this.arms) this._fallbackArms();
    this._built = true;
    this.equip(this.g.inventory?.held || null);
  }
  _fallbackArms() {
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x8a3a24, roughness: 0.85 }), skin = new THREE.MeshStandardMaterial({ color: 0xc89b7b, roughness: 0.6 });
    const mk = (side) => {
      const s = new THREE.Group();
      const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.32, 4, 10), sleeve); arm.rotation.x = Math.PI / 2; arm.position.z = 0.16; s.add(arm);
      const hand = new THREE.Group(); hand.position.set(0, 0, -0.04); s.add(hand);
      const palm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.04, 0.09), skin); hand.add(palm);
      s.position.set(side * 0.24, -0.26, -0.42);
      this.rig.add(s);
      return { s, hand };
    };
    const R = mk(1), L = mk(-1);
    this.arms = { root: this.rig, handR: R.hand, handL: L.hand, armR: R.s, armL: L.s, pose() {}, fallback: true };
    this.handR = R.hand; this.handL = L.hand;
  }
  resize() { this.cam.aspect = innerWidth / innerHeight; this.cam.updateProjectionMatrix(); }
  _model(name) {
    if (this.models[name]) return this.models[name];
    const m = itemModel(name);
    m.traverse(c => { if (c.isMesh) { c.castShadow = false; c.receiveShadow = false; c.frustumCulled = false; } });
    m.visible = false;
    (this.handR || this.rig).add(m);
    this.models[name] = m;
    return m;
  }
  equip(name) {
    if (!this._built) return;
    for (const k in this.models) this.models[k].visible = false;
    this.cur = name; this.drawT = 0; this.swing = 0; this.draw = 0;
    if (name) { const m = this._model(name); m.visible = true; this.tip = m.getObjectByName('tip'); }
    const T = name ? ITEMS[name]?.tool : null;
    // torches light themselves; flashlights and lighters remember the switch
    if (name === 'torch') this.g.lightOn = true;
    else if (name === 'flashlight' || name === 'lighter') this.g.lightOn = this.g.lightOn && true;
    else this.g.lightOn = false;
    if (name === 'torch') { const m = this.models.torch; if (m && !m.userData.flame && this.g.fx) { const f = m.getObjectByName('fire') || m.getObjectByName('tip') || m; m.userData.flame = this.g.fx.flame(f, 0.11); m.userData.flame.group.traverse(o => { o.renderOrder = 20; }); this._torchFlame = m.userData.flame; } }
    this.hold = T?.hold || (name ? 'right' : 'none');
    this.g.audio.uiClick?.();
  }
  gesture(kind) { if (kind === 'eat') this.eatT = 1.1; }
  get busy() { return this.swing > 0; }

  update(dt) {
    const g = this.g, p = g.player, I = g.input, inv = g.inventory;
    if (!this._built) return;
    const can = g.phase === 'play' && !g.ui.modal && !p.downed && !g.cutscene && !g.build?.active;
    const name = this.cur, T = name ? ITEMS[name]?.tool : null;
    this.actT = Math.max(0, this.actT - dt);
    // light switch
    if (can && I.pressed('KeyF') && (name === 'flashlight' || name === 'lighter' || name === 'torch')) {
      if (name === 'flashlight' && inv.battery <= 0) { g.hud.toast('No batteries.'); g.audio.deny?.(); }
      else { g.lightOn = !g.lightOn; if (name === 'flashlight') g.audio.flashlightClick?.(); else if (name === 'lighter') g.audio.lighter?.(); else if (g.lightOn) g.audio.torchIgnite?.(p.pos); }
    }
    if (can && I.pressed('KeyG') && inv.count('log')) { inv.dropLog(); g.items?.dropAt('log', 1); }
    // actions
    if (T && can) {
      if (T.ranged === 'arrow') this._bow(dt, T);
      else if (T.ranged) { if (I.click(0) && this.recoil <= 0) this._fire(T); }
      else if (T.horn) { if (I.click(0) && this.blowT <= 0) { this.blowT = 2.5; g.story?.blowHorn?.(); } }
      else if (T.dmg && I.btn(0) && this.swing <= 0 && p.stamina > 3) this._startSwing(T);
    }
    // swing progress: the blow lands 42% through
    if (this.swing > 0) {
      const prev = this.swing;
      this.swing = Math.max(0, this.swing - dt / this.swingDur);
      const strikeAt = 0.58;
      if (prev > strikeAt && this.swing <= strikeAt && !this.hitDone) { this.hitDone = true; this._strike(T); }
    }
    this.recoil = Math.max(0, this.recoil - dt * 2.5); this.eatT = Math.max(0, this.eatT - dt); this.blowT = Math.max(0, this.blowT - dt);
    this._pose(dt);
    this._light(dt);
    this._carry();
    if (this._torchFlame) this._torchFlame.setSize(g.lightOn && name === 'torch' ? 0.11 : 0.0001);
  }
  _startSwing(T) {
    const p = this.g.player;
    this.swingDur = T.rate; this.swing = 1; this.hitDone = false; this.actT = T.rate;
    p.stamina -= T.stamina || 6;
    this.g.audio.axeSwing?.();
    this.thrust = !!T.thrust;
  }
  /** the moment of impact: trees first if it is a chopping tool, then creatures, then anything solid */
  _strike(T) {
    const g = this.g, p = g.player;
    const o = g.camera.position.clone(), d = p.forward.clone();
    const reach = T.reach || 2.3;
    const hitC = g.combat?.melee(o, d, reach, T, this.cur);
    if (hitC) { g.shake = Math.max(g.shake, 0.25); return; }
    const tr = g.forest.raycast(o, d, reach + 0.3);
    if (tr && T.chop > 0) { g.chop?.hit(tr.tree, tr.point, d, T.chop); g.shake = Math.max(g.shake, 0.18); return; }
    if (tr) { g.audio.axeHit?.(tr.point, 0.5, 'wood'); g.fx?.chipBurst(tr.point, d.clone().negate(), 3); return; }
    if (g.chop?.hitLog(o, d, reach, T)) return;
    if (g.build?.hitPiece(o, d, reach, T)) return;
    const r = g.physics.ray(o, d, reach);
    if (r) {
      g.audio.axeHit?.(r.point, 0.4, r.terrain ? 'stone' : 'wood');
      if (r.terrain) g.fx?.dust(r.point, 4, [0.4, 0.35, 0.28], 0.3, 0.2); else g.fx?.sparks(r.point, 5, [1.4, 1.0, 0.6], 2);
    }
  }
  _bow(dt, T) {
    const g = this.g, I = g.input;
    if (I.btn(0) && g.inventory.count('arrow')) { if (this.draw === 0) g.audio.bowDraw?.(); this.draw = Math.min(1, this.draw + dt * 1.4); }
    else if (this.draw > 0) {
      if (this.draw > 0.25) { g.inventory.remove('arrow', 1); g.combat?.shoot('arrow', this.draw); g.audio.bowRelease?.(); this.recoil = 0.5; }
      this.draw = 0;
    } else if (I.click(0)) { g.hud.toast('No arrows.'); g.audio.deny?.(); }
  }
  _fire(T) {
    const g = this.g, inv = g.inventory, need = T.ranged;
    if (!inv.count(need)) { g.audio.deny?.(); g.hud.toast(need === 'ammo' ? 'No rounds left.' : 'No flares left.'); this.recoil = 0.3; return; }
    inv.remove(need, 1);
    g.combat?.shoot(need, 1);
    this.recoil = 1; g.shake = Math.max(g.shake, need === 'ammo' ? 0.5 : 0.3);
    g.player.pitch += need === 'ammo' ? 0.035 : 0.02;
  }
  /** procedural pose: idle sway, bob, swings, draw, recoil */
  _pose(dt) {
    const g = this.g, p = g.player, I = g.input;
    this.drawT = Math.min(1, this.drawT + dt * 3.5);
    const lk = I.mouse;
    this.sway.x = damp(this.sway.x, clamp(-lk.dx * 0.0005, -0.05, 0.05), 7, dt);
    this.sway.y = damp(this.sway.y, clamp(lk.dy * 0.0005, -0.05, 0.05), 7, dt);
    const mv = Math.min(1, p.speed / 6.8) * (p.onGround ? 1 : 0.2);
    const bx = Math.cos(p.bob) * 0.016 * mv, by = Math.abs(Math.sin(p.bob)) * 0.02 * mv;
    const breathe = Math.sin(g.time * 1.6) * 0.004;
    const R = this.rig;
    R.position.set(this.sway.x + bx, this.sway.y - by + breathe - (1 - this.drawT) * 0.35 - p.land * 0.4, 0);
    R.rotation.set(this.sway.y * 2, this.sway.x * 2, bx * 2);
    // sprint: tools tilt down and in
    const run = p.sprinting ? 1 : 0;
    this._run = damp(this._run || 0, run, 6, dt);
    R.rotation.x -= this._run * 0.25; R.position.y -= this._run * 0.03;
    // swing curve: wind-up (1 -> 0.75), strike (0.75 -> 0.5), recover
    const s = this.swing;
    let e = 0, wind = 0;
    if (s > 0) {
      if (s > 0.68) wind = (1 - s) / 0.32;
      else if (s > 0.48) { wind = 1 - (0.68 - s) / 0.2 * 1.6; e = (0.68 - s) / 0.2; }
      else { e = 1 - (0.48 - s) / 0.48 * 0.9; wind = -0.6 * (s / 0.48); }
      wind = clamp(wind, -0.6, 1);
    }
    if (this.thrust) {
      R.position.z += -e * 0.35 + wind * 0.12; R.position.y += wind * 0.02;
    } else {
      // two-handed overhead/diagonal swing pivoting around the shoulders
      R.rotation.x += wind * 0.85 - e * 0.95;
      R.rotation.z += -wind * 0.35 + e * 0.5;
      R.rotation.y += -wind * 0.25 + e * 0.35;
      R.position.x += wind * 0.06 - e * 0.12; R.position.y += wind * 0.1 - e * 0.08; R.position.z += -e * 0.12;
    }
    // bow draw, recoil, eating, horn
    R.position.z += this.draw * 0.06 + this.recoil * 0.08; R.rotation.x += this.recoil * 0.22;
    if (this.eatT > 0) { const k = Math.sin(this.eatT / 1.1 * Math.PI); R.position.y += k * 0.15; R.rotation.x += k * 0.6; }
    if (this.blowT > 0) { const k = Math.min(1, Math.sin(Math.min(1, this.blowT / 2.5) * Math.PI) * 1.5); R.position.y += k * 0.12; R.rotation.x += k * 0.4; R.position.x -= k * 0.08; }
    // hand poses from the art module
    if (this.arms && !this.arms.fallback) {
      const hold = this.cur ? (this.cur === 'bow' ? 'bow' : this.cur === 'torch' || this.cur === 'lighter' ? 'torch' : this.hold === 'two' ? 'grip' : 'gripR') : 'none';
      this.arms.pose?.(hold, 1);
    }
    this.rig.visible = !p.downed && g.phase === 'play' && !g.cutscene;
  }
  /** overlay lighting follows the world */
  _light(dt) {
    const g = this.g, A = g.atmos, p = g.player;
    const day = A.out.daylight * (g.inCave ? 0.05 : 1) * (1 - A.w.dark * 0.5);
    const amb = lerp(0.05, 1.1, day) + (g.lightOn && this.cur === 'torch' ? 0.25 : 0);
    this.hemi.intensity = damp(this.hemi.intensity, amb + A.out.flash * 2, 5, dt);
    this.hemi.color.copy(A.hemi.color); this.hemi.groundColor.copy(A.hemi.groundColor);
    this.key.intensity = damp(this.key.intensity, A.sun.intensity * (g.inCave ? 0 : 0.6), 5, dt); this.key.color.copy(A.sun.color);
    const fire = p.nearFire + (g.lightOn && (this.cur === 'torch') ? 0.9 : g.lightOn && this.cur === 'lighter' ? 0.35 : 0);
    this.warm.intensity = damp(this.warm.intensity, fire * 2.2 * (0.85 + 0.15 * Math.sin(g.time * 13)), 10, dt);
    if (g.lightOn && this.cur === 'flashlight') this.warm.intensity = Math.max(this.warm.intensity, 0.4);
  }
  _carry() {
    const n = this.g.inventory?.count('log') || 0;
    if (n && !this.logMesh) {
      const m = itemModel('log'); m.traverse(c => { if (c.isMesh) c.frustumCulled = false; });
      const holder = new THREE.Group(); holder.add(m);
      m.rotation.set(0, 0, Math.PI / 2); m.position.set(0, 0, 0);
      holder.position.set(0.32, 0.12, -0.25); holder.rotation.set(0.15, 0.5, 0.25);
      this.scene.add(holder); this.logMesh = holder;
    }
    if (this.logMesh) this.logMesh.visible = n > 0 && this.rig.visible;
  }
}
