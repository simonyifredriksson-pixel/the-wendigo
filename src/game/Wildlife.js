/* Wildlife.js - the island's animals, and what the night does to them.

   The host keeps a living population around every player: deer in small
   herds at forest edges and meadows, rabbits in the grass, a wolf pack
   roaming the deep forest, the odd bear in the north, flocks of birds on
   the ground and in the trees, fish in the lakes and the river.

   DAY      graze, wander, rest; flee from people (wolves keep their
            distance unless cornered or hurt; a bear charges if you walk
            into its space).
   NIGHT    corruption creeps in with the dark (a per-animal threshold, so
            not every animal turns, and not at the same moment):
            rabbits    freeze, then turn to watch you; sudden jerky darts
            deer       stand in the dark staring, bolt without a sound
            wolves     long-legged and too still, watching from between the
                       trees, following at a distance; they attack if you
                       get close, hurt one, or run from them alone
            birds      silent; the director borrows their calls
            Corrupted animals keep out of firelight and torchlight.
   ALWAYS   everything flees from the Wendigo (the forest empties before
            you see it), from falling trees and gunshots.

   Dead animals can be butchered (hold E): meat, hide, bone, feathers. */
import * as THREE from '../../lib/three.module.js';
import { clamp, lerp, damp, dampAng, angDiff, sstep, rng } from '../core/Util.js';

let AnimalArt = null;
async function art() { if (AnimalArt === null) { try { AnimalArt = await import('../art/AnimalArt.js'); } catch (e) { AnimalArt = false; } } return AnimalArt; }

const KINDS = {
  deer:   { hp: 60, walk: 1.6, run: 11, r: 0.5, h: 1.6, flee: 28, herd: [2, 4], loot: { meatRaw: 3, hide: 1, bone: 1 }, sound: 'deer' },
  rabbit: { hp: 12, walk: 1.2, run: 7, r: 0.2, h: 0.35, flee: 12, herd: [1, 2], loot: { meatRaw: 1 }, sound: 'rabbit' },
  wolf:   { hp: 80, walk: 1.8, run: 9.5, r: 0.45, h: 0.9, flee: 0, herd: [3, 4], loot: { meatRaw: 2, hide: 1, bone: 1 }, sound: 'wolf', dmg: 14 },
  bear:   { hp: 260, walk: 1.5, run: 9, r: 0.9, h: 1.4, flee: 0, herd: [1, 1], loot: { meatRaw: 5, hide: 2, bone: 2 }, sound: 'bear', dmg: 32 },
  bird:   { hp: 4, walk: 0.6, run: 12, r: 0.15, h: 0.25, flee: 9, herd: [4, 9], loot: { feather: 2 }, sound: 'bird' },
  fish:   { hp: 6, walk: 0.8, run: 3, r: 0.2, h: 0.2, flee: 4, herd: [2, 4], loot: { fishRaw: 1 }, sound: null },
};
let AID = 1;

