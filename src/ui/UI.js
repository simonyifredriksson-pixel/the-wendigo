/* UI.js - menus. Everything that pauses the hands.

   title     name, look (the four survivors), continue / new / host / join, settings
   pause     resume, journal, settings, the room code, leave
   bag       (I) everything you carry: eat, equip, drop; crafting on the right
   craft     the workbench: the bench recipes (and the hand ones)
   journal   (J) the notes, carvings and discoveries, and what you think you must do
   stash     a storage box: move things in and out
   settings  sensitivity, invert, field of view, volume, music, quality, subtitles, the intro

   One panel element (#panel) is reused; open(name, arg) renders it.
   Esc closes the current panel (or opens pause). */
import { ITEMS, RECIPES, label } from '../data/Items.js';
import { saveProfile } from '../game/State.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LOOKS = [{ c: '#c8462a', n: 'Red shell' }, { c: '#5f6f3c', n: 'Olive parka' }, { c: '#2c3d70', n: 'Navy puffer' }, { c: '#d8b02a', n: 'Yellow rain' }];

export class UI {
  constructor(game) {
    this.g = game; this.modal = null; this.arg = null;
    this.panel = $('panel');
    addEventListener('keydown', (e) => this._key(e));
    this.panel.addEventListener('click', (e) => this._click(e));
  }
  /* ---------------------------------------------------------------- title */
  title(profile, h) {
    this.h = h;
    $('tname').value = profile.name;
    const looks = $('looks');
    const draw = () => { looks.innerHTML = LOOKS.map((l, i) => `<button data-look="${i}" title="${l.n}" class="${profile.look === i ? 'on' : ''}" style="background:${l.c}"></button>`).join(''); };
    draw();
    looks.onclick = (e) => { const b = e.target.closest('[data-look]'); if (!b) return; profile.look = +b.dataset.look; saveProfile(profile); draw(); this.g.audio.uiClick?.(); };
    if (!h.hasSave) $('bcont').style.display = 'none'; else $('bnew').classList.remove('big');
    const keep = () => { profile.name = ($('tname').value || 'Survivor').replace(/[<>]/g, '').slice(0, 16); saveProfile(profile); h.unlock(); };
    const go = (fn) => () => { keep(); this.g.audio.uiClick?.(); $('title').classList.add('gone'); setTimeout(() => $('title').classList.add('hidden'), 1400); fn(); };
    $('bcont').onclick = go(h.cont);
    $('bnew').onclick = () => { if (h.hasSave && !confirm('Start again? The island you have now will be lost.')) return; go(h.fresh)(); };
    $('bhost').onclick = async () => { keep(); $('tmsg').textContent = 'Opening a room...'; try { $('title').classList.add('gone'); await h.host(); setTimeout(() => $('title').classList.add('hidden'), 1400); } catch (e) { $('title').classList.remove('gone'); $('tmsg').textContent = e.message; } };
    $('bjoin').onclick = async () => { keep(); $('tmsg').textContent = 'Connecting...'; try { await h.join($('tcode').value); $('title').classList.add('gone'); setTimeout(() => $('title').classList.add('hidden'), 1400); } catch (e) { $('tmsg').textContent = e.message; } };
    $('tcode').onkeydown = (e) => { if (e.key === 'Enter') $('bjoin').click(); };
    $('bset').onclick = () => this.open('settings');
  }
  showTitle() { $('title').classList.remove('hidden', 'gone'); }

  /* ---------------------------------------------------------------- panels */
  open(name, arg) {
    const g = this.g;
    this.modal = name; this.arg = arg;
    g.input.unlock?.(); g.input.blocked = name !== null && name !== 'none';
    this.panel.className = 'on ' + name;
    this.render();
    g.audio.uiOpen?.();
  }
  close() {
    if (!this.modal) return;
    this.modal = null; this.panel.className = ''; this.panel.innerHTML = '';
    this.g.input.blocked = false;
    if (this.g.phase === 'play') this.g.input.lock?.();
    this.g.audio.uiClose?.();
  }
  render() {
    const m = this.modal; if (!m) return;
    const fn = { pause: this._pause, bag: this._bag, craft: this._bag, journal: this._journal, stash: this._stash, settings: this._settings }[m];
    this.panel.innerHTML = fn ? fn.call(this) : '';
  }
  _key(e) {
    const g = this.g;
    if (g.chatOpen || e.target?.tagName === 'INPUT') return;
    if (g.phase !== 'play') { if (e.code === 'Escape' && this.modal === 'settings') this.close(); return; }
    if (e.code === 'Escape') { if (this.modal) this.close(); else if (!g.build?.active && !g.cutscene) this.open('pause'); e.preventDefault(); return; }
    if (e.code === 'KeyI') { if (this.modal === 'bag') this.close(); else if (!this.modal && !g.cutscene) this.open('bag'); }
    if (e.code === 'KeyJ') { if (this.modal === 'journal') this.close(); else if (!this.modal && !g.cutscene) this.open('journal'); }
  }
  _click(e) {
    const g = this.g, b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, v = b.dataset.v;
    g.audio.uiClick?.();
    if (a === 'close') return this.close();
    if (a === 'resume') return this.close();
    if (a === 'open') return this.open(v);
    if (a === 'use') { g.inventory.use(v); return this.render(); }
    if (a === 'drop') { if (g.inventory.count(v)) { g.inventory.remove(v, 1); g.items?.dropAt(v, 1); } return this.render(); }
    if (a === 'craft') { const r = RECIPES[+v]; g.inventory.craft(r); return this.render(); }
    if (a === 'put' || a === 'takeout') { g.act({ k: 'stash', id: this.arg, item: v, dir: a === 'put' ? 1 : -1 }); if (a === 'put') g.inventory.remove(v, 1); setTimeout(() => this.render(), 120); return; }
    if (a === 'leave') { if (confirm('Leave the island? (Your progress is saved.)')) { g.saveNow(); location.reload(); } return; }
    if (a === 'set') return this._set(b.dataset.k, v);
  }

