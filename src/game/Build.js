/* Build.js - shelters, fires and camp furniture.

   B opens build mode: the piece list appears, mouse wheel or 1-9 picks a
   piece, R turns it, left click places it, B or Esc leaves.
   Grid pieces (foundations, floors, walls, roofs, stairs) live on a 2 m grid
   that is anchored to the first foundation nearby, so a camp grows
   naturally: walls snap to the edges of floors/foundations, roofs sit on
   top of walls. Everything else (fires, beds, boxes, the workbench...) is
   placed freely on the ground or on a floor.

   Placed pieces are shared world state (W.built) and solid. They have hit
   points: the Wendigo and the cannibals can smash them; an axe takes your
   own mistakes down. Doors open, beds set where you wake up and let you
   sleep, boxes store things, the workbench crafts the better recipes,
   fires warm, light, cook - and burn out unless you feed them.

   "In a shelter" (roofed, with walls around) keeps the rain off and warms. */
import * as THREE from '../../lib/three.module.js';
import { PIECES, BUILD_ORDER, label } from '../data/Items.js';
import { clamp } from '../core/Util.js';

let ItemArt = null;
async function art() { if (ItemArt === null) { try { ItemArt = await import('../art/ItemArt.js'); } catch (e) { ItemArt = false; } } return ItemArt; }
const GRID = 2;

// stand-in shapes until the art module is there: [w, h, d, y]
const BOX = { foundation: [2, 0.5, 2, 0], floor: [2, 0.15, 2, 0], wall: [2, 2.4, 0.3, 0], wallWindow: [2, 2.4, 0.3, 0], wallDoor: [2, 2.4, 0.3, 0], roof: [2, 0.2, 2.2, 0.5], roofFlat: [2, 0.2, 2, 0], stairs: [2, 1.2, 2, 0], campfire: [1, 0.4, 1, 0], firePit: [1.6, 0.5, 1.6, 0], bed: [1, 0.5, 2, 0], storage: [1.2, 0.8, 0.7, 0], workbench: [1.6, 0.9, 0.8, 0], rack: [2, 1.6, 0.6, 0], spikes: [2, 1.4, 0.8, 0], torchStand: [0.3, 1.8, 0.3, 0], logPile: [2.4, 0.8, 1.2, 0], signal: [2.4, 3.5, 2.4, 0] };

export class Build {
  constructor(game) {
    this.g = game;
    this.active = false; this.sel = 0; this.rot = 0; this.ghost = null; this.ghostKind = null; this.valid = false;
    this.pieces = new Map();    // id -> { id, kind, x, y, z, rot, hp, obj, cols, open }
    this.group = new THREE.Group(); this.group.name = 'built'; game.scene.add(this.group);
    art();
  }
  get kind() { return BUILD_ORDER[this.sel]; }

