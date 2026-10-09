/* Atmos.js - time of day, weather and the lights that follow from them.

   hour runs 0..24. One in-game day lasts DAY_SECONDS real seconds by default
   (24 minutes): ~15 minutes of daylight, a slow dusk, ~6 minutes of night.
   The sun rises in the east (+x) and sets in the west, passing south (+z).

   Weather states blend smoothly: clear, cloudy, fog, rain, storm.
   Everything visible is derived each frame from (hour, weather):
   sun/moon direction and colour, hemisphere light, fog colour/density,
   sky colours, exposure and colour grade, wind strength (GU.uWind). */
import * as THREE from '../../lib/three.module.js';
import { GU } from '../core/Shading.js';
import { clamp, lerp, sstep } from '../core/Util.js';

export const DAY_SECONDS = 24 * 60;
export const WEATHERS = {
  clear: { cloud: 0.25, fog: 1.0, rain: 0, wind: 0.25, dark: 0 },
  cloudy: { cloud: 0.75, fog: 1.4, rain: 0, wind: 0.45, dark: 0.3 },
  fog: { cloud: 0.6, fog: 7.0, rain: 0, wind: 0.1, dark: 0.35 },
  rain: { cloud: 0.95, fog: 2.6, rain: 0.7, wind: 0.6, dark: 0.55 },
  storm: { cloud: 1.0, fog: 3.2, rain: 1.0, wind: 1.0, dark: 0.7 },
};

const C = (r, g, b) => new THREE.Color(r, g, b);
// key frames by sun elevation (degrees)
const KEYS = [
  { e: -18, zen: C(0.004, 0.006, 0.014), hor: C(0.012, 0.018, 0.032), fog: C(0.010, 0.014, 0.024), sun: C(0, 0, 0), hemiS: C(0.020, 0.028, 0.045), hemiG: C(0.006, 0.007, 0.009), cloud: C(0.025, 0.03, 0.045), exp: 1.9 },
  { e: -6, zen: C(0.025, 0.035, 0.085), hor: C(0.13, 0.11, 0.16), fog: C(0.07, 0.07, 0.10), sun: C(0, 0, 0), hemiS: C(0.08, 0.09, 0.14), hemiG: C(0.03, 0.025, 0.025), cloud: C(0.14, 0.11, 0.14), exp: 1.45 },
  { e: 0, zen: C(0.10, 0.17, 0.36), hor: C(0.85, 0.48, 0.26), fog: C(0.45, 0.33, 0.27), sun: C(1.6, 0.55, 0.18), hemiS: C(0.30, 0.28, 0.34), hemiG: C(0.12, 0.08, 0.06), cloud: C(0.95, 0.5, 0.35), exp: 1.15 },
  { e: 8, zen: C(0.16, 0.30, 0.62), hor: C(0.95, 0.72, 0.52), fog: C(0.62, 0.55, 0.48), sun: C(2.6, 1.55, 0.8), hemiS: C(0.46, 0.50, 0.60), hemiG: C(0.18, 0.15, 0.11), cloud: C(1.1, 0.85, 0.7), exp: 1.0 },
  { e: 25, zen: C(0.17, 0.36, 0.78), hor: C(0.62, 0.74, 0.88), fog: C(0.58, 0.66, 0.74), sun: C(3.3, 2.95, 2.5), hemiS: C(0.55, 0.65, 0.82), hemiG: C(0.24, 0.22, 0.17), cloud: C(1.2, 1.18, 1.15), exp: 0.95 },
  { e: 60, zen: C(0.14, 0.33, 0.78), hor: C(0.58, 0.72, 0.9), fog: C(0.56, 0.66, 0.76), sun: C(3.6, 3.35, 3.0), hemiS: C(0.58, 0.68, 0.86), hemiG: C(0.26, 0.24, 0.19), cloud: C(1.3, 1.3, 1.3), exp: 0.92 },
];
function sampleKeys(e, out) {
  let i = 0; while (i < KEYS.length - 2 && e > KEYS[i + 1].e) i++;
  const a = KEYS[i], b = KEYS[i + 1], t = clamp((e - a.e) / (b.e - a.e), 0, 1), s = t * t * (3 - 2 * t);
  for (const k of ['zen', 'hor', 'fog', 'sun', 'hemiS', 'hemiG', 'cloud']) out[k].copy(a[k]).lerp(b[k], s);
  out.exp = lerp(a.exp, b.exp, s);
  return out;
}

