/* Inventory.js - what you carry.

   A bag of counts (items[name] = n) plus the HOTBAR: every tool you own, in
   the order you found it, on keys 1-8 (mouse wheel cycles, Q puts the hands
   down). Logs are carried on the shoulder: at most four, and you walk slower.
   Each player has their own inventory; it is saved with the world under the
   player's profile key. */
import { ITEMS, RECIPES, label } from '../data/Items.js';

export class Inventory {
  constructor(game) {
    this.g = game;
    this.items = {}; this.hot = []; this.held = null; this.battery = 1;
    this.sick = 0;
  }
  get heldName() { return this.held; }
  get warmthBonus() { return this.items.hideCoat ? 1 : 0; }
  count(n) { return this.items[n] || 0; }
  has(need) { for (const k in need) if (this.count(k) < need[k]) return false; return true; }
  cap(n) { const it = ITEMS[n]; if (!it) return 99; if (it.heavy) return 4; return it.kind === 'tool' || it.kind === 'relic' ? 1 : it.stack * 3; }
  /** add n of an item; returns how many fit */
  add(n, k = 1, quiet = false) {
    const fit = Math.max(0, Math.min(k, this.cap(n) - this.count(n)));
    if (!fit) { if (!quiet) this.g.hud.toast(ITEMS[n]?.heavy ? 'You can\'t carry more logs. Drop them (G) or use them.' : 'You can\'t carry more ' + label(n).toLowerCase() + '.'); return 0; }
    this.items[n] = this.count(n) + fit;
    const it = ITEMS[n];
    if (it?.tool && !this.hot.includes(n)) { this.hot.push(n); if (!this.held && it.kind === 'tool') this.select(n); }
    if (!quiet) this.g.hud.pickup?.(n, fit);
    this._sync();
    return fit;
  }
  remove(n, k = 1) {
    this.items[n] = Math.max(0, this.count(n) - k);
    if (!this.items[n]) { delete this.items[n]; const i = this.hot.indexOf(n); if (i >= 0) this.hot.splice(i, 1); if (this.held === n) this.select(null); }
    this._sync();
  }
  take(need) { if (!this.has(need)) return false; for (const k in need) this.remove(k, need[k]); return true; }
  _sync() { this.g.player.carry = this.count('log'); this.g.hud?.inventoryChanged?.(); }
  select(n) {
    if (n && !this.count(n)) return;
    if (this.held === n) return;
    this.held = n;
    this.g.viewmodel?.equip(n);
    this.g.audio.uiClick?.();
    this.g.hud?.hotbar?.();
  }
  /** eat, drink, heal */
  use(n) {
    const it = ITEMS[n], p = this.g.player;
    if (!it || !this.count(n)) return false;
    if (it.food) {
      const f = it.food;
      if (f.hunger && p.hunger > 97 && !f.health) { this.g.hud.toast('You are not hungry.'); return false; }
      if (it.kind === 'med' && p.health >= 100) { this.g.hud.toast('You are not hurt.'); return false; }
      this.remove(n, 1);
      p.hunger = Math.min(100, p.hunger + (f.hunger || 0));
      p.health = Math.min(100, p.health + (f.health || 0));
      p.warmth = Math.min(100, p.warmth + (f.warmth || 0));
      if (f.raw && Math.random() < f.raw) { this.sick = 30; this.g.hud.toast('Your stomach turns. You should have cooked that.'); }
      if (it.kind === 'med') this.g.audio.pickup?.('item'); else this.g.audio.eat?.();
      this.g.viewmodel?.gesture('eat');
      return true;
    }
    if (it.tool) { this.select(n); return true; }
    return false;
  }
  craftable(r, atBench) {
    if (r.where === 'bench' && !atBench) return false;
    return this.has(r.need) || (r.alt && this.has(r.alt));
  }
  craft(r) {
    const need = this.has(r.need) ? r.need : r.alt && this.has(r.alt) ? r.alt : null;
    if (!need) return false;
    for (const k in need) this.remove(k, need[k]);
    this.add(r.out, r.n, true);
    this.g.audio.craft?.();
    this.g.hud.toast('Made: ' + label(r.out) + (r.n > 1 ? ' x' + r.n : ''));
    if (r.out === 'emberSpear') this.g.story?.onCrafted('emberSpear');
    return true;
  }
  update(dt) {
    const g = this.g, I = g.input;
    if (this.sick > 0) { this.sick -= dt; g.player.hunger -= dt * 0.25; g.player.stamina = Math.min(g.player.stamina, 60); }
    if (g.ui.modal || g.player.downed || g.cutscene) return;
    for (let i = 0; i < 8; i++) if (I.pressed('Digit' + (i + 1))) { const n = this.hot[i]; if (n) this.select(this.held === n ? null : n); }
    if (I.pressed('KeyQ')) this.select(null);
    const w = g.build?.active ? 0 : I.wheel();
    if (w && this.hot.length) { const list = [null, ...this.hot]; let i = list.indexOf(this.held); i = (i + (w > 0 ? 1 : -1) + list.length) % list.length; this.select(list[i]); }
    // flashlight battery
    if (this.held === 'flashlight' && g.lightOn) {
      this.battery -= dt / 300;
      if (this.battery <= 0) { if (this.count('batteries')) { this.remove('batteries'); this.battery = 1; g.hud.toast('Fresh batteries.'); } else { this.battery = 0; g.lightOn = false; g.hud.toast('The flashlight is dead.'); } }
    }
  }
  starter() {
    this.items = {}; this.hot = []; this.held = null; this.battery = 1;
    this.add('axe', 1, true); this.add('lighter', 1, true); this.add('can', 1, true); this.add('waterBottle', 1, true); this.add('cloth', 2, true);
    this.select('axe');
  }
  save() { return { items: { ...this.items }, hot: [...this.hot], held: this.held, battery: this.battery }; }
  load(s) {
    if (!s) return this.starter();
    this.items = { ...s.items }; this.hot = (s.hot || []).filter(n => this.items[n]); this.battery = s.battery ?? 1; this.held = null;
    this._sync();
    this.select(s.held && this.items[s.held] ? s.held : this.hot[0] || null);
  }
  /** drop logs (G) */
  dropLog() { if (!this.count('log')) return false; this.remove('log', 1); return true; }
  recipes() { return RECIPES; }
}
