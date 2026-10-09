/* PostFX.js - the cinematic layer between the scene and the screen.

   scene -> HDR target (alpha 0 = open sky)
     -> god rays: the sky mask near the sun is smeared radially toward the
        sun's screen position (light shafts through the canopy)
     -> bright-pass -> 5-level blur pyramid (bloom)
     -> composite: bloom, shafts, exposure, ACES, colour grade (per time of
        day), vignette, film grain, chromatic aberration, fear effects
        (desaturation, pulse, edge darkening), hurt flash, underwater tint,
        letterbox bars for cutscenes, fade to black/white.
   The renderer's own tone mapping is off while PostFX is on. */
import * as THREE from '../../lib/three.module.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const BRIGHT = `uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;
void main(){ vec3 c = texture2D(tDiffuse, vUv).rgb; float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(threshold, threshold + 0.8, l); gl_FragColor = vec4(min(c * k, vec3(20.0)), 1.0); }`;
const BLUR = `uniform sampler2D tDiffuse; uniform vec2 dir; uniform vec2 res; varying vec2 vUv;
void main(){ vec2 o = dir / res; vec3 c = texture2D(tDiffuse, vUv).rgb * 0.227027;
  c += texture2D(tDiffuse, vUv + o * 1.3846).rgb * 0.316216; c += texture2D(tDiffuse, vUv - o * 1.3846).rgb * 0.316216;
  c += texture2D(tDiffuse, vUv + o * 3.2308).rgb * 0.070270; c += texture2D(tDiffuse, vUv - o * 3.2308).rgb * 0.070270;
  gl_FragColor = vec4(c, 1.0); }`;
// sky mask near the sun, then radial blur toward the sun
const RAYMASK = `uniform sampler2D tDiffuse; uniform vec2 sunUv; uniform float aspect; varying vec2 vUv;
void main(){ vec4 c = texture2D(tDiffuse, vUv); float sky = 1.0 - clamp(c.a, 0.0, 1.0);
  vec2 d = (vUv - sunUv) * vec2(aspect, 1.0); float r = length(d);
  float near = exp(-r * r * 6.0);
  gl_FragColor = vec4(min(c.rgb, vec3(4.0)) * sky * near, 1.0); }`;
const RAYS = `uniform sampler2D tDiffuse; uniform vec2 sunUv; uniform float decay; varying vec2 vUv;
void main(){ vec2 d = (vUv - sunUv) / 48.0 * 0.9; vec2 uv = vUv; vec3 s = vec3(0.0); float w = 1.0;
  for (int i = 0; i < 48; i++) { uv -= d; s += texture2D(tDiffuse, uv).rgb * w; w *= decay; }
  gl_FragColor = vec4(s / 34.0, 1.0); }`;

const COMPOSITE = `uniform sampler2D tDiffuse, b0, b1, b2, b3, b4, tRays;
uniform float bloom, exposure, time, grain, vignette, aberr, hurt, sat, contrast, fear, pulse, rays, underwater, bars, fade, white, flash, blur;
uniform vec3 tint, shadowTint, lightTint, fadeCol;
varying vec2 vUv;
vec3 aces(vec3 x){ const float a=2.51; const float b=0.03; const float c=2.43; const float d=0.59; const float e=0.14; return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }
float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
void main(){
  vec2 uv = vUv;
  if (underwater > 0.01) uv += vec2(sin(uv.y * 30.0 + time * 2.0), cos(uv.x * 25.0 + time * 1.7)) * 0.003 * underwater;
  vec2 dc = uv - 0.5; float r2 = dot(dc, dc);
  float ab = aberr * (0.3 + r2 * 3.0) + hurt * 0.005 + fear * 0.003;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + dc * ab).r; col.g = texture2D(tDiffuse, uv).g; col.b = texture2D(tDiffuse, uv - dc * ab).b;
  vec3 bl = texture2D(b0, uv).rgb * 0.3 + texture2D(b1, uv).rgb * 0.26 + texture2D(b2, uv).rgb * 0.22 + texture2D(b3, uv).rgb * 0.2 + texture2D(b4, uv).rgb * 0.26;
  if (blur > 0.01) col = mix(col, texture2D(b1, uv).rgb * 1.2, blur);
  col += bl * bloom;
  col += texture2D(tRays, uv).rgb * rays;
  col *= exposure * (1.0 + flash);
  col = aces(col);
  // grade
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, sat * (1.0 - fear * 0.45));
  col = mix(col * shadowTint, col * lightTint, smoothstep(0.05, 0.75, l));
  col = (col - 0.5) * contrast + 0.5;
  col *= tint;
  if (underwater > 0.01) col = mix(col, vec3(0.05, 0.2, 0.22) * (0.4 + l), underwater * 0.7);
  // vignette, tighter when afraid; heartbeat pulse darkens the edges
  float vig = vignette * (1.0 + fear * 0.9 + pulse * 0.6);
  col *= mix(1.0, smoothstep(0.95, 0.15, r2 * vig * 2.0), 0.9);
  col = mix(col, col * vec3(1.35, 0.3, 0.25), hurt * smoothstep(0.03, 0.35, r2));
  // grain: stronger in the dark (sensor noise at night)
  float g = h(uv * vec2(1920.0, 1080.0) + fract(time * 13.7) * 100.0) - 0.5;
  col += g * grain * (1.15 - l);
  col = mix(col, fadeCol, fade);
  col = mix(col, vec3(1.0), white);
  // letterbox
  if (bars > 0.0) { float b = bars * 0.11; if (vUv.y < b || vUv.y > 1.0 - b) col = vec3(0.0); }
  gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
}`;

export class PostFX {
  constructor(renderer) {
    this.r = renderer; this.enabled = true;
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    const hf = { type: THREE.HalfFloatType, depthBuffer: false };
    this.main = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 });
    this.levels = [];
    for (let i = 0; i < 5; i++) this.levels.push({ a: new THREE.WebGLRenderTarget(4, 4, hf), b: new THREE.WebGLRenderTarget(4, 4, hf) });
    this.rayA = new THREE.WebGLRenderTarget(4, 4, hf); this.rayB = new THREE.WebGLRenderTarget(4, 4, hf);
    const sm = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.bright = sm(BRIGHT, { tDiffuse: { value: null }, threshold: { value: 1.0 } });
    this.blur = sm(BLUR, { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() }, res: { value: new THREE.Vector2() } });
    this.rayMask = sm(RAYMASK, { tDiffuse: { value: null }, sunUv: { value: new THREE.Vector2(0.5, 0.5) }, aspect: { value: 1 } });
    this.rayBlur = sm(RAYS, { tDiffuse: { value: null }, sunUv: { value: new THREE.Vector2(0.5, 0.5) }, decay: { value: 0.965 } });
    this.comp = sm(COMPOSITE, {
      tDiffuse: { value: null }, b0: { value: null }, b1: { value: null }, b2: { value: null }, b3: { value: null }, b4: { value: null }, tRays: { value: null },
      bloom: { value: 0.6 }, exposure: { value: 1.0 }, time: { value: 0 }, grain: { value: 0.03 }, vignette: { value: 1 }, aberr: { value: 0.0015 },
      hurt: { value: 0 }, sat: { value: 1.0 }, contrast: { value: 1.04 }, fear: { value: 0 }, pulse: { value: 0 }, rays: { value: 0 }, underwater: { value: 0 },
      bars: { value: 0 }, fade: { value: 0 }, white: { value: 0 }, flash: { value: 0 }, blur: { value: 0 },
      tint: { value: new THREE.Vector3(1, 1, 1) }, shadowTint: { value: new THREE.Vector3(0.94, 1.0, 1.06) }, lightTint: { value: new THREE.Vector3(1.04, 1.0, 0.95) }, fadeCol: { value: new THREE.Vector3(0, 0, 0) },
    });
    this.u = this.comp.uniforms;
    this.sunWorld = new THREE.Vector3(); this.sunVisible = 0;
    this.scale = 1; this.raysOn = true;
    this.setSize(innerWidth, innerHeight);
  }
  setSize(w, h) {
    const pr = this.r.getPixelRatio();
    const W = Math.max(4, Math.floor(w * pr * this.scale)), H = Math.max(4, Math.floor(h * pr * this.scale));
    this.main.setSize(W, H);
    let bw = W >> 1, bh = H >> 1;
    for (const L of this.levels) { L.w = Math.max(2, bw); L.h = Math.max(2, bh); L.a.setSize(L.w, L.h); L.b.setSize(L.w, L.h); bw >>= 1; bh >>= 1; }
    this.rayA.setSize(Math.max(2, W >> 2), Math.max(2, H >> 2)); this.rayB.setSize(Math.max(2, W >> 2), Math.max(2, H >> 2));
    this.aspect = W / H;
  }
  _pass(mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.scene, this.cam); }
  /** sunDir: world direction toward the sun (or moon); strength 0..1 */
  setSun(dir, strength) { this.sunWorld.copy(dir); this.sunStrength = strength; }
  render(scene, camera, dt = 0.016, overlay = null) {
    const r = this.r;
    if (!this.enabled) {
      r.toneMapping = THREE.ACESFilmicToneMapping; r.setRenderTarget(null); r.render(scene, camera);
      if (overlay) { r.autoClear = false; r.clearDepth(); r.render(overlay.scene, overlay.camera); r.autoClear = true; }
      return;
    }
    r.toneMapping = THREE.NoToneMapping;
    r.setRenderTarget(this.main); r.render(scene, camera);
    if (overlay) { r.autoClear = false; r.clearDepth(); r.render(overlay.scene, overlay.camera); r.autoClear = true; }
    // god rays
    const u = this.u;
    let raysAmt = 0;
    if (this.raysOn && this.sunStrength > 0.01) {
      const p = _v.copy(this.sunWorld).multiplyScalar(500).add(camera.position).project(camera);
      const facing = _f.set(0, 0, -1).applyQuaternion(camera.quaternion).dot(this.sunWorld);
      if (facing > 0.05 && p.z < 1) {
        const su = (p.x + 1) / 2, sv = (p.y + 1) / 2;
        raysAmt = this.sunStrength * Math.min(1, facing * 2.5) * (1 - Math.min(1, Math.max(0, Math.hypot(su - 0.5, sv - 0.5) - 0.6) * 2));
        if (raysAmt > 0.01) {
          this.rayMask.uniforms.tDiffuse.value = this.main.texture; this.rayMask.uniforms.sunUv.value.set(su, sv); this.rayMask.uniforms.aspect.value = this.aspect;
          this._pass(this.rayMask, this.rayA);
          this.rayBlur.uniforms.tDiffuse.value = this.rayA.texture; this.rayBlur.uniforms.sunUv.value.set(su, sv);
          this._pass(this.rayBlur, this.rayB);
          this.rayBlur.uniforms.tDiffuse.value = this.rayB.texture; this._pass(this.rayBlur, this.rayA);
        }
      }
    }
    u.rays.value = raysAmt; u.tRays.value = this.rayA.texture;
    // bloom pyramid
    let src = this.main.texture;
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i];
      if (i === 0) { this.bright.uniforms.tDiffuse.value = src; this._pass(this.bright, L.a); }
      else { this.blur.uniforms.tDiffuse.value = src; this.blur.uniforms.res.value.set(L.w, L.h); this.blur.uniforms.dir.value.set(0, 0); this._pass(this.blur, L.a); }
      this.blur.uniforms.res.value.set(L.w, L.h);
      this.blur.uniforms.tDiffuse.value = L.a.texture; this.blur.uniforms.dir.value.set(1, 0); this._pass(this.blur, L.b);
      this.blur.uniforms.tDiffuse.value = L.b.texture; this.blur.uniforms.dir.value.set(0, 1); this._pass(this.blur, L.a);
      src = L.a.texture;
    }
    u.tDiffuse.value = this.main.texture;
    u.b0.value = this.levels[0].a.texture; u.b1.value = this.levels[1].a.texture; u.b2.value = this.levels[2].a.texture; u.b3.value = this.levels[3].a.texture; u.b4.value = this.levels[4].a.texture;
    u.time.value += dt;
    this._pass(this.comp, null);
  }
}
const _v = new THREE.Vector3(), _f = new THREE.Vector3();