  /* ---------------------------------------------------------------- pause */
  _pause() {
    const g = this.g, n = g.net;
    const code = n.isHost && n.room ? `<div class="room">Room code <b>${n.room}</b><span>Friends press JOIN and type it</span></div>` : '';
    const who = n.isOnline ? `<div class="who">${n.lobbyList.map(p => `<span>${esc(p.name)}${p.host ? ' (host)' : ''}${p.you ? ' (you)' : ''}</span>`).join('')}</div>` : '';
    return `<div class="box narrow"><h1>PAUSED</h1>${code}${who}
      <button data-a="resume" class="big">RESUME</button>
      <button data-a="open" data-v="journal">JOURNAL</button>
      <button data-a="open" data-v="bag">BACKPACK</button>
      <button data-a="open" data-v="settings">SETTINGS</button>
      <button data-a="leave">LEAVE</button>
      <div class="keys">WASD move &middot; Shift run &middot; C crouch &middot; Space jump &middot; E use &middot; LMB swing &middot; F light &middot; 1-8 tools &middot; Q hands &middot; G drop log &middot; B build &middot; I backpack &middot; J journal &middot; Tab status &middot; Enter chat</div></div>`;
  }
  /* ---------------------------------------------------------------- backpack + crafting */
  _bag() {
    const g = this.g, inv = g.inventory, bench = this.modal === 'craft';
    const names = Object.keys(inv.items).sort((a, b) => (ITEMS[a]?.kind || '').localeCompare(ITEMS[b]?.kind || '') || a.localeCompare(b));
    const row = (n) => {
      const it = ITEMS[n] || {}, c = inv.count(n);
      const acts = [];
      if (it.food) acts.push(`<button data-a="use" data-v="${n}">${it.kind === 'med' ? 'USE' : 'EAT'}</button>`);
      if (it.tool) acts.push(`<button data-a="use" data-v="${n}">${inv.held === n ? 'HELD' : 'HOLD'}</button>`);
      if (it.kind !== 'relic' && it.kind !== 'note') acts.push(`<button data-a="drop" data-v="${n}">DROP</button>`);
      return `<div class="it ${it.kind || ''}"><div class="n">${esc(label(n))}${c > 1 ? `<em>x${c}</em>` : ''}</div><div class="d">${esc(it.desc || '')}</div><div class="a">${acts.join('')}</div></div>`;
    };
    const recipes = RECIPES.map((r, i) => {
      if (r.story && !this.g.W?.flags?.knowsSpear) return '';
      const ok = inv.craftable(r, bench), here = r.where === 'hand' || bench;
      const need = Object.entries(r.need).map(([n, c]) => `<span class="${inv.count(n) >= c ? 'have' : ''}">${c} ${esc(label(n).toLowerCase())}</span>`).join(' ');
      return `<div class="rc${ok ? ' ok' : ''}${here ? '' : ' far'}"><div class="n">${esc(label(r.out))}${r.n > 1 ? ' x' + r.n : ''}</div><div class="need">${need}${r.where === 'bench' && !bench ? ' <i>at a workbench</i>' : ''}</div>${ok ? `<button data-a="craft" data-v="${i}">MAKE</button>` : ''}</div>`;
    }).join('');
    const p = g.player;
    return `<div class="box wide"><h1>${bench ? 'WORKBENCH' : 'BACKPACK'}</h1>
      <div class="cols"><div class="col"><h2>Carrying</h2>${names.map(row).join('') || '<div class="empty">Nothing.</div>'}</div>
      <div class="col"><h2>Make</h2>${recipes}</div></div>
      <div class="stat">Health ${Math.round(p.health)} &middot; Hunger ${Math.round(p.hunger)} &middot; Warmth ${Math.round(p.warmth)}${inv.count('flashlight') ? ' &middot; Battery ' + Math.round(inv.battery * 100) + '%' : ''}</div>
      <button data-a="close" class="x">CLOSE</button></div>`;
  }
  /* ---------------------------------------------------------------- storage */
  _stash() {
    const g = this.g, inv = g.inventory, box = g.W?.stash?.[this.arg] || {};
    const mine = Object.keys(inv.items).filter(n => ITEMS[n]?.kind !== 'relic').map(n => `<div class="it"><div class="n">${esc(label(n))}<em>x${inv.count(n)}</em></div><div class="a"><button data-a="put" data-v="${n}">PUT IN</button></div></div>`).join('');
    const theirs = Object.keys(box).filter(n => box[n] > 0).map(n => `<div class="it"><div class="n">${esc(label(n))}<em>x${box[n]}</em></div><div class="a"><button data-a="takeout" data-v="${n}">TAKE</button></div></div>`).join('');
    return `<div class="box wide"><h1>STORAGE BOX</h1><div class="cols"><div class="col"><h2>You</h2>${mine || '<div class="empty">Nothing.</div>'}</div><div class="col"><h2>Box</h2>${theirs || '<div class="empty">Empty.</div>'}</div></div><button data-a="close" class="x">CLOSE</button></div>`;
  }
  /* ---------------------------------------------------------------- journal */
  _journal() {
    const st = this.g.story;
    const entries = st?.journal?.() || [];
    const goal = st?.goalText?.() || 'Survive.';
    return `<div class="box journal"><h1>JOURNAL</h1><div class="goal">${esc(goal)}</div>
      ${entries.length ? entries.map(e => `<div class="je ${e.kind}">${e.img ? `<img src="${e.img}">` : ''}<div class="jt">${esc(e.title)}</div><div class="jb">${esc(e.text).replace(/\n/g, '<br>')}</div></div>`).join('') : '<div class="empty">Nothing written yet. Explore.</div>'}
      <button data-a="close" class="x">CLOSE</button></div>`;
  }
  /* ---------------------------------------------------------------- settings */
  _settings() {
    const p = this.g.profile;
    const sl = (k, l, min, max, step, v) => `<label class="set"><span>${l}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-k="${k}"></label>`;
    const tg = (k, l, v) => `<label class="set"><span>${l}</span><button data-a="set" data-k="${k}" data-v="${v ? 0 : 1}" class="tog${v ? ' on' : ''}">${v ? 'ON' : 'OFF'}</button></label>`;
    const q = ['low', 'medium', 'high'].map(x => `<button data-a="set" data-k="quality" data-v="${x}" class="${p.quality === x ? 'on' : ''}">${x.toUpperCase()}</button>`).join('');
    setTimeout(() => this.panel.querySelectorAll('input[type=range]').forEach(r => r.oninput = () => this._set(r.dataset.k, r.value)), 0);
    return `<div class="box narrow"><h1>SETTINGS</h1>
      ${sl('sens', 'Mouse sensitivity', 0.2, 3, 0.05, p.sens)}${sl('fov', 'Field of view', 60, 95, 1, p.fov)}
      ${sl('vol', 'Volume', 0, 1, 0.01, p.vol)}${sl('music', 'Music', 0, 1, 0.01, p.music)}
      ${tg('invert', 'Invert mouse', p.invert)}${tg('subtitles', 'Subtitles', p.subtitles)}${tg('intro', 'Play the opening', p.intro)}
      <label class="set"><span>Graphics</span><span class="qs">${q}</span></label>
      <button data-a="${this.g.phase === 'play' ? 'open' : 'close'}" data-v="pause" class="x">BACK</button></div>`;
  }
  _set(k, v) {
    const g = this.g, p = g.profile;
    if (k === 'quality') { p.quality = v; g.applyQuality?.(v); }
    else if (k === 'invert' || k === 'subtitles' || k === 'intro') p[k] = v === '1' || v === 1;
    else p[k] = +v;
    g.input.sensitivity = p.sens; g.input.invertY = p.invert;
    if (k === 'fov') { g.camera.fov = p.fov; g.camera.updateProjectionMatrix(); }
    if (k === 'vol' || k === 'music') g.audio.setVolume?.(p.vol, p.music);
    saveProfile(p);
    if (k !== 'sens' && k !== 'fov' && k !== 'vol' && k !== 'music') this.render();
  }
  update() { if (this.modal === 'bag' || this.modal === 'craft') { this._rt = (this._rt || 0) + 1; } }
}
