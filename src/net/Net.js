/* Net.js - co-op for up to four players over WebRTC (PeerJS signalling).

   Star topology: the host owns the world. Clients send their own avatar
   state and ACTIONS ("I caught this", "build that exhibit"); the host
   performs them and the result reaches everyone through the next world
   snapshot. So there is one zoo, one purse and one herd of wild animals,
   and no two players can both rope the same dinosaur.

   Messages
     hello   client -> host      name, look, build
     welcome host -> client      your id, everyone's profile, the host save
     p       anyone              player state (15 Hz), host relays
     w       host -> clients     world snapshot (10 Hz)
     s       host -> clients     the save (on change, at most every 2 s)
     a       client -> host      an action to perform
     e       anyone              a one-off event (dialogue, bark, chat, fx) */

const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};
const PREFIX = 'thewendigo-v1-';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
// bump whenever the species list or a message format changes: an older
// client would meet fish it has never heard of
export const BUILD = 1;

function code() { let s = ''; for (let i = 0; i < 5; i++) s += LETTERS[Math.floor(Math.random() * LETTERS.length)]; return s; }
const clean = (s, n = 16) => String(s || '').replace(/[<>]/g, '').slice(0, n);


/* A stand-in for PeerJS over BroadcastChannel, used only by the two-window
   test (?loop). It implements exactly the slice of the PeerJS API that Net
   uses, so the whole co-op protocol can be exercised without WebRTC. */