export class Wildlife {
  constructor(game) {
    this.g = game; this.list = []; this.byId = new Map();
    this.group = new THREE.Group(); this.group.name = 'wildlife'; game.scene.add(this.group);
    this.spawnT = 2; this.r = rng(77);
    art();
  }
  /* ---------------------------------------------------------------- spawning (host) */
  _want(x, z) {
    const I = this.g.island, night = this.g.atmos.out.night, f = I.forestAt(x, z), m = I.meadowAt(x, z), w = I.wetAt(x, z);
    return {
      deer: 2.2 * (0.4 + m * 0.6 + (f > 0.3 && f < 0.7 ? 0.5 : 0)),
      rabbit: 2.5 * (0.3 + m),
      wolf: (0.35 + f * 0.4) * (night ? 1.6 : 1),
      bear: (x * 0 + (-z > 200 ? 0.35 : 0.08)),
      bird: 2.2,
      fish: w > 0.5 ? 1.5 : 0,
    };
  }
  _spawnNear(px, pz) {
    const g = this.g, I = g.island, r = this.r;
    const a = r() * 6.28, d = 70 + r() * 80, x = px + Math.cos(a) * d, z = pz + Math.sin(a) * d;
    if (!I.onLand(x, z) && I.waterDepth(x, z) < 1) return;
    const want = this._want(x, z);
    // weighted pick of a kind that is under its local cap
    const counts = {}; for (const an of this.list) if (Math.hypot(an.x - px, an.z - pz) < 170) counts[an.kind] = (counts[an.kind] || 0) + 1;
    const caps = { deer: 8, rabbit: 8, wolf: 4, bear: 1, bird: 14, fish: 6 };
    let tot = 0; const opts = [];
    for (const k in want) { if ((counts[k] || 0) >= caps[k] || want[k] <= 0) continue; tot += want[k]; opts.push([k, want[k]]); }
    if (!opts.length) return;
    let pick = r() * tot, kind = opts[0][0];
    for (const [k, w] of opts) { pick -= w; if (pick <= 0) { kind = k; break; } }
    const K = KINDS[kind];
    if (kind === 'fish') { if (I.waterDepth(x, z) < 1) return; }
    else if (I.waterDepth(x, z) > 0.1 || I.height(x, z) < 1.5) return;
    if (kind === 'wolf' && g.atmos.out.daylight > 0.5 && r() < 0.6) return;   // wolves are mostly a dusk-and-night thing
    const n = Math.round(lerp(K.herd[0], K.herd[1], r()));
    for (let i = 0; i < n; i++) {
      const ox = x + (r() - 0.5) * 8, oz = z + (r() - 0.5) * 8;
      this._add({ id: 'a' + AID++, kind, x: ox, z: oz, yaw: r() * 6.28, hp: K.hp, seed: r(), herd: x + ',' + z, perched: kind === 'bird' && r() < 0.5 });
    }
  }
  async _add(s) {
    const g = this.g, K = KINDS[s.kind];
    const an = { ...s, y: g.island.height(s.x, s.z), speed: 0, tspeed: 0, mode: s.mode || 'idle', mt: 0, think: Math.random(), c: s.c || 0, tc: 0, target: null, hpMax: K.hp, dead: s.dead || false, model: null, cool: 0 };
    if (s.kind === 'fish') an.y = g.island.waterLevel(s.x, s.z) - 0.6;
    if (an.perched) { const t = this._perchTree(an); if (t) { an.x = t.x + 0.6; an.z = t.z; an.y = t.y + t.h * 0.55; an.tree = t.id; } else an.perched = false; }
    this.list.push(an); this.byId.set(an.id, an);
    const A = await art();
    if (!this.byId.has(an.id)) return;
    let m = null;
    if (A && A.createAnimal) { try { m = A.createAnimal(s.kind, { seed: Math.floor(an.seed * 1000), antlers: s.kind === 'deer' && an.seed > 0.6 }); } catch (e) { window.__log?.('ART animal ' + s.kind + ': ' + e.message); } }
    if (!m) m = this._fallback(s.kind);
    an.model = m; m.root.traverse(o => { if (o.isMesh) { o.castShadow = true; } });
    this.group.add(m.root);
  }
  _fallback(kind) {
    const K = KINDS[kind], g = new THREE.Group();
    const b = new THREE.Mesh(new THREE.CapsuleGeometry(K.r, K.r * 2.5, 4, 8), new THREE.MeshStandardMaterial({ color: kind === 'wolf' ? 0x666660 : kind === 'bear' ? 0x3a2a1e : 0x7a5a3e }));
    b.rotation.x = Math.PI / 2; b.position.y = K.h * 0.7; g.add(b);
    return { root: g, animate() {}, setCorruption() {}, head: b };
  }
  _perchTree(an) { let best = null; this.g.forest.near(an.x, an.z, 12, (t) => { if (!best && t.state === 0 && t.h > 8) best = t; }); return best; }
  _remove(an) { an.model?.root.removeFromParent(); this.byId.delete(an.id); const i = this.list.indexOf(an); if (i >= 0) this.list.splice(i, 1); this.g.interact?.remove('butcher_' + an.id); }

