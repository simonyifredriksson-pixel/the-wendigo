/* Chop.js - cutting trees down, and cutting them up.

   1. The first axe blow PROMOTES the tree: it leaves the instanced forest and
      becomes its own mesh, with a bark material that can be cut away.
   2. Every blow deepens a V-shaped notch at waist height on the side facing
      the chopper: the bark is discarded in the shader inside the notch and
      two fresh-wood faces (the wedge) show the cut. Chips fly, the trunk
      shudders, needles and leaves rain out of the crown.
   3. When the notch passes the middle the tree creaks, then FALLS: it hinges
      on the uncut side and rotates with rod physics (slow start, violent
      finish) away from the chopper, crashes into the terrain (dust, a ground
      thump, camera shake for anyone near, damage for anyone under it), the
      crown bounces twice and settles. A stump stays behind.
   4. The fallen trunk is solid and can be bucked: every two blows split off a
      log that drops next to you (pick it up, carry up to four). When it is
      used up it crumbles away.

   Host-authoritative: blows are actions; the host keeps hit points and
   decides when a tree falls; everyone animates from events. */
import * as THREE from '../../lib/three.module.js';
import { model, materials, trunkRadius } from '../art/Trees.js';
import { tex } from '../core/Textures.js';
import { PROMOTED, FELLED, GONE, STANDING } from '../world/Forest.js';
import { clamp, lerp } from '../core/Util.js';

const NOTCH_Y = 0.9;     // world metres above the ground

export class Chop {
  constructor(game) {
    this.g = game;
    this.live = new Map();     // tree id -> state of a promoted tree
    this.wood = new THREE.MeshStandardMaterial({ map: tex('freshWood').map, normalMap: tex('freshWood').normalMap, roughness: 0.85, side: THREE.DoubleSide });
    const le = tex('logEnd').map.clone(); le.wrapS = le.wrapT = THREE.ClampToEdgeWrapping; le.needsUpdate = true;
    this.endMat = new THREE.MeshStandardMaterial({ map: le, roughness: 0.85 });
  }
  hits(t) { return clamp(3 + t.h * 0.26, 3, 10); }

  /* ------------------------------------------------------------ input from the viewmodel */
  hit(tree, point, dir, power) {
    const g = this.g;
    // instant local feedback; the host confirms
    g.audio.axeHit?.(point, 0.8, 'wood');
    g.fx?.chipBurst(point, { x: -dir.x, z: -dir.z }, 7 + Math.floor(Math.random() * 4), g.island.height(point.x, point.z));
    g.player.noise = Math.max(g.player.noise, 0.7);
    g.act({ k: 'chop', id: tree.id, px: point.x, py: point.y, pz: point.z, dx: dir.x, dz: dir.z, p: power });
  }
  /** host: apply a blow */
  apply(a, from) {
    const t = this.g.forest.get(a.id); if (!t || t.state === FELLED || t.state === GONE) return;
    const L = this.live.get(t.id);
    if (L && L.falling) return;
    t.hp = (t.hp ?? this.hits(t)) - a.p;
    this.g.emit({ k: 'chopHit', id: t.id, dx: a.dx, dz: a.dz, px: a.px, py: a.py, pz: a.pz, dmg: 1 - Math.max(0, t.hp) / this.hits(t), by: from });
    if (t.hp <= 0) {
      // fall away from the chopper, give or take
      const ang = Math.atan2(a.dx, a.dz) + (Math.random() - 0.5) * 1.1;
      this.g.emit({ k: 'treeFall', id: t.id, a: ang });
      this.g.W.stats.trees++;
    }
  }
  onEvent(e) {
    if (e.k === 'chopHit') this._hitFx(e);
    else if (e.k === 'treeFall') this.fall(e.id, e.a);
    else if (e.k === 'logCut') this._logCut(e);
  }

