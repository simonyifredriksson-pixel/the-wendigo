/* Shading.js - the look shared by every material in the game.

   1. Height fog with sun in-scattering. three's fog chunks are replaced so the
      fog thickens near the ground (valleys and lakes fill with mist), thins
      with altitude, and glows warm when you look toward the sun. Fog is
      computed from the real world position, so it is the same on every
      material: terrain, trees, creatures, water.
   2. GU - global uniforms (time, wind, sun direction, fog). Every material
      gets them through Material.prototype.onBeforeCompile, so updating
      GU.x.value once a frame drives the whole world.
   3. windify(material, opts) - vertex sway for grass, foliage and branches. */
import * as THREE from '../../lib/three.module.js';

export const GU = {
  uTime: { value: 0 },
  uWind: { value: 0.4 },              // 0 calm .. 1 storm
  uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
  uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2) },
  uFogSun: { value: new THREE.Color(0.25, 0.2, 0.12) },
  uSunCol: { value: new THREE.Color(1, 0.95, 0.85) },  // sun (or moon) light colour * intensity, for foliage translucency
  uFogHeight: { value: 0.035 },       // falloff per metre above uFogBase
  uFogBase: { value: 0 },
  uPlayerPos: { value: new THREE.Vector3() },   // grass bends away from the player
  uShake: { value: new THREE.Vector4(0, 0, 0, 0) }, // x,z,radius,strength: trees shake near the Wendigo
};

THREE.ShaderChunk.fog_pars_vertex = `
#ifdef USE_FOG
varying float vFogDepth;
varying vec3 vFogWorld;
#endif`;
THREE.ShaderChunk.fog_vertex = `
#ifdef USE_FOG
vFogDepth = - mvPosition.z;
vFogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
#endif`;
THREE.ShaderChunk.fog_pars_fragment = `
#ifdef USE_FOG
uniform vec3 fogColor;
varying float vFogDepth;
varying vec3 vFogWorld;
uniform float fogDensity;
uniform float fogNear;
uniform float fogFar;
uniform vec3 uSunDir;
uniform vec3 uFogSun;
uniform float uFogHeight;
uniform float uFogBase;
float wdFog(out vec3 fcol) {
  vec3 fv = vFogWorld - cameraPosition;
  float fd = length(fv);
  vec3 fdir = fv / max(fd, 1e-3);
  float dens = fogDensity;
  float integ = 1.0;
  if (uFogHeight > 0.0) {
    float y0 = cameraPosition.y - uFogBase;
    float t = uFogHeight * fv.y;
    integ = exp(-uFogHeight * max(y0, -20.0)) * (abs(t) > 1e-4 ? (1.0 - exp(-t)) / t : 1.0);
    integ = clamp(integ, 0.12, 4.0);
  }
  float f = 1.0 - exp(-dens * fd * integ);
  float s = pow(max(dot(fdir, uSunDir), 0.0), 5.0);
  fcol = fogColor + uFogSun * s;
  return clamp(f, 0.0, 1.0);
}
#endif`;
THREE.ShaderChunk.fog_fragment = `
#ifdef USE_FOG
vec3 wdFogCol;
float wdFogF = wdFog(wdFogCol);
gl_FragColor.rgb = mix(gl_FragColor.rgb, wdFogCol, wdFogF);
#endif`;

const FOG_U = ['uSunDir', 'uFogSun', 'uFogHeight', 'uFogBase'];
THREE.Material.prototype.onBeforeCompile = function (shader) { for (const k of FOG_U) shader.uniforms[k] = GU[k]; };

/** fog density in three's FogExp2 is now "per metre" (linear exponent) */
export function makeFog(color, density) { return new THREE.FogExp2(color, density); }

/* ---------------- wind ---------------- */
const WIND_HEAD = `
uniform float uTime; uniform float uWind; uniform vec2 uWindDir; uniform vec3 uPlayerPos; uniform vec4 uShake;
attribute float aSway;
float wdHash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
`;
/**
 * windify(material, { mode })
 *   mode 'grass'  : bends by height (uv.y or position.y within the blade), pushed away from the player
 *   mode 'foliage': branch cards flutter + whole tree sways with height (instanced trees)
 *   mode 'trunk'  : whole tree sways with height only
 * Instanced meshes are expected; the instance origin gives the phase.
 * `aSway` attribute (optional, per vertex) scales the motion; defaults to height-based when missing.
 */
