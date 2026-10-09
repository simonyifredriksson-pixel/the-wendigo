/* Sky.js - the sky dome: gradient atmosphere, sun with a wide warm glow, a
   moon, stars, a moving cloud layer and lightning. It writes alpha 0 so the
   post pass knows which pixels are open sky (that is what the god rays
   stream out of when the sun is low behind the trees). */
import * as THREE from '../../lib/three.module.js';

const VERT = `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`;
const FRAG = `
uniform vec3 uSunDir, uMoonDir, uSunCol, uZenith, uHorizon, uFogCol, uCloudCol, uCloudShade;
uniform float uNight, uCloud, uTime, uFlash, uStars, uHaze;
varying vec3 vDir;
float h3(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // haze band at the horizon blends into the fog colour so the terrain fog meets the sky
  col = mix(col, uFogCol, (1.0 - smoothstep(-0.02, 0.22, h)) * uHaze);
  if (h < 0.0) col = mix(uFogCol, uFogCol * 0.6, smoothstep(0.0, -0.3, h));
  float sd = dot(d, uSunDir);
  // sun: tight disc, warm halo, broad forward-scatter glow
  float sunVis = smoothstep(-0.12, 0.05, uSunDir.y);
  col += uSunCol * (pow(max(sd, 0.0), 900.0) * 30.0 + pow(max(sd, 0.0), 60.0) * 0.45 + pow(max(sd, 0.0), 8.0) * 0.07) * sunVis;
  // stars and moon
  if (uStars > 0.001) {
    vec3 sp = d * 380.0; vec3 cell = floor(sp); float s = h3(cell);
    float star = step(0.9965, s) * smoothstep(0.25, 0.0, length(fract(sp) - 0.5));
    float tw = 0.6 + 0.4 * sin(uTime * (2.0 + s * 9.0) + s * 60.0);
    col += vec3(0.8, 0.88, 1.0) * star * tw * uStars * 2.2 * smoothstep(0.0, 0.25, h);
    // the band of the galaxy, faint
    float band = exp(-pow(dot(d, normalize(vec3(0.3, 0.5, -0.8))) * 3.2, 2.0));
    col += vec3(0.12, 0.13, 0.18) * band * fbm(d.xz * 9.0 + d.y * 4.0) * uStars * 0.5;
  }
  float md = dot(d, uMoonDir);
  float moonDisc = smoothstep(0.99955, 0.9997, md);
  vec3 mcol = vec3(0.85, 0.88, 0.95) * (0.75 + 0.25 * fbm(d.xy * 400.0));
  col = mix(col, mcol * 1.6, moonDisc * uNight);
  col += vec3(0.25, 0.32, 0.5) * pow(max(md, 0.0), 120.0) * uNight * 0.5;
  // clouds on a plane above the island
  if (h > -0.02) {
    vec2 uv = d.xz / (h + 0.12) * 1.6 + vec2(uTime * 0.006, uTime * 0.0025);
    float n = fbm(uv * 1.3);
    float cov = smoothstep(1.0 - uCloud * 0.95, 1.0 - uCloud * 0.95 + 0.35, n);
    float thick = fbm(uv * 2.6 + 3.0);
    vec3 lit = mix(uCloudShade, uCloudCol, clamp(0.55 + 0.6 * dot(normalize(vec3(uSunDir.x, 0.4, uSunDir.z)), normalize(vec3(d.x, 0.2, d.z))) - thick * 0.4, 0.0, 1.0));
    lit += uSunCol * pow(max(sd, 0.0), 12.0) * 0.6 * sunVis * (1.0 - thick);
    float fade = smoothstep(-0.02, 0.18, h);
    col = mix(col, lit, cov * fade);
  }
  col += vec3(0.6, 0.65, 0.8) * uFlash * (0.6 + 0.4 * smoothstep(-0.1, 0.5, h));
  gl_FragColor = vec4(col, 0.0);
}`;

export class Sky {
  constructor() {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunCol: { value: new THREE.Color(1, 0.9, 0.7) }, uZenith: { value: new THREE.Color(0.2, 0.4, 0.8) }, uHorizon: { value: new THREE.Color(0.6, 0.7, 0.85) },
      uFogCol: { value: new THREE.Color(0.6, 0.7, 0.8) }, uCloudCol: { value: new THREE.Color(1, 1, 1) }, uCloudShade: { value: new THREE.Color(0.5, 0.55, 0.62) },
      uNight: { value: 0 }, uCloud: { value: 0.4 }, uTime: { value: 0 }, uFlash: { value: 0 }, uStars: { value: 0 }, uHaze: { value: 1 },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -10;
  }
  follow(cam) { this.mesh.position.copy(cam.position); }
}
