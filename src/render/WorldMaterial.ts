import * as THREE from 'three';

/**
 * Shared uniforms for all world materials (updated by DayNight/Weather once per frame).
 */
export const worldUniforms = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uWet: { value: 0 },
  uSand: { value: 0 },
};

/**
 * Patch a lit material to support:
 *  - `wparams` (vec4): x = window style, y = floor height, z = seed, w = emissive strength
 *  - `uvm` (vec2): wall-space metres for procedural windows
 * Procedural windows (lit at night), neon emissive, asphalt grain, wet-road darkening.
 */
export function patchWorldMaterial(mat: THREE.MeshStandardMaterial | THREE.MeshLambertMaterial, opts: { grain?: boolean; lodMask?: THREE.Texture } = {}): void {
  const isStd = (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, worldUniforms);
    if (opts.lodMask) {
      shader.uniforms.uMask = { value: opts.lodMask };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 chunk;\nuniform sampler2D uMask;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nif (texelFetch(uMask, ivec2(chunk), 0).r > 0.5) gl_Position = vec4(4.0, 4.0, 4.0, 1.0);');
    }
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec4 wparams;
attribute vec2 uvm;
flat varying vec4 vW;
varying vec2 vUvM;
varying vec3 vWPos;
varying float vUp;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vW = wparams;
vUvM = uvm;
vec4 wp4 = modelMatrix * vec4(transformed, 1.0);
#ifdef USE_INSTANCING
wp4 = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
#endif
vWPos = wp4.xyz;
vUp = normal.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uNight;
uniform float uTime;
uniform float uWet;
uniform float uSand;
flat varying vec4 vW;
varying vec2 vUvM;
varying vec3 vWPos;
varying float vUp;
float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wNoise(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(wHash(i), wHash(i+vec2(1,0)), f.x), mix(wHash(i+vec2(0,1)), wHash(i+vec2(1,1)), f.x), f.y); }
vec3 gWinEmissive = vec3(0.0);
float gGlass = 0.0;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float style = vW.x;
  ${opts.grain === false ? '' : `
  // ground grain / dirt variation on horizontal surfaces
  if (style < 0.5 && vUp > 0.6) {
    float n = wNoise(vWPos.xz * 0.35) * 0.5 + wNoise(vWPos.xz * 2.1) * 0.3 + wNoise(vWPos.xz * 0.05) * 0.4;
    diffuseColor.rgb *= 0.86 + n * 0.22;
    // wet ground darkens
    diffuseColor.rgb *= 1.0 - uWet * 0.35;
  }`}
  if (style > 0.5) {
    float fh = max(vW.y, 2.5);
    vec2 uv = vUvM;
    float cellW = style < 1.5 ? 2.0 : style < 2.5 ? 3.2 : style < 3.5 ? 1.5 : style < 4.5 ? 5.0 : style < 5.5 ? 3.0 : style < 6.5 ? 7.0 : 3.6;
    vec2 cell = vec2(uv.x / cellW, uv.y / fh);
    vec2 id = floor(cell);
    vec2 f = fract(cell);
    float ww = style < 1.5 ? 0.9 : style < 3.5 ? 0.7 : style < 5.5 ? 0.42 : style < 6.5 ? 0.8 : 0.4;
    float wh = style < 1.5 ? 0.78 : style < 3.5 ? 0.55 : style < 5.5 ? 0.42 : style < 6.5 ? 0.22 : 0.42;
    float wy = style > 5.5 && style < 6.5 ? 0.78 : 0.55;
    float inWin = step(abs(f.x - 0.5), ww * 0.5) * step(abs(f.y - wy), wh * 0.5);
    // fade the pattern to its average coverage when cells shrink below a few pixels
    vec2 fw = fwidth(cell);
    float aa = clamp(max(fw.x, fw.y) * 2.5 - 0.35, 0.0, 1.0);
    float ground = step(uv.y, fh);
    // ground floor: storefront glass for shops/offices/towers, doors for houses
    if (style < 3.5) inWin = mix(inWin, step(abs(f.x - 0.5), 0.46) * step(0.08, f.y) * step(f.y, 0.8), ground);
    else if (style > 3.5 && style < 4.5) inWin *= 1.0 - ground; // clubs: blank ground floor (neon instead)
    float rnd = wHash(id + vec2(vW.z * 0.173, vW.z * 0.291));
    // a few windows are broken / boarded in shacks
    if (style > 4.5 && style < 5.5 && rnd < 0.15) inWin = 0.0;
    float edge = smoothstep(0.0, 0.04, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
    vec3 glass = mix(vec3(0.08, 0.1, 0.14), vec3(0.42, 0.52, 0.62), clamp(0.3 + rnd * 0.55 + vUp * 0.2, 0.0, 1.0));
    glass = mix(glass, vec3(0.02, 0.03, 0.05), uNight * 0.7);
    // mullions
    vec3 frame = diffuseColor.rgb * 0.55;
    inWin = mix(inWin, ww * wh * 0.8, aa);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(frame, glass, mix(edge, 1.0, aa)), inWin);
    gGlass = inWin * edge;
    float litChance = style > 3.5 && style < 4.5 ? 0.2 : 0.3;
    float lit = inWin * step(1.0 - litChance - uNight * 0.15, rnd) * uNight;
    vec3 warm = mix(vec3(1.0, 0.62, 0.3), vec3(0.6, 0.75, 1.0), step(0.82, wHash(id.yx + 3.1)));
    gWinEmissive = warm * lit * (0.5 + rnd * 0.35) + vec3(1.0, 0.7, 0.4) * ground * inWin * uNight * 0.35 * step(style, 3.5) * step(0.35, rnd);
  }
}`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
totalEmissiveRadiance += gWinEmissive;
totalEmissiveRadiance += diffuseColor.rgb * vW.w * (0.5 + uNight * 1.6);`,
      );
    if (isStd) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, gGlass);
if (vW.x < 0.5 && vUp > 0.6) roughnessFactor = mix(roughnessFactor, 0.18, uWet);`,
      ).replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.6, gGlass);`,
      );
    }
  };
  mat.customProgramCacheKey = () => `world-${isStd ? 's' : 'l'}-${opts.grain === false ? 0 : 1}-${opts.lodMask ? 1 : 0}`;
}

let worldMat: THREE.Material | null = null;
export function getWorldMaterial(low: boolean): THREE.Material {
  if (worldMat) return worldMat;
  const m = low
    ? new THREE.MeshLambertMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.02 });
  patchWorldMaterial(m);
  worldMat = m;
  return m;
}