export class Atmos {
  constructor(scene, sky) {
    this.scene = scene; this.sky = sky;
    this.hour = 7.5; this.day = 1; this.speed = 24 / DAY_SECONDS; // hours per second
    this.weather = 'clear'; this.w = { ...WEATHERS.clear }; this.wTarget = WEATHERS.clear;
    this.flash = 0; this.nextBolt = 20;
    this.sunDir = new THREE.Vector3(); this.moonDir = new THREE.Vector3(); this.lightDir = new THREE.Vector3();
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.00025; this.sun.shadow.normalBias = 0.04;
    this.shadowR = 70;
    const sc = this.sun.shadow.camera; sc.near = 1; sc.far = 600;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.FogExp2(0x8899aa, 0.002);
    this.k = { zen: C(0, 0, 0), hor: C(0, 0, 0), fog: C(0, 0, 0), sun: C(0, 0, 0), hemiS: C(0, 0, 0), hemiG: C(0, 0, 0), cloud: C(0, 0, 0), exp: 1 };
    this.out = { daylight: 1, night: 0, dusk: 0, exposure: 1, rain: 0, wind: 0.3, fogDensity: 0.002 };
    this.extraFog = 0;      // the director can thicken the fog
    this.silence = 0;       // drives wind/ambience down (audio reads it)
    this.forceDark = 0;     // cutscenes
  }
  setWeather(name) { if (WEATHERS[name]) { this.weather = name; this.wTarget = WEATHERS[name]; } }
  get isNight() { return this.hour >= 20.6 || this.hour < 5.2; }
  get sunElev() { return Math.asin(clamp(this.sunDir.y, -1, 1)) * 180 / Math.PI; }

