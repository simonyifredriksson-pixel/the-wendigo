/* Director.js - pacing. It decides when the island is quiet and when it is not.

   The rhythm it aims for:
     CALM -> CURIOSITY -> UNEASE -> CALM -> SUSPENSE -> EXPLORATION -> FEAR -> CALM -> DANGER -> RELIEF
   never  SCARY -> SCARY -> SCARY -> JUMPSCARE.

   intensity   rises with every event and encounter, decays slowly; nothing
               new happens while it is high (players need the downtime).
   menace      how far the island has escalated (days survived, relics
               taken, the reveal) - unlocks the bigger encounters.

   HOST: the Wendigo's encounters, at most one big thing per night:
     night 1   indirect only (sounds, shaking trees, birds)
     night 2+  distant sightings, the first footprints around the camp
     night 3+  the REVEAL (once), observation
     later     hunts (rare; more likely as menace grows)
   LOCAL (each player gets their own, so co-op players compare stories):
     silence (the forest stops), a branch snapping behind you, footsteps that
     stop when you do, wooden knocks, a distant human scream, a bird call
     far away... then the same call right behind you, your friend's name
     from the wrong direction (only when you are alone, rarely), a figure at
     the edge of your firelight that is gone when you turn, eyes in the dark.
   CAMP: while everybody is away at night, the camp is visited - a door
     left open, logs scattered, enormous tracks circling the shelter. */
import * as THREE from '../../lib/three.module.js';
import { clamp, lerp, damp, sstep } from '../core/Util.js';

const LOCAL = {
  silence:   { w: 2.0, cool: 140, cost: 1.0, night: 0.3 },
  branch:    { w: 3.0, cool: 45, cost: 0.4 },
  footsteps: { w: 2.0, cool: 90, cost: 1.0, night: 0.5 },
  knock:     { w: 1.2, cool: 160, cost: 0.8, night: 0.6 },
  scream:    { w: 1.0, cool: 220, cost: 1.0, night: 0.6 },
  mimic:     { w: 1.4, cool: 260, cost: 1.4, night: 0.5 },
  name:      { w: 1.0, cool: 600, cost: 2.0, night: 0.6, alone: true, coop: true },
  firelight: { w: 1.4, cool: 300, cost: 2.0, night: 0.7, fire: true },
  eyes:      { w: 1.8, cool: 120, cost: 1.0, night: 0.7 },
};

export class Director {
  constructor(game) {
    this.g = game;
    this.intensity = 0; this.budget = 1; this.cool = {}; this.t = 0; this.next = 40;
    this.silence = 0; this.silenceHold = 0; this.remoteSilence = 0; this.fear = 0; this.tension = 0;
    this.nightPlan = null; this.lastNight = -1; this.enabled = true;
    this.fig = null; this.eyes = null; this.mimicPend = null;
    this._v = new THREE.Vector3();
  }
  get menace() {
    const W = this.g.W; if (!W) return 0;
    const relics = Object.keys(W.relics || {}).length;
    return clamp((this.g.atmos.day - 1) * 0.14 + relics * 0.15 + (W.flags.revealed ? 0.1 : 0) + (W.flags.knowsSpear ? 0.1 : 0), 0, 1);
  }
  noise(p, loud) { this.intensity = Math.min(1, this.intensity + loud * 0.05); }
  onSighted(level) {
    const g = this.g;
    this.intensity = Math.min(1, this.intensity + (level === 'reveal' ? 0.9 : level === 3 ? 0.5 : 0.35));
    g.W.stats.seen = (g.W.stats.seen || 0) + 1;
    g.audio.stinger?.(level === 'reveal' ? 'reveal' : 'dread');
    if (level === 'reveal') { this.silence = 1; this.silenceHold = 12; g.post.u.fear.value = 1; }
    g.story?.onSighted?.(level);
  }
  onHunt(on) { this.hunt = !!on; if (on) { this.intensity = 1; this.g.audio.setChase?.(true); } else { this.g.audio.setChase?.(false); this.relief = 25; this.g.audio.stinger?.('safe'); } }
  encounterOver() { this.intensity = Math.min(1, this.intensity + 0.15); }

