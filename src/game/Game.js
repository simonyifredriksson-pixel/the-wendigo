/* Game.js - owns every system and runs the frame.

   Phases
     title   the menu: a slow camera drifting through the forest at dusk
     intro   the helicopter cutscene (Intro.js)
     play    the game
     end     the rescue and the credits (Finale.js)

   Authority: the HOST (or a solo player) owns the world - time, weather,
   trees, structures, items, animals, cannibals, the Wendigo and the horror
   director. Clients send their own player state and ACTIONS; results come
   back as events and world snapshots (see NetSync.js). act(a) is the single
   entry point for anything that changes shared state. */
import * as THREE from '../../lib/three.module.js';
import { World, loadPropArt, loadBakedIsland } from '../world/World.js';
import { Player } from './Player.js';
import { HUD } from '../ui/HUD.js';
import { UI } from '../ui/UI.js';
import { GU } from '../core/Shading.js';
import { clamp, damp, lerp } from '../core/Util.js';
import { newWorld, saveWorld } from './State.js';

export class Game {
  constructor(o) {
    Object.assign(this, o);
    this.phase = 'boot'; this.time = 0; this.paused = false; this.timeScale = 1;
    this.me = 'local';
    this.W = null;            // the world save (host) / mirror (client)
    this.systems = [];        // objects with update(dt) called during play, in order
    this.shake = 0; this.inCave = null; this.lightOn = false;
    this.hud = new HUD(this);
    this.ui = new UI(this);
  }
  get isHost() { return !this.net.isClient; }
  get island() { return this.world.island; }
  get physics() { return this.world.physics; }
  get atmos() { return this.world.atmos; }
  get forest() { return this.world.forest; }