  /* ---------------------------------------------------------------- players and threats */
  _people() {
    const g = this.g, out = [{ x: g.player.pos.x, z: g.player.pos.z, y: g.player.pos.y, noise: g.player.noise, sprint: g.player.sprinting, me: true, light: g.lightOn && (g.inventory?.held === 'torch') }];
    for (const r of g.remotes?.list || []) out.push({ x: r.pos.x, z: r.pos.z, y: r.pos.y, noise: r.s.m === 'run' ? 0.55 : 0.2, sprint: r.s.m === 'run', id: r.id, light: r.s.l && r.item === 'torch' });
    return out;
  }
  /** something frightening happened at p (a tree fell, a shot): everything near runs */
  scare(p, r) { for (const an of this.list) if (!an.dead && Math.hypot(an.x - p.x, an.z - p.z) < r) { an.fleeFrom = { x: p.x, z: p.z }; an.fleeT = 6 + Math.random() * 4; if (an.kind === 'bird' && !an.flying) this._takeOff(an); } }
  _takeOff(an) {
    an.flying = true; an.perched = false; an.vy = 3 + Math.random() * 2; an.mode = 'fly'; an.mt = 0;
    if (!this._flockT || this.g.time - this._flockT > 1.5) { this._flockT = this.g.time; this.g.audio.birdFlock?.({ x: an.x, y: an.y + 2, z: an.z }, 6); }
  }