  /* ================================================================ frame */
  update(dt) {
    const g = this.g; if (g.phase !== 'play') return;
    this.t += dt;
    const A = g.atmos.out, W = g.wendigo;
    // decay
    this.intensity = Math.max(0, this.intensity - dt * 0.006);
    this.relief = Math.max(0, (this.relief || 0) - dt);
    this.silenceHold -= dt;
    if (this.silenceHold <= 0) this.silence = Math.max(0, this.silence - dt * 0.2);
    // the forest goes quiet when it is near
    const near = W?.presence?.(g.player.pos.x, g.player.pos.z) || 0;
    const sil = Math.max(this.silence, this.remoteSilence * 0.5, near * 0.9, W?.hunting ? 0.6 : 0);
    g.atmos.silence = sil;
    // fear on screen: its presence, the hunt, being low on health in the dark
    const wd = W?.present ? Math.hypot(W.pos.x - g.player.pos.x, W.pos.z - g.player.pos.z) : 1e9;
    const close = W?.present ? clamp(1 - wd / 90, 0, 1) : 0;
    this.fear = damp(this.fear, Math.max(close, W?.hunting ? 0.55 : 0, g.player.health < 30 ? 0.35 : 0), 2, dt);
    g.post.u.fear.value = Math.max(this.fear, g.post.u.fear.value * Math.exp(-dt * 0.8));
    g.post.u.pulse.value = this.fear > 0.4 ? Math.max(0, Math.sin(g.time * (4 + this.fear * 4))) * this.fear * 0.5 : 0;
    this.tension = damp(this.tension, Math.max(close * 0.9, A.night * 0.25 * this.menace, this.intensity * 0.4), 0.5, dt);
    g.audio.setTension?.(this.tension);
    g.audio.heartbeat?.(this.fear > 0.35 ? this.fear : 0);
    this._audioEnv(dt, sil);
    this._figure(dt); this._eyes(dt); this._mimic(dt);
    if (!this.enabled || g.cutscene || g.finale?.active) return;
    if (g.isHost) this._hostPlan(dt, A);
    this._local(dt, A);
  }
  _audioEnv(dt, sil) {
    const g = this.g, A = g.atmos.out, p = g.player.pos, I = g.island;
    this._envT = (this._envT || 0) - dt; if (this._envT > 0) return; this._envT = 0.25;
    const rv = I.riverDist(p.x, p.z), lake = I.lakes.reduce((m, L) => Math.max(m, 1 - sstep(L.r, L.r + 60, Math.hypot(p.x - L.x, p.z - L.z))), 0);
    g.audio.setEnv?.({
      daylight: g.inCave ? 0 : A.daylight, dusk: A.dusk, night: A.night, wind: g.inCave ? 0 : A.wind, rain: g.inCave ? 0 : A.rain, storm: g.atmos.weather === 'storm' ? 1 : 0,
      water: Math.max(rv.p ? 1 - sstep(10, 70, rv.d) : 0, lake), ocean: 1 - sstep(700, 820, Math.hypot(p.x, p.z)), cave: g.inCave ? 1 : 0,
      fire: g.player.nearFire, silence: sil, menace: this.tension, underwater: g.player.underwater ? 1 : 0, height: sstep(120, 220, p.y),
    });
    g.audio.setSpace?.(g.inCave ? 'cave' : g.player.inShelter ? 'interior' : 'outdoor');
  }

