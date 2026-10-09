/* World.js - builds the static island and keeps it updated around the camera.

   Layers: Island (data) -> Terrain, Forest, Cover, Water, Sky + Atmos.
   Landmarks: each LANDMARK gets a hand-arranged composition of props from
   PropArt (helicopter wreck, cabin, villages, the stone circle...), and the
   wider island gets scattered set dressing - boulders, fallen logs, bones,
   effigies and offerings at the cannibals' borders, claw marks and symbols on
   trees. Everything is placed from fixed positions or the world seed, so all
   players see the same island. */
import * as THREE from '../../lib/three.module.js';
import { Island } from './Island.js';
import { Terrain } from './Terrain.js';
import { Forest } from './Forest.js';
import { Cover } from './Cover.js';
import { Water, SkyEnv } from './Water.js';
import { Sky } from './Sky.js';
import { Atmos } from './Atmos.js';
import { Physics } from './Physics.js';
import { rng, hash2 } from '../core/Util.js';

let PropArt = null;
export async function loadPropArt() {
  try { PropArt = await import('../art/PropArt.js'); } catch (e) { window.__log?.('ART props unavailable: ' + e.message); PropArt = null; }
  return PropArt;
}
const missing = new Set();
export function prop(name, opts) {
  if (!PropArt || missing.has(name)) return null;
  try { return PropArt.createProp(name, opts); } catch (e) { missing.add(name); window.__log?.('ART prop ' + name + ': ' + e.message); return null; }
}

/** the baked island (tools/bakeIsland.mjs); null if it is missing - then it is generated */
export async function loadBakedIsland() {
  try {
    const [b, m] = await Promise.all([fetch('data/island.bin'), fetch('data/island.json')]);
    if (!b.ok || !m.ok) return null;
    return { bin: await b.arrayBuffer(), meta: await m.json() };
  } catch (e) { return null; }
}

export class World {
  constructor(game) {
    this.game = game;
    this.group = new THREE.Group(); this.group.name = 'world';
    this.props = new THREE.Group(); this.props.name = 'props';
    this.named = {};          // landmark id -> { group, parts }
    this.decor = [];          // { obj, x, z, r } for distance culling
  }
  build(renderer, scene, seed, baked) {
    const t0 = performance.now();
    this.island = new Island(baked);
    const t1 = performance.now();
    this.terrain = new Terrain(this.island);
    this.forest = new Forest(this.island, renderer);
    const t2 = performance.now();
    this.cover = new Cover(this.island, this.forest);
    this.physics = new Physics(this.island, this.forest);
    this.sky = new Sky();
    this.atmos = new Atmos(scene, this.sky);
    this.skyEnv = new SkyEnv(renderer, this.sky.mesh);
    this.water = new Water(this.island, this.skyEnv.texture);
    this.group.add(this.terrain.group, this.forest.group, this.cover.group, this.water.group, this.props, this.sky.mesh);
    scene.add(this.group);
    this.seed = seed;
    window.__log?.(`world: island ${(t1 - t0) | 0}ms, forest ${(t2 - t1) | 0}ms (${this.forest.trees.length} trees), total ${(performance.now() - t0) | 0}ms`);
  }