  /* ------------------------------------------------------------ loading */
  async load(step) {
    await step('Painting the forest...', 0.1);
    await loadPropArt();
    await step('Raising the island...', 0.3);
    this.world = new World(this);
    const baked = this.params?.has('genisland') ? null : await loadBakedIsland();
    this.world.build(this.renderer, this.scene, 1, baked);
    await step('Placing the old places...', 0.7);
    this.player = new Player(this);
    await this._loadSystems(step);
    await step('Listening to the forest...', 0.95);
    // warm up: compile shaders by rendering once from the crash site
    const c = this.island.landmark('crash');
    this.camera.position.set(c.x, c.y + 2, c.z + 10); this.camera.lookAt(c.x, c.y + 1, c.z);
    this.world.update(0.016, this.camera);
    this.renderer.compile(this.scene, this.camera);
  }
  /** systems are optional modules; each is loaded if present so the game boots while parts are in progress */
  async _loadSystems(step) {
    const mods = this.params?.get('nosys') ? [] : [
      ['fx', './FX.js', 'FX'], ['inventory', './Inventory.js', 'Inventory'], ['viewmodel', './Viewmodel.js', 'Viewmodel'],
      ['fires', './Fire.js', 'Fires'], ['chop', './Chop.js', 'Chop'], ['build', './Build.js', 'Build'], ['items', './Items.js', 'Items'],
      ['interact', './Interact.js', 'Interact'], ['remotes', './Remote.js', 'Remotes'], ['wildlife', './Wildlife.js', 'Wildlife'],
      ['cannibals', './Cannibals.js', 'Cannibals'], ['wendigo', './Wendigo.js', 'WendigoAI'], ['caves', './Caves.js', 'Caves'],
      ['story', './Story.js', 'Story'], ['director', './Director.js', 'Director'], ['combat', './Combat.js', 'Combat'],
      ['intro', './Intro.js', 'Intro'], ['finale', './Finale.js', 'Finale'], ['sync', './NetSync.js', 'NetSync'], ['admin', '../ui/Admin.js', 'Admin'],
    ];
    for (const [key, path, cls] of mods) {
      try {
        const m = await import(path);
        this[key] = new m[cls](this);
        this[key].sysKey = key;
        if (this[key].init) await this[key].init();
        if (this[key].update) this.systems.push(this[key]);
      } catch (e) {
        if (!/Failed to fetch|Importing a module script failed|error loading dynamically/i.test(e.message)) window.__log?.('ERR system ' + key + ': ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | '));
        this[key] = null;
      }
    }
  }
  setQuality(q) { this.world.setQuality(q); this.fires?.setQuality(q); this.quality = q; }

  /* ------------------------------------------------------------ phases */
  toTitle() {
    this.phase = 'title';
    this.atmos.hour = 19.6; this.atmos.setWeather('fog'); this.atmos.w.fog = 3;
    this.hud.hide();
    this.ui.showTitle?.();
    this._titleT = 0;
  }
  /** start (or continue) as host/solo */
  start(save, opts = {}) {
    this.W = save && save.v ? save : newWorld((Math.random() * 2 ** 32) >>> 0);
    this.world.seed = this.W.seed;
    this.atmos.hour = this.W.hour; this.atmos.day = this.W.day; this.atmos.setWeather(this.W.weather || 'clear');
    this.atmos.w = { ...this.atmos.wTarget };
    this.forest.applySaved(this.W.felled);
    if (!this._propsPlaced) { this.world.landmarkProps(); this._propsPlaced = true; }
    for (const s of this.systems) s.begin?.(this.W);
    const mine = this.W.players[this.profile.key];
    if (!this.W.intro && this.intro && !opts.skipIntro && this.profile.intro !== false) { this.intro.play(); return; }
    this.W.intro = true;
    this.enterPlay(mine);
  }
  /** a client joined: mirror the host's save */
  startClient(d) {
    this.W = d.save || newWorld(1);
    this.world.seed = this.W.seed;
    this.forest.applySaved(this.W.felled || {});
    if (!this._propsPlaced) { this.world.landmarkProps(); this._propsPlaced = true; }
    for (const s of this.systems) s.begin?.(this.W);
    if (d.intro && this.intro) { this.intro.play(d.intro); return; }
    this.enterPlay(this.W.players?.[this.profile.key]);
  }
  enterPlay(mine) {
    this.phase = 'play';
    this.hud.show();
    if (mine && mine.x !== undefined) { this.player.spawn(mine.x, mine.z, mine.yaw || 0); Object.assign(this.player, { health: mine.health ?? 100, hunger: mine.hunger ?? 80, warmth: mine.warmth ?? 80 }); this.inventory?.load(mine.inv); }
    else { const s = this.spawnPoint(); this.player.spawn(s.x, s.z, s.yaw); this.inventory?.starter(); }
    for (const s of this.systems) s.onPlay?.();
    this.input.lock();
  }
  spawnPoint() {
    const c = this.island.landmark('crash');
    const n = this.net.count || 1, k = [...this.net.lobbyList].findIndex(p => p.you);
    const a = 2.2 + (k < 0 ? 0 : k) * 0.6;
    return { x: c.x + Math.cos(a) * 7, z: c.z + Math.sin(a) * 7, yaw: Math.atan2(Math.cos(a), Math.sin(a)) + Math.PI + n * 0 };
  }

  /* ------------------------------------------------------------ actions */
  /** perform (host) or request (client) a change to shared state */
  act(a) { if (this.isHost) this.apply(a, this.me); else this.net.sendAction(a); }
  apply(a, from) { this.sync?.apply(a, from); }
  /** a one-off event for everyone (including us) */
  emit(e) { this.onEvent(e, this.me); this.net.sendEvent(e); }
  onEvent(e, from) { for (const s of this.systems) s.onEvent?.(e, from); this.hud.onEvent?.(e, from); }
  saveNow() {
    if (!this.isHost || !this.W) return;
    this.W.hour = this.atmos.hour; this.W.day = this.atmos.day; this.W.weather = this.atmos.weather;
    this.W.players[this.profile.key] = { x: this.player.pos.x, y: this.player.pos.y, z: this.player.pos.z, yaw: this.player.yaw, health: this.player.health, hunger: this.player.hunger, warmth: this.player.warmth, inv: this.inventory?.save() };
    for (const s of this.systems) s.save?.(this.W);
    saveWorld(this.W);
  }
  onPlayerDown(kind) { (this.combat?.down || (() => { this.player.health = 100; this.player.spawn(this.player.lastSafe.x, this.player.lastSafe.z); }))(kind); }
  surfaceAt(x, z, y) { return this.island.surface(x, z); }

  /* ------------------------------------------------------------ frame */
  update(dt) {
    this.time += dt;
    GU.uTime.value = this.time;
    if (this.phase === 'title') return this._titleUpdate(dt);
    if (this.phase === 'intro') { this.intro?.update(dt); this._worldUpdate(dt, true); return; }
    if (this.phase === 'end') { this.finale?.updateEnd(dt); this._worldUpdate(dt); return; }
    if (this.phase !== 'play') return;
    const look = this.input.locked && !this.ui.modal ? this.input.look() : null;
    this.player.update(dt, this.cutscene ? null : this.input, this.cutscene ? null : look);
    for (const s of this.systems) s.update(dt);
    if (!this.cutscene) this.player.applyCamera(this.camera, dt, this.time);
    GU.uPlayerPos.value.copy(this.player.pos);
    this._worldUpdate(dt);
    this.hud.update(dt);
    this.ui.update?.(dt);
    // autosave
    this._saveT = (this._saveT || 0) + dt;
    if (this._saveT > 30) { this._saveT = 0; this.saveNow(); }
  }
  _worldUpdate(dt, frozen = false) {
    const A = this.atmos;
    A.update(this.isHost ? dt : 0, this.inCave ? null : this.camera.position, { frozen: !this.isHost || frozen || this.freezeTime });
    this.world.update(dt, this.camera);
    A.grade(this.post);
    this.post.setSun(A.sunDir, A.out.sunStrength * (this.inCave ? 0 : 1));
    // decay screen effects
    const u = this.post.u;
    u.hurt.value = Math.max(0, u.hurt.value - dt * 0.8);
    this.shake = Math.max(0, this.shake - dt * 1.5);
    u.underwater.value = damp(u.underwater.value, this.player?.underwater ? 1 : 0, 8, dt);
    this.audio.listener && Object.assign(this.audio.listener, { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z, yaw: this.camera.rotation.y, pitch: this.camera.rotation.x });
    this.audio.update?.(dt);
  }
  _titleUpdate(dt) {
    // slow drift along the river toward the mountains at dusk, in fog
    this._titleT += dt;
    const t = this._titleT * 0.012, c = this.island.landmark('cabin');
    const x = c.x - 60 - t * 40, z = c.z - 30 - t * 70;
    const y = Math.max(this.island.height(x, z), this.island.waterLevel(x, z)) + 3.2 + Math.sin(this._titleT * 0.2) * 0.4;
    this.camera.position.set(x, y, z);
    this.camera.rotation.order = 'YXZ'; this.camera.rotation.set(0.04 + Math.sin(this._titleT * 0.13) * 0.03, 2.6 + Math.sin(this._titleT * 0.07) * 0.2, 0);
    this._worldUpdate(dt);
  }
  render(dt) {
    const overlay = this.phase === 'play' && this.viewmodel && !this.cutscene ? this.viewmodel.overlay : null;
    this.post.render(this.scene, this.camera, dt, overlay);
  }
}