  /* ---------------------------------------------------------------- models */
  _model(kind, ghost) {
    if (ItemArt && ItemArt.createPiece) { try { const m = ItemArt.createPiece(kind, { ghost }); if (m) return m; } catch (e) { window.__log?.('ART piece ' + kind + ': ' + e.message); } }
    const [w, h, d, y] = BOX[kind] || [1, 1, 1, 0];
    const g = new THREE.Group();
    const mat = ghost ? new THREE.MeshBasicMaterial({ color: 0x9fd0ff, transparent: true, opacity: 0.35, depthWrite: false }) : new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 0.9 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.y = h / 2 + y; m.castShadow = !ghost; m.receiveShadow = true; g.add(m);
    if (PIECES[kind]?.fire) { const f = new THREE.Object3D(); f.name = 'fire'; f.position.y = 0.2; g.add(f); }
    if (kind === 'wallDoor') { const dr = new THREE.Group(); dr.name = 'door'; dr.position.set(-0.5, 0, 0); const p = new THREE.Mesh(new THREE.BoxGeometry(1, 2.1, 0.08), mat); p.position.set(0.5, 1.05, 0); dr.add(p); g.add(dr); }
    g.userData.colliders = this._defaultCols(kind);
    return g;
  }
  _defaultCols(kind) {
    const [w, h, d] = BOX[kind] || [1, 1, 1];
    if (kind === 'wallDoor') return [{ x: -0.75, z: 0, w: 0.5, d: 0.3, h: 2.4 }, { x: 0.75, z: 0, w: 0.5, d: 0.3, h: 2.4 }, { x: 0, z: 0, w: 1, d: 0.3, h: 0.3, y: 2.1 }];
    if (kind === 'foundation' || kind === 'floor') return [{ x: 0, z: 0, w, d, h, walk: true, y: kind === 'foundation' ? -1 : 0 }];
    if (kind === 'stairs') return [{ x: 0, z: 0.5, w: 2, d: 1, h: 0.6, walk: true, y: 0 }, { x: 0, z: -0.5, w: 2, d: 1, h: 1.2, walk: true, y: 0 }];
    if (kind === 'roof' || kind === 'roofFlat') return [{ x: 0, z: 0, w, d, h: 0.25, walk: true, y: kind === 'roof' ? 0.4 : 0 }];
    if (kind === 'campfire' || kind === 'firePit' || kind === 'torchStand') return [];
    return [{ x: 0, z: 0, w, d, h }];
  }