  /* ---------------------------------------------------------------- per frame */
  update(dt) {
    const g = this.g; if (g.phase !== 'play' && g.phase !== 'end') return;
    if (!g.isHost) { this._clientUpdate(dt); return; }
    const people = this._people(), A = g.atmos.out;
    // population
    this.spawnT -= dt;
    if (this.spawnT <= 0 && !g.inCave) {
      this.spawnT = 1.2;
      for (const p of people) { let near = 0; for (const an of this.list) if (Math.hypot(an.x - p.x, an.z - p.z) < 170) near++; if (near < 26) this._spawnNear(p.x, p.z); }
    }
    for (const an of [...this.list]) {
      let dmin = 1e9; for (const p of people) dmin = Math.min(dmin, Math.hypot(an.x - p.x, an.z - p.z));
      if (dmin > 240 || (an.dead && an.deadT > 300)) { this._remove(an); continue; }
      this._think(an, dt, people, A);
      this._move(an, dt);
      this._animate(an, dt);
    }
  }
  /** the night creeps into an animal at its own moment */
  _corruptTarget(an, A) {
    if (an.kind === 'fish' || an.kind === 'bear') return 0;
    const menace = this.g.director?.menace ?? 0.3;
    const thr = 0.25 + an.seed * 0.6 - menace * 0.25;
    return sstep(thr, thr + 0.2, A.night) * (an.seed < 0.85 || menace > 0.5 ? 1 : 0);
  }
  _think(an, dt, people, A) {
    const g = this.g, K = KINDS[an.kind];
    an.mt += dt; an.cool -= dt; an.fleeT = (an.fleeT || 0) - dt;
    an.tc = this._corruptTarget(an, A);
    an.c = damp(an.c, an.tc, 0.25, dt);
    if (an.dead) { an.deadT = (an.deadT || 0) + dt; an.tspeed = 0; return; }
    an.think -= dt; if (an.think > 0) return;
    an.think = 0.2 + Math.random() * 0.15;
    // nearest person
    let P = null, pd = 1e9; for (const p of people) { const d = Math.hypot(an.x - p.x, an.z - p.z); if (d < pd) { pd = d; P = p; } }
    const corrupt = an.c > 0.5;
    const fireNear = g.combat?.fireNear(an.x, an.z, 9) || 0;
    const wendigoNear = g.wendigo?.presence?.(an.x, an.z) || 0;
    const set = (mode, speed, tgt) => { if (an.mode !== mode) { an.mode = mode; an.mt = 0; } an.tspeed = speed; if (tgt) an.target = tgt; };
    // birds
    if (an.kind === 'bird') {
      if (!an.flying && (pd < K.flee || wendigoNear > 0.2 || an.fleeT > 0)) this._takeOff(an);
      if (an.flying) { set('fly', K.run); if (!an.target || an.mt > 6) an.target = { x: an.x + (Math.random() - 0.5) * 160, z: an.z + (Math.random() - 0.5) * 160 }; if (an.mt > 9) this._remove(an); }
      else set(an.perched ? 'perch' : Math.random() < 0.5 ? 'eat' : 'hop', an.perched ? 0 : 0.3, { x: an.x + (Math.random() - 0.5) * 2, z: an.z + (Math.random() - 0.5) * 2 });
      return;
    }
    if (an.kind === 'fish') { if (pd < 3 || !an.target || Math.random() < 0.05) { const a = Math.random() * 6.28; const tx = an.x + Math.cos(a) * 6, tz = an.z + Math.sin(a) * 6; if (g.island.waterDepth(tx, tz) > 0.8) an.target = { x: tx, z: tz }; } set('swim', pd < 3 ? K.run : K.walk); return; }
    // everyone runs from the Wendigo
    if (wendigoNear > 0.25) { const w = g.wendigo.pos; an.fleeFrom = { x: w.x, z: w.z }; an.fleeT = 8; }
    if (an.fleeT > 0 && an.fleeFrom) { const a = Math.atan2(an.x - an.fleeFrom.x, an.z - an.fleeFrom.z) + (Math.random() - 0.5) * 0.6; set('run', K.run, { x: an.x + Math.sin(a) * 30, z: an.z + Math.cos(a) * 30 }); return; }
    // corrupted animals keep out of the light
    if (corrupt && fireNear > 0.15) { const p = P || an; const a = Math.atan2(an.x - p.x, an.z - p.z); set('walk', K.walk * 1.5, { x: an.x + Math.sin(a) * 12, z: an.z + Math.cos(a) * 12 }); return; }
    const toP = P ? { x: P.x, z: P.z } : null;
    switch (an.kind) {
      case 'deer':
      case 'rabbit':
        if (corrupt) {
          if (pd < (an.kind === 'deer' ? 10 : 5)) { const a = Math.atan2(an.x - P.x, an.z - P.z); set('run', K.run * 1.3, { x: an.x + Math.sin(a) * 40, z: an.z + Math.cos(a) * 40 }); an.silent = true; return; }
          if (pd < 45) { if (an.kind === 'rabbit' && Math.random() < 0.08) { set('jerk', 0); return; } set('stare', 0); an.lookAt = toP; return; }
        } else if (pd < K.flee + (P?.sprint ? 10 : 0)) {
          if (an.mode !== 'run') { this.g.audio.animal?.(K.sound, 'flee', { x: an.x, y: an.y + 1, z: an.z }, 0); }
          const a = Math.atan2(an.x - P.x, an.z - P.z) + (Math.random() - 0.5) * 0.8; set('run', K.run, { x: an.x + Math.sin(a) * 35, z: an.z + Math.cos(a) * 35 }); return;
        } else if (pd < K.flee * 1.8 && an.mode !== 'run') { set('alert', 0); an.lookAt = toP; return; }
        this._graze(an, K, set, A);
        return;
      case 'wolf': {
        const hostile = an.angry > 0 || (corrupt && (pd < 7 || (P?.sprint && pd < 18))) || (!corrupt && pd < 3.5);
        an.angry = (an.angry || 0) - 0.2;
        if (hostile && P && pd < 40) {
          if (pd < 2.2 && an.cool <= 0) { set('attack', 0); an.lookAt = toP; an.cool = 1.6; this._bite(an, P, K.dmg * (1 + an.c * 0.5)); return; }
          set('run', K.run * (corrupt ? 1.15 : 1), toP); return;
        }
        if (corrupt && P && pd < 60) {
          // watch from between the trees; drift closer when not looked at
          const seen = this._seenBy(an, P);
          if (pd > 28 && !seen) { set('walk', K.walk * 1.2, toP); return; }
          if (Math.random() < 0.01) this.g.audio.animal?.('wolf', 'growl', { x: an.x, y: an.y + 0.8, z: an.z }, an.c);
          set('stare', 0); an.lookAt = toP; return;
        }
        if (!corrupt && P && pd < 20) { const a = Math.atan2(an.x - P.x, an.z - P.z); set('walk', K.walk * 1.3, { x: an.x + Math.sin(a) * 20, z: an.z + Math.cos(a) * 20 }); return; }
        if (Math.random() < (A.night > 0.5 ? 0.004 : 0.001)) { set('howl', 0); this.g.audio.animal?.('wolf', 'howl', { x: an.x, y: an.y + 1, z: an.z }, an.c); return; }
        if (an.mode === 'howl' && an.mt < 3) return;
        this._graze(an, K, set, A, true);
        return;
      }
      case 'bear': {
        const hostile = an.angry > 0 || pd < 9;
        an.angry = (an.angry || 0) - 0.2;
        if (hostile && P && pd < 35) {
          if (pd < 2.8 && an.cool <= 0) { set('attack', 0); an.lookAt = toP; an.cool = 2.2; this._bite(an, P, K.dmg); return; }
          if (an.mode !== 'run') this.g.audio.animal?.('bear', 'growl', { x: an.x, y: an.y + 1.2, z: an.z }, 0);
          set('run', K.run, toP); return;
        }
        this._graze(an, K, set, A);
      }
    }
  }
  _graze(an, K, set, A, roam) {
    if (A.night > 0.7 && an.c < 0.3 && an.kind === 'deer' && Math.random() < 0.3) { set('sleep', 0); return; }
    if (an.mode === 'walk' && an.target && Math.hypot(an.target.x - an.x, an.target.z - an.z) > 1.5 && an.mt < 12) return;
    if ((an.mode === 'eat' || an.mode === 'idle' || an.mode === 'sleep') && an.mt < 4 + an.seed * 6) return;
    if (Math.random() < (roam ? 0.7 : 0.45)) { const a = Math.random() * 6.28, d = roam ? 15 + Math.random() * 30 : 3 + Math.random() * 10; set('walk', K.walk, { x: an.x + Math.cos(a) * d, z: an.z + Math.sin(a) * d }); }
    else set(Math.random() < 0.7 ? 'eat' : 'idle', 0);
  }
  _seenBy(an, P) {
    if (!P.me) return false;
    const g = this.g, f = g.player.forward, dx = an.x - P.x, dz = an.z - P.z, d = Math.hypot(dx, dz);
    return (dx * f.x + dz * f.z) / d > 0.75;
  }
  _bite(an, P, dmg) {
    const g = this.g;
    g.audio.animal?.(KINDS[an.kind].sound, 'attack', { x: an.x, y: an.y + 0.8, z: an.z }, an.c);
    setTimeout(() => {
      if (an.dead) return;
      const d = Math.hypot(an.x - P.x, an.z - P.z); if (d > 3.2) return;
      if (P.me) { g.player.hurt(dmg, an, an.kind); g.hud.hitFrom?.(an.x, an.z); if (an.kind === 'bear' || Math.random() < 0.3) g.player.launch((P.x - an.x) / d * 4, 3, (P.z - an.z) / d * 4, 0.6); }
      else g.net.sendEvent({ k: 'hurtPlayer', to: P.id, dmg, x: an.x, z: an.z, kind: an.kind });
    }, 350);
  }
  _move(an, dt) {
    const g = this.g, I = g.island, K = KINDS[an.kind];
    an.speed = damp(an.speed, an.tspeed, an.mode === 'run' ? 4 : 6, dt);
    if (an.kind === 'bird' && an.flying) {
      const t = an.target || an; const a = Math.atan2(t.x - an.x, t.z - an.z);
      an.yaw = dampAng(an.yaw, a, 3, dt);
      an.vy = damp(an.vy || 0, an.y < I.height(an.x, an.z) + 25 ? 2.5 : 0.2, 2, dt);
      an.x += Math.sin(an.yaw) * an.speed * dt; an.z += Math.cos(an.yaw) * an.speed * dt; an.y += an.vy * dt;
      return;
    }
    if (an.dead || an.perched) return;
    if (an.target && an.speed > 0.05) {
      const dx = an.target.x - an.x, dz = an.target.z - an.z, d = Math.hypot(dx, dz);
      if (d < 0.8 && an.mode === 'walk') { an.tspeed = 0; an.mode = 'idle'; an.mt = 0; }
      an.yaw = dampAng(an.yaw, Math.atan2(dx, dz), an.mode === 'run' ? 5 : 2.5, dt);
    } else if (an.lookAt) an.yaw = dampAng(an.yaw, Math.atan2(an.lookAt.x - an.x, an.lookAt.z - an.z), an.mode === 'stare' ? 1.2 : 3, dt);
    let nx = an.x + Math.sin(an.yaw) * an.speed * dt, nz = an.z + Math.cos(an.yaw) * an.speed * dt;
    if (an.kind === 'fish') { if (I.waterDepth(nx, nz) < 0.7) { an.target = null; an.yaw += 2; return; } an.x = nx; an.z = nz; an.y = I.waterLevel(nx, nz) - 0.5 - Math.sin(g.time + an.seed * 9) * 0.15; return; }
    [nx, nz] = g.forest.collide(nx, nz, K.r);
    if (I.waterDepth(nx, nz) > 0.6 || I.height(nx, nz) < 1.2) { an.target = null; an.yaw += Math.PI * 0.6; return; }
    an.x = nx; an.z = nz; an.y = damp(an.y, g.physics.ground(nx, nz, an.y + 1), 12, dt);
    // corrupted rabbits jerk: tiny teleports
    if (an.mode === 'jerk' && Math.random() < dt * 2) { an.x += (Math.random() - 0.5) * 0.6; an.z += (Math.random() - 0.5) * 0.6; an.yaw += (Math.random() - 0.5) * 1.5; }
  }
  _animate(an, dt) {
    const m = an.model; if (!m) return;
    m.root.position.set(an.x, an.y, an.z); m.root.rotation.y = an.yaw;
    m.setCorruption?.(an.c);
    const look = an.lookAt ? _v.set(an.lookAt.x, (an.lookAt.y ?? an.y) + 1.5, an.lookAt.z) : null;
    m.animate?.(dt, { mode: an.dead ? 'dead' : an.mode, t: an.mt, speed: an.speed, lookAt: an.mode === 'stare' || an.mode === 'alert' || an.mode === 'attack' ? look : null });
  }