  update(dt, focus, opts = {}) {
    if (!opts.frozen) {
      this.hour += dt * this.speed;
      if (this.hour >= 24) { this.hour -= 24; this.day++; }
    }
    // weather blend
    const w = this.w, T = this.wTarget, k = 1 - Math.exp(-dt * 0.08);
    for (const key in T) w[key] = lerp(w[key], T[key], k);
    // sun path: rises east ~5:15, noon at 12:40, sets west ~20:05
    const h = this.hour, dayFrac = (h - 12.65) / 24 * Math.PI * 2;
    const elev = Math.cos(dayFrac) * 0.7 + 0.25;           // crosses 0 at ~5:15 and ~20:05
    const az = dayFrac;
    this.sunDir.set(-Math.sin(az) * 0.9, elev, Math.cos(az) * 0.55 + 0.35).normalize();
    this.moonDir.set(Math.sin(az) * 0.8, -elev * 0.85 + 0.15, -Math.cos(az) * 0.4 + 0.3).normalize();
    const e = this.sunElev;
    sampleKeys(e, this.k);
    const K = this.k, dark = w.dark;
    const daylight = sstep(-4, 10, e), night = 1 - sstep(-14, -2, e), dusk = clamp(1 - Math.abs(e - 1) / 9, 0, 1);
    // light: sun by day, moon by night (same shadowed light)
    const useMoon = e < -3;
    this.lightDir.copy(useMoon ? this.moonDir : this.sunDir);
    if (this.lightDir.y < 0.08) this.lightDir.y = 0.08;
    this.lightDir.normalize();
    const cloudDim = 1 - dark * 0.75;
    if (useMoon) {
      const m = 0.16 * night * (1 - dark * 0.8) * (1 - this.forceDark);
      this.sun.color.setRGB(0.55, 0.68, 1.0); this.sun.intensity = m;
    } else {
      this.sun.color.copy(K.sun); const mx = Math.max(K.sun.r, K.sun.g, K.sun.b, 0.001);
      this.sun.color.multiplyScalar(1 / mx); this.sun.intensity = mx * cloudDim * sstep(-3, 2, e) * (1 - this.forceDark);
    }
    this.hemi.color.copy(K.hemiS).multiplyScalar(1 - dark * 0.35); this.hemi.groundColor.copy(K.hemiG);
    this.hemi.intensity = 2.6 * (1 - this.forceDark * 0.9);
    // lightning
    this.nextBolt -= dt;
    if (w.rain > 0.85 && this.weather === 'storm' && this.nextBolt <= 0) { this.flash = 1; this.nextBolt = 7 + Math.random() * 22; this.onBolt?.(Math.random()); }
    this.flash = Math.max(0, this.flash - dt * 3.2);
    const fl = this.flash > 0 ? (Math.sin(this.flash * 40) > -0.2 ? this.flash : this.flash * 0.2) : 0;
    this.hemi.intensity += fl * 3;
    // fog
    const fogCol = this.scene.fog.color.copy(K.fog).multiplyScalar(1 - dark * 0.45);
    const base = lerp(0.0016, 0.0055, night) * w.fog + this.extraFog;
    this.scene.fog.density = base;
    GU.uFogSun.value.copy(K.sun).multiplyScalar(0.05 * (1 - dark) * (useMoon ? 0 : 1));
    GU.uFogHeight.value = 0.022; GU.uFogBase.value = 0;
    GU.uSunDir.value.copy(useMoon ? this.moonDir : this.sunDir);
    GU.uSunCol.value.copy(this.sun.color).multiplyScalar(this.sun.intensity);
    GU.uWind.value = clamp(w.wind * (1 - this.silence * 0.85), 0, 1);
    // sky
    const S = this.sky.uniforms;
    S.uSunDir.value.copy(this.sunDir); S.uMoonDir.value.copy(this.moonDir);
    S.uSunCol.value.copy(K.sun).multiplyScalar(1 - dark * 0.9);
    S.uZenith.value.copy(K.zen).multiplyScalar(1 - dark * 0.5); S.uHorizon.value.copy(K.hor).lerp(fogCol, dark * 0.6);
    S.uFogCol.value.copy(fogCol); S.uHaze.value = clamp(0.6 + w.fog * 0.1, 0, 1);
    S.uCloud.value = w.cloud; S.uCloudCol.value.copy(K.cloud).multiplyScalar(1 - dark * 0.55); S.uCloudShade.value.copy(K.cloud).multiplyScalar(0.45 * (1 - dark * 0.5));
    S.uNight.value = night * (1 - dark * 0.7); S.uStars.value = night * (1 - w.cloud * 0.9); S.uFlash.value = fl;
    S.uTime.value += dt;
    // shadows follow the focus point, snapped to texels so they do not swim
    if (focus) {
      const R = this.shadowR, sc = this.sun.shadow.camera;
      sc.left = -R; sc.right = R; sc.top = R; sc.bottom = -R; sc.updateProjectionMatrix();
      const texel = (2 * R) / this.sun.shadow.mapSize.x;
      const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
      this.sun.target.position.set(fx, focus.y, fz);
      this.sun.position.set(fx + this.lightDir.x * 250, focus.y + this.lightDir.y * 250, fz + this.lightDir.z * 250);
    }
    const o = this.out;
    o.daylight = daylight; o.night = night; o.dusk = dusk; o.rain = w.rain; o.wind = w.wind; o.fogDensity = base;
    o.exposure = K.exp; o.flash = fl; o.sunStrength = useMoon ? 0 : sstep(-2, 6, e) * (1 - dark) * (0.6 + 0.4 * sstep(40, 5, e));
    return o;
  }
  /** colour grade for the post pass */
  grade(post) {
    const u = post.u, o = this.out;
    u.exposure.value = o.exposure;
    u.sat.value = lerp(1.05, 0.72, o.night) - this.w.dark * 0.15;
    u.contrast.value = lerp(1.06, 1.1, o.night);
    u.shadowTint.value.set(lerp(0.96, 0.85, o.night), lerp(1.0, 0.95, o.night), lerp(1.04, 1.18, o.night));
    u.lightTint.value.set(lerp(1.05, 0.95, o.night) + o.dusk * 0.06, 1.0, lerp(0.94, 1.05, o.night) - o.dusk * 0.06);
    u.grain.value = lerp(0.025, 0.06, o.night);
    u.flash.value = o.flash * 0.8;
    u.bloom.value = lerp(0.45, 0.8, o.night);
  }
}