  /* ---------------------------------------------------------------- build mode */
  toggle(on = !this.active) {
    const g = this.g;
    if (on && (g.player.downed || g.inCave)) { if (g.inCave) g.hud.toast('You can\'t build in here.'); return; }
    this.active = on;
    if (!on) this._dropGhost();
    g.hud.buildMenu?.(on);
    g.audio[on ? 'uiOpen' : 'uiClose']?.();
  }
  _dropGhost() { if (this.ghost) { this.ghost.removeFromParent(); this.ghost = null; this.ghostKind = null; } }
  update(dt) {
    const g = this.g, I = g.input;
    for (const p of this.pieces.values()) if (p.doorObj) { p.doorA = (p.doorA || 0) + ((p.open ? -1.6 : 0) - (p.doorA || 0)) * Math.min(1, dt * 6); p.doorObj.rotation.y = p.doorA; }
    this._shelter(dt);
    if (g.phase !== 'play' || g.cutscene) return;
    if (!g.ui.modal && I.pressed('KeyB')) this.toggle();
    if (!this.active) return;
    if (g.ui.modal || g.player.downed) { this.toggle(false); return; }
    if (I.pressed('Escape')) { this.toggle(false); return; }
    const w = I.wheel(); if (w) { this.sel = (this.sel + (w > 0 ? 1 : -1) + BUILD_ORDER.length) % BUILD_ORDER.length; g.hud.buildMenu?.(true); }
    for (let i = 0; i < 9; i++) if (I.pressed('Digit' + (i + 1))) { this.sel = i; g.hud.buildMenu?.(true); }
    if (I.pressed('KeyR')) this.rot = (this.rot + Math.PI / 2) % (Math.PI * 2);
    const kind = this.kind;
    if (this.ghostKind !== kind) { this._dropGhost(); this.ghost = this._model(kind, true); this.ghost.traverse(o => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 9; } }); this.ghostKind = kind; g.scene.add(this.ghost); }
    const spot = this._spot(kind);
    this.valid = !!spot && spot.ok;
    if (spot) { this.ghost.visible = true; this.ghost.position.set(spot.x, spot.y, spot.z); this.ghost.rotation.y = spot.rot; this.spot = spot; } else this.ghost.visible = false;
    const can = g.inventory.has(PIECES[kind].cost);
    this._tint(this.valid && can);
    if (I.click(0)) {
      if (!spot) return;
      if (!can) { g.audio.buildDeny?.(); g.hud.toast('Not enough: ' + Object.entries(PIECES[kind].cost).map(([k, n]) => n + ' ' + label(k).toLowerCase()).join(', ')); return; }
      if (!this.valid) { g.audio.buildDeny?.(); g.hud.toast(spot.why || 'You can\'t build there.'); return; }
      g.inventory.take(PIECES[kind].cost);
      g.act({ k: 'build', kind, x: +spot.x.toFixed(2), y: +spot.y.toFixed(2), z: +spot.z.toFixed(2), rot: +spot.rot.toFixed(4) });
      g.audio.build?.(spot);
    }
  }
  _tint(ok) {
    if (this._tintOk === ok && this._tintFor === this.ghost) return; this._tintOk = ok; this._tintFor = this.ghost;
    this.ghost.traverse(o => { if (o.isMesh && o.material) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) { if (!o.userData.ghostMat) o.userData.ghostMat = m.clone(); } o.material = o.userData.ghostMat; if (o.material.color) o.material.color.set(ok ? 0x9fd0ff : 0xff6a50); o.material.transparent = true; o.material.opacity = Math.min(o.material.opacity ?? 1, 0.45); o.material.depthWrite = false; } });
  }
  /** where the current piece would go */
  _spot(kind) {
    const g = this.g, o = g.camera.position, d = g.player.forward;
    const hit = g.physics.ray(o, d, 9);
    if (!hit) return null;
    const P = PIECES[kind];
    let x = hit.point.x, z = hit.point.z, y = hit.point.y, rot = this.rot + Math.round(g.player.yaw / (Math.PI / 2)) * Math.PI / 2;
    if (Math.hypot(x - g.player.pos.x, z - g.player.pos.z) < 1.2 && !P.grid) { x += d.x; z += d.z; }
    const out = { x, y, z, rot, ok: true };
    if (P.grid) {
      // find a grid to snap to: the nearest grid piece within 6 m
      let anchor = null, ad = 6;
      for (const p of this.pieces.values()) { if (!PIECES[p.kind].grid) continue; const dd = Math.hypot(p.x - x, p.z - z); if (dd < ad) { ad = dd; anchor = p; } }
      if (anchor) {
        const a = anchor.rot, c = Math.cos(a), s = Math.sin(a);
        // into the anchor's grid frame
        const lx = (x - anchor.x) * c - (z - anchor.z) * s, lz = (x - anchor.x) * s + (z - anchor.z) * c;
        let gx = Math.round(lx / GRID) * GRID, gz = Math.round(lz / GRID) * GRID, r = a;
        const base = anchor.y + (anchor.kind === 'foundation' ? 0.5 : anchor.kind === 'floor' ? 0.15 : 0) - (PIECES[anchor.kind].edge || PIECES[anchor.kind].roof ? (PIECES[anchor.kind].roof ? 2.4 : 0) : 0);
        let y2 = base;
        if (P.edge) {
          // snap to the nearest cell edge
          const fx = lx - Math.round(lx / GRID) * GRID, fz = lz - Math.round(lz / GRID) * GRID;
          if (Math.abs(fx) > Math.abs(fz)) { gx = Math.round(lx / GRID) * GRID + Math.sign(fx) * GRID / 2; r = a + Math.PI / 2; }
          else { gz = Math.round(lz / GRID) * GRID + Math.sign(fz) * GRID / 2; r = a; }
          if (this.rot % Math.PI > 0.1) r += Math.PI;
        } else if (P.roof) { y2 = base + 2.4; r = a + this.rot; }
        else if (kind === 'floor') { y2 = base + (hit.point.y > base + 1.5 ? 2.4 : 0); }
        else if (kind === 'stairs') r = a + this.rot;
        out.x = anchor.x + gx * c + gz * s; out.z = anchor.z - gx * s + gz * c; out.y = kind === 'foundation' ? anchor.y : y2; out.rot = r;
        if (kind === 'foundation') out.y = anchor.y;
        // something already there?
        for (const p of this.pieces.values()) if (p.kind === kind && Math.hypot(p.x - out.x, p.z - out.z) < 0.3 && Math.abs(p.y - out.y) < 0.5) { out.ok = false; out.why = 'There is already one there.'; }
      } else {
        if (kind !== 'foundation' && kind !== 'floor') { out.ok = false; out.why = 'Start with a foundation or a floor.'; }
        out.y = g.island.height(x, z); out.rot = rot;
      }
    } else {
      out.y = g.physics.ground(x, z, hit.point.y + 0.3);
    }
    if (g.island.waterDepth(out.x, out.z) > 0.3) { out.ok = false; out.why = 'Not in the water.'; }
    if (Math.hypot(out.x - g.player.pos.x, out.z - g.player.pos.z) > 8) { out.ok = false; out.why = 'Too far away.'; }
    // trees in the way (stumps are fine for grid pieces)
    let blocked = false;
    g.forest.near(out.x, out.z, kind === 'campfire' || kind === 'torchStand' ? 0.6 : 1.2, (t) => { if (t.state === 0 || t.state === 1) blocked = true; });
    if (blocked) { out.ok = false; out.why = 'A tree is in the way. Chop it down first.'; }
    return out;
  }

  /* ---------------------------------------------------------------- shared state */
  applyBuild(a, from) {
    const g = this.g;
    const id = 'b' + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const rec = { id, kind: a.kind, x: a.x, y: a.y, z: a.z, rot: a.rot, hp: PIECES[a.kind]?.hp || 100, by: from === g.me ? g.profile.key : (g.net.profiles.get(from)?.key || from) };
    g.W.built.push(rec); g.W.stats.built++;
    g.emit({ k: 'built', p: rec });
  }
  onEvent(e) {
    if (e.k === 'built') { this._place(e.p); if (this.g.player.pos.distanceTo(new THREE.Vector3(e.p.x, e.p.y, e.p.z)) < 30) this.g.fx?.dust(e.p, 6, [0.5, 0.42, 0.3], 0.8, 1); }
    else if (e.k === 'pieceHp') this._hp(e.id, e.hp, e);
    else if (e.k === 'door') { const p = this.pieces.get(e.id); if (p) { p.open = e.open; this.g.audio[e.open ? 'doorOpen' : 'doorClose']?.(p); } }
    else if (e.k === 'fireOp') this._fireOp(e);
  }
  begin(W) {
    for (const p of [...this.pieces.values()]) this._unplace(p);
    for (const rec of W.built || []) this._place(rec);
  }
  _place(rec) {
    if (this.pieces.has(rec.id)) return;
    const g = this.g;
    const obj = this._model(rec.kind, false);
    obj.position.set(rec.x, rec.y, rec.z); obj.rotation.y = rec.rot;
    obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(obj);
    const p = { ...rec, obj, rec };
    p.cols = g.physics.addProp(obj.userData.colliders || this._defaultCols(rec.kind), rec.x, rec.y, rec.z, rec.rot, 1, 'piece:' + rec.id);
    for (const c of p.cols) c.piece = rec.id;
    p.doorObj = obj.getObjectByName('door');
    const P = PIECES[rec.kind];
    if (P.fire && g.fires) {
      const fo = obj.getObjectByName('fire'); const wp = new THREE.Vector3(); (fo || obj).getWorldPosition(wp);
      p.fire = g.fires.add({ id: rec.id, x: wp.x, y: wp.y, z: wp.z, size: rec.kind === 'signal' ? 2.6 : rec.kind === 'firePit' ? 1.2 : rec.kind === 'torchStand' ? 0.35 : 0.9, fuel: rec.fuel ?? (rec.kind === 'torchStand' ? 600 : 0), lit: rec.lit ?? rec.kind === 'torchStand', warm: P.fire, cook: !!P.cook });
      p.fire.shared = true;
    }
    this.pieces.set(rec.id, p);
    this._interactions(p);
  }
  _unplace(p) {
    p.obj.removeFromParent();
    for (const c of p.cols || []) this.g.physics.remove(c);
    if (p.fire) this.g.fires.remove(p.fire);
    this.g.interact?.remove(p.id); this.g.interact?.remove(p.id + 'b');
    this.pieces.delete(p.id);
  }
  _interactions(p) {
    const g = this.g, I = g.interact; if (!I) return;
    const at = (dy = 0.8) => ({ x: p.x, y: p.y + dy, z: p.z });
    const k = p.kind;
    if (p.doorObj) I.add({ id: p.id, ...at(1.1), r: 0.7, text: () => (p.open ? 'Close the door' : 'Open the door'), act: () => g.act({ k: 'door', id: p.id }) });
    else if (k === 'bed') I.add({ id: p.id, ...at(0.5), r: 0.9, text: () => (g.atmos.isNight || g.atmos.hour >= 19 ? 'Sleep' : 'Rest here (sets where you wake)'), act: () => { this.setBed(p); if (g.atmos.isNight || g.atmos.hour >= 19) g.combat?.sleepRequest(p.id); } });
    else if (k === 'storage') I.add({ id: p.id, ...at(0.6), r: 0.7, text: () => 'Open the box', act: () => g.ui.open('stash', p.id) });
    else if (k === 'workbench') I.add({ id: p.id, ...at(0.9), r: 0.8, text: () => 'Use the workbench', act: () => g.ui.open('craft', 'bench') });
    else if (p.fire) {
      I.add({ id: p.id, ...at(0.4), r: 0.6, text: () => this._fireText(p), act: () => this._fireAct(p) });
    }
  }
  setBed(p) { const g = this.g; g.W.beds = g.W.beds || {}; g.W.beds[g.profile.key] = { x: p.x, y: p.y, z: p.z }; g.hud.toast('You will wake up here.'); }
  bedFor(key) { return this.g.W?.beds?.[key] || null; }
  applyStash(a, from) {
    const g = this.g, S = (g.W.stash[a.id] = g.W.stash[a.id] || {});
    if (a.dir > 0) S[a.item] = (S[a.item] || 0) + 1;
    else if ((S[a.item] || 0) > 0) { S[a.item]--; g.sync?.give(from, a.item, 1); }
    g.net.sendSave?.(g.W);
  }
  applyDoor(a) { const p = this.pieces.get(a.id); if (!p) return; this.g.emit({ k: 'door', id: a.id, open: !p.open }); }

  /* ---------------------------------------------------------------- fires */
  _fireText(p) {
    const g = this.g, f = p.fire, inv = g.inventory;
    if (!f.lit) return inv.count('lighter') || inv.held === 'torch' ? 'Light the fire' + (f.fuel < 30 ? (inv.count('stick') ? ' (uses a stick)' : ' (needs a stick)') : '') : 'You need a lighter';
    if (inv.held && inv.count(inv.held) && /Raw/.test(inv.held) && f.cook !== false) return 'Cook ' + label(inv.held).toLowerCase();
    if (inv.count('meatRaw') || inv.count('fishRaw')) return 'Cook food';
    if (inv.count('log')) return 'Add a log (' + Math.round(f.fuel / 60) + ' min left)';
    if (inv.count('stick')) return 'Add a stick (' + Math.round(f.fuel / 60) + ' min left)';
    return 'Warm yourself (' + Math.round(f.fuel / 60) + ' min left)';
  }
  _fireAct(p) {
    const g = this.g, f = p.fire, inv = g.inventory;
    if (!f.lit) {
      if (!(inv.count('lighter') || inv.held === 'torch')) { g.audio.deny?.(); return; }
      if (f.fuel < 30) { if (!inv.count('stick')) { g.hud.toast('Put a stick on it first.'); return; } inv.remove('stick'); }
      g.act({ k: 'fire', id: p.id, op: 'light' }); g.audio.lighter?.(); return;
    }
    const raw = inv.count('meatRaw') ? 'meatRaw' : inv.count('fishRaw') ? 'fishRaw' : null;
    if (raw) { inv.remove(raw); inv.add(raw === 'meatRaw' ? 'meatCooked' : 'fishCooked'); g.audio.fireIgnite?.(f); g.fx?.smoke(f, 4, 0.4, 0.4); g.hud.toast('Cooked.'); return; }
    if (inv.count('log')) { inv.remove('log'); g.act({ k: 'fire', id: p.id, op: 'feed', s: 240 }); return; }
    if (inv.count('stick')) { inv.remove('stick'); g.act({ k: 'fire', id: p.id, op: 'feed', s: 60 }); return; }
  }
  applyFire(a) { this.g.emit({ k: 'fireOp', id: a.id, op: a.op, s: a.s }); }
  _fireOp(e) {
    const p = this.pieces.get(e.id); if (!p?.fire) return;
    if (e.op === 'light') this.g.fires.feed(p.fire, 90);
    else if (e.op === 'feed') this.g.fires.feed(p.fire, e.s);
  }

  /* ---------------------------------------------------------------- damage */
  /** melee from the local player on a piece */
  hitPiece(o, d, reach, T) {
    const r = this.g.physics.ray(o, d, reach);
    if (!r?.collider?.piece) return false;
    this.g.audio.structureHit?.(r.point); this.g.fx?.chipBurst(r.point, { x: -d.x, z: -d.z }, 5);
    this.g.act({ k: 'pieceHit', id: r.collider.piece, dmg: (T.chop || 0.2) * 40 });
    return true;
  }
  /** host: damage a piece (players, cannibals, the Wendigo) */
  applyHit(a) { const p = this.pieces.get(a.id); if (!p) return; p.hp -= a.dmg; const rec = this.g.W.built.find(b => b.id === a.id); if (rec) rec.hp = p.hp; this.g.emit({ k: 'pieceHp', id: a.id, hp: p.hp, big: a.big }); }
  damageNear(x, z, r, dmg, big) { if (!this.g.isHost) return; for (const p of [...this.pieces.values()]) if (Math.hypot(p.x - x, p.z - z) < r) this.applyHit({ id: p.id, dmg, big }); }
  _hp(id, hp, e) {
    const p = this.pieces.get(id); if (!p) return;
    p.hp = hp;
    if (ItemArt?.setPieceDamage) try { ItemArt.setPieceDamage(p.obj, clamp(1 - hp / (PIECES[p.kind].hp || 100), 0, 1)); } catch (err) { /* */ }
    if (hp <= 0) {
      const g = this.g;
      g.audio.structureBreak?.(p); g.fx?.dust(p, 14, [0.45, 0.38, 0.28], 1.6, 1.5); g.fx?.chipBurst({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, z: 0 }, 20, p.y);
      if (g.isHost) { g.W.built = g.W.built.filter(b => b.id !== id); if (Math.random() < 0.6) g.items?.spawn('log', p.x + 0.5, p.z + 0.5); }
      this._unplace(p);
    }
  }
  /* ---------------------------------------------------------------- shelter */
  _shelter(dt) {
    this._sT = (this._sT || 0) - dt; if (this._sT > 0) return; this._sT = 0.5;
    const pp = this.g.player.pos;
    let roof = false, walls = 0;
    for (const p of this.pieces.values()) {
      const d = Math.hypot(p.x - pp.x, p.z - pp.z);
      if (PIECES[p.kind].roof && d < 1.8 && p.y > pp.y + 1) roof = true;
      if (PIECES[p.kind].edge && d < 3.2) walls++;
    }
    this.g.player.inShelter = roof && walls >= 2;
    for (const f of this.g.fires?.list || []) f.roofed = false;
  }
  save(W) { for (const p of this.pieces.values()) if (p.fire) { const rec = W.built.find(b => b.id === p.id); if (rec) { rec.fuel = Math.round(p.fire.fuel); rec.lit = p.fire.lit; } } }
  /** cannibals and the Wendigo: the piece nearest a point */
  nearest(x, z, r) { let best = null, bd = r; for (const p of this.pieces.values()) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = p; } } return best; }
}
