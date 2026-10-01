import * as THREE from 'three';

/** Shared material factory. On low quality we use Lambert to save fragment cost. */
let lowQuality = false;
const cache = new Map<string, THREE.Material>();

export function setLowQualityMaterials(low: boolean): void {
  lowQuality = low;
}
export function isLowQuality(): boolean {
  return lowQuality;
}

export interface MatOpts {
  color?: number;
  vertexColors?: boolean;
  roughness?: number;
  metalness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  flatShading?: boolean;
}

export function litMaterial(key: string, o: MatOpts = {}): THREE.MeshStandardMaterial | THREE.MeshLambertMaterial {
  const k = `${key}|${lowQuality ? 'L' : 'S'}`;
  const hit = cache.get(k);
  if (hit) return hit as THREE.MeshStandardMaterial;
  const common = {
    color: o.color ?? 0xffffff,
    vertexColors: o.vertexColors ?? false,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    side: o.side ?? THREE.FrontSide,
    emissive: new THREE.Color(o.emissive ?? 0),
    emissiveIntensity: o.emissiveIntensity ?? 1,
    flatShading: o.flatShading ?? false,
  };
  const m = lowQuality
    ? new THREE.MeshLambertMaterial(common)
    : new THREE.MeshStandardMaterial({ ...common, roughness: o.roughness ?? 0.8, metalness: o.metalness ?? 0 });
  cache.set(k, m);
  return m;
}

/** Simple unlit material (glows, decals). */
export function basicMaterial(key: string, o: { color?: number; transparent?: boolean; opacity?: number; blending?: THREE.Blending; depthWrite?: boolean; vertexColors?: boolean; side?: THREE.Side; map?: THREE.Texture } = {}): THREE.MeshBasicMaterial {
  const hit = cache.get(key);
  if (hit) return hit as THREE.MeshBasicMaterial;
  const m = new THREE.MeshBasicMaterial({
    color: o.color ?? 0xffffff,
    transparent: o.transparent ?? false,
    opacity: o.opacity ?? 1,
    blending: o.blending ?? THREE.NormalBlending,
    depthWrite: o.depthWrite ?? true,
    vertexColors: o.vertexColors ?? false,
    side: o.side ?? THREE.FrontSide,
    map: o.map ?? null,
  });
  cache.set(key, m);
  return m;
}

/** Paint a geometry's vertex colours with a single colour (for merging multi-colour meshes). */
export function paint(geo: THREE.BufferGeometry, color: number | THREE.Color, emissiveMask = 0): THREE.BufferGeometry {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const n = geo.attributes.position!.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (emissiveMask >= 0) {
    const e = new Float32Array(n).fill(emissiveMask);
    geo.setAttribute('emissiveMask', new THREE.BufferAttribute(e, 1));
  }
  return geo;
}