  /* ================================================================ host: the Wendigo's schedule */
  _hostPlan(dt, A) {
    const g = this.g, W = g.wendigo; if (!W) return;
    const night = A.night > 0.55, day = g.atmos.day;
    // a new night: decide what this night holds
    if (night && this.lastNight !== day) {
      this.lastNight = day;
      const m = this.menace, plan = [];
      plan.push({ lvl: 1, at: 40 + Math.random() * 60 });
      if (day >= 2 && Math.random() < 0.7) plan.push({ lvl: 2, at: 120 + Math.random() * 120 });
      if (day >= 2) plan.push({ camp: true, at: 30 });
      if (day >= 3 && !g.W.flags.revealed) plan.push({ lvl: 'reveal', at: 150 + Math.random() * 100 });
      else if (day >= 3 && Math.random() < 0.6) plan.push({ lvl: 3, at: 100 + Math.random() * 150 });
      if (day >= 4 && g.W.flags.revealed && Math.random() < 0.25 + m * 0.45) plan.push({ lvl: 4, at: 200 + Math.random() * 150 });
      this.nightPlan = { t: 0, items: plan };
    }
    if (!night) { this.nightPlan = null; if (A.dusk > 0.3 && Math.random() < dt / 600 && g.atmos.day >= 2) this._tryEncounter(1); return; }
    const P = this.nightPlan; if (!P) return;
    P.t += dt;
    for (const it of P.items) {
      if (it.done || P.t < it.at) continue;
      if (W.state !== 'away' || this.intensity > 0.75 || this.relief > 0) { it.at += 20; continue; }
      it.done = true;
      if (it.camp) this._visitCamp(); else this._tryEncounter(it.lvl);
    }
  }
  _tryEncounter(lvl) {
    const g = this.g;
    // pick the most isolated player (the one away from the others, or outside the firelight)
    const people = g.wendigo._people(); if (!people.length) return;
    let best = people[0], bs = -1;
    for (const p of people) { const iso = Math.min(...people.filter(o => o !== p).map(o => Math.hypot(o.x - p.x, o.z - p.z)), 200); const fire = g.combat?.fireNear(p.x, p.z, 10) || 0; const s = iso - fire * 50 + Math.random() * 20; if (s > bs) { bs = s; best = p; } }
    if (g.wendigo.request(lvl, best)) this.intensity = Math.min(1, this.intensity + 0.2);
  }
  /** while everyone is away from camp at night: things are moved, tracks circle the shelter */
  _visitCamp() {
    const g = this.g, B = g.build; if (!B || !B.pieces.size) return;
    const bed = [...B.pieces.values()].find(p => p.kind === 'bed' || p.fire) || [...B.pieces.values()][0];
    const people = g.wendigo._people();
    if (people.some(p => Math.hypot(p.x - bed.x, p.z - bed.z) < 70)) { setTimeout(() => this._visitCamp(), 60000); return; }
    g.emit({ k: 'campVisit', x: bed.x, z: bed.z });
    for (const p of B.pieces.values()) if (p.doorObj && Math.hypot(p.x - bed.x, p.z - bed.z) < 20 && !p.open) g.act({ k: 'door', id: p.id });
    for (const p of B.pieces.values()) if (p.fire?.lit && Math.hypot(p.x - bed.x, p.z - bed.z) < 20) g.act({ k: 'fire', id: p.id, op: 'feed', s: -9999 });
  }
  onEvent(e) {
    const g = this.g;
    if (e.k === 'campVisit') {
      // a ring of enormous tracks around the shelter
      const n = 14, r = 13;
      for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; g.fx?.footprint(e.x + Math.cos(a) * r, e.z + Math.sin(a) * r, -a, true, 1500); }
      g.W.flags.campVisited = (g.W.flags.campVisited || 0) + 1;
      g.story?.onCampVisited?.();
    }
  }

  /* ================================================================ local scares */
  _local(dt, A) {
    const g = this.g;
    if (this.hunt || g.wendigo?.present) return;
    this.budget = Math.min(4, this.budget + dt * 0.01 * (0.4 + A.night));
    this.next -= dt;
    if (this.next > 0) return;
    this.next = 35 + Math.random() * 60 * (1.2 - A.night * 0.6);
    if (this.intensity > 0.6 || this.relief > 0) return;
    const alone = !(g.remotes?.list || []).some(r => r.pos.distanceTo(g.player.pos) < 50);
    const coop = (g.remotes?.list || []).length > 0;
    const fire = g.player.nearFire > 0.15;
    const opts = Object.entries(LOCAL).filter(([k, o]) =>
      (this.cool[k] ?? -1e9) < this.t - o.cool && o.cost <= this.budget && (!o.night || A.night >= o.night) &&
      (!o.alone || alone) && (!o.coop || coop) && (!o.fire || fire) && (k !== 'mimic' || !g.inCave));
    if (!opts.length) return;
    let tot = 0; for (const [, o] of opts) tot += o.w;
    let r = Math.random() * tot, pick = opts[0][0];
    for (const [k, o] of opts) { r -= o.w; if (r <= 0) { pick = k; break; } }
    if (this.fire(pick)) { this.cool[pick] = this.t; this.budget -= LOCAL[pick].cost; this.intensity = Math.min(1, this.intensity + LOCAL[pick].cost * 0.12); }
  }
  /** a point around the player: ahead (+1) / behind (-1) / either (0), d metres away */
  _spot(dir, dmin, dmax) {
    const p = this.g.player, f = p.forward, d = dmin + Math.random() * (dmax - dmin);
    let a = Math.atan2(f.x, f.z) + (dir < 0 ? Math.PI : 0) + (Math.random() - 0.5) * (dir === 0 ? 6.28 : 1.0);
    const x = p.pos.x + Math.sin(a) * d, z = p.pos.z + Math.cos(a) * d;
    return { x, y: this.g.island.height(x, z) + 1, z };
  }
  fire(k) {
    const g = this.g, a = g.audio, p = g.player;
    switch (k) {
      case 'silence': this.silence = 1; this.silenceHold = 10 + Math.random() * 15; return true;
      case 'branch': a.branchSnap?.(this._spot(-1, 9, 22)); return true;
      case 'footsteps': a.footstepsFake?.(this._spot(-1, 7, 14), 4 + Math.floor(Math.random() * 4)); return true;
      case 'knock': { const s = this._spot(0, 30, 60); a.knock?.(s); setTimeout(() => a.knock?.(s), 1400); return true; }
      case 'scream': a.distantScream?.(this._spot(0, 250, 500)); return true;
      case 'mimic': { const far = this._spot(1, 120, 200); a.animal?.('bird', 'call', far, 0); this.mimicPend = { t: 6 + Math.random() * 6 }; return true; }
      case 'name': {
        const friends = g.remotes?.list || []; if (!friends.length) return false;
        const f = friends[Math.floor(Math.random() * friends.length)];
        // from a direction where they are NOT
        const toF = Math.atan2(f.pos.x - p.pos.x, f.pos.z - p.pos.z), aa = toF + Math.PI + (Math.random() - 0.5);
        const s = { x: p.pos.x + Math.sin(aa) * 24, y: p.pos.y + 1.5, z: p.pos.z + Math.cos(aa) * 24 };
        a.mimicName?.(s, g.profile.name);
        g.hud.subtitle('', '"' + g.profile.name + '..."', 2.5, 'whisper');
        return true;
      }
      case 'firelight': return this._spawnFigure();
      case 'eyes': return this._spawnEyes();
    }
    return false;
  }
  _mimic(dt) {
    const m = this.mimicPend; if (!m) return;
    m.t -= dt;
    if (m.t <= 0) { this.mimicPend = null; this.g.audio.birdMimic?.(this._spot(-1, 3, 5)); this.g.post.u.fear.value = Math.max(this.g.post.u.fear.value, 0.4); }
  }
  /** a tall shape standing just outside the firelight; turn toward it and it is not there */
  _spawnFigure() {
    const g = this.g; if (this.fig) return false;
    const s = this._spot(-1, 15, 19); s.y -= 1;
    const geo = new THREE.CapsuleGeometry(0.35, 3.2, 4, 8); geo.translate(0, 1.95, 0);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x020202 }));
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.28, 0.9, 6), m.material); head.position.y = 4.1; head.rotation.x = 0.3; m.add(head);
    for (const sx of [-1, 1]) { const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.05, 1.2, 4), m.material); ant.position.set(sx * 0.35, 4.6, 0); ant.rotation.z = -sx * 0.6; m.add(ant); }
    m.position.set(s.x, s.y, s.z); m.lookAt(g.player.pos.x, s.y, g.player.pos.z);
    g.scene.add(m);
    this.fig = { m, t: 0 };
    return true;
  }
  _figure(dt) {
    const f = this.fig; if (!f) return;
    const g = this.g; f.t += dt;
    const v = this._v.copy(f.m.position); v.y += 2.5; v.project(g.camera);
    const inView = v.z < 1 && Math.abs(v.x) < 0.85 && Math.abs(v.y) < 0.95;
    if (inView || f.t > 20) { if (inView) { g.audio.stinger?.('dread'); g.post.u.fear.value = Math.max(g.post.u.fear.value, 0.5); } f.m.removeFromParent(); this.fig = null; }
  }
  /** two pale glints in the dark between the trees that blink and are gone */
  _spawnEyes() {
    const g = this.g; if (this.eyes) return false;
    const s = this._spot(1, 26, 40); s.y += 0.6 + Math.random() * 1.6;
    const grp = new THREE.Group();
    for (const sx of [-1, 1]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 4), new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.6, 2.0) })); e.position.x = sx * 0.09; grp.add(e); }
    grp.position.set(s.x, s.y, s.z); grp.lookAt(g.player.pos.x, s.y, g.player.pos.z);
    g.scene.add(grp);
    this.eyes = { grp, t: 0 };
    return true;
  }
  _eyes(dt) {
    const e = this.eyes; if (!e) return;
    e.t += dt;
    e.grp.visible = !(e.t > 3 && e.t < 3.15) && !(e.t > 5.5 && e.t < 5.6);
    const d = e.grp.position.distanceTo(this.g.player.pos);
    if (e.t > 7 || d < 14 || (this.g.lightOn && d < 30)) { e.grp.removeFromParent(); this.eyes = null; }
  }
}
