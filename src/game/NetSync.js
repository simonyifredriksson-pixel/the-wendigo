/* NetSync.js - co-op glue between Net.js and the game.

   Clients -> host: their player state (15 Hz) and ACTIONS (chop, take,
   build, hit...). The host performs actions in apply() and tells everyone
   what happened as EVENTS (game.emit). The host also streams a WORLD
   SNAPSHOT (10 Hz) - time of day, weather, the Wendigo, animals,
   cannibals - and the save when it changes, so a late joiner gets the
   same felled trees, shelters and discoveries.

   give(to, item, n) hands an item to a specific player (picking something
   up is decided by the host so two players cannot grab the same log). */

export class NetSync {
  constructor(game) {
    this.g = game; this.t = 0;
    const n = game.net, g = game;
    n.on.player = (id, s) => g.remotes?.state(id, s);
    n.on.action = (id, a) => this.apply(a, id);
    n.on.event = (id, e) => { if (e.k === 'give') { if (e.to === g.me) g.inventory?.add(e.name, e.n); return; } if (e.k === 'chat') g.hud.chat?.(e.name, e.t); g.onEvent(e, id); };
    n.on.world = (w) => this.applyWorld(w);
    n.on.saveIn = (s) => { if (!g.isHost) this._mergeSave(s); };
    n.on.getSave = () => { g.saveNow?.(); return g.W; };
    n.on.join = (id, p) => { g.hud.toast(p.name + ' joined.'); g.remotes?.join(id, p); if (g.isHost) { g.saveNow(); n.sendSave(g.W); if (g.intro?.playing) g.net.sendEvent({ k: 'introAt', t: g.intro.t }); } };
    n.on.leave = (id, p) => { g.hud.toast((p?.name || 'Someone') + ' left.'); g.remotes?.leave(id); };
    n.on.lost = () => { g.hud.toast('Lost the connection to the host. You are playing alone now.', 8); };
    n.on.welcome = (d) => { for (const pl of d.players) if (pl.id !== d.id) g.remotes?.join(pl.id, pl); };
  }
  /** host: perform an action from a player (from = net id, or game.me for the host) */
  apply(a, from) {
    const g = this.g;
    if (!a || typeof a !== 'object') return;
    switch (a.k) {
      case 'chop': g.chop?.apply(a, from); break;
      case 'buck': g.chop?.buck(a, from); break;
      case 'take': g.items?.take(a, from); break;
      case 'spawnItem': g.items?.spawn(a.name, a.x, a.z, a.n); break;
      case 'build': g.build?.applyBuild(a, from); break;
      case 'pieceHit': g.build?.applyHit(a, from); break;
      case 'door': g.build?.applyDoor(a); break;
      case 'stash': g.build?.applyStash(a, from); break;
      case 'fire': g.build?.applyFire(a, from); break;
      case 'hit': g.combat?.applyHit(a, from); break;
      case 'shot': g.combat?.applyShot(a, from); break;
      case 'revive': g.combat?.applyRevive(a, from); break;
      case 'down': g.emit({ k: 'down', id: from, on: a.on }); break;
      case 'lore': g.story?.applyLore(a, from); break;
      case 'flag': g.story?.applyFlag(a, from); break;
      case 'horn': g.finale?.applyHorn(a, from); break;
      case 'pyre': g.finale?.applyPyre(a, from); break;
      case 'deadfall': g.finale?.applyDeadfall(a, from); break;
      case 'board': g.finale?.applyBoard(a, from); break;
      case 'sleep': g.combat?.applySleep(a, from); break;
      case 'noise': g.wendigo?.hear(a, from); g.wildlife?.scare(a, a.r || 30); break;
      default: g.onEvent?.({ ...a, k: 'act:' + a.k }, from);
    }
  }
  give(to, name, n) {
    const g = this.g;
    if (to === g.me) g.inventory?.add(name, n);
    else g.net.sendEvent({ k: 'give', to, name, n });
  }
  /* ---------------- world snapshot */
  snapshot() {
    const g = this.g, A = g.atmos;
    return {
      h: +A.hour.toFixed(3), d: A.day, wx: A.weather, sil: g.director?.silence ? +g.director.silence.toFixed(2) : 0,
      wd: g.wendigo?.snapshot?.() || null, an: g.wildlife?.snapshot?.() || null, cn: g.cannibals?.snapshot?.() || null,
      fi: g.fires ? g.fires.list.filter(f => f.shared).map(f => [f.id, f.lit ? 1 : 0, Math.round(f.fuel)]) : null,
      fn: g.finale?.snapshot?.() || null,
    };
  }
  applyWorld(w) {
    const g = this.g, A = g.atmos;
    if (Math.abs(A.hour - w.h) > 0.05 && Math.abs(A.hour - w.h) < 23) A.hour = w.h; else if (Math.abs(A.hour - w.h) >= 23) A.hour = w.h;
    A.day = w.d; if (A.weather !== w.wx) A.setWeather(w.wx);
    if (g.director) g.director.remoteSilence = w.sil;
    if (w.wd) g.wendigo?.applySnapshot?.(w.wd);
    if (w.an) g.wildlife?.applySnapshot?.(w.an);
    if (w.cn) g.cannibals?.applySnapshot?.(w.cn);
    if (w.fi) for (const [id, lit, fuel] of w.fi) { const f = g.fires?.byId(id); if (f) { f.fuel = fuel; if (!!lit !== f.lit) { f.lit = !!lit; g.fires._vis(f); } } }
    if (w.fn) g.finale?.applySnapshot?.(w.fn);
  }
  _mergeSave(s) {
    const g = this.g; if (!s) return;
    // clients keep their own inventory; everything else follows the host
    const keep = g.W?.players;
    g.W = s; if (keep) g.W.players = keep;
  }
  update(dt) {
    const g = this.g, n = g.net;
    if (!n.isOnline || g.phase !== 'play' && g.phase !== 'end') return;
    n.sendPlayer(g.player.state(), dt);
    if (g.isHost) n.sendWorld(() => this.snapshot(), dt);
  }
}
