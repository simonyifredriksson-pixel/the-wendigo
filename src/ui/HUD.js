/* HUD.js - the little that stays on screen. The forest should fill the view.

   Bottom left   four thin vitals (health, stamina, hunger, warmth). Each one
                 only shows while it is not comfortable; all fade away when
                 you are fine. Warmth gets a frost tint at the screen edges.
   Bottom centre the hotbar - only while you switch, then it fades.
   Centre        a pin-prick crosshair, the interaction prompt with a hold ring.
   Top left      the current objective: shows when it changes, fades; hold Tab.
   Also          toasts, subtitles (radio, whispers), the downed overlay,
                 the build menu, chat, a compass strip while holding Tab,
                 the save flicker, and red slivers showing where a hit came from. */
import { ITEMS, PIECES, BUILD_ORDER, label } from '../data/Items.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class HUD {
  constructor(game) {
    this.g = game;
    const h = $('hud');
    h.innerHTML = `
      <div id="cross"></div>
      <div id="prompt"><svg viewBox="0 0 40 40" class="ring"><circle cx="20" cy="20" r="16"/><circle id="ringfill" cx="20" cy="20" r="16"/></svg><span class="key">E</span><span id="ptext"></span></div>
      <div id="vitals">
        <div class="vit" id="v-hp"><span>HEALTH</span><b><i></i></b></div>
        <div class="vit" id="v-st"><span>STAMINA</span><b><i></i></b></div>
        <div class="vit" id="v-hu"><span>HUNGER</span><b><i></i></b></div>
        <div class="vit" id="v-wa"><span>WARMTH</span><b><i></i></b></div>
      </div>
      <div id="hotbar"></div>
      <div id="held"></div>
      <div id="obj"><div class="ot" id="ot"></div><div class="os" id="os"></div></div>
      <div id="toasts"></div>
      <div id="hits"></div>
      <div id="hitmark"></div>
      <div id="compass"><div id="cstrip"></div></div>
      <div id="clock"></div>
      <div id="save">SAVING</div>
      <div id="downed"><div class="dt">YOU ARE DOWN</div><div class="ds" id="dsub"></div></div>
      <div id="frost"></div>
      <div id="buildm"></div>
      <div id="chatlog"></div>`;
    this.objT = 0; this.hotT = 0; this.subs = $('subs');
    this._buildCompass();
  }
  show() { $('hud').classList.remove('hidden'); }
  hide() { $('hud').classList.add('hidden'); }
  /* ---------------- prompts & messages */
  prompt(text, frac, hold) {
    const p = $('prompt');
    if (!text) { p.classList.remove('on'); this._pt = null; return; }
    if (text !== this._pt) { this._pt = text; $('ptext').textContent = text; }
    p.classList.add('on'); p.classList.toggle('hold', !!hold);
    $('ringfill').style.strokeDashoffset = String(100.5 * (1 - (frac || 0)));
  }
  toast(t, secs = 3.4) {
    const box = $('toasts'); if (!box) return;
    const d = document.createElement('div'); d.className = 'toast'; d.textContent = t; box.appendChild(d);
    setTimeout(() => d.classList.add('out'), secs * 1000); setTimeout(() => d.remove(), secs * 1000 + 800);
    while (box.children.length > 4) box.firstChild.remove();
  }
  pickup(name, n) {
    // stack repeated pickups into one line: "+3 sticks"
    const now = performance.now();
    if (this._lastPick && this._lastPick.name === name && now - this._lastPick.t < 2500 && this._lastPick.el.isConnected) {
      this._lastPick.n += n; this._lastPick.t = now; this._lastPick.el.textContent = '+' + this._lastPick.n + '  ' + label(name);
      return;
    }
    const box = $('toasts'); const d = document.createElement('div'); d.className = 'toast pick'; d.textContent = '+' + n + '  ' + label(name); box.appendChild(d);
    setTimeout(() => d.classList.add('out'), 2600); setTimeout(() => d.remove(), 3400);
    this._lastPick = { name, n, t: now, el: d };
    this.g.audio.pickup?.(ITEMS[name]?.kind === 'food' ? 'food' : name === 'log' || name === 'stick' ? 'wood' : name === 'stone' ? 'stone' : ITEMS[name]?.kind === 'relic' ? 'relic' : 'item');
  }
  subtitle(who, text, dur = 4, kind = '') {
    if (this.g.profile.subtitles === false && kind !== 'force') return;
    const d = document.createElement('div'); d.className = 'sub ' + kind;
    d.innerHTML = (who ? `<b>${esc(who)}</b> ` : '') + esc(text);
    this.subs.appendChild(d);
    while (this.subs.children.length > 2) this.subs.firstChild.remove();
    setTimeout(() => d.classList.add('out'), dur * 1000); setTimeout(() => d.remove(), dur * 1000 + 700);
  }
  objective(t, sub) {
    if (t === this._ot && sub === this._os) return;
    const changed = t !== this._ot; this._ot = t; this._os = sub;
    $('ot').textContent = t || ''; $('os').innerHTML = sub ? esc(sub).replace(/\n/g, '<br>') : '';
    if (changed && t) { this.objT = 9; $('obj').classList.add('new'); setTimeout(() => $('obj').classList.remove('new'), 1400); this.g.audio.objective?.(); }
  }
  hitFrom(x, z) {
    const p = this.g.player, a = Math.atan2(x - p.pos.x, z - p.pos.z) - (p.yaw + Math.PI);
    const d = document.createElement('div'); d.className = 'hitdir'; d.style.transform = `translate(-50%,-50%) rotate(${-a}rad)`;
    $('hits').appendChild(d); setTimeout(() => d.remove(), 1000);
  }
  hitmark(weak) { const h = $('hitmark'); h.className = weak ? 'on weak' : 'on'; clearTimeout(this._hm); this._hm = setTimeout(() => (h.className = ''), 160); }
  checkpoint() { const s = $('save'); s.classList.add('on'); setTimeout(() => s.classList.remove('on'), 1600); }
  chat(name, t) { const d = document.createElement('div'); d.innerHTML = `<b>${esc(name)}</b> ${esc(t)}`; $('chatlog').appendChild(d); setTimeout(() => d.classList.add('out'), 11000); setTimeout(() => d.remove(), 12000); }
  /** big centred text over a fade: "DAY 3", "YOU BLACKED OUT" */
  fadeText(t, s, secs = 4) {
    const F = $('fade'); const ft = F.querySelector('.ft'), fs = F.querySelector('.fs');
    ft.textContent = t; fs.textContent = s || '';
    ft.style.opacity = t ? 1 : 0; fs.style.opacity = s ? 1 : 0;
    clearTimeout(this._ft); this._ft = setTimeout(() => { ft.style.opacity = 0; fs.style.opacity = 0; }, secs * 1000);
  }
  downed(on, kind, t) {
    $('downed').classList.toggle('on', !!on);
    if (on && t !== undefined) $('dsub').textContent = t > 0 ? 'Waiting for help... ' + Math.ceil(t) + 's' : '';
    else if (on) $('dsub').textContent = 'Your friends can help you up.';
  }
  /* ---------------- hotbar */
  hotbar() {
    const inv = this.g.inventory; if (!inv) return;
    let h = '';
    inv.hot.forEach((n, i) => { h += `<div class="slot${inv.held === n ? ' on' : ''}"><span class="k">${i + 1}</span>${esc(label(n))}${ITEMS[n]?.tool?.ranged ? `<em>${inv.count(ITEMS[n].tool.ranged)}</em>` : ''}</div>`; });
    $('hotbar').innerHTML = h;
    this.hotT = 2.5;
    $('held').textContent = inv.held ? label(inv.held) : '';
  }
  inventoryChanged() { this._invDirty = true; }
  /* ---------------- build menu */
  buildMenu(on) {
    const el = $('buildm'); el.classList.toggle('on', !!on);
    if (!on) return;
    const b = this.g.build, inv = this.g.inventory;
    el.innerHTML = '<div class="bt">BUILD</div>' + BUILD_ORDER.map((k, i) => {
      const P = PIECES[k], can = inv.has(P.cost);
      const cost = Object.entries(P.cost).map(([n, c]) => `${c} ${label(n).toLowerCase()}`).join(' · ');
      return `<div class="bi${i === b.sel ? ' on' : ''}${can ? '' : ' no'}"><span>${i < 9 ? i + 1 : ''}</span>${esc(P.label)}<em>${esc(cost)}</em></div>`;
    }).join('') + '<div class="bh">Wheel to choose &middot; R to turn &middot; Click to build &middot; B to close</div>';
  }
  /* ---------------- compass */
  _buildCompass() {
    const marks = []; const names = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    for (let d = -360; d <= 720; d += 15) { const n = names[((d % 360) + 360) % 360]; marks.push(`<i style="left:${d * 4}px" class="${n ? 'big' : ''}">${n || '|'}</i>`); }
    $('cstrip').innerHTML = marks.join('');
  }
  /* ---------------- per frame */
  update(dt) {
    const g = this.g, p = g.player, I = g.input;
    const vit = (id, v, show, cls = '') => { const el = $(id); el.classList.toggle('on', show); el.querySelector('i').style.width = Math.max(0, Math.min(100, v)) + '%'; el.className = 'vit' + (show ? ' on' : '') + (v < 25 ? ' low' : '') + cls; };
    const tab = I.held('Tab') && !g.ui.modal;
    vit('v-hp', p.health, p.health < 85 || tab || p.downed);
    vit('v-st', p.stamina, p.stamina < 97 || tab);
    vit('v-hu', p.hunger, p.hunger < 45 || tab, p.hunger < 15 ? ' crit' : '');
    vit('v-wa', p.warmth, p.warmth < 50 || tab || p.nearFire > 0.2, p.nearFire > 0.2 ? ' fire' : '');
    $('frost').style.opacity = String(Math.max(0, (35 - p.warmth) / 35) * 0.85);
    this.hotT -= dt;
    $('hotbar').classList.toggle('on', this.hotT > 0 || tab);
    if (this._invDirty) { this._invDirty = false; if (this.hotT > 0) this.hotbar(); }
    this.objT -= dt;
    $('obj').classList.toggle('on', (this.objT > 0 || tab) && !!this._ot);
    // compass and clock while holding Tab
    $('compass').classList.toggle('on', tab);
    if (tab) {
      const deg = ((-p.yaw * 180 / Math.PI) % 360 + 360) % 360;
      $('cstrip').style.transform = `translateX(${-deg * 4 + 200}px)`;
      const h = g.atmos.hour, hh = Math.floor(h), mm = Math.floor((h % 1) * 60);
      $('clock').textContent = 'DAY ' + g.atmos.day + '  ·  ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
    }
    $('clock').classList.toggle('on', tab);
    $('cross').classList.toggle('off', !!g.build?.active || !!g.cutscene);
  }
  onEvent(e) {
    if (e.k === 'sleepWait') this.toast(e.n + ' of ' + e.of + ' are asleep. Everyone has to be in bed.');
  }
}
