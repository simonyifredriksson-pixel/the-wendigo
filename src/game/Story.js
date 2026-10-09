/* Story.js - what happened on this island, told by what is left behind.

   Nothing is explained by a narrator. Players find:
     NOTES      the Northbound Survey expedition (1986): five people, a
                geologist, a surveyor, a radio operator, a biologist and the
                guide who stayed behind. Their journals, a radio log, a diary.
     CARVINGS   six stones carved by the island's first people. In order they
                tell the whole story; found out of order they mislead (a
                ritual? a god? - no).
     PLACES     the crash (the pilot's seat is empty), the survey camp, the
                hunter's cabin, the lookout, the old settlement, the caves,
                the cannibals' camps.
   Discoveries are shared: when one player reads a note, it goes into
   everyone's journal (J). The GOAL line at the top of the journal and the
   objective on the HUD follow what the group knows:
     survive -> what happened here -> fire, a horn and a black spear ->
     make the Ember Spear -> the Antler Clearing at night -> escape. */
import * as THREE from '../../lib/three.module.js';
import { itemModel } from './Viewmodel.js';
import { prop } from '../world/World.js';

/* ------------------------------------------------------------------ the writing */
export const LORE = {
  pilot: { kind: 'discovery', title: 'The empty seat', text: 'The cockpit is crushed, the harness is still buckled - and the pilot is gone. No blood. No tracks leading away. Just the headset, swinging from its cable.' },
  survey1: { kind: 'note', title: 'Northbound Survey - field journal, E. Marsh', text: 'Day 3. Base camp established on the plateau. Varga has the theodolite up; Hale finally has the radio talking to the mainland.\n\nDay 9. Hale says the signal dies at the same minute every night and comes back at dawn. Walt laughed and said the island "keeps office hours".\n\nDay 14. Okita found a deer lying in the meadow with nothing wrong with it. Not a mark. It was just lying there watching us. She says its eyes were wrong. We moved camp anyway.' },
  radio: { kind: 'note', title: 'Radio log - P. Hale', text: '22:41  carrier lost. again.\n22:58  something on the band under the static. like breathing played slow.\n23:30  Walt says turn it off. Walt says it can hear the set.\n00:12  footsteps around the tents. heavy. nobody is outside.\n00:13  nobody is outside.' },
  okita: { kind: 'note', title: 'J. Okita - specimen notebook', text: 'Lepus (hare), meadow below the plateau. Normal behaviour all day.\nAfter dusk the same animal sat upright for forty minutes, motionless, oriented toward camp. I counted eleven of them by midnight. None moved when I walked toward them. All of them were gone at first light.\n\nThe wolves here do not howl the way wolves howl.' },
  varga: { kind: 'note', title: 'T. Varga - survey notes (lookout)', text: 'Marked two caves from the tower: one in the east cliffs the people in the west call "the Deep", one on the shoulder of the big peak full of bones.\nThe stone ring below the eastern peak is not natural. Twelve uprights, three hearths, a fallen arch. Someone built a place to burn something very large.\n\nWalt will not go up there. I asked why. "Because that is where it died the last time."' },
  brenner: { kind: 'note', title: 'Walt Brenner - cabin diary', text: 'The others are gone. Ellen last, from the ridge, in October. I stayed because a man has to stay with what he did.\n\nThe people in the west know it. They leave it meat at the edge of their land so it walks past them. They were people once. Hunger is a door, and they went through it.\n\nThe stones say the old ones killed it. Fire, to make it weak. A horn, to call it to the ring. A black spear with a burning heart, to finish it. The horn is in the west, on their altar. The black spearhead is in the bone cave. The ember is down in the Deep, where it sleeps in summer.\n\nIt will hear the horn from anywhere on the island. Light the hearths first.' },
  hale: { kind: 'note', title: 'Folded note in a parka pocket', text: 'If anyone finds this - do not follow the singing. It is not Ellen. It used her voice. It can use anybody\'s.' },
  cannibal: { kind: 'discovery', title: 'Offerings', text: 'Meat wrapped in leaves on flat stones, ringed with red pebbles, always at the border of their land, always facing the forest. Not food for themselves. Payment.' },
  headset: { kind: 'discovery', title: 'The pilot\'s headset', text: 'Hung on a stick at the edge of their camp like a trophy - or a warning. Whatever took the pilot, it was not them. They are afraid of it too.' },
  stone0: { kind: 'carving', title: 'The first stone', text: 'People dance in a circle around a fire. In the middle stands a tall, thin figure with branching antlers. A celebration - or a god among them.' },
  stone1: { kind: 'carving', title: 'The second stone', text: 'The same people carry gifts to the antlered figure: animals, baskets... and a figure with its hands bound.' },
  stone2: { kind: 'carving', title: 'The third stone', text: 'The people are running. The antlered figure is drawn again, but now it towers over the trees.' },
  stone3: { kind: 'carving', title: 'The fourth stone', text: 'A settlement of broken huts. Figures lying still. The antlered thing stands over all of it.' },
  stone4: { kind: 'carving', title: 'The fifth stone', text: 'Three figures walk toward a ring of standing stones. One carries fire, one a curved horn, one a spear with a mark at its tip. The antlered thing waits inside the ring.' },
  stone5: { kind: 'carving', title: 'The sixth stone', text: 'The antlered thing lies broken in the ring, burning. The sun rises over it. A single bird flies away across the sea.' },
  footprints: { kind: 'discovery', title: 'Tracks', text: 'Around the shelter, in a perfect circle, prints longer than a man is tall. Clawed, hoofed. Whatever made them walked all the way round. Slowly.' },
  sighting: { kind: 'discovery', title: 'Something on the ridge', text: 'Far away, standing taller than the trees. When we looked again there was nothing there.' },
  reveal: { kind: 'discovery', title: 'It looked down at us', text: 'Its head was up in the branches. Antlers like dead trees. It bent down to look at us, the way you look at something on the ground. Then it was gone.' },
  emberStone: { kind: 'relic', title: 'The Ember Stone', text: 'Deep under the island, on a shelf of black rock, a stone that is warm in the cold. Red light moves inside the cracks like something breathing.' },
  ashSpearhead: { kind: 'relic', title: 'The Ash Spearhead', text: 'Black glass wrapped in rotten leather, lying among a thousand bones. The edge has not dulled in however many centuries.' },
  boneHorn: { kind: 'relic', title: 'The Bone Horn', text: 'Taken from their altar. Spirals carved all the way to the mouthpiece. Brenner wrote that it can be heard from anywhere on the island.' },
};
const STONE_SPOTS = [
  [[50, 190], [20, 215], [-90, 200]],          // 0 near the crash
  [[318, 268], [300, 300], [345, 240]],        // 1 by the river, near the cabin
  [[-228, -205], [-280, -200], [-245, -265]],  // 2 survey camp
  [[395, -105], [430, -40], [380, -60]],       // 3 old settlement
  null,                                        // 4 inside the Deep (Caves.js)
  [[110, -330], [175, -340], [95, -365]],      // 5 the approach to the stone circle
];
/* loot at landmarks: [landmark, dx, dz, item, n] */
const LOOT = [
  ['crash', 3, -2, 'flaregun', 1], ['crash', 3.4, -2.2, 'flare', 3], ['crash', 2.6, -1.6, 'medkit', 1], ['crash', -2, 3, 'can', 2], ['crash', -2.4, 3.3, 'rope', 2],
  ['cabin', 1.2, 0.6, 'rifle', 1], ['cabin', 1.6, 0.2, 'ammo', 6], ['cabin', -1.5, 1, 'flashlight', 1], ['cabin', -1.2, 1.4, 'batteries', 2], ['cabin', 0.5, -1.5, 'can', 2],
  ['survey', 1.5, 0.5, 'batteries', 2], ['survey', -1, 1.5, 'rope', 3], ['survey', 2, -1.2, 'cloth', 3], ['survey', -2.5, -1, 'medkit', 1],
  ['beachcamp', 1, 1, 'can', 2], ['beachcamp', 1.5, 0.4, 'waterBottle', 2], ['beachcamp', -1, 1.2, 'rope', 2],
  ['tower', 0.6, 0.6, 'flare', 2], ['tower', -0.5, 0.8, 'batteries', 1],
  ['camp2', 2, 2, 'boneClub', 1], ['camp2', -2, 1, 'hide', 2],
  ['village', 8, -6, 'herbs', 3], ['village', -6, 8, 'hide', 2],
  ['ruins', 3, 4, 'bone', 3],
];