export function windify(mat, { mode = 'foliage', height = 20, bend = 1 } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, r) {
    prev.call(this, shader, r);
    Object.assign(shader.uniforms, { uTime: GU.uTime, uWind: GU.uWind, uWindDir: GU.uWindDir, uPlayerPos: GU.uPlayerPos, uShake: GU.uShake });
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\n' + WIND_HEAD + `\n#define WD_H ${height.toFixed(2)}\n#define WD_BEND ${bend.toFixed(3)}\n`);
    let body;
    if (mode === 'grass') {
      body = `
      vec3 ip = vec3(0.0);
      #ifdef USE_INSTANCING
        ip = instanceMatrix[3].xyz;
      #endif
      float hgt = clamp(position.y / WD_H, 0.0, 1.0);
      float k = hgt * hgt * WD_BEND;
      float ph = wdHash(ip.xz) * 6.28;
      float gust = sin(uTime * 1.3 + dot(ip.xz, uWindDir) * 0.15) * 0.5 + 0.5;
      float w = (0.15 + uWind * 0.9) * (0.5 + gust) * (sin(uTime * (1.7 + uWind * 2.0) + ph + ip.x * 0.3) * 0.6 + 0.4);
      transformed.xz += uWindDir * w * k * 0.35;
      // walk through it and it parts around your legs
      vec2 away = ip.xz - uPlayerPos.xz; float d = length(away);
      transformed.xz += (d > 0.01 ? away / d : vec2(0.0)) * k * 0.5 * (1.0 - smoothstep(0.0, 1.1, d));
      transformed.y -= k * 0.25 * (1.0 - smoothstep(0.0, 1.1, d));
      `;
    } else {
      body = `
      vec3 ip = vec3(0.0);
      #ifdef USE_INSTANCING
        ip = instanceMatrix[3].xyz;
      #endif
      float hgt = clamp(position.y / WD_H, 0.0, 1.5);
      float ph = wdHash(ip.xz) * 6.28;
      float sway = (0.05 + uWind * 0.35) * hgt * hgt;
      vec2 sw = uWindDir * (sin(uTime * 0.7 + ph) * 0.7 + sin(uTime * 1.9 + ph * 1.7) * 0.3) * sway;
      // the Wendigo pushes through: trees inside the shake radius rock hard
      float sd = length(ip.xz - uShake.xy);
      float sk = uShake.w * (1.0 - smoothstep(uShake.z * 0.4, uShake.z, sd));
      sw += vec2(sin(uTime * 9.0 + ph), cos(uTime * 7.3 + ph)) * sk * hgt * hgt * 0.9;
      transformed.xz += sw;
      ${mode === 'foliage' ? `
      float fl = (0.02 + uWind * 0.06) * WD_BEND;
      transformed += normal * sin(uTime * 4.0 + position.y * 2.1 + position.x * 1.3 + ph) * fl * hgt;
      transformed.y += sin(uTime * 3.1 + position.x * 2.0 + ph) * fl * 0.6 * hgt;` : ''}
      `;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + body);
  };
  mat.customProgramCacheKey = () => 'wind-' + mode + height + bend;
  return mat;
}

/**
 * foliage(material): leaves and needle cards.
 *  - both faces use the same (outward, crown-shaped) normal instead of flipping, so a crown is lit like a soft volume
 *  - light shining through from behind (sun low behind the trees) glows yellow-green
 */
export function foliage(mat, { translucency = 0.6 } = {}) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    sh.uniforms.uSunCol = GU.uSunCol; sh.uniforms.uSunDir = GU.uSunDir;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunCol;\n#ifndef USE_FOG\nuniform vec3 uSunDir;\n#endif')
      .replace('float faceDirection = gl_FrontFacing ? 1.0 : - 1.0;', 'float faceDirection = 1.0;')
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        {
          vec3 vd = normalize(vViewPosition);
          vec3 sv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          float back = pow(max(dot(vd, sv), 0.0), 3.0);
          reflectedLight.indirectDiffuse += diffuseColor.rgb * uSunCol * back * ${translucency.toFixed(2)} * vec3(1.0, 1.08, 0.7);
        }`);
  };
  const key = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => key + '-fol' + translucency;
  return mat;
}

/** standard material helper with sensible defaults for the realistic look */
export function stdMat(o = {}) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0, ...o });
  return m;
}
