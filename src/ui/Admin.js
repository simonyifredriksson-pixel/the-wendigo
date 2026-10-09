/* Admin.js - the admin panel (F9 or ` ). Host/solo only.
   God mode, noclip, speed, give everything, time and weather, teleport to
   any landmark or cave, trigger every Wendigo encounter, spawn animals,
   reveal the whole journal. A small readout shows position, time, FPS and
   the Wendigo's state. */
import { ITEMS } from '../data/Items.js';
import { LORE } from '../game/Story.js';

const PLACES = ['crash', 'cabin', 'survey', 'beachcamp', 'tower', 'village', 'camp2', 'ruins', 'circle', 'dock'];

export class Admin {
  constructor(game) {
    this.g = game; this.on = false;
    const el = this.el = document.createElement('div'); el.id = 'admin'; document.body.appendChild(el);
    addEventListener('keydown', (e) => {
      if (e.target?.tagName === 'INPUT') return;
      if (e.code === 'F9' || e.code === 'Backquote') { e.preventDefault(); this.toggle(); }
    });
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) { this.run(b.dataset.a, b.dataset.v); this.render(); } });
    this.fpsT = 0; this.frames = 0; this.fps = 0;
  }
  toggle() {
    const g = this.g;
    if (!g.isHost) { g.hud.toast('Only the host can use the admin panel.'); return; }
    this.on = !this.on; this.el.classList.toggle('on', this.on);
    if (this.on) { g.input.unlock?.(); g.input.blocked = true; this.render(); } else { g.input.blocked = false; if (g.phase === 'play') g.input.lock?.(); }
  }
  render() {
    const g = this.g, p = g.player;
    const b = (a, l, v = '', on) => `<button data-a="${a}" data-v="${v}" class="${on ? 'on' : ''}">${l}</button>`;
    this.el.innerHTML = `<div class="ah">ADMIN <span>F9 to close</span></div>
      <div class="ag"><h3>Player</h3>${b('god', 'God mode', '', p.god)}${b('noclip', 'Noclip (fly)', '', p.noclip)}${b('speed', 'Speed x3', '', p.speedMul > 1)}${b('heal', 'Heal all')}${b('give', 'Give everything')}${b('logs', '+4 logs')}${b('relics', 'Give the relics')}</div>
      <div class="ag"><h3>Time</h3>${[6, 9, 12, 16, 19.5, 21, 0, 3].map(h => b('hour', String(h).padStart(2, '0') + ':00', h)).join('')}${b('fast', g.atmos.speed > 0.1 ? 'Normal time' : 'Fast time')}${b('freeze', g.freezeTime ? 'Unfreeze time' : 'Freeze time')}</div>
      <div class="ag"><h3>Weather</h3>${['clear', 'cloudy', 'fog', 'rain', 'storm'].map(w => b('weather', w, w, g.atmos.weather === w)).join('')}</div>
      <div class="ag"><h3>Go to</h3>${PLACES.map(id => b('tp', g.island.landmark(id)?.name || id, id)).join('')}${g.island.caves.map(c => b('tpc', c.name, c.id)).join('')}</div>
      <div class="ag"><h3>The Wendigo</h3>${b('wd', '1 Sounds far away', 1)}${b('wd', '2 Distant sighting', 2)}${b('wd', '3 Watching', 3)}${b('wd', 'The reveal', 'reveal')}${b('wd', '4 HUNT', 4)}${b('wdoff', 'Send it away')}${b('camp', 'Visit the camp')}</div>
      <div class="ag"><h3>Scares</h3>${['silence', 'branch', 'footsteps', 'knock', 'scream', 'mimic', 'firelight', 'eyes'].map(k => b('scare', k, k)).join('')}</div>
      <div class="ag"><h3>World</h3>${b('lore', 'Reveal the journal')}${b('finale', 'Start the finale')}${b('menace', 'Menace +')}</div>
      <div class="ar" id="aread"></div>`;
  }
  run(a, v) {
    const g = this.g, p = g.player, inv = g.inventory;
    switch (a) {
      case 'god': p.god = !p.god; break;
      case 'noclip': p.noclip = !p.noclip; break;
      case 'speed': p.speedMul = p.speedMul > 1 ? 1 : 3; break;
      case 'heal': Object.assign(p, { health: 100, stamina: 100, hunger: 100, warmth: 100 }); break;
      case 'give': for (const k in ITEMS) if (!['journal', 'note'].includes(k)) inv.add(k, ITEMS[k].kind === 'tool' || ITEMS[k].kind === 'relic' ? 1 : 10, true); inv.items.log = 4; inv._sync(); g.hud.hotbar?.(); break;
      case 'logs': inv.add('log', 4, true); break;
      case 'relics': for (const r of ['emberStone', 'ashSpearhead', 'boneHorn']) g.act({ k: 'flag', relic: r }); break;
      case 'hour': g.atmos.hour = +v; break;
      case 'fast': g.atmos.speed = g.atmos.speed > 0.1 ? 24 / (24 * 60) : 0.4; break;
      case 'freeze': g.freezeTime = !g.freezeTime; break;
      case 'weather': g.atmos.setWeather(v); break;
      case 'tp': { const l = g.island.landmark(v); p.spawn(l.x + l.r * 0.8 + 3, l.z + 3, 0); break; }
      case 'tpc': { const c = g.island.cave(v); p.spawn(c.x + Math.sin(c.dir) * 9, c.z + Math.cos(c.dir) * 9, c.dir); break; }
      case 'wd': { g.wendigo?._vanish?.(); const t = g.wendigo?._people()[0]; if (t) g.wendigo.request(v === 'reveal' ? 'reveal' : +v, t); this.toggle(); break; }
      case 'wdoff': g.wendigo?._vanish?.(); break;
      case 'camp': g.director?._visitCamp?.(); break;
      case 'scare': g.director?.fire(v); this.toggle(); break;
      case 'lore': for (const k in LORE) g.story?.applyLore({ key: k }); break;
      case 'finale': g.finale?.begin?.(); this.toggle(); break;
      case 'menace': g.atmos.day += 1; break;
    }
  }
  update(dt) {
    this.frames++; this.fpsT += dt;
    if (this.fpsT >= 1) { this.fps = this.frames; this.frames = 0; this.fpsT = 0; }
    if (!this.on) return;
    const g = this.g, p = g.player.pos, W = g.wendigo, el = document.getElementById('aread');
    if (el) el.textContent = `pos ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}  ·  day ${g.atmos.day} ${g.atmos.hour.toFixed(2)}h  ·  ${this.fps} fps  ·  menace ${(g.director?.menace ?? 0).toFixed(2)}  ·  wendigo ${W ? W.state + (W.present ? ' @' + Math.hypot(W.pos.x - p.x, W.pos.z - p.z).toFixed(0) + 'm' : '') : '-'}  ·  animals ${g.wildlife?.list.length ?? 0}  ·  tris ${g.renderer.info.render.triangles}`;
  }
}
