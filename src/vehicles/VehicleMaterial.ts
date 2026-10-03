import * as THREE from 'three';

export interface VehicleMatUniforms {
  uPaint: { value: THREE.Color };
  /** x head, y brake, z reverse, w siren on */
  uLights: { value: THREE.Vector4 };
  /** x left indicator, y right indicator, z siren phase, w sign on */
  uInd: { value: THREE.Vector4 };
  uGlass: { value: number };
  uDamage: { value: number };
  uNight: { value: number };
}

/**
 * Per-vehicle material (cloned; shares one program). Paint via `vpaint` mask, emissive
 * lights via `vlight` id, broken glass via `vglass` + noise discard, damage grime.
 */
export function makeVehicleMaterial(low: boolean): { mat: THREE.Material; u: VehicleMatUniforms } {
  const u: VehicleMatUniforms = {
    uPaint: { value: new THREE.Color(0xc8283c) },
    uLights: { value: new THREE.Vector4() },
    uInd: { value: new THREE.Vector4() },
    uGlass: { value: 0 },
    uDamage: { value: 0 },
    uNight: { value: 0 },
  };
  const mat = low
    ? new THREE.MeshLambertMaterial({ vertexColors: true })
    : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.25 });
  const isStd = !low;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float vpaint; attribute float vlight; attribute float vglass;
flat varying float fPaint; flat varying float fLight; flat varying float fGlass; varying vec3 vLocal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
fPaint = vpaint; fLight = vlight; fGlass = vglass; vLocal = position;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uPaint; uniform vec4 uLights; uniform vec4 uInd; uniform float uGlass; uniform float uDamage; uniform float uNight;
flat varying float fPaint; flat varying float fLight; flat varying float fGlass; varying vec3 vLocal;
float vh(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
vec3 gVehEm = vec3(0.0); float gIsGlass = 0.0; float gIsPaint = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
gIsPaint = fPaint;
diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uPaint, fPaint);
if (uDamage > 0.0) {
  float n = vh(floor(vLocal * 6.0));
  diffuseColor.rgb *= 1.0 - uDamage * (0.35 + 0.4 * n) * (0.5 + fPaint * 0.5);
}
if (fGlass > 0.5) {
  gIsGlass = 1.0;
  if (uGlass > 0.5) {
    float c = vh(floor(vLocal * 9.0));
    if (c > 0.25) discard;
    diffuseColor.rgb = vec3(0.6, 0.65, 0.7);
  }
}
float lid = fLight;
if (lid > 0.5) {
  if (lid < 1.5) gVehEm = vec3(1.0, 0.95, 0.82) * (uLights.x * 2.2);
  else if (lid < 2.5) gVehEm = vec3(1.0, 0.08, 0.05) * (uLights.x * 0.8 + uLights.y * 2.6);
  else if (lid < 3.5) gVehEm = vec3(1.0, 0.55, 0.05) * uInd.x * 2.5;
  else if (lid < 4.5) gVehEm = vec3(1.0, 0.55, 0.05) * uInd.y * 2.5;
  else if (lid < 5.5) gVehEm = vec3(1.0) * uLights.z * 1.8;
  else if (lid < 6.5) gVehEm = vec3(1.0, 0.1, 0.08) * uLights.w * step(0.5, uInd.z) * 4.0;
  else if (lid < 7.5) gVehEm = vec3(0.1, 0.25, 1.0) * uLights.w * step(uInd.z, 0.5) * 4.0;
  else if (lid < 8.5) gVehEm = diffuseColor.rgb * (0.6 + uNight * 1.2) * uInd.w;
  else gVehEm = diffuseColor.rgb * 1.6;
}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += gVehEm;`);
    if (isStd) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.28 + uDamage * 0.5, gIsPaint);
roughnessFactor = mix(roughnessFactor, 0.06, gIsGlass * (1.0 - uGlass));`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.45 - uDamage * 0.3, gIsPaint);
metalnessFactor = mix(metalnessFactor, 0.9, gIsGlass * (1.0 - uGlass));`);
    }
  };
  mat.customProgramCacheKey = () => (low ? 'veh-l' : 'veh-s');
  return { mat, u };
}