  /* ------------------------------------------------------------ promotion */
  _promote(t) {
    if (this.live.has(t.id)) return this.live.get(t.id);
    const g = this.g, M = materials(), m = model(t.sp, t.v, 0);
    const s = t.s;
    const root = new THREE.Group(); root.position.set(t.x, t.y, t.z); root.rotation.y = t.rot; root.scale.setScalar(s);
    const sway = new THREE.Group(); root.add(sway);         // shudder pivot (at the base)
    const bark = this._cutMaterial(M.bark[t.sp], t.charred);
    const trunk = new THREE.Mesh(m.trunk, bark); trunk.castShadow = trunk.receiveShadow = true;
    sway.add(trunk);
    let leaves = null;
    if (m.leaves) { leaves = new THREE.Mesh(m.leaves, M.leaves[t.sp]); leaves.castShadow = true; leaves.receiveShadow = true; leaves.customDepthMaterial = M.depth[t.sp]; sway.add(leaves); }
    const wedge = new THREE.Mesh(new THREE.BufferGeometry(), this.wood); wedge.castShadow = true; sway.add(wedge);
    g.scene.add(root);
    g.forest.setState(t.id, PROMOTED);
    const hn = NOTCH_Y / s;
    const L = { t, m, root, sway, trunk, leaves, wedge, bark, hn, R: trunkRadius(m, hn), u: null, depth: 0, shake: 0, shakeV: 0, falling: false, theta: 0, omega: 0 };
    this.live.set(t.id, L);
    return L;
  }
  /** a bark material that can discard a notch and everything below a cut plane */
  _cutMaterial(base, charred) {
    const m = base.clone();
    if (charred) m.color = new THREE.Color(0.18, 0.16, 0.15);
    const u = { uNotch: { value: new THREE.Vector4(1, 0, 0, 0.9) }, uNotchW: { value: new THREE.Vector2(0, 0) }, uR: { value: 0.3 }, uCut: { value: -1e4 } };
    m.userData.u = u;
    const prev = base.onBeforeCompile;
    m.onBeforeCompile = (sh, r) => {
      prev.call(m, sh, r);
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vLocal;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvLocal = position;');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vLocal; uniform vec4 uNotch; uniform vec2 uNotchW; uniform float uR; uniform float uCut;')
        .replace('void main() {', `void main() {
          if (vLocal.y < uCut) discard;
          if (uNotch.z > 0.0) {
            float sd = uR - dot(vLocal.xz, uNotch.xy);          // depth from the face side
            if (sd < uNotch.z) {
              float k = 1.0 - sd / uNotch.z;
              if (vLocal.y < uNotch.w + uNotchW.x * k && vLocal.y > uNotch.w - uNotchW.y * k) discard;
            }
          }`);
    };
    m.customProgramCacheKey = () => 'cutbark' + (base.customProgramCacheKey ? base.customProgramCacheKey() : '');
    return m;
  }
  /** rebuild the wedge faces for a notch of depth d (local units) */
  _wedge(L, topOnly = false) {
    const { R, hn, u, depth: d } = L;
    if (!u || d <= 0.001) { L.wedge.visible = false; return; }
    L.wedge.visible = true;
    const wt = d * 0.9, wb = d * 0.35;
    const vx = -u.y, vz = u.x; // lateral (u is {x: ux, y: uz})
    const P = [], UV = [], I = [];
    const S = 8;
    const face = (top) => {
      const base = P.length / 3;
      for (let i = 0; i <= S; i++) {
        const s = (i / S) * d, k = 1 - s / d, c = R - s;
        const hw = Math.sqrt(Math.max(0, R * R - c * c)) * 1.02;
        const y = top ? hn + wt * k : hn - wb * k;
        const cx = u.x * c, cz = u.y * c;
        P.push(cx + vx * hw, y, cz + vz * hw, cx - vx * hw, y, cz - vz * hw);
        UV.push(0, s * 3, 1, s * 3);
      }
      for (let i = 0; i < S; i++) { const a = base + i * 2; if (top) I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); else I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    };
    face(true); if (!topOnly) face(false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setIndex(I);
    g.computeVertexNormals();
    L.wedge.geometry.dispose(); L.wedge.geometry = g;
    const bu = L.bark.userData.u;
    bu.uNotch.value.set(u.x, u.y, d, hn); bu.uNotchW.value.set(wt, wb); bu.uR.value = R * 1.06;
  }

  /* ------------------------------------------------------------ blows */
  _hitFx(e) {
    const g = this.g, t = g.forest.get(e.id); if (!t) return;
    const L = this._promote(t);
    if (!L.u) {
      // the notch faces whoever struck first (in the tree's local frame)
      const wx = -e.dx, wz = -e.dz, l = Math.hypot(wx, wz) || 1;
      const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
      L.u = { x: (wx * c + wz * s) / l, y: (-wx * s + wz * c) / l };
    }
    L.depth = clamp(e.dmg, 0, 1) * L.R * 1.25;
    this._wedge(L);
    L.shakeV += 1.6; // shudder
    if (e.by !== g.me) { g.audio.axeHit?.({ x: e.px, y: e.py, z: e.pz }, 0.8, 'wood'); g.fx?.chipBurst({ x: e.px, y: e.py, z: e.pz }, { x: -e.dx, z: -e.dz }, 7, t.y); }
    // needles and leaves shaken loose
    if (g.fx && t.h > 5) for (let i = 0; i < 6; i++) {
      const a = Math.random() * 6.28, r = Math.random() * 3 * t.s;
      g.fx.soft.spawn(g.fx._p0({ x: t.x + Math.cos(a) * r, y: t.y + t.h * (0.5 + Math.random() * 0.4), z: t.z + Math.sin(a) * r, vy: -1, drag: 2.5, g: 0.8, life: 6, s0: 0.06, s1: 0.06, r: t.sp === 'maple' ? 0.6 : 0.25, gg: t.sp === 'maple' ? 0.28 : 0.35, b: 0.1, a: 0.9, spin: 4, soft: 0.1, wind: 2, floor: t.y + 0.02 }));
    }
    if (e.dmg > 0.72 && !L.creaked) { L.creaked = true; g.audio.treeCreak?.({ x: t.x, y: t.y + 3, z: t.z }, clamp(t.h / 25, 0.2, 1)); }
  }
  /** start the fall (also used when the Wendigo snaps a tree) */
  fall(id, ang, opts = {}) {
    const g = this.g, t = g.forest.get(id); if (!t) return;
    const L = this._promote(t);
    if (L.falling) return;
    L.falling = true; L.fallAng = ang;
    // re-parent the trunk group under a hinge on the fall side at notch height
    const dirW = { x: Math.sin(ang), z: Math.cos(ang) };
    const c = Math.cos(-t.rot), s = Math.sin(-t.rot);
    const dl = { x: dirW.x * c + dirW.z * s, z: -dirW.x * s + dirW.z * c };      // fall direction, tree-local
    const hinge = new THREE.Group();
    hinge.position.set(dl.x * L.R, L.hn, dl.z * L.R);
    L.root.add(hinge);
    L.sway.position.set(-dl.x * L.R, -L.hn, -dl.z * L.R);
    L.sway.rotation.set(0, 0, 0);
    hinge.add(L.sway);
    L.hinge = hinge; L.axis = new THREE.Vector3(dl.z, 0, -dl.x).normalize();  // rotating about this tips the top toward dl
    L.dl = dl; L.dirW = dirW;
    // the stump stays, the trunk keeps only what is above the cut
    L.bark.userData.u.uCut.value = L.hn;
    if (!opts.snap) { if (L.u) this._wedge(L, true); }
    else { L.wedge.visible = false; L.bark.userData.u.uNotch.value.z = 0; }
    const cap = new THREE.Mesh(new THREE.CircleGeometry(L.R, 14).rotateX(Math.PI / 2), this.endMat); cap.position.y = L.hn; L.sway.add(cap);
    g.forest.setState(t.id, FELLED, { stumpH: NOTCH_Y, fallen: true });
    // where does it land? the angle at which the trunk meets the ground
    const H = t.h * 0.75;
    const gx = t.x + dirW.x * H, gz = t.z + dirW.z * H;
    const dy = g.island.height(gx, gz) - (t.y + NOTCH_Y);
    L.thetaMax = clamp(Math.PI / 2 - Math.atan2(dy, H), 0.9, 2.0);
    L.theta = opts.snap ? 0.15 : 0.012; L.omega = opts.snap ? 1.2 : 0.06; L.bounces = 0;
    L.len = t.h;
    L.logs = Math.max(1, Math.round(t.h / 4)); L.blows = 0;
    g.audio.treeFall?.({ x: t.x, y: t.y + t.h * 0.6, z: t.z }, clamp(t.h / 25, 0.2, 1));
    if (!opts.snap) g.audio.treeCreak?.({ x: t.x, y: t.y + 2, z: t.z }, clamp(t.h / 25, 0.2, 1));
  }

  /* ------------------------------------------------------------ per frame */
  update(dt) {
    const g = this.g;
    for (const L of this.live.values()) {
      // shudder: a damped spring around the base
      if (!L.falling) {
        L.shakeV += -L.shake * 60 * dt - L.shakeV * 8 * dt; L.shake += L.shakeV * dt;
        const k = L.shake * 0.012;
        L.sway.rotation.set(L.u ? -L.u.y * k : k, 0, L.u ? L.u.x * k : 0);
        continue;
      }
      if (L.rest) { this._settle(L, dt); continue; }
      // rod tipping about its base: theta'' = (3g / 2L) sin(theta)
      const acc = (3 * 9.8 / (2 * Math.max(4, L.len))) * Math.sin(Math.max(0.02, L.theta));
      L.omega += acc * dt;
      L.theta += L.omega * dt;
      if (L.theta >= L.thetaMax) {
        L.theta = L.thetaMax;
        if (L.bounces === 0) this._impact(L);
        if (L.bounces < 2 && Math.abs(L.omega) > 0.25) { L.omega = -L.omega * 0.22; L.bounces++; }
        else { L.omega = 0; L.rest = true; L.restT = 0; this._makeSolid(L); }
      }
      L.hinge.quaternion.setFromAxisAngle(L.axis, L.theta);
    }
  }
  _settle(L, dt) {
    L.restT += dt;
    if (L.dissolve !== undefined) {
      L.dissolve += dt;
      L.root.position.y -= dt * 0.6;
      if (L.dissolve > 1.6) this._remove(L);
    }
  }
  _impact(L) {
    const g = this.g, t = L.t;
    const mid = { x: t.x + L.dirW.x * t.h * 0.5, y: g.island.height(t.x + L.dirW.x * t.h * 0.5, t.z + L.dirW.z * t.h * 0.5), z: t.z + L.dirW.z * t.h * 0.5 };
    const size = clamp(t.h / 25, 0.2, 1);
    g.audio.treeImpact?.(mid, size);
    if (g.fx) for (let k = 0.25; k <= 1; k += 0.15) {
      const x = t.x + L.dirW.x * t.h * k, z = t.z + L.dirW.z * t.h * k;
      g.fx.dust({ x, y: g.island.height(x, z), z }, Math.ceil(6 * size), [0.45, 0.4, 0.32], 1.8 * size, 1.5);
    }
    // camera shake for anyone near, damage for anyone underneath (host decides damage)
    const p = g.player, d = Math.hypot(p.pos.x - mid.x, p.pos.z - mid.z);
    g.shake = Math.max(g.shake, clamp(1 - d / 45, 0, 1) * 0.6 * size);
    if (!p.downed) {
      // distance from the player to the trunk line on the ground
      const ax = p.pos.x - t.x, az = p.pos.z - t.z, along = ax * L.dirW.x + az * L.dirW.z, off = Math.abs(ax * L.dirW.z - az * L.dirW.x);
      if (along > 1 && along < t.h * 0.95 && off < 1.2 + (along > t.h * 0.5 ? 2.2 : 0) * size) {
        p.hurt(45 * size + 10, { x: p.pos.x - L.dirW.z * (ax * L.dirW.z - az * L.dirW.x > 0 ? -1 : 1), z: p.pos.z }, 'tree');
        g.hud.toast('TIMBER. Watch where it falls.');
      }
    }
    g.wildlife?.scare(mid, 60);
    g.director?.noise?.(mid, 0.8);
    // a few sticks and leaves break off the crown
    if (g.isHost && g.items) {
      const cx = t.x + L.dirW.x * t.h * 0.8, cz = t.z + L.dirW.z * t.h * 0.8;
      const n = t.sp === 'fir' ? 1 : 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) g.items.spawn('stick', cx + (Math.random() - 0.5) * 4, cz + (Math.random() - 0.5) * 4);
      if (t.sp !== 'dead') g.items.spawn('leaves', cx, cz, 3);
    }
  }
  _makeSolid(L) {
    const g = this.g, t = L.t;
    // a box along the trunk you can climb over (or chop up)
    const len = t.h * 0.85, cx = t.x + L.dirW.x * len / 2, cz = t.z + L.dirW.z * len / 2;
    L.col = g.physics.add({ x: cx, z: cz, w: L.R * t.s * 2, d: len, h: L.R * t.s * 2, y0: g.island.height(cx, cz) - 0.2, rot: Math.atan2(L.dirW.x, L.dirW.z), walk: true, tag: 'fallen' });
  }
  /* ------------------------------------------------------------ bucking the fallen trunk */
  /** a melee ray against fallen trunks; returns true if it hit one */
  hitLog(o, d, reach, T) {
    const g = this.g;
    for (const L of this.live.values()) {
      if (!L.rest || L.dissolve !== undefined) continue;
      const t = L.t, ax = t.x, az = t.z;
      // closest approach between the ray and the trunk axis (2D + rough height)
      for (let s = 0.4; s <= reach; s += 0.2) {
        const px = o.x + d.x * s, py = o.y + d.y * s, pz = o.z + d.z * s;
        const along = (px - ax) * L.dirW.x + (pz - az) * L.dirW.z;
        if (along < 1 || along > t.h * 0.9) continue;
        const off = Math.abs((px - ax) * L.dirW.z - (pz - az) * L.dirW.x);
        const gy = g.island.height(px, pz);
        if (off < L.R * t.s + 0.25 && py < gy + L.R * t.s * 2.4 + 0.3) {
          const pt = new THREE.Vector3(px, py, pz);
          g.audio.chopLog?.(pt) ?? g.audio.axeHit?.(pt, 0.7, 'wood');
          g.fx?.chipBurst(pt, { x: -d.x, z: -d.z }, 6, gy);
          if ((T.chop || 0) > 0) g.act({ k: 'buck', id: t.id, x: px, z: pz });
          return true;
        }
      }
    }
    return false;
  }
  /** host: a blow on a fallen trunk */
  buck(a, from) {
    const L = this.live.get(a.id); if (!L || !L.rest || L.dissolve !== undefined) return;
    L.blows++;
    if (L.blows % 2 === 0) {
      L.logs--;
      this.g.items?.spawn('log', a.x, a.z);
      this.g.emit({ k: 'logCut', id: a.id, left: L.logs });
    }
  }
  _logCut(e) {
    const L = this.live.get(e.id); if (!L) return;
    L.logs = e.left;
    this.g.fx?.dust({ x: L.t.x + L.dirW.x * L.t.h * 0.4, y: L.t.y + 0.3, z: L.t.z + L.dirW.z * L.t.h * 0.4 }, 4, [0.5, 0.42, 0.3], 0.8, 1);
    if (e.left <= 0) {
      L.dissolve = 0;
      if (L.col) this.g.physics.remove(L.col);
      this.g.forest.setState(L.t.id, GONE);
    }
  }
  _remove(L) { L.root.removeFromParent(); L.trunk.material.dispose(); this.live.delete(L.t.id); }

  /* ------------------------------------------------------------ save/load */
  save(W) {
    for (const L of this.live.values()) if (L.falling) W.felled[L.t.id] = L.dissolve !== undefined ? GONE : FELLED;
    W.fallen = {};
    for (const L of this.live.values()) if (L.rest && L.dissolve === undefined) W.fallen[L.t.id] = { a: +L.fallAng.toFixed(3), n: L.logs };
  }
  begin(W) {
    for (const L of [...this.live.values()]) this._remove(L);
    // trees that were lying on the ground when the game was saved
    for (const id in W.fallen || {}) {
      const f = W.fallen[id], t = this.g.forest.get(+id); if (!t) continue;
      t.state = STANDING;
      this.fall(t.id, f.a, { snap: true });
      const L = this.live.get(t.id);
      L.theta = L.thetaMax; L.hinge.quaternion.setFromAxisAngle(L.axis, L.theta); L.rest = true; L.restT = 0; L.logs = f.n; this._makeSolid(L);
    }
  }
}