export class Story {
  constructor(game) { this.g = game; this.objs = []; }
  /* ---------------------------------------------------------------- setup */
  begin(W) {
    const g = this.g, I = g.island;
    for (const o of this.objs) o.removeFromParent(); this.objs = [];
    const L = (id) => I.landmark(id);
    const note = (key, x, z, y, model = 'note') => {
      const yy = y ?? g.physics.ground(x, z) + 0.05;
      const m = itemModel(model); m.position.set(x, yy, z); m.rotation.y = Math.random() * 6; g.scene.add(m); this.objs.push(m);
      g.interact?.add({ id: 'lore_' + key, x, y: yy + 0.1, z, r: 0.45, text: () => (W.lore[key] ? 'Read again' : 'Read'), act: () => this.read(key) });
      return m;
    };
    // the crash: the empty cockpit
    const c = L('crash');
    g.interact?.add({ id: 'lore_pilot', x: c.x + 3.5, y: c.y + 1.5, z: c.z + 1.5, r: 1.6, text: () => (W.lore.pilot ? null : 'Look into the cockpit'), act: () => this.read('pilot') });
    // notes at their places (use the props' named spots when the art provides them)
    const spot = (lm, name, dx, dz) => { const grp = g.world.named[lm]; const o = grp?.getObjectByName?.(name); if (o) { const v = new THREE.Vector3(); o.getWorldPosition(v); return v; } const l = L(lm); return new THREE.Vector3(l.x + dx, g.physics.ground(l.x + dx, l.z + dz) + 0.8, l.z + dz); };
    let s = spot('survey', 'journal', 1, 0.5); note('survey1', s.x, s.z, s.y, 'journal');
    note('radio', L('survey').x - 3, L('survey').z + 2);
    s = spot('cabin', 'desk', 0.8, -1); note('brenner', s.x, s.z, s.y + 0.05, 'journal');
    note('okita', L('beachcamp').x - 1.5, L('beachcamp').z + 0.5, undefined, 'journal');
    s = spot('tower', 'top', 0, 0); note('varga', s.x, s.z, W.towerY ?? undefined);
    const sv = L('survey'); note('hale', sv.x - 11, sv.z + 8.5);
    const c2 = L('camp2'); g.interact?.add({ id: 'lore_headset', x: c2.x - 9, y: c2.y + 1.4, z: c2.z + 5, r: 0.8, text: () => (W.lore.headset ? null : 'A headset, hung on a stick'), act: () => this.read('headset') });
    const hs = itemModel('radio'); hs.position.set(c2.x - 9, c2.y + 1.3, c2.z + 5); g.scene.add(hs); this.objs.push(hs);
    // carved stones (positions picked from the world seed)
    this.stones = [];
    STONE_SPOTS.forEach((cands, i) => {
      if (!cands) return;
      const [x, z] = cands[(W.seed >>> (i * 3)) % cands.length];
      this.placeStone(i, x, z);
    });
    // loot
    for (const [lm, dx, dz, item, n] of LOOT) {
      const id = 'loot_' + lm + '_' + item + dx;
      if (W.taken[id]) continue;
      const l = L(lm); const x = l.x + dx, z = l.z + dz;
      g.items?._add({ id, name: item, n, x, y: g.physics.ground(x, z, l.y + 3) + 0.03, z });
    }
    // the horn on the cannibals' altar
    if (!W.relics.boneHorn) { const r = spot('village', 'relic', 0, 6); this.relicSpot('boneHorn', r.x, r.y, r.z); }
    this._objective();
  }
  placeStone(i, x, z, y, rotY) {
    const g = this.g, W = g.W;
    const gy = y ?? g.island.height(x, z);
    let m = prop('carvedStone', { story: i });
    if (!m) { m = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.9, 0.45), new THREE.MeshStandardMaterial({ color: 0x777370, roughness: 0.95 })); m.geometry.translate(0, 0.95, 0); }
    m.position.set(x, gy - 0.1, z);
    const c = g.island.landmark('crash');
    m.rotation.y = rotY ?? Math.atan2(c.x - x, c.z - z) * 0 + (W.seed % 7) * 0.9 + i;
    m.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    g.scene.add(m); this.objs.push(m);
    g.physics.add({ x, z, r: 0.7, h: 2, y0: gy - 0.5 });
    const f = new THREE.Vector3(Math.sin(m.rotation.y), 0, Math.cos(m.rotation.y));
    g.interact?.add({ id: 'lore_stone' + i, x: x + f.x * 0.5, y: gy + 1.1, z: z + f.z * 0.5, r: 0.8, text: () => 'Study the carving', act: () => this.read('stone' + i, m) });
    this.stones.push({ i, m });
  }
  /** a relic lying somewhere (caves call this too) */
  relicSpot(name, x, y, z) {
    const g = this.g;
    if (g.W.relics[name]) return;
    const m = itemModel(name); m.position.set(x, y, z); g.scene.add(m); this.objs.push(m);
    if (name === 'emberStone' || name === 'ashSpearhead') { const l = { x, y: y + 0.3, z, i: 1.5, r: 6, c: 0xff4020, flicker: true, seed: x }; (g.extraLights ||= []).push(l); m.userData.light = l; }
    g.interact?.add({ id: 'relic_' + name, x, y: y + 0.15, z, r: 0.5, text: () => 'Take the ' + LORE[name].title.replace('The ', '').toLowerCase(), act: () => g.act({ k: 'flag', relic: name }) });
    m.userData.relic = name;
  }

  /* ---------------------------------------------------------------- discovering */
  read(key, obj) {
    const g = this.g, L = LORE[key];
    let img = null;
    if (obj && L.kind === 'carving') { obj.traverse(o => { if (!img && o.name === 'face' && o.material?.map?.image?.toDataURL) try { img = o.material.map.image.toDataURL('image/jpeg', 0.7); } catch (e) { /* */ } }); }
    g.ui.open('note', null);
    g.ui.close();
    this._show(L, img);
    if (!g.W.lore[key]) g.act({ k: 'lore', key, img });
  }
  _show(L, img) {
    const g = this.g;
    g.ui.modal = 'read'; g.input.blocked = true; g.input.unlock?.();
    const p = document.getElementById('panel');
    p.className = 'on read';
    p.innerHTML = `<div class="box paper ${L.kind}"><div class="ptitle">${L.title}</div>${img ? `<img src="${img}">` : ''}<div class="ptext">${L.text.replace(/</g, '&lt;').replace(/\n/g, '<br>')}</div><button data-a="close" class="x">CLOSE (E)</button></div>`;
    const close = (e) => { if (e.code === 'KeyE' || e.code === 'Escape') { removeEventListener('keydown', close); g.ui.modal = 'read'; g.ui.close(); } };
    setTimeout(() => addEventListener('keydown', close), 200);
    g.audio.journal?.();
  }
  applyLore(a) { const g = this.g; if (g.W.lore[a.key]) return; g.W.lore[a.key] = 1; if (a.img) (g.W.loreImg ||= {})[a.key] = a.img.length < 120000 ? a.img : null; g.emit({ k: 'lore', key: a.key }); this._flags(a.key); }
  applyFlag(a, from) {
    if (from !== undefined && a.from === undefined) a = { ...a, from };
    const g = this.g;
    if (a.relic) {
      if (g.W.relics[a.relic]) return;
      g.W.relics[a.relic] = 1; g.W.lore[a.relic] = 1;
      g.emit({ k: 'relic', name: a.relic });
      g.sync?.give(a.from || g.me, a.relic, 1);
    }
  }
  _flags(key) {
    const W = this.g.W;
    if (key === 'brenner' || key === 'stone4') W.flags.knowsRelics = 1;
  }
  onEvent(e, from) {
    const g = this.g;
    if (e.k === 'lore') { g.W.lore[e.key] = 1; this._flags(e.key); g.hud.toast('New journal entry: ' + LORE[e.key].title + '  (J)', 4.5); g.audio.discovery?.(); this._objective(); }
    if (e.k === 'relic') {
      g.W.relics[e.name] = 1; g.W.lore[e.name] = 1;
      for (const o of this.objs) if (o.userData.relic === e.name) { o.removeFromParent(); if (o.userData.light) g.extraLights.splice(g.extraLights.indexOf(o.userData.light), 1); }
      g.interact?.remove('relic_' + e.name);
      g.audio.stinger?.('relic');
      g.hud.toast(LORE[e.name].title + ' - taken.', 5);
      if (g.W.relics.emberStone && g.W.relics.ashSpearhead) g.W.flags.knowsSpear = 1;
      // taking a relic angers the island
      if (g.isHost && e.name === 'boneHorn') g.cannibals?.alarm?.();
      this._objective();
    }
    if (e.k === 'act:flag') this.applyFlag({ ...e, from });
  }
  onSighted(level) {
    const key = level === 'reveal' ? 'reveal' : 'sighting';
    if (!this.g.W.lore[key] && this.g.isHost) this.applyLore({ key });
  }
  onCampVisited() { if (!this.g.W.lore.footprints && this.g.isHost) setTimeout(() => this.applyLore({ key: 'footprints' }), 100); }
  onCrafted(n) { if (n === 'emberSpear') { this.g.W.flags.spear = 1; this.g.act({ k: 'lore', key: 'stone5' }); this._objective(); } }

  /* ---------------------------------------------------------------- the goal */
  goalText() {
    const W = this.g.W; if (!W) return '';
    const R = W.relics, has = (k) => !!R[k];
    if (W.done) return 'You escaped the island.';
    if (W.flags.finale) return 'Kill it. Light the hearths. Drop the deadfalls on it. Strike the heart.';
    if (this.g.inventory?.count('emberSpear') || W.flags.spear) return has('boneHorn') ? 'Go to the Antler Clearing at night. Light the three hearths. Blow the horn.' : 'Take the Bone Horn from the cannibals\' altar in the west.';
    if (W.flags.knowsSpear) return 'Make the Ember Spear at a workbench (spearhead, ember stone, two sticks, two rope).' + (has('boneHorn') ? '' : ' The horn is still on their altar.');
    if (W.flags.knowsRelics) {
      const need = [];
      if (!has('boneHorn')) need.push('the Bone Horn (their altar, in the west)');
      if (!has('ashSpearhead')) need.push('the black spearhead (the Bone Cave, on the big peak)');
      if (!has('emberStone')) need.push('the Ember Stone (the Deep, in the east cliffs)');
      return 'Fire, a horn and a black spear killed it once. Find ' + need.join(', ') + '.';
    }
    if (Object.keys(W.lore).length >= 2) return 'Find out what happened to the people who were here before you.';
    return this.g.atmos.day === 1 && this.g.atmos.hour < 19 ? 'Find shelter and build a fire before dark.' : 'Survive the night.';
  }
  _objective() {
    const t = this.goalText();
    const [head, ...rest] = t.split('. ');
    this.g.hud.objective(head.replace(/\.$/, ''), rest.join('. '));
  }
  journal() {
    const W = this.g.W; if (!W) return [];
    return Object.keys(W.lore).filter(k => LORE[k]).map(k => ({ ...LORE[k], img: W.loreImg?.[k] || null }));
  }
  update(dt) {
    this._t = (this._t || 0) - dt;
    if (this._t <= 0) { this._t = 5; this._objective(); }
    // the cannibals' offerings tell their own story
    const g = this.g;
    if (!g.W.lore.cannibal && g.isHost) { const v = g.island.landmark('village'); if (Math.hypot(g.player.pos.x - v.x, g.player.pos.z - v.z) < 110) this.applyLore({ key: 'cannibal' }); }
  }
}