  /* ------------------------------------------------------------ props */
  place(name, x, z, rot = 0, opts = {}) {
    const g = prop(name, opts); if (!g) return null;
    const y = opts.y !== undefined ? opts.y : this.island.height(x, z) + (opts.dy || 0);
    g.position.set(x, y, z); g.rotation.y = rot; if (opts.scale) g.scale.setScalar(opts.scale);
    g.traverse(o => { if (o.isMesh) { if (o.castShadow === undefined) o.castShadow = true; o.receiveShadow = true; } });
    this.props.add(g);
    if (!opts.noCollide) g.userData.phys = this.physics.addProp(g.userData.colliders, x, y, z, rot, opts.scale || 1, name);
    this.decor.push({ obj: g, x, z, r: opts.cull || 260 });
    return g;
  }
  /** place a flat decal prop on the ground (footprints, symbols) */
  decal(name, x, z, rot, opts = {}) {
    const g = prop(name, opts); if (!g) return null;
    const n = this.island.normal(x, z, new THREE.Vector3());
    g.position.set(x, this.island.height(x, z) + 0.03, z);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    g.rotateZ(rot);
    this.props.add(g); this.decor.push({ obj: g, x, z, r: opts.cull || 80 });
    return g;
  }
  /** a decal on a tree trunk facing outward toward (fx,fz) */
  trunkDecal(name, tree, fx, fz, h = 1.6) {
    const g = prop(name); if (!g) return null;
    const a = Math.atan2(fx - tree.x, fz - tree.z);
    g.position.set(tree.x + Math.sin(a) * (tree.r + 0.04), tree.y + h, tree.z + Math.cos(a) * (tree.r + 0.04));
    g.rotation.y = a;
    this.props.add(g); this.decor.push({ obj: g, x: tree.x, z: tree.z, r: 70 });
    return g;
  }
  landmarkProps() {
    const I = this.island, L = (id) => I.landmark(id);
    const r = rng(this.seed ^ 0x5eed);
    const at = (id, name, dx, dz, rot, opts) => { const l = L(id); return this.place(name, l.x + dx, l.z + dz, rot, opts); };
    // the crash
    this.named.crash = at('crash', 'helicopterWreck', 0, 0, 0.6, { cull: 400 });
    // hunter's cabin by the river
    this.named.cabin = at('cabin', 'cabin', 0, 0, -0.4 + Math.PI, { cull: 350 });
    at('cabin', 'logFallen', 9, 6, 1.2);
    // the survey camp
    this.named.survey = at('survey', 'surveyCamp', 0, 0, 0.3, { cull: 300 });
    at('survey', 'signpost', 14, 10, 2.2);
    at('survey', 'humanRemains', -11, 7, 1.0);
    // beach camp
    at('beachcamp', 'tent', 0, 0, 0.2); at('beachcamp', 'crate', 3, 2, 0.8); at('beachcamp', 'rowboat', 6, 7, 2.4); at('beachcamp', 'barrel', -3, 2, 0);
    // lookout tower
    this.named.tower = at('tower', 'watchtower', 0, 0, 0.5, { cull: 600 });
    // the cannibal village and its borders
    this.named.village = at('village', 'cannibalVillage', 0, 0, Math.PI / 2, { cull: 450 });
    for (let k = 0; k < 4; k++) { const a = -0.9 + k * 0.6, l = L('village'); this.place('effigy', l.x + Math.cos(a) * 95, l.z + Math.sin(a) * 95, -a + Math.PI / 2, { cull: 350 }); }
    // hide camp in the north-east
    this.named.camp2 = at('camp2', 'cannibalHut', -5, 0, 0.4);
    at('camp2', 'cannibalHut', 6, -4, -0.8); at('camp2', 'effigy', 0, 12, 0); at('camp2', 'offering', 3, 6, 0); at('camp2', 'totem', -8, -7, 0.5);
    // the old settlement in the burned forest
    this.named.ruins = at('ruins', 'ruinSettlement', 0, 0, 0.2, { cull: 450 });
    // the final arena
    this.named.circle = at('circle', 'stoneCircle', 0, 0, 0, { cull: 700 });
    // jetty on Mirror Lake
    const lake = I.lakes[0], dk = L('dock');
    const da = Math.atan2(lake.x - dk.x, lake.z - dk.z);
    this.named.dock = this.place('dock', dk.x, dk.z, da, { y: lake.level + 0.4, noCollide: false });
    this.place('rowboat', dk.x + Math.sin(da + 0.6) * 7, dk.z + Math.cos(da + 0.6) * 7, da + 1, { y: lake.level - 0.1 });
    // cave mouths
    for (const c of I.caves) {
      const g = this.place('caveMouth', c.x, c.z, c.dir, { cull: 500, y: c.y - 0.6 });
      this.named['cave_' + c.id] = g;
    }
    this._scatter(r);
  }
  _scatter(r) {
    const I = this.island;
    // boulders & big rocks - fixed (hash-based), collidable
    let n = 0;
    for (let k = 0; k < 6000 && n < 340; k++) {
      const x = (hash2(k, 1, 77) - 0.5) * 1800, z = (hash2(k, 2, 77) - 0.5) * 1800, h = I.height(x, z);
      if (h < 3 || I.waterDepth(x, z) > 0) continue;
      const g = I.grad(x, z), s = Math.hypot(g.x, g.z);
      if (hash2(k, 3, 77) > 0.25 + s * 0.8) continue;
      if (this._nearLandmark(x, z, 1.1)) continue;
      const big = hash2(k, 4, 77) < 0.3;
      this.place(big ? 'rockLarge' : 'boulder', x, z, hash2(k, 5, 77) * 6.28, { seed: k % 5, scale: 0.7 + hash2(k, 6, 77) * 0.8, cull: 300 });
      n++;
    }
    // fallen logs in the forest
    n = 0;
    for (let k = 0; k < 4000 && n < 140; k++) {
      const x = (hash2(k, 1, 91) - 0.5) * 1700, z = (hash2(k, 2, 91) - 0.5) * 1700;
      if (I.forestAt(x, z) < 0.5 || this._nearLandmark(x, z, 1.1)) continue;
      this.place('logFallen', x, z, hash2(k, 3, 91) * 6.28, { cull: 200 }); n++;
    }
    // old stumps and bones
    n = 0;
    for (let k = 0; k < 3000 && n < 60; k++) {
      const x = (hash2(k, 1, 93) - 0.5) * 1700, z = (hash2(k, 2, 93) - 0.5) * 1700;
      if (I.height(x, z) < 3 || this._nearLandmark(x, z, 1)) continue;
      this.place(hash2(k, 4, 93) < 0.6 ? 'stump' : hash2(k, 5, 93) < 0.5 ? 'skull' : 'bones', x, z, hash2(k, 3, 93) * 6.28, { cull: 120, noCollide: true }); n++;
    }
    // offerings on the trails between the cannibal camps and the forest
    const offs = [[-480, 120], [-520, 260], [-430, 40], [380, -380], [300, -300], [-300, 200], [120, -250]];
    for (const [x, z] of offs) this.place('offering', x + (r() - 0.5) * 30, z + (r() - 0.5) * 30, r() * 6.28, { cull: 140, noCollide: true });
    // symbols and claw marks on trunks
    const marks = (name, cx, cz, rad, count) => {
      let c = 0; this.forest.near(cx, cz, rad, (t) => { if (c >= count || t.sp === 'fir' || r() > 0.15) return; this.trunkDecal(name, t, cx, cz, 1.2 + r() * 1.4); c++; });
    };
    marks('symbolTree', -560, 160, 140, 10);
    marks('symbolTree', 140, -390, 90, 8);
    marks('clawMarks', 470, -430, 70, 4);
    marks('clawMarks', -260, -230, 60, 3);
    marks('clawMarks', 250, 320, 80, 2);
  }
  _nearLandmark(x, z, k = 1) {
    for (const l of this.island.landmarks) if (Math.hypot(x - l.x, z - l.z) < l.r * k + 6) return true;
    for (const c of this.island.caves) if (Math.hypot(x - c.x, z - c.z) < 18) return true;
    return false;
  }

  /* ------------------------------------------------------------ per frame */
  update(dt, cam) {
    const p = cam.position;
    this.forest.update(dt, p);
    this.cover.update(p);
    this._lodT = (this._lodT || 0) - dt;
    if (this._lodT <= 0) {
      this._lodT = 0.5;
      this.terrain.update(p);
      for (const d of this.decor) { const dx = d.x - p.x, dz = d.z - p.z; d.obj.visible = dx * dx + dz * dz < d.r * d.r; }
    }
    this.sky.follow(cam);
    if (this.skyEnv.update(dt)) this.water.setEnv(this.skyEnv.texture);
  }
  setQuality(q) {
    this.forest.setQuality(q); this.cover.setQuality(q);
    this.atmos.sun.shadow.mapSize.set(q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024, q === 'high' ? 4096 : q === 'medium' ? 2048 : 1024);
    if (this.atmos.sun.shadow.map) { this.atmos.sun.shadow.map.dispose(); this.atmos.sun.shadow.map = null; }
    this.atmos.shadowR = q === 'high' ? 80 : q === 'medium' ? 65 : 50;
  }
}