class LoopConn {
  constructor(ch, self, other, cid) { this.ch = ch; this.self = self; this.peer = other; this.cid = cid; this.open = false; this.h = {}; }
  on(k, f) { this.h[k] = f; }
  send(d) { this.ch.postMessage({ kind: 'data', cid: this.cid, to: this.peer, data: JSON.parse(JSON.stringify(d)) }); }
  close() { this.ch.postMessage({ kind: 'close', cid: this.cid, to: this.peer }); }
  _fire(k, v) { if (this.h[k]) this.h[k](v); }
}
class LoopPeer {
  constructor(id) {
    this.id = id || 'p' + Math.random().toString(36).slice(2, 9);
    this.h = {}; this.conns = new Map();
    this.ch = new BroadcastChannel('wd-loop');
    this.ch.onmessage = e => this._msg(e.data);
    setTimeout(() => this.h.open && this.h.open(this.id), 50);
  }
  on(k, f) { this.h[k] = f; }
  connect(to) {
    const cid = this.id + '>' + to + Math.random().toString(36).slice(2, 6);
    const c = new LoopConn(this.ch, this.id, to, cid);
    this.conns.set(cid, c);
    this.ch.postMessage({ kind: 'dial', cid, from: this.id, to });
    return c;
  }
  _msg(m) {
    if (m.kind === 'dial' && m.to === this.id) {
      const c = new LoopConn(this.ch, this.id, m.from, m.cid);
      this.conns.set(m.cid, c);
      if (this.h.connection) this.h.connection(c);
      setTimeout(() => { c.open = true; c._fire('open'); this.ch.postMessage({ kind: 'ack', cid: m.cid, to: m.from }); }, 30);
    } else if (m.kind === 'ack' && m.to === this.id) {
      const c = this.conns.get(m.cid); if (c) { c.open = true; c._fire('open'); }
    } else if (m.kind === 'data' && m.to === this.id) {
      const c = this.conns.get(m.cid); if (c) c._fire('data', m.data);
    } else if (m.kind === 'close' && m.to === this.id) {
      const c = this.conns.get(m.cid); if (c) { c.open = false; c._fire('close'); }
    }
  }
  destroy() { this.ch.close(); }
}
const LOOP = typeof location !== 'undefined' && /[?&]loop/.test(location.search);
const PeerCtor = () => (LOOP ? LoopPeer : window.Peer);
export class Net {
  constructor() {
    this.peer = null; this.role = 'offline'; this.room = null; this.selfId = null;
    this.conns = new Map();        // host: id -> conn
    this.hostConn = null;
    this.profiles = new Map();     // id -> {name, look}
    this.status = '';
    this.profile = { name: 'Survivor', look: 0 };
    this.on = {};
    this._pT = 0; this._wT = 0;
    this.stats = { tx: {}, rx: {} };
  }
  static get available() { return LOOP || (typeof window !== 'undefined' && !!window.Peer); }
  get isOnline() { return this.role !== 'offline'; }
  get isHost() { return this.role === 'host'; }
  get isClient() { return this.role === 'client'; }
  get count() { return 1 + this.profiles.size; }
  get lobbyList() {
    const out = [{ id: this.selfId, name: this.profile.name, you: true, host: this.isHost }];
    for (const [id, p] of this.profiles) out.push({ id, name: p.name, host: p.host });
    return out;
  }
  _emit(k, ...a) { if (this.on[k]) try { this.on[k](...a); } catch (e) { console.error('[net]', k, e); if (window.__log && (this['_e' + k] = (this['_e' + k] || 0) + 1) < 4) { window.__log('NET ' + k + ': ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' ')); } } }
  _status(s) { this.status = s; this._emit('status', s); }

  host(profile) {
    this.profile = profile;
    return new Promise((res, rej) => {
      if (!Net.available) return rej(new Error('Co-op needs an internet connection (PeerJS could not load).'));
      const tryOne = (left) => {
        const c = code();
        const P = PeerCtor(); const p = new P(PREFIX + c, { debug: 0, config: ICE });
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; p.destroy(); rej(new Error('The matchmaking server did not answer.')); } }, 12000);
        p.on('open', id => {
          if (done) return; done = true; clearTimeout(timer);
          this.peer = p; this.role = 'host'; this.room = c; this.selfId = id;
          this._status('Room open. Share the code: ' + c);
          p.on('connection', conn => this._accept(conn));
          res(c);
        });
        p.on('error', e => {
          if (done) { this._status('Network: ' + (e.type || e.message)); return; }
          if (e.type === 'unavailable-id' && left > 0) { done = true; clearTimeout(timer); p.destroy(); tryOne(left - 1); return; }
          done = true; clearTimeout(timer); p.destroy(); rej(new Error('Could not open a room (' + (e.type || 'error') + ').'));
        });
      };
      tryOne(4);
    });
  }

  _accept(conn) {
    conn.on('open', () => {
      if (this.conns.size >= 3) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 300); return; }
      this.conns.set(conn.peer, conn);
      conn.on('data', d => this._hostData(conn, d));
      conn.on('close', () => this._drop(conn.peer));
      conn.on('error', () => this._drop(conn.peer));
    });
  }
  _drop(id) {
    if (!this.conns.has(id) && !this.profiles.has(id)) return;
    this.conns.delete(id);
    const p = this.profiles.get(id);
    this.profiles.delete(id);
    this._broadcast({ t: 'left', id });
    this._emit('leave', id, p);
  }
  _broadcast(msg, except = null) { this.stats.tx[msg.t] = (this.stats.tx[msg.t] || 0) + 1; for (const [id, c] of this.conns) if (id !== except && c.open) try { c.send(msg); } catch (e) { this.stats.tx.err = String(e); } }

  _hostData(conn, d) {
    if (!d || typeof d !== 'object') return;
    const id = conn.peer;
    if (d.t === 'hello') {
      if (d.v !== BUILD) { conn.send({ t: 'version', v: BUILD }); return; }
      const prof = { name: clean(d.name) || 'Survivor', look: (d.look | 0) % 4, key: String(d.key || id).replace(/[^a-z0-9]/gi, '').slice(0, 32) || id };
      this.profiles.set(id, prof);
      const everyone = [{ id: this.selfId, ...this.profile, host: true }, ...[...this.profiles].map(([pid, p]) => ({ id: pid, ...p }))];
      conn.send({ t: 'welcome', id, players: everyone, save: this._emitGet('getSave') });
      this._broadcast({ t: 'joined', id, p: prof }, id);
      this._emit('join', id, prof);
      return;
    }
    if (!this.profiles.has(id)) return;
    if (d.t === 'p') { this._emit('player', id, d.s); this._broadcast({ t: 'p', id, s: d.s }, id); }
    else if (d.t === 'a') this._emit('action', id, d.a);
    else if (d.t === 'e') { this._emit('event', id, d.e); this._broadcast({ t: 'e', id, e: d.e }, id); }
  }
  _emitGet(k) { return this.on[k] ? this.on[k]() : null; }

  join(c, profile) {
    this.profile = profile;
    c = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    return new Promise((res, rej) => {
      if (!Net.available) return rej(new Error('Co-op needs an internet connection (PeerJS could not load).'));
      if (c.length !== 5) return rej(new Error('Room codes are five characters.'));
      this._status('Connecting...');
      const P = PeerCtor(); const p = new P(undefined, { debug: 0, config: ICE });
      let done = false;
      const fail = msg => { if (done) return; done = true; try { p.destroy(); } catch (e) { /* */ } this.role = 'offline'; rej(new Error(msg)); };
      const timer = setTimeout(() => fail('Could not reach that room. Check the code and try again.'), 30000);
      p.on('error', e => fail(e.type === 'peer-unavailable' ? 'No room with that code.' : 'Network error (' + (e.type || 'unknown') + ').'));
      p.on('open', () => {
        const conn = p.connect(PREFIX + c, { reliable: true });
        conn.on('open', () => conn.send({ t: 'hello', name: profile.name, look: profile.look, key: profile.key, v: BUILD }));
        conn.on('data', d => {
          if (!d || typeof d !== 'object') return;
          if (d.t === 'welcome') {
            if (done) return; done = true; clearTimeout(timer);
            this.peer = p; this.hostConn = conn; this.role = 'client'; this.room = c; this.selfId = d.id;
            for (const pl of d.players) if (pl.id !== d.id) this.profiles.set(pl.id, { name: clean(pl.name), look: pl.look | 0, host: !!pl.host });
            this._status('Connected to room ' + c);
            this._emit('welcome', d);
            res(d);
          } else if (d.t === 'full') fail('That group is full (4 players).');
          else if (d.t === 'version') fail('Your friend is running a different version. Both refresh the page.');
          else this._clientData(d);
        });
        conn.on('close', () => { if (done && this.role === 'client') { this.role = 'offline'; this._emit('lost'); } });
      });
    });
  }

  _clientData(d) {
    this.stats.rx[d.t] = (this.stats.rx[d.t] || 0) + 1;
    if (d.t === 'p') this._emit('player', d.id, d.s);
    else if (d.t === 'w') this._emit('world', d.w);
    else if (d.t === 's') this._emit('saveIn', d.s);
    else if (d.t === 'e') this._emit('event', d.id, d.e);
    else if (d.t === 'joined') { this.profiles.set(d.id, { name: clean(d.p.name), look: d.p.look | 0 }); this._emit('join', d.id, d.p); }
    else if (d.t === 'left') { const p = this.profiles.get(d.id); this.profiles.delete(d.id); this._emit('leave', d.id, p); }
  }

  /* ---------------- sending ---------------- */
  sendPlayer(s, dt) {
    if (!this.isOnline) return;
    this._pT -= dt;
    if (this._pT > 0) return;
    this._pT = 1 / 15;
    if (this.isHost) this._broadcast({ t: 'p', id: this.selfId, s });
    else if (this.hostConn?.open) this.hostConn.send({ t: 'p', s });
  }
  sendWorld(fn, dt) {
    if (!this.isHost || !this.conns.size) return;
    this._wT -= dt;
    if (this._wT > 0) return;
    this._wT = 0.1;
    this._broadcast({ t: 'w', w: fn() });
  }
  sendSave(save) { if (this.isHost && this.conns.size) this._broadcast({ t: 's', s: save }); }
  sendAction(a) { if (this.isClient && this.hostConn?.open) this.hostConn.send({ t: 'a', a }); }
  sendEvent(e) {
    if (!this.isOnline) return;
    if (this.isHost) this._broadcast({ t: 'e', id: this.selfId, e });
    else if (this.hostConn?.open) this.hostConn.send({ t: 'e', e });
  }

  leave() {
    try { if (this.peer) this.peer.destroy(); } catch (e) { /* */ }
    this.peer = null; this.role = 'offline'; this.room = null; this.conns.clear(); this.profiles.clear(); this.hostConn = null;
    this._status('');
  }
}

