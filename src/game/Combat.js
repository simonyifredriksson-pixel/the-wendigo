/* Combat.js - hitting things, being hit, going down, getting back up.

   Targets: every AI system (wildlife, cannibals, the Wendigo) exposes
   targets() -> [{ id, sys, x, y, z, r, h, weak? }] and hurt(id, dmg, info).
   Melee is a short ray with a little forgiveness. Arrows and flares are
   real projectiles with gravity; the rifle is instant. A flare sticks where
   it lands and burns for a minute: light, and fire the Wendigo hates.

   Going down: with friends online you fall to the ground and bleed out
   over 60 s unless someone holds E on you for 4 s. Alone - or if nobody
   comes - you black out and wake at your bed (or the crash site) with
   what you were carrying, minus the logs.

   Sleeping: use a bed at night; when every living player is in bed and
   nothing is hunting, the night passes. */
import * as THREE from '../../lib/three.module.js';
import { ITEMS } from '../data/Items.js';
import { clamp } from '../core/Util.js';

export class Combat {
  constructor(game) { this.g = game; this.proj = []; this.flares = []; this.downT = 0; this.sleepers = new Set(); this._v = new THREE.Vector3(); }
  _targets() {
    const g = this.g, out = [];
    for (const s of [g.wildlife, g.cannibals, g.wendigo]) if (s?.targets) for (const t of s.targets()) { t.sys = s; out.push(t); }
    return out;
  }
  /** closest target hit by a ray (vertical cylinders) */
  pick(o, d, maxD, pad = 0.15) {
    let best = null, bt = maxD;
    for (const t of this._targets()) {
      const ox = o.x - t.x, oz = o.z - t.z, a = d.x * d.x + d.z * d.z; if (a < 1e-6) continue;
      const r = t.r + pad, b = 2 * (ox * d.x + oz * d.z), c = ox * ox + oz * oz - r * r, disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const tt = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a));
      if (tt > bt) continue;
      const y = o.y + d.y * tt; if (y < t.y - 0.3 || y > t.y + t.h + 0.3) continue;
      bt = tt; best = { t, dist: tt, point: new THREE.Vector3(o.x + d.x * tt, y, o.z + d.z * tt) };
    }
    return best;
  }
  melee(o, d, reach, T, item) {
    const g = this.g;
    let hit = this.pick(o, d, reach, 0.3);
    if (!hit) for (const a of [-0.22, 0.22]) { const d2 = d.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a); hit = this.pick(o, d2, reach * 0.9, 0.2); if (hit) break; }
    if (!hit) return false;
    // a trunk in the way?
    const tr = g.forest.raycast(o, d, hit.dist); if (tr && tr.dist < hit.dist - 0.3) return false;
    const weak = hit.t.weak && hit.point.y > hit.t.y + hit.t.h * hit.t.weak[0] && hit.point.y < hit.t.y + hit.t.h * hit.t.weak[1];
    let dmg = T.dmg * (weak ? 1.6 : 1);
    const info = { kind: 'melee', item, fire: !!T.burn && g.lightOn, ember: !!T.ember, dx: d.x, dz: d.z, weak };
    g.act({ k: 'hit', id: hit.t.id, sys: hit.t.sys.sysKey, dmg, info, x: hit.point.x, y: hit.point.y, z: hit.point.z });
    g.audio.axeHit?.(hit.point, 0.9, hit.t.material || 'flesh');
    if (hit.t.blood !== false) g.fx?.blood(hit.point, 6, { x: d.x, z: d.z });
    if (info.fire) g.fx?.sparks(hit.point, 12);
    g.hud.hitmark?.(weak);
    return true;
  }
  applyHit(a, from) {
    const sys = { wildlife: this.g.wildlife, cannibals: this.g.cannibals, wendigo: this.g.wendigo }[a.sys];
    sys?.hurt?.(a.id, a.dmg, { ...a.info, from, x: a.x, y: a.y, z: a.z });
  }
  /* ---------------- ranged */
  shoot(kind, power = 1) {
    const g = this.g, p = g.player, o = g.camera.position.clone(), d = p.forward.clone();
    if (kind === 'ammo') {
      g.audio.rifleShot?.(o);
      g.act({ k: 'noise', x: o.x, y: o.y, z: o.z, r: 400, loud: 1 });
      const hit = this.pick(o, d, 250, 0.05);
      const tr = g.forest.raycast(o, d, hit ? hit.dist : 250);
      if (tr && (!hit || tr.dist < hit.dist)) { g.fx?.chipBurst(tr.point, { x: -d.x, z: -d.z }, 5); g.audio.arrowHit?.(tr.point, 'wood'); return; }
      if (hit) { g.act({ k: 'hit', id: hit.t.id, sys: hit.t.sys.sysKey, dmg: ITEMS.rifle.tool.dmg, info: { kind: 'bullet', dx: d.x, dz: d.z }, x: hit.point.x, y: hit.point.y, z: hit.point.z }); g.fx?.blood(hit.point, 10, d); g.hud.hitmark?.(false); }
      g.fx?.smoke({ x: o.x + d.x, y: o.y - 0.1, z: o.z + d.z }, 3, 0.6, 0.3);
      return;
    }
    const speed = kind === 'arrow' ? 18 + 32 * power : 34;
    const pr = { kind, x: o.x + d.x * 0.5, y: o.y + d.y * 0.5 - 0.05, z: o.z + d.z * 0.5, vx: d.x * speed, vy: d.y * speed, vz: d.z * speed, t: 0, mine: true, power };
    this.proj.push(pr);
    if (kind === 'flare') { g.audio.flareGun?.(o); g.act({ k: 'noise', x: o.x, y: o.y, z: o.z, r: 200 }); g.net.sendEvent({ k: 'proj', p: { ...pr, mine: false } }); }
    else g.net.sendEvent({ k: 'proj', p: { ...pr, mine: false } });
    pr.mesh = this._projMesh(kind); g.scene.add(pr.mesh);
  }
  _projMesh(kind) {
    if (kind === 'flare') { const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 1.5, 1) })); return m; }
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.72, 5), new THREE.MeshStandardMaterial({ color: 0x8a6a44 })); shaft.rotation.x = Math.PI / 2; g.add(shaft);
    return g;
  }
  onEvent(e) {
    if (e.k === 'proj') { const p = { ...e.p }; p.mesh = this._projMesh(p.kind); this.g.scene.add(p.mesh); this.proj.push(p); }
    else if (e.k === 'down') this._remoteDown(e);
    else if (e.k === 'revived' && e.id === this.g.me) this._getUp();
    else if (e.k === 'sleep') this._sleepFx(e);
  }
  /** lights for the pool: burning flares */
  lights() { return this.flares.map(f => ({ x: f.x, y: f.y + 0.3, z: f.z, i: 9 * Math.min(1, f.life / 10), r: 22, c: 0xff3a2a, flicker: true, seed: f.x })).concat(this.proj.filter(p => p.kind === 'flare').map(p => ({ x: p.x, y: p.y, z: p.z, i: 8, r: 20, c: 0xff3a2a }))); }
  update(dt) {
    const g = this.g;
    // projectiles
    for (let i = this.proj.length - 1; i >= 0; i--) {
      const p = this.proj[i];
      p.t += dt; p.vy -= (p.kind === 'flare' ? 4 : 9.8) * dt;
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + p.vz * dt;
      const step = Math.hypot(nx - p.x, ny - p.y, nz - p.z), dir = this._v.set(nx - p.x, ny - p.y, nz - p.z).normalize();
      let done = false, at = null;
      if (p.mine) {
        const hit = this.pick({ x: p.x, y: p.y, z: p.z }, dir, step, 0.1);
        if (hit) {
          const dmg = p.kind === 'arrow' ? ITEMS.bow.tool.dmg * (0.4 + 0.6 * p.power) : ITEMS.flaregun.tool.dmg;
          g.act({ k: 'hit', id: hit.t.id, sys: hit.t.sys.sysKey, dmg, info: { kind: p.kind, fire: p.kind === 'flare', dx: dir.x, dz: dir.z }, x: hit.point.x, y: hit.point.y, z: hit.point.z });
          g.audio.arrowHit?.(hit.point, 'flesh'); g.hud.hitmark?.(false); g.fx?.blood(hit.point, 5, dir);
          done = true; at = hit.point;
        }
      }
      const tr = !done && g.forest.raycast({ x: p.x, y: p.y, z: p.z }, dir, step);
      if (tr) { done = true; at = tr.point; g.audio.arrowHit?.(tr.point, 'wood'); }
      const gy = g.physics.ground(nx, nz, ny + 1);
      if (!done && ny <= gy) { done = true; at = new THREE.Vector3(nx, gy, nz); g.audio.arrowHit?.(at, 'ground'); }
      if (!done && g.island.waterLevel(nx, nz) > ny) { done = true; g.fx?.splash({ x: nx, y: ny, z: nz }, 0.4); }
      p.x = nx; p.y = ny; p.z = nz;
      p.mesh.position.set(p.x, p.y, p.z); p.mesh.lookAt(p.x + p.vx, p.y + p.vy, p.z + p.vz);
      if (p.kind === 'flare' && g.fx) g.fx.embers(p, 1, 0.05, 0.08);
      if (done || p.t > 8) {
        if (p.kind === 'flare' && at) this.flares.push({ x: at.x, y: at.y, z: at.z, life: 60, mesh: p.mesh });
        else if (p.kind === 'arrow' && at && p.mine && g.isHost && Math.random() < 0.6) { p.mesh.removeFromParent(); g.items?.spawn('arrow', at.x, at.z, 1); }
        else p.mesh.removeFromParent();
        if (p.kind !== 'flare' || !at) p.mesh.removeFromParent();
        this.proj.splice(i, 1);
      }
    }
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i]; f.life -= dt;
      if (g.fx && Math.random() < dt * 20) { g.fx.embers(f, 1, 0.1, 0.07); if (Math.random() < 0.3) g.fx.smoke(f, 1, 0.5, 0.3); }
      if (f.life <= 0) { f.mesh.removeFromParent(); this.flares.splice(i, 1); }
    }
    this._downUpdate(dt);
  }
  /** fire near a point (flares, torches): AI asks this */
  fireNear(x, z, r) {
    for (const f of this.flares) if (Math.hypot(f.x - x, f.z - z) < r) return 1;
    return this.g.fires?.lightAt(x, z) || 0;
  }

  /* ---------------- down, revive, death */
  down(kind) {
    const g = this.g, p = g.player;
    if (p.downed || p.dead) return;
    g.W && g.W.stats && g.W.stats.deaths++;
    const friends = g.remotes?.list.filter(r => !r.s.d).length || 0;
    if (friends > 0) {
      p.downed = true; p.health = 0; this.downT = 60; g.lightOn = false;
      g.act({ k: 'down', on: 1 });
      g.hud.downed?.(true, kind);
      g.audio.death?.();
    } else this._blackout(kind);
  }
  _downUpdate(dt) {
    const g = this.g, p = g.player;
    if (p.downed) {
      this.downT -= dt;
      g.post.u.fear.value = Math.max(g.post.u.fear.value, 0.8);
      g.hud.downed?.(true, null, this.downT);
      if (this.downT <= 0) { p.downed = false; g.act({ k: 'down', on: 0 }); this._blackout('bleed'); }
    }
    // revive prompts on downed friends
    if (!g.interact) return;
    for (const r of g.remotes?.list || []) {
      const id = 'revive_' + r.id;
      if (r.s.d) g.interact.add({ id, x: r.pos.x, y: r.pos.y + 0.4, z: r.pos.z, r: 0.8, hold: 4, text: () => 'Help ' + r.name + ' up', act: () => g.act({ k: 'revive', id: r.id }) });
      else g.interact.remove(id);
    }
  }
  applyRevive(a) { this.g.emit({ k: 'revived', id: a.id }); }
  _remoteDown(e) { if (e.id !== this.g.me && e.on) this.g.hud.toast((this.g.net.profiles.get(e.id)?.name || 'Someone') + ' is down! Hold E on them to help them up.', 6); }
  _getUp() { const g = this.g, p = g.player; if (!p.downed) return; p.downed = false; p.health = 35; g.act({ k: 'down', on: 0 }); g.hud.downed?.(false); g.hud.toast('Back on your feet.'); }
  _blackout(kind) {
    const g = this.g, p = g.player;
    p.dead = true; g.cutscene = 'death';
    g.hud.downed?.(false);
    g.audio.death?.();
    const msg = { tree: 'Crushed under a falling tree.', cold: 'The cold took you.', starve: 'You starved.', wendigo: 'It found you.', fall: 'You fell.', drown: 'You drowned.' }[kind] || 'You blacked out.';
    g.hud.fadeText?.('YOU BLACKED OUT', msg, 5);
    let t = 0; const u = g.post.u;
    const step = () => {
      t += 0.05; u.fade.value = Math.min(1, t / 1.5);
      if (t < 4.5) { setTimeout(step, 50); return; }
      // wake up at the bed (or the crash site)
      const bed = g.build?.bedFor?.(g.profile.key);
      const n = g.inventory.count('log'); if (n) { g.inventory.remove('log', n); }
      if (bed) p.spawn(bed.x + 1, bed.z + 1, 0); else { const s = g.spawnPoint(); p.spawn(s.x, s.z, s.yaw); }
      p.dead = false; p.health = 50; p.hunger = Math.max(p.hunger, 35); p.warmth = Math.max(p.warmth, 50); p.stamina = 60;
      g.cutscene = null;
      const up = () => { u.fade.value = Math.max(0, u.fade.value - 0.03); if (u.fade.value > 0) setTimeout(up, 50); };
      up();
    };
    step();
  }
  /* ---------------- sleeping */
  sleepRequest(bedId) {
    const g = this.g;
    if (!g.atmos.isNight && g.atmos.hour < 19) { g.hud.toast('You can only sleep at night.'); return; }
    if (g.wendigo?.hunting) { g.hud.toast('You can\'t sleep now. Something is out there.'); return; }
    g.act({ k: 'sleep', key: g.profile.key, on: 1 });
  }
  applySleep(a, from) {
    const g = this.g;
    if (a.on) this.sleepers.add(from); else this.sleepers.delete(from);
    const total = 1 + (g.remotes?.list.length || 0);
    if (this.sleepers.size >= total) {
      this.sleepers.clear();
      g.emit({ k: 'sleep', hour: 6.2 });
    } else g.emit({ k: 'sleepWait', n: this.sleepers.size, of: total });
  }
  _sleepFx(e) {
    const g = this.g, u = g.post.u;
    g.cutscene = 'sleep'; g.hud.fadeText?.('', '', 0);
    let t = 0;
    const step = () => {
      t += 0.05; u.fade.value = Math.min(1, t);
      if (t < 2.5) return setTimeout(step, 50);
      if (g.isHost) { if (g.atmos.hour > 12) g.atmos.day++; g.atmos.hour = e.hour; }
      g.player.warmth = Math.max(g.player.warmth, 70); g.player.health = Math.min(100, g.player.health + 30); g.player.hunger = Math.max(0, g.player.hunger - 15);
      g.saveNow?.();
      g.hud.fadeText?.('DAY ' + g.atmos.day, '', 3);
      const up = () => { u.fade.value = Math.max(0, u.fade.value - 0.02); if (u.fade.value > 0) setTimeout(up, 50); else g.cutscene = null; };
      setTimeout(up, 1200);
    };
    step();
  }
}
