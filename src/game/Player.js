/* Player.js - the local survivor: movement, camera and vital signs.

   Movement     walk 3.6 m/s, sprint 6.8, crouch 1.8 (quiet), jump; slides off
                slopes steeper than ~45 deg; swims when the water is deep.
   Vitals       health, stamina, hunger, warmth (0..100). Kept simple:
                - stamina: sprinting, jumping, swimming and swinging cost it
                - hunger: falls slowly; empty = health drains
                - warmth: night, rain and water chill you; fires, shelter, hides warm
                - health regenerates slowly while fed and warm
   Downed       at 0 health with friends online you go down and can be revived
                (hold E on a downed friend); otherwise you die and respawn.
   Camera       first person; head bob, landing dip, a trauma value for
                shake (Wendigo footsteps, hits), FOV kick when sprinting. */
import * as THREE from '../../lib/three.module.js';
import { clamp, lerp, damp } from '../core/Util.js';

export const EYE = 1.62, RADIUS = 0.34, HEIGHT = 1.78;

export class Player {
  constructor(game) {
    this.game = game;
    this.pos = new THREE.Vector3(0, 10, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = false; this.crouch = 0; this.sprinting = false; this.swimming = false; this.underwater = false;
    this.health = 100; this.stamina = 100; this.hunger = 85; this.warmth = 80;
    this.downed = false; this.dead = false; this.downT = 0; this.reviveT = 0;
    this.trauma = 0; this.bob = 0; this.bobAmp = 0; this.land = 0; this.fovKick = 0;
    this.speed = 0; this.noise = 0;            // how loud we are this frame (0..1) - the Wendigo and animals listen
    this.stepT = 0; this.surface = 'grass';
    this.inShelter = false; this.nearFire = 0; this.wet = 0;
    this.god = false; this.noclip = false; this.speedMul = 1;
    this.mode = 'idle';                          // for remote avatars
    this.carry = 0;                              // logs carried on the shoulder
    this.knock = new THREE.Vector3();            // knockback impulse
    this.stunT = 0;
    this.lastSafe = new THREE.Vector3();
  }
  get eye() { return _e.set(this.pos.x, this.pos.y + EYE - this.crouch * 0.6, this.pos.z); }
  get forward() { return _f.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)); }
  spawn(x, z, yaw = 0) {
    const g = this.game.physics.ground(x, z);
    this.pos.set(x, g, z); this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0;
    this.lastSafe.copy(this.pos);
  }
  hurt(amount, from, kind = 'hit') {
    if (this.god || this.dead || this.downed) return;
    this.health -= amount;
    this.trauma = Math.min(1, this.trauma + amount / 40);
    this.game.post.u.hurt.value = Math.min(1, this.game.post.u.hurt.value + amount / 30);
    this.game.audio.hurt?.(Math.min(1, amount / 40));
    if (from) { const dx = this.pos.x - from.x, dz = this.pos.z - from.z, l = Math.hypot(dx, dz) || 1; this.knock.x += dx / l * amount * 0.12; this.knock.z += dz / l * amount * 0.12; }
    if (this.health <= 0) this.game.onPlayerDown(kind);
  }
  /** launch the player (Wendigo throws, shockwaves) */
  launch(vx, vy, vz, stun = 0.8) { this.vel.set(vx, vy, vz); this.onGround = false; this.stunT = Math.max(this.stunT, stun); this.airLaunched = true; }

  update(dt, input, look) {
    const G = this.game, phys = G.physics, isl = G.island;
    // ------------- look
    if (look) {
      this.yaw -= look.x; this.pitch = clamp(this.pitch - look.y, -1.5, 1.5);
    }
    if (this.dead) return;
    if (this.downed) { this.mode = 'downed'; this.vel.set(0, 0, 0); this._vitals(dt, 0); return; }
    // ------------- intent
    const busy = G.ui.modal || this.stunT > 0;
    let mx = 0, mz = 0;
    if (!busy && input) { mx = input.axis('KeyA', 'KeyD'); mz = input.axis('KeyS', 'KeyW'); }
    const wantCrouch = !busy && input && (input.held('KeyC') || input.held('ControlLeft'));
    this.crouch = damp(this.crouch, wantCrouch ? 1 : 0, 10, dt);
    const moving = mx !== 0 || mz !== 0;
    const exhausted = this.stamina < 2;
    this.sprinting = !busy && input && input.held('ShiftLeft') && mz > 0 && !wantCrouch && !exhausted && this.carry < 2 && !this.swimming;
    let speed = this.swimming ? 2.4 : wantCrouch ? 1.8 : this.sprinting ? 6.8 : 3.6;
    if (this.carry) speed *= 0.82;
    if (this.warmth < 15) speed *= 0.85;
    speed *= this.speedMul;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = (mx * cy - mz * sy), wz = (-mx * sy - mz * cy);
    const wl = Math.hypot(wx, wz); if (wl > 1) { wx /= wl; wz /= wl; }
    // ------------- noclip (admin)
    if (this.noclip) {
      const f = this.forward, up = (input?.held('Space') ? 1 : 0) - (input?.held('KeyC') ? 1 : 0);
      const v = 30 * (input?.held('ShiftLeft') ? 4 : 1);
      this.pos.x += (wx * v + f.x * 0) * dt; this.pos.z += wz * v * dt; this.pos.y += (up * v + (mz ? f.y * mz * v : 0)) * dt;
      this.mode = 'idle'; this.onGround = false; return;
    }
    // ------------- horizontal velocity
    const accel = this.onGround || this.swimming ? 12 : 2.5;
    this.vel.x = damp(this.vel.x, wx * speed, accel, dt) + this.knock.x;
    this.vel.z = damp(this.vel.z, wz * speed, accel, dt) + this.knock.z;
    this.knock.multiplyScalar(Math.max(0, 1 - dt * 6));
    if (this.stunT > 0) this.stunT -= dt;
    // ------------- water
    const wl2 = isl.waterLevel(this.pos.x, this.pos.z);
    const cave = phys.cave && phys.cave.contains(this.pos.x, this.pos.y, this.pos.z);
    const depth = cave ? phys.cave.waterDepth(this.pos.x, this.pos.y, this.pos.z) : (wl2 === -Infinity ? 0 : wl2 - this.pos.y);
    const surfaceY = cave ? this.pos.y + depth : wl2;
    this.swimming = depth > 1.25;
    this.underwater = this.swimming && G.camera.position.y < surfaceY - 0.05;
    if (depth > 0.3) this.wet = 1;
    // ------------- vertical
    if (this.swimming) {
      const target = surfaceY - 1.35;
      this.vel.y = damp(this.vel.y, (target - this.pos.y) * 3 + (input?.held('Space') ? 1 : 0), 4, dt);
      this.onGround = false;
    } else {
      this.vel.y -= 18 * dt;
      if (this.onGround && !busy && input && input.pressed('Space') && this.stamina > 8) {
        this.vel.y = 5.2; this.onGround = false; this.stamina -= 8; G.audio.jump?.(); this.noise = Math.max(this.noise, 0.3);
      }
    }
    // ------------- integrate + collide
    let nx = this.pos.x + this.vel.x * dt, nz = this.pos.z + this.vel.z * dt;
    [nx, nz] = phys.collide(nx, nz, this.pos.y, RADIUS, HEIGHT);
    // keep on the island
    const r = Math.hypot(nx, nz); if (r > 980) { nx *= 980 / r; nz *= 980 / r; }
    let ny = this.pos.y + this.vel.y * dt;
    const g = phys.ground(nx, nz, this.pos.y);
    // too steep? slide back
    if (!this.swimming && !cave) {
      const gr = isl.grad(nx, nz), slope = Math.hypot(gr.x, gr.z);
      if (slope > 1.05 && g > this.pos.y - 0.2 && this.onGround) {
        const k = (slope - 1.05) * 6 * dt;
        nx -= gr.x / slope * k * 4; nz -= gr.z / slope * k * 4;
        if (g - this.pos.y > 0.25) { nx = this.pos.x; nz = this.pos.z; }
      }
    }
    const wasAir = !this.onGround;
    if (ny <= g + 0.001 || (this.onGround && ny - g < 0.35 && this.vel.y <= 0)) {
      // landed / walking (stick to the ground going downhill)
      if (wasAir && this.vel.y < -7) {
        const f = clamp((-this.vel.y - 7) / 10, 0, 1);
        this.land = 0.15 + f * 0.25; G.audio.land?.(f);
        if (this.vel.y < -14 && !this.god) this.hurt((-this.vel.y - 14) * 8, null, 'fall');
      }
      ny = g; if (this.vel.y < 0) this.vel.y = 0; this.onGround = true; this.airLaunched = false;
    } else if (!this.swimming) this.onGround = false;
    this.pos.set(nx, ny, nz);
    // ------------- feel
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed = hs;
    if (this.onGround && hs > 0.5) {
      this.bob += dt * hs * 1.9; this.bobAmp = damp(this.bobAmp, Math.min(1, hs / 6.8), 8, dt);
      this.stepT -= dt * hs;
      if (this.stepT <= 0) {
        this.stepT = this.sprinting ? 1.9 : 1.6;
        this.surface = cave ? 'cave' : (depth > 0.15 ? 'water' : G.surfaceAt(nx, nz, ny));
        G.audio.step?.(this.surface, this.crouch > 0.5 ? 0 : this.sprinting ? 1 : 0.5);
        G.onFootstep?.(this);
      }
    } else this.bobAmp = damp(this.bobAmp, 0, 6, dt);
    if (this.swimming && moving) { this.stepT -= dt; if (this.stepT <= 0) { this.stepT = 1.1; G.audio.swim?.(); } }
    this.noise = Math.max(this.noise * Math.exp(-dt * 4), this.sprinting ? 0.55 : moving ? (this.crouch > 0.5 ? 0.05 : 0.22) : 0);
    this.fovKick = damp(this.fovKick, this.sprinting && hs > 5 ? 1 : 0, 4, dt);
    this.land = damp(this.land, 0, 6, dt);
    this.trauma = Math.max(0, this.trauma - dt * 0.9);
    this.mode = this.swimming ? 'swim' : !this.onGround ? 'idle' : wantCrouch ? 'crouch' : hs > 4.5 ? 'run' : hs > 0.4 ? (this.carry ? 'carry' : 'walk') : 'idle';
    if (this.onGround && !this.swimming && g > 1) this.lastSafe.copy(this.pos);
    // ------------- vitals
    this._vitals(dt, hs);
  }
  _vitals(dt, hs) {
    const G = this.game;
    if (this.god) { this.health = 100; this.stamina = 100; this.hunger = Math.max(this.hunger, 60); this.warmth = Math.max(this.warmth, 60); return; }
    // stamina
    if (this.sprinting && hs > 1) this.stamina -= 13 * dt;
    else if (this.swimming) this.stamina -= 3 * dt;
    else this.staminaRegen(dt);
    this.stamina = clamp(this.stamina, 0, 100);
    // hunger (about two in-game days from full to empty)
    this.hunger -= dt * (0.032 + (this.sprinting ? 0.03 : 0));
    this.hunger = clamp(this.hunger, 0, 100);
    // warmth
    const A = G.atmos.out;
    let dw = 0;
    dw -= A.night * 0.16 + A.rain * (this.inShelter ? 0 : 0.22);
    if (this.swimming) dw -= 1.2; else if (this.wet > 0) dw -= this.wet * 0.35;
    if (G.inCave) dw -= 0.05;
    dw += this.nearFire * 2.2;
    if (this.inShelter) dw += 0.15;
    dw += (G.inventory?.warmthBonus || 0) * 0.12;
    if (A.daylight > 0.5 && A.rain < 0.2 && !this.swimming) dw += 0.12;
    this.warmth = clamp(this.warmth + dw * dt, 0, 100);
    this.wet = Math.max(0, this.wet - dt * (0.02 + this.nearFire * 0.2));
    // health
    if (this.hunger <= 0) this.health -= 0.25 * dt;
    if (this.warmth <= 0) this.health -= 0.35 * dt;
    if (this.hunger > 45 && this.warmth > 30 && this.health < 100 && !this.downed) this.health += 0.18 * dt;
    if (this.health <= 0 && !this.downed && !this.dead) G.onPlayerDown(this.hunger <= 0 ? 'starve' : 'cold');
    this.health = Math.min(100, this.health);
  }
  staminaRegen(dt) { const k = this.warmth < 20 ? 0.55 : 1; this.stamina += (this.hunger < 10 ? 6 : 14) * k * dt; }

  /** place the camera at the eye with bob, landing dip and shake */
  applyCamera(cam, dt, time) {
    const e = this.eye;
    const bobY = Math.sin(this.bob * 2) * 0.045 * this.bobAmp, bobX = Math.cos(this.bob) * 0.03 * this.bobAmp;
    const t = this.trauma * this.trauma, sh = this.game.shake || 0;
    const k = t + sh;
    const n = (s) => Math.sin(time * s) * Math.sin(time * s * 1.37 + 1.3);
    cam.position.set(e.x + Math.cos(this.yaw) * bobX, e.y + bobY - this.land + (this.downed ? -1.1 : 0), e.z - Math.sin(this.yaw) * bobX);
    cam.rotation.order = 'YXZ';
    cam.rotation.y = this.yaw + n(23) * 0.03 * k;
    cam.rotation.x = this.pitch + n(29) * 0.03 * k;
    cam.rotation.z = n(17) * 0.025 * k + (this.downed ? 0.35 : 0) + bobX * 0.15;
    const fov = (this.game.profile.fov || 72) + this.fovKick * 6;
    if (Math.abs(cam.fov - fov) > 0.05) { cam.fov = damp(cam.fov, fov, 6, dt); cam.updateProjectionMatrix(); }
  }
  /** network state */
  state() {
    return { x: +this.pos.x.toFixed(2), y: +this.pos.y.toFixed(2), z: +this.pos.z.toFixed(2), yaw: +this.yaw.toFixed(3), pitch: +this.pitch.toFixed(2), m: this.mode, h: Math.round(this.health), d: this.downed ? 1 : 0, it: this.game.inventory?.heldName || null, l: this.game.lightOn ? 1 : 0, c: this.carry, a: this.game.viewmodel?.actT || 0, cave: this.game.inCave || null };
  }
}
const _e = new THREE.Vector3(), _f = new THREE.Vector3();
