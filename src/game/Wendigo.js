/* Wendigo.js - the thing that hunts the island. Host-authoritative brain,
   everyone draws the same body from snapshots.

   It is twenty metres tall. It is not a big enemy with a lot of health: it
   is a creature that happens to be hunting you, and most of the time you
   should not see it at all. The Director decides WHEN (pacing, rarity);
   this file decides HOW.

   Encounter levels
     1 indirect   no body. Something huge moves through the forest far away:
                  footfalls you feel more than hear, a line of trees shaking,
                  birds bursting out of the canopy, a scream from the hills.
     2 distant    a silhouette on a ridge or deep between the trunks; when you
                  look away and back, it is gone. In a storm it is only there
                  for the length of a lightning flash.
     3 observe    it watches from the trees, crouched, head tilted. Walk toward
                  it or put a light on it and it is gone - fast.
     R reveal     (once) a branch snaps behind you, nothing. Later, you look up
                  and it is standing over you between the trees. It looks down.
                  Nobody moves. Then it is gone into the dark.
     4 hunt       it comes. Swipe, stomp, charge, grab-and-throw, tree throw.
                  It breaks walls, it snaps trees, it avoids firelight until it
                  is angry enough. It leaves when hurt enough, when the hunt
                  has gone on long enough, or at dawn.
     5 finale     driven by Finale.js.

   Memory: where players spend time (a heat map) and where they built
   shelters. Between encounters it visits those places - you find its tracks
   around your camp in the morning. */
import * as THREE from '../../lib/three.module.js';
import { clamp, lerp, damp, dampAng, angDiff, sstep } from '../core/Util.js';
import { GU } from '../core/Shading.js';

let WA = null;
async function art() { if (WA === null) { try { WA = await import('../art/WendigoArt.js'); } catch (e) { window.__log?.('ART wendigo: ' + e.message); WA = false; } } return WA; }
const DEFAULT_ANIMS = { swipe: { dur: 1.7, hit: 0.95 }, stomp: { dur: 1.6, hit: 0.9 }, grab: { dur: 2.2, hit: 0.8 }, throw: { dur: 2.4, hit: 1.5 }, roar: { dur: 3.0 }, hurt: { dur: 1.0 }, death: { dur: 6.0 }, lookDown: { dur: 4.0 }, emerge: { dur: 2.0 } };
const HEAT = 64;