  /* ---------------------------------------------------------------- combat */
  targets() { return this.list.filter(a => !a.dead && a.model && a.kind !== 'bird' || (a.kind === 'bird' && !a.flying && !a.dead)).map(a => ({ id: a.id, x: a.x, y: a.y, z: a.z, r: KINDS[a.kind].r + 0.1, h: KINDS[a.kind].h, material: 'flesh' })); }
  hurt(id, dmg, info) {
    const an = this.byId.get(id); if (!an || an.dead) return;
    an.hp -= dmg; an.mode = 'hurt'; an.mt = 0; an.angry = 8;
    this.g.audio.animal?.(KINDS[an.kind].sound, an.hp <= 0 ? 'die' : 'hurt', { x: an.x, y: an.y + 0.8, z: an.z }, an.c);
    if (an.kind === 'deer' || an.kind === 'rabbit') { an.fleeFrom = { x: info.x ?? an.x, z: info.z ?? an.z }; an.fleeT = 10; }
    if (an.hp <= 0) this._kill(an);
  }
  _kill(an) {
    an.dead = true; an.deadT = 0; an.tspeed = 0; an.speed = 0; an.mode = 'dead';
    this.g.W.stats.kills = (this.g.W.stats.kills || 0) + 1;
    if (an.kind === 'bird' || an.kind === 'fish') { const loot = KINDS[an.kind].loot; for (const k in loot) this.g.items?.spawn(k, an.x, an.z, loot[k], an.kind === 'fish' ? this.g.island.waterLevel(an.x, an.z) : undefined); this._remove(an); return; }
    this._butcherable(an);
  }
  _butcherable(an) {
    const g = this.g;
    g.interact?.add({ id: 'butcher_' + an.id, x: an.x, y: an.y + 0.4, z: an.z, r: KINDS[an.kind].r + 0.4, hold: 2, text: () => 'Butcher the ' + an.kind, act: () => g.act({ k: 'butcher', id: an.id }) });
  }
  onEvent(e, from) {
    if (e.k === 'act:butcher' && this.g.isHost) { const an = this.byId.get(e.id); if (!an || !an.dead) return; const loot = KINDS[an.kind].loot; for (const k in loot) this.g.items?.spawn(k, an.x + (Math.random() - 0.5), an.z + (Math.random() - 0.5), loot[k]); this.g.emit({ k: 'butchered', id: an.id }); }
    else if (e.k === 'butchered') { const an = this.byId.get(e.id); if (an) { this.g.fx?.blood({ x: an.x, y: an.y + 0.3, z: an.z }, 6); this._remove(an); } }
    else if (e.k === 'hurtPlayer' && e.to === this.g.me) { this.g.player.hurt(e.dmg, { x: e.x, z: e.z }, e.kind); this.g.hud.hitFrom?.(e.x, e.z); }
  }
  /* ---------------------------------------------------------------- network */
  snapshot() { return this.list.map(a => [a.id, a.kind, +a.x.toFixed(1), +a.y.toFixed(1), +a.z.toFixed(1), +a.yaw.toFixed(2), a.mode, +a.c.toFixed(2), +a.speed.toFixed(1), a.dead ? 1 : 0, +a.seed.toFixed(3)]); }
  applySnapshot(s) {
    const seen = new Set();
    for (const [id, kind, x, y, z, yaw, mode, c, speed, dead, seed] of s) {
      seen.add(id);
      let an = this.byId.get(id);
      if (!an) { this._add({ id, kind, x, z, yaw, seed, c, mode }); an = this.byId.get(id); }
      an.nx = x; an.ny = y; an.nz = z; an.nyaw = yaw; if (mode !== an.mode) { an.mode = mode; an.mt = 0; } an.c = c; an.speed = speed;
      if (dead && !an.dead) { an.dead = true; this._butcherable(an); }
    }
    for (const an of [...this.list]) if (!seen.has(an.id)) this._remove(an);
  }
  _clientUpdate(dt) {
    for (const an of this.list) {
      an.mt += dt;
      if (an.nx !== undefined) { an.x = damp(an.x, an.nx, 8, dt); an.y = damp(an.y, an.ny, 8, dt); an.z = damp(an.z, an.nz, 8, dt); an.yaw = dampAng(an.yaw, an.nyaw, 8, dt); }
      const p = this.g.player.pos; an.lookAt = { x: p.x, y: p.y, z: p.z };
      this._animate(an, dt);
    }
  }
}
const _v = new THREE.Vector3();