export class WendigoAI {
  constructor(game) {
    this.g = game;
    this.pos = new THREE.Vector3(0, -500, 0); this.yaw = 0; this.speed = 0; this.tspeed = 0;
    this.mode = 'idle'; this.mt = 0; this.present = false; this.state = 'away'; this.st = 0;
    this.lookAt = null; this.target = null; this.goal = null;
    this.pain = 0; this.anger = 0; this.glow = 0.5; this.heart = 0;
    this.body = null; this.anims = DEFAULT_ANIMS;
    this.ghost = null;          // level-1 invisible walker
    this.heat = new Map();      // memory
    this.held = null;           // grabbed player / thrown tree
    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
  }
  async init() {
    const A = await art();
    if (A && A.createWendigo) {
      try { this.body = A.createWendigo(); this.anims = A.ANIMS || DEFAULT_ANIMS; } catch (e) { window.__log?.('ART wendigo: ' + e.message); }
    }
    if (!this.body) this.body = this._fallback();
    this.body.root.visible = false;
    this.body.root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this.g.scene.add(this.body.root);
  }
  _fallback() {
    const g = new THREE.Group(), m = new THREE.MeshStandardMaterial({ color: 0x15110f, roughness: 0.7 });
    const add = (geo, x, y, z, rx = 0, rz = 0) => { const k = new THREE.Mesh(geo, m); k.position.set(x, y, z); k.rotation.set(rx, 0, rz); g.add(k); return k; };
    add(new THREE.CylinderGeometry(0.5, 0.7, 9, 8), -1.2, 4.5, 0); add(new THREE.CylinderGeometry(0.5, 0.7, 9, 8), 1.2, 4.5, 0);
    add(new THREE.CylinderGeometry(2.0, 1.2, 7, 10), 0, 12.5, 0); add(new THREE.CylinderGeometry(0.35, 0.3, 12, 6), -2.8, 11, 0.6, 0.2, 0.15); add(new THREE.CylinderGeometry(0.35, 0.3, 12, 6), 2.8, 11, 0.6, 0.2, -0.15);
    const head = add(new THREE.ConeGeometry(0.9, 3.2, 8), 0, 18, 1.2, Math.PI / 2 + 0.3);
    for (const s of [-1, 1]) { add(new THREE.CylinderGeometry(0.1, 0.2, 5, 5), s * 1.6, 21, 0.6, 0, s * 0.7); add(new THREE.CylinderGeometry(0.08, 0.15, 3, 5), s * 2.8, 22.5, 0.6, 0, s * 0.2); }
    const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 1.5, 1) })); eyes.position.set(0, 18.3, 2.2); g.add(eyes);
    const handR = new THREE.Object3D(); handR.position.set(-3.2, 5.5, 1.5); g.add(handR);
    const chest = new THREE.Object3D(); chest.position.set(0, 13, 1.4); g.add(chest);
    return { root: g, animate() {}, setGlow() {}, setHeart() {}, setDissolve(v) { g.visible = v < 1; }, setVisible(v) { g.visible = v; }, handR, head, chest, footEvents: [] };
  }

  /* ================================================================ public */
  get hunting() { return this.state === 'hunt' || this.state === 'finale' && this.mode !== 'pinned'; }
  /** how strongly animals near (x,z) feel it (0..1) */
  presence(x, z) {
    if (this.present) return 1 - sstep(80, 200, Math.hypot(this.pos.x - x, this.pos.z - z));
    if (this.ghost) return 1 - sstep(60, 160, Math.hypot(this.ghost.x - x, this.ghost.z - z));
    return 0;
  }
  /** a loud noise: it may come to look (host) */
  hear(a) { this.lastNoise = { x: a.x, z: a.z, t: this.g.time, loud: a.loud || 0 }; this._remember(a.x, a.z, a.loud ? 3 : 0.5); }
  /** the Director asks for an encounter: 1 | 2 | 3 | 'reveal' | 4 ; target = player record {x,z,id,me} */
  request(level, target) {
    if (this.state !== 'away' && this.state !== 'roam') return false;
    const g = this.g;
    this.target = target; this.st = 0; this.seenT = 0; this.wasSeen = false;
    if (level === 1) return this._startIndirect(target);
    if (level === 2) return this._startDistant(target);
    if (level === 3) return this._startObserve(target);
    if (level === 'reveal') { this.state = 'revealWait'; this.st = 0; g.audio.branchSnap?.(this._behind(target, 14)); return true; }
    if (level === 4) return this._startHunt(target);
    return false;
  }

  /* ================================================================ helpers */
  _people() {
    const g = this.g, out = [];
    const P = g.player; if (!P.dead) out.push({ x: P.pos.x, y: P.pos.y, z: P.pos.z, yaw: P.yaw, pitch: P.pitch, me: true, id: g.me, downed: P.downed, inCave: g.inCave, cam: g.camera.position, lit: g.lightOn });
    for (const r of g.remotes?.list || []) out.push({ x: r.pos.x, y: r.pos.y, z: r.pos.z, yaw: r.s.yaw, pitch: r.s.pitch, id: r.id, downed: !!r.s.d, inCave: r.s.cave, lit: !!r.s.l });
    return out.filter(p => !p.inCave);
  }
  _behind(t, d) { const a = t.yaw; return { x: t.x + Math.sin(a) * d, y: t.y + 1, z: t.z + Math.cos(a) * d }; }
  /** a point at distance d from player t, at an angle offset from where they look (0 = straight ahead) */
  _around(t, d, off) { const a = t.yaw + Math.PI + off; return { x: t.x + Math.sin(a) * d, z: t.z + Math.cos(a) * d }; }
  /** is (x,y,z) on screen and not hidden for player p */
  _visibleTo(p, x, y, z, needLos = true) {
    const dx = x - p.x, dz = z - p.z, d = Math.hypot(dx, dz);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const cos = (dx * fx + dz * fz) / (d || 1);
    if (cos < 0.62) return false;
    const ey = p.y + 1.6, pitchTo = Math.atan2(y - ey, d);
    if (Math.abs(pitchTo - p.pitch) > 0.75) return false;
    if (!needLos) return true;
    return !this.g.physics.blocked({ x: p.x, y: ey, z: p.z }, { x, y, z }, { trees: true, step: 4 });
  }
  _seenBy(people, heightFrac = 0.8) {
    const top = this.pos.y + 20 * heightFrac;
    for (const p of people) {
      if (this._visibleTo(p, this.pos.x, top, this.pos.z) || this._visibleTo(p, this.pos.x, this.pos.y + 10, this.pos.z)) return p;
    }
    return null;
  }
  _ground(x, z) { return this.g.island.height(x, z); }
  _place(x, z, yaw) { this.pos.set(x, this._ground(x, z), z); this.yaw = yaw; this._show(true); }
  _show(v) { this.present = v; if (this.body) { this.body.root.visible = v; this.body.setVisible?.(v); } if (!v) { this.speed = 0; this.tspeed = 0; GU.uShake.value.w = 0; } }
  _setMode(m) { if (this.mode !== m) { this.mode = m; this.mt = 0; this._hitDone = false; } }
  _vanish() { this._show(false); this.state = 'away'; this.st = 0; this.mode = 'idle'; this.held = null; this.g.director?.encounterOver?.(); }
  _remember(x, z, w) { const k = Math.floor(x / HEAT) + ',' + Math.floor(z / HEAT); this.heat.set(k, (this.heat.get(k) || 0) + w); }
  /** the warmest remembered cell near a point */
  hotSpot() { let best = null, bw = 0; for (const [k, w] of this.heat) if (w > bw) { bw = w; best = k; } if (!best) return null; const [i, j] = best.split(',').map(Number); return { x: (i + 0.5) * HEAT, z: (j + 0.5) * HEAT, w: bw }; }

  /* ================================================================ level 1: indirect */
  _startIndirect(t) {
    // an invisible walker 200-320 m away moving across the player's view
    const side = Math.random() < 0.5 ? -1 : 1;
    const a = this._around(t, 220 + Math.random() * 100, side * (0.6 + Math.random() * 0.8));
    const dirA = t.yaw + Math.PI + side * Math.PI / 2;
    this.ghost = { x: a.x, z: a.z, dx: Math.sin(dirA), dz: Math.cos(dirA), t: 0, life: 22 + Math.random() * 10, stepT: 0, foot: 0 };
    this.state = 'indirect'; this.st = 0;
    if (Math.random() < 0.5) setTimeout(() => this.g.audio.wendigo?.('scream', { x: a.x, y: this._ground(a.x, a.z) + 18, z: a.z }, 1), 1500 + Math.random() * 5000);
    return true;
  }
  _updateIndirect(dt) {
    const G = this.ghost; if (!G) { this.state = 'away'; return; }
    G.t += dt; G.x += G.dx * 6 * dt; G.z += G.dz * 6 * dt;
    G.stepT -= dt;
    if (G.stepT <= 0) {
      G.stepT = 1.15; G.foot ^= 1;
      const y = this._ground(G.x, G.z);
      this.g.emit({ k: 'wdStep', x: G.x, y, z: G.z, f: 0.8, ghost: 1 });
      // birds burst from the canopy now and then
      if (Math.random() < 0.18) this.g.emit({ k: 'wdBirds', x: G.x, y: y + 15, z: G.z });
    }
    GU.uShake.value.set(G.x, G.z, 18, 0.5);
    if (G.t > G.life) { this.ghost = null; GU.uShake.value.w = 0; this.state = 'away'; this.g.director?.encounterOver?.(); }
  }

  /* ================================================================ level 2: distant silhouette */
  _startDistant(t) {
    const I = this.g.island;
    // prefer high ground in view: a ridge, the far side of a lake or meadow
    let best = null, bs = -1e9;
    for (let k = 0; k < 40; k++) {
      const d = 110 + Math.random() * 160, off = (Math.random() - 0.5) * 1.2;
      const p = this._around(t, d, off); if (!I.onLand(p.x, p.z)) continue;
      const h = I.height(p.x, p.z), rise = h - t.y;
      const open = 1 - I.forestAt(p.x, p.z);
      const s = rise * 0.08 + open * 2 + Math.random();
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) return false;
    this._place(best.x, best.z, Math.atan2(t.x - best.x, t.z - best.z));
    this._setMode('stand'); this.state = 'distant'; this.st = 0; this.lookAt = new THREE.Vector3(t.x, t.y + 1.7, t.z);
    this.lightningOnly = this.g.atmos.weather === 'storm';
    return true;
  }
  _updateDistant(dt, people) {
    const seen = this._seenBy(people);
    if (this.lightningOnly) this.body.root.visible = this.g.atmos.out.flash > 0.15;
    if (seen) { this.seenT += dt; if (this.seenT > 0.4) this.wasSeen = true; if (!this._stung && this.seenT > 0.6) { this._stung = true; this.g.emit({ k: 'wdSighted', level: 2 }); } }
    // gone the moment nobody is looking at it any more (or after a while)
    if ((this.wasSeen && !seen) || this.st > 25) { this._stung = false; this._vanish(); }
  }

  /* ================================================================ level 3: observe */
  _startObserve(t) {
    const I = this.g.island;
    let best = null;
    for (let k = 0; k < 40 && !best; k++) {
      const d = 45 + Math.random() * 35, off = (Math.random() - 0.5) * 2.4;
      const p = this._around(t, d, off);
      if (!I.onLand(p.x, p.z) || I.forestAt(p.x, p.z) < 0.4) continue;
      best = p;
    }
    if (!best) return false;
    this._place(best.x, best.z, Math.atan2(t.x - best.x, t.z - best.z));
    this._setMode(Math.random() < 0.5 ? 'crouch' : 'stand'); this.state = 'observe'; this.st = 0;
    return true;
  }
  _updateObserve(dt, people) {
    const t = this._nearest(people); if (!t) return this._vanish();
    this.lookAt = this._v.set(t.x, t.y + 1.6, t.z).clone();
    this.yaw = dampAng(this.yaw, Math.atan2(t.x - this.pos.x, t.z - this.pos.z), 0.8, dt);
    const d = Math.hypot(t.x - this.pos.x, t.z - this.pos.z);
    const seen = this._seenBy(people, 0.6);
    if (seen) { this.seenT += dt; if (!this._stung && this.seenT > 0.8) { this._stung = true; this.g.emit({ k: 'wdSighted', level: 3 }); } }
    if (this.st % 6 < dt) this.g.emit({ k: 'wdSound', s: 'breath', x: this.pos.x, y: this.pos.y + 17, z: this.pos.z, p: 0.6 });
    const lit = seen && seen.lit && d < 50;
    if (d < 30 || lit || this.st > 40 || (this.seenT > 6)) { this._stung = false; this._bolt(t); }
  }
  /** it turns and is gone - very fast, away from t */
  _bolt(t) {
    this.state = 'bolt'; this.st = 0;
    const a = Math.atan2(this.pos.x - t.x, this.pos.z - t.z) + (Math.random() - 0.5) * 0.6;
    this.goal = { x: this.pos.x + Math.sin(a) * 140, z: this.pos.z + Math.cos(a) * 140 };
    this._setMode('run'); this.tspeed = 20;
  }
  _updateBolt(dt, people) {
    this._steer(dt, this.goal, 6);
    const seen = this._seenBy(people);
    if ((!seen && this.st > 1.2) || this.st > 7) this._vanish();
  }

  /* ================================================================ the first reveal */
  _updateRevealWait(dt, people) {
    // 6-12 s after the branch snap, it is standing over the target
    const t = this.target && people.find(p => p.id === this.target.id) || this._nearest(people);
    if (!t) return this._vanish();
    if (this.st < 6 + Math.random() * 0.01) return;
    const p = this._around(t, 11, (Math.random() - 0.5) * 0.9);
    this._place(p.x, p.z, Math.atan2(t.x - p.x, t.z - p.z));
    this._setMode('stand'); this.state = 'reveal'; this.st = 0; this.lookAt = new THREE.Vector3(t.x, t.y + 1.7, t.z);
    this.g.emit({ k: 'wdSound', s: 'breath', x: this.pos.x, y: this.pos.y + 18, z: this.pos.z, p: 1 });
  }
  _updateReveal(dt, people) {
    const t = this._nearest(people); if (!t) return this._vanish();
    this.lookAt = new THREE.Vector3(t.x, t.y + 1.7, t.z);
    const seen = this._seenBy(people, 0.9);
    if (seen && !this.wasSeen) { this.wasSeen = true; this.seenAt = this.st; this._setMode('lookDown'); this.g.emit({ k: 'wdSighted', level: 'reveal' }); this.g.W.flags.revealed = 1; }
    if (this.wasSeen && this.st - this.seenAt > 5.5) { this._bolt(t); this.g.emit({ k: 'wdSound', s: 'growl', x: this.pos.x, y: this.pos.y + 16, z: this.pos.z, p: 0.8 }); }
    if (!this.wasSeen && this.st > 45) this._vanish();
  }

  /* ================================================================ level 4: the hunt */
  _startHunt(t) {
    const p = this._around(t, 110, Math.PI + (Math.random() - 0.5));   // starts behind them
    this._place(p.x, p.z, Math.atan2(t.x - p.x, t.z - p.z));
    this.state = 'hunt'; this.st = 0; this.pain = 0; this.anger = 0; this.attackCool = 4; this.huntLen = 70 + Math.random() * 40;
    this._setMode('stalk'); this.tspeed = 4;
    this.g.emit({ k: 'wdHunt', on: 1 });
    this.g.emit({ k: 'wdSound', s: 'scream', x: this.pos.x, y: this.pos.y + 18, z: this.pos.z, p: 1 });
    return true;
  }
  _nearest(people, filter) { let best = null, bd = 1e9; for (const p of people) { if (filter && !filter(p)) continue; const d = Math.hypot(p.x - this.pos.x, p.z - this.pos.z); if (d < bd) { bd = d; best = p; } } return best; }
  _alone(p, people) { return people.every(o => o === p || Math.hypot(o.x - p.x, o.z - p.z) > 25); }
  _updateHunt(dt, people) {
    const g = this.g;
    const t = this._nearest(people, p => !p.downed) || this._nearest(people);
    if (!t) return this._leave();
    const dx = t.x - this.pos.x, dz = t.z - this.pos.z, d = Math.hypot(dx, dz);
    this.lookAt = new THREE.Vector3(t.x, t.y + 1.5, t.z);
    this.attackCool -= dt;
    // finished?
    const dawn = g.atmos.out.daylight > 0.5 && !g.finale?.active;
    if (this.pain > 100 || this.st > this.huntLen || dawn) return this._leave();
    // a one-shot attack in progress
    const A = this.anims[this.mode];
    if (A && A.dur && ['swipe', 'stomp', 'grab', 'throw', 'roar', 'hurt'].includes(this.mode)) {
      this.tspeed = 0;
      if (A.hit && !this._hitDone && this.mt >= A.hit) { this._hitDone = true; this._landAttack(this.mode, t, people); }
      if (this.mt >= A.dur) this._setMode('walk');
      return;
    }
    // firelight: it hesitates at the edge, circles, roars - unless angry
    const fire = g.combat?.fireNear(t.x, t.z, 12) || 0;
    if (fire > 0.3 && this.anger < 60) {
      if (d < 35) { const a = Math.atan2(this.pos.x - t.x, this.pos.z - t.z) + dt * 0.4; this.goal = { x: t.x + Math.sin(a) * 34, z: t.z + Math.cos(a) * 34 }; this._setMode('stalk'); this.tspeed = 3.5; this._steer(dt, this.goal, 2); this.anger += dt * 4; if (Math.random() < dt * 0.15) { this._setMode('roar'); this._roar(); } return; }
    }
    // shelters in the way get smashed
    const piece = g.build?.nearest(this.pos.x + Math.sin(this.yaw) * 6, this.pos.z + Math.cos(this.yaw) * 6, 7);
    if (piece && this.attackCool <= 0 && d < 40) { this._setMode('swipe'); this.attackCool = 3; this._swipeTarget = piece; return; }
    // choose an attack
    if (this.attackCool <= 0) {
      if (d < 9) {
        const alone = this._alone(t, people);
        this._setMode(alone && Math.random() < 0.45 ? 'grab' : Math.random() < 0.55 ? 'swipe' : 'stomp');
        this.attackCool = 2.4 + Math.random() * 1.5; return;
      }
      if (d > 22 && d < 60 && Math.random() < 0.012) { const tree = this._smallTree(); if (tree) { this._throwTree = tree; this._setMode('throw'); this.attackCool = 4; return; } }
      if (d > 30 && d < 90 && Math.random() < 0.01) { this.charging = 2.6; this._setMode('run'); }
    }
    // move: stalk while far and unseen, run when close or charging
    const seen = this._seenBy(people);
    if (this.charging > 0) { this.charging -= dt; this.tspeed = 22; this._setMode('run'); this._smashTrees(); }
    else if (d > 60 && !seen) { this.tspeed = 6; this._setMode('walk'); }
    else if (d > 12) { this.tspeed = seen ? 14 : 9; this._setMode(this.tspeed > 10 ? 'run' : 'walk'); }
    else { this.tspeed = 2; this._setMode('stalk'); }
    this._steer(dt, { x: t.x, z: t.z }, this.charging > 0 ? 1.2 : 2.5);
    this._smashTrees(true);
  }
  _roar() { this.g.emit({ k: 'wdSound', s: 'roar', x: this.pos.x, y: this.pos.y + 18, z: this.pos.z, p: 1 }); }
  _leave() {
    const g = this.g;
    this.state = 'leave'; this.st = 0;
    const t = this._nearest(this._people()) || { x: 0, z: 0 };
    const a = Math.atan2(this.pos.x - t.x, this.pos.z - t.z);
    this.goal = { x: this.pos.x + Math.sin(a) * 200, z: this.pos.z + Math.cos(a) * 200 };
    this._setMode('run'); this.tspeed = 16;
    g.emit({ k: 'wdHunt', on: 0 });
    if (this.pain > 100) g.emit({ k: 'wdSound', s: 'hurt', x: this.pos.x, y: this.pos.y + 18, z: this.pos.z, p: 1 });
  }
  _updateLeave(dt, people) { this._steer(dt, this.goal, 4); this._smashTrees(); const seen = this._seenBy(people); if ((!seen && this.st > 3) || this.st > 12) this._vanish(); }

  /** the moment a blow lands */
  _landAttack(kind, t, people) {
    const g = this.g, hx = this.pos.x + Math.sin(this.yaw) * 7, hz = this.pos.z + Math.cos(this.yaw) * 7;
    if (kind === 'swipe') {
      g.emit({ k: 'wdSound', s: 'screech', x: hx, y: this.pos.y + 6, z: hz, p: 1 });
      if (this._swipeTarget) { g.build?.damageNear(this._swipeTarget.x, this._swipeTarget.z, 4.5, 260, true); this._swipeTarget = null; }
      for (const p of people) { const d = Math.hypot(p.x - hx, p.z - hz); if (d < 6.5) this._hitPlayer(p, 45, 14, 6); }
      this._snapNear(hx, hz, 6, 0.45);
      g.build?.damageNear(hx, hz, 5, 180, true);
    } else if (kind === 'stomp') {
      const fx = this.pos.x + Math.sin(this.yaw) * 4, fz = this.pos.z + Math.cos(this.yaw) * 4;
      g.emit({ k: 'wdStep', x: fx, y: this._ground(fx, fz), z: fz, f: 1.6, stomp: 1 });
      for (const p of people) { const d = Math.hypot(p.x - fx, p.z - fz); if (d < 14) this._hitPlayer(p, d < 5 ? 35 : 12, (14 - d) * 0.8, 4 + (14 - d) * 0.3, true); }
      g.build?.damageNear(fx, fz, 7, 140, true);
    } else if (kind === 'grab') {
      const p = this._nearest(people); if (!p || Math.hypot(p.x - hx, p.z - hz) > 8) return;
      g.emit({ k: 'wdGrab', id: p.id, yaw: this.yaw });
    } else if (kind === 'throw' && this._throwTree) {
      const tr = this._throwTree; this._throwTree = null;
      const tt = this._nearest(people) || t;
      g.emit({ k: 'wdThrow', id: tr.id, from: { x: this.pos.x, y: this.pos.y + 14, z: this.pos.z }, to: { x: tt.x, y: tt.y, z: tt.z } });
    }
  }
  _hitPlayer(p, dmg, push, up, stun) {
    const g = this.g, dx = p.x - this.pos.x, dz = p.z - this.pos.z, d = Math.hypot(dx, dz) || 1;
    g.emit({ k: 'wdHit', id: p.id, dmg, vx: dx / d * push, vy: up, vz: dz / d * push, stun: stun ? 1.2 : 0.8, x: this.pos.x, z: this.pos.z });
  }
  /** small trees within reach of its body snap as it pushes through (charges, retreats) */
  _smashTrees(light) {
    const g = this.g; this._smT = (this._smT || 0) - 0.016; if (this._smT > 0) return; this._smT = light ? 0.4 : 0.15;
    const fx = this.pos.x + Math.sin(this.yaw) * 4, fz = this.pos.z + Math.cos(this.yaw) * 4;
    this._snapNear(fx, fz, light ? 3.5 : 6, light ? 0.22 : 0.4);
  }
  _snapNear(x, z, r, maxR) {
    const g = this.g;
    g.forest.near(x, z, r, (t) => {
      if (t.state !== 0 || t.r > maxR) return;
      g.emit({ k: 'wdSnap', id: t.id, a: this.yaw + (Math.random() - 0.5) * 1.2 });
    });
  }
  _smallTree() { let best = null; this.g.forest.near(this.pos.x, this.pos.z, 14, (t) => { if (!best && t.state === 0 && t.r < 0.35 && t.h > 5) best = t; }); return best; }
  _steer(dt, goal, turn) {
    const dx = goal.x - this.pos.x, dz = goal.z - this.pos.z;
    this.yaw = dampAng(this.yaw, Math.atan2(dx, dz), turn, dt);
  }

  /* ================================================================ damage */
  targets() {
    if (!this.present || this.state === 'distant') return [];
    // legs and body as one tall cylinder; the chest is the weak spot (only in the finale)
    return [{ id: 'wendigo', x: this.pos.x, y: this.pos.y, z: this.pos.z, r: 2.6, h: 18, weak: this.state === 'finale' ? [0.55, 0.75] : null, blood: false, material: 'flesh' }];
  }
  hurt(id, dmg, info) {
    const g = this.g;
    if (this.state === 'finale') { g.finale?.wendigoHit(dmg, info); return; }
    let k = 0.25;
    if (info.fire) k = 3; else if (info.kind === 'flare') k = 4; else if (info.kind === 'bullet') k = 0.6; else if (info.ember) k = 1.5;
    this.pain += dmg * k * 0.25; this.anger += dmg * 0.4;
    g.emit({ k: 'wdSound', s: 'hurt', x: this.pos.x, y: this.pos.y + 16, z: this.pos.z, p: Math.min(1, dmg / 60) });
    if (this.state === 'observe' || this.state === 'distant' || this.state === 'reveal') { this._bolt(this._nearest(this._people()) || this.pos); return; }
    if (this.state === 'hunt' && (info.fire || info.kind === 'flare') && this.mode !== 'hurt') this._setMode('hurt');
  }

  /* ================================================================ frame */
  update(dt) {
    const g = this.g;
    if (g.phase !== 'play' && g.phase !== 'end') return;
    if (g.isHost) this._brain(dt);
    this._body(dt);
  }
  _brain(dt) {
    const people = this._people();
    this.st += dt;
    // memory: remember where people are
    this._memT = (this._memT || 0) - dt;
    if (this._memT <= 0) { this._memT = 5; for (const p of people) this._remember(p.x, p.z, 1); for (const p of this.g.build?.pieces.values() || []) if (p.kind === 'bed' || p.fire) this._remember(p.x, p.z, 0.2); }
    switch (this.state) {
      case 'indirect': this._updateIndirect(dt); break;
      case 'distant': this._updateDistant(dt, people); break;
      case 'observe': this._updateObserve(dt, people); break;
      case 'bolt': this._updateBolt(dt, people); break;
      case 'revealWait': this._updateRevealWait(dt, people); break;
      case 'reveal': this._updateReveal(dt, people); break;
      case 'hunt': this._updateHunt(dt, people); break;
      case 'leave': this._updateLeave(dt, people); break;
      case 'finale': this.g.finale?.wendigoBrain(dt, people); break;
    }
    // move
    if (this.present) {
      this.speed = damp(this.speed, this.tspeed, 2.5, dt);
      const nx = this.pos.x + Math.sin(this.yaw) * this.speed * dt, nz = this.pos.z + Math.cos(this.yaw) * this.speed * dt;
      const r = Math.hypot(nx, nz);
      if (r < 960) { this.pos.x = nx; this.pos.z = nz; }
      this.pos.y = damp(this.pos.y, this._ground(this.pos.x, this.pos.z), 6, dt);
    }
  }
  /** both host and clients: animate the body and its effect on the world */
  _body(dt) {
    const g = this.g, B = this.body; if (!B) return;
    this.mt += dt;
    if (!this.present) { B.root.visible = false; return; }
    B.root.position.copy(this.pos); B.root.rotation.y = this.yaw;
    B.setGlow?.(this.glow); B.setHeart?.(this.heart);
    B.animate?.(dt, { mode: this.mode, t: this.mt, speed: this.speed, lookAt: this.lookAt, ground: (x, z) => g.island.height(x, z) });
    // the forest reacts: trees around it shake
    GU.uShake.value.set(this.pos.x, this.pos.z, 13 + this.speed * 0.4, clamp(0.25 + this.speed / 12, 0, 1.4));
    // footfalls
    if (B.footEvents?.length) {
      for (const f of B.footEvents) this._footfall(f.pos.x, f.pos.y, f.pos.z, f.force);
      B.footEvents.length = 0;
    } else if (!B.footEvents && this.speed > 0.5) {
      this._ft = (this._ft || 0) - dt * this.speed; if (this._ft <= 0) { this._ft = 9; this._footfall(this.pos.x, this.pos.y, this.pos.z, Math.min(1, this.speed / 15)); }
    }
    // a grabbed player rides in its hand
    if (this.held === g.me && B.handR) {
      B.handR.getWorldPosition(this._w);
      g.player.pos.set(this._w.x, this._w.y - 1, this._w.z); g.player.vel.set(0, 0, 0);
    }
  }
  _footfall(x, y, z, force) {
    const g = this.g;
    g.audio.wendigo?.('step', { x, y, z }, force);
    const d = Math.hypot(x - g.player.pos.x, z - g.player.pos.z);
    g.shake = Math.max(g.shake, clamp(1 - d / 140, 0, 1) * 0.5 * force);
    if (d < 120) g.fx?.dust({ x, y, z }, Math.ceil(5 * force), [0.4, 0.36, 0.3], 2.5, 2);
    g.fx?.footprint(x, z, this.yaw, true);
    // leaves shaken loose
    if (g.fx && d < 80) for (let i = 0; i < 6; i++) g.fx.soft.spawn(g.fx._p0({ x: x + (Math.random() - 0.5) * 16, y: y + 10 + Math.random() * 12, z: z + (Math.random() - 0.5) * 16, vy: -1, drag: 2, g: 0.6, life: 7, s0: 0.08, s1: 0.08, r: 0.3, gg: 0.32, b: 0.12, a: 0.9, spin: 3, soft: 0.1, wind: 2, floor: g.island.height(x, z) + 0.02 }));
  }

  /* ================================================================ events (everyone) */
  onEvent(e) {
    const g = this.g, p = g.player;
    switch (e.k) {
      case 'wdStep': if (e.ghost || !this.present || !g.isHost) this._footfall(e.x, e.y, e.z, e.f); if (e.stomp) { g.fx?.dust(e, 30, [0.4, 0.35, 0.28], 4, 6); g.audio.wendigo?.('step', e, 1); } if (e.ghost) GU.uShake.value.set(e.x, e.z, 18, 0.5); break;
      case 'wdBirds': g.audio.birdFlock?.(e, 10); g.wildlife?.scare(e, 120); this._birdBurst(e); break;
      case 'wdSound': g.audio.wendigo?.(e.s, e, e.p); break;
      case 'wdSighted': g.director?.onSighted?.(e.level); break;
      case 'wdHunt': g.director?.onHunt?.(e.on); break;
      case 'wdSnap': g.chop?.fall(e.id, e.a, { snap: true }); g.audio.wendigo?.('snap', g.forest.get(e.id) || this.pos, 1); break;
      case 'wdHit': if (e.id === g.me) { p.hurt(e.dmg, { x: e.x, z: e.z }, 'wendigo'); p.launch(e.vx, e.vy, e.vz, e.stun); g.hud.hitFrom?.(e.x, e.z); g.shake = 1; } break;
      case 'wdGrab': this._grab(e); break;
      case 'wdThrow': this._throwFx(e); break;
    }
  }
  _birdBurst(e) {
    const g = this.g; if (!g.fx) return;
    for (let i = 0; i < 24; i++) g.fx.soft.spawn(g.fx._p0({ x: e.x + (Math.random() - 0.5) * 20, y: e.y + Math.random() * 8, z: e.z + (Math.random() - 0.5) * 20, vx: (Math.random() - 0.5) * 8, vy: 4 + Math.random() * 4, vz: (Math.random() - 0.5) * 8, drag: 0.3, life: 5, s0: 0.25, s1: 0.25, r: 0.05, gg: 0.05, b: 0.06, a: 1, soft: 0.2 }));
  }
  _grab(e) {
    const g = this.g;
    this.held = e.id;
    g.audio.wendigo?.('roar', this.pos, 0.8);
    if (e.id === g.me) { g.player.stunT = 3; g.post.u.fear.value = 1; g.cutscene = null; }
    setTimeout(() => {
      // thrown far from the others
      if (this.held === g.me) {
        const a = e.yaw + (Math.random() < 0.5 ? 1 : -1) * 1.2;
        g.player.launch(Math.sin(a) * 16, 9, Math.cos(a) * 16, 2.2);
        g.player.hurt(30, this.pos, 'wendigo');
      }
      this.held = null;
    }, 1600);
  }
  _throwFx(e) {
    const g = this.g, t = g.forest.get(e.id); if (!t) return;
    g.chop?.fall(e.id, Math.atan2(e.to.x - t.x, e.to.z - t.z), { snap: true });
    g.audio.wendigo?.('snap', t, 1);
    // a flying log toward the target
    const len = Math.min(8, t.h * 0.6);
    const log = new THREE.Mesh(new THREE.CylinderGeometry(t.r * 0.8, t.r, len, 8), new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.9 }));
    log.castShadow = true; g.scene.add(log);
    const from = new THREE.Vector3(e.from.x, e.from.y, e.from.z), to = new THREE.Vector3(e.to.x, e.to.y + 0.5, e.to.z);
    const dur = Math.max(0.9, from.distanceTo(to) / 26);
    let t0 = 0;
    const step = () => {
      t0 += 0.016; const k = Math.min(1, t0 / dur);
      log.position.lerpVectors(from, to, k); log.position.y += Math.sin(k * Math.PI) * 10;
      log.rotation.x += 0.15; log.rotation.z += 0.07;
      if (k < 1) requestAnimationFrame(step);
      else {
        g.audio.treeImpact?.(to, 0.6); g.fx?.dust(to, 18, [0.42, 0.36, 0.28], 2, 3);
        const d = g.player.pos.distanceTo(to);
        if (d < 3.5) { g.player.hurt(50, from, 'wendigo'); g.player.launch((g.player.pos.x - to.x) * 2, 4, (g.player.pos.z - to.z) * 2, 1.2); }
        g.shake = Math.max(g.shake, clamp(1 - d / 40, 0, 1) * 0.8);
        setTimeout(() => log.removeFromParent(), 8000);
      }
    };
    step();
  }
  /* ================================================================ network */
  snapshot() { return this.present ? [1, +this.pos.x.toFixed(2), +this.pos.y.toFixed(2), +this.pos.z.toFixed(2), +this.yaw.toFixed(3), this.mode, +this.speed.toFixed(2), this.lookAt ? [+this.lookAt.x.toFixed(1), +this.lookAt.y.toFixed(1), +this.lookAt.z.toFixed(1)] : null, +this.glow.toFixed(2), +this.heart.toFixed(2), this.state, this.held] : [0, this.state]; }
  applySnapshot(s) {
    if (!s[0]) { if (this.present) this._show(false); this.state = s[1]; return; }
    if (!this.present) { this._show(true); this.pos.set(s[1], s[2], s[3]); }
    this._tgt = { x: s[1], y: s[2], z: s[3], yaw: s[4] };
    this.pos.x = lerp(this.pos.x, s[1], 0.4); this.pos.y = lerp(this.pos.y, s[2], 0.4); this.pos.z = lerp(this.pos.z, s[3], 0.4);
    this.yaw = this.yaw + angDiff(this.yaw, s[4]) * 0.5;
    if (s[5] !== this.mode) { this.mode = s[5]; this.mt = 0; }
    this.speed = s[6]; this.lookAt = s[7] ? new THREE.Vector3(...s[7]) : null; this.glow = s[8]; this.heart = s[9]; this.state = s[10]; this.held = s[11];
  }
  save(W) { W.memory = [...this.heat].slice(-200); }
  begin(W) { this.heat = new Map(W.memory || []); this._show(false); this.state = 'away'; }
}
