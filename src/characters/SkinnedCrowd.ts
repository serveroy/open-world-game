import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RigData } from './rig/RigData';
import { buildPartGeometry, headOf, limbsOf } from './rig/Outfits';
import { isLowQuality } from '../render/materials';

/**
 * GPU-skinned, instanced characters built from dressed parts (head / body / legs / feet). Every
 * character slot owns one row of a float texture holding its skin matrices (3 texels per bone).
 * Each distinct part combination is merged into one mesh on demand (cached), drawn once for all
 * characters wearing it — e.g. a whole police squad is one draw. Clothing, skin and hair colours are
 * tinted per instance; hats and held items are per-instance variants selected in the vertex shader.
 * Only combinations with a character near the camera cast shadows.
 */

/** Per-instance float params (3 × vec4). */
const PARAMS = 12;

export interface InstanceLook {
  /** Packed 0xRRGGBB colours. */
  skin: number;
  hair: number;
  top1: number;
  top2: number;
  bottom: number;
  shoes: number;
  hat: number;
  tattoo: number;
  hatId: number;
  /** Tattoo kind 0 none, 1 tribal, 2 sleeve, 3 neck, 4 full. */
  tattooKind: number;
  /** Painted beard 0 none, 1 stubble, 2 goatee, 3 full. */
  beard: number;
}

interface ComboMesh {
  key: string;
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  attrs: THREE.InstancedBufferAttribute[];
  arrays: Float32Array[];
  n: number;
  refs: number;
  shadow: boolean;
  /** Frame it was last used (unused combos are kept briefly to avoid rebuild churn). */
  last: number;
}

export class SkinnedCrowd {
  readonly group = new THREE.Group();
  readonly poseData: Float32Array;
  readonly rowFloats: number;
  private readonly tex: THREE.DataTexture;
  private readonly params: Float32Array;
  private readonly combo: (ComboMesh | null)[];
  private readonly item: Uint8Array;
  private readonly visible: Uint8Array;
  private readonly shadow: Uint8Array;
  private readonly partGeo: THREE.BufferGeometry[];
  private readonly mats: THREE.Material[];
  private readonly depth: THREE.MeshDepthMaterial;
  private readonly combos = new Map<string, ComboMesh>();
  private castShadows: boolean;
  private frame = 0;

  constructor(scene: THREE.Scene, readonly rig: RigData, readonly capacity: number, castShadow: boolean) {
    const nb = rig.boneNames.length;
    this.rowFloats = nb * 12;
    this.poseData = new Float32Array(nb * 3 * 4 * capacity);
    this.tex = new THREE.DataTexture(this.poseData, nb * 3, capacity, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    this.params = new Float32Array(capacity * PARAMS);
    this.combo = new Array<ComboMesh | null>(capacity).fill(null);
    this.item = new Uint8Array(capacity);
    this.visible = new Uint8Array(capacity);
    this.shadow = new Uint8Array(capacity);
    this.castShadows = castShadow;
    this.mats = rig.bodies.map((b) => makeMaterial(this.tex, limbsOf(rig, b), headOf(rig, b), nb));
    this.depth = makeDepthMaterial(this.tex, nb);
    // CPU-side part geometries; merged per combination when first worn
    this.partGeo = rig.parts.map((p) => buildPartGeometry(rig, p).geometry);
    scene.add(this.group);
  }

  private acquire(head: number, body: number, legs: number, feet: number): ComboMesh {
    const key = `${head},${body},${legs},${feet}`;
    let c = this.combos.get(key);
    if (!c) {
      const merged = mergeGeometries([head, body, legs, feet].map((i) => this.partGeo[i]!), false);
      if (!merged) throw new Error('part merge failed');
      const geo = new THREE.InstancedBufferGeometry();
      for (const [k, a] of Object.entries(merged.attributes)) geo.setAttribute(k, a);
      geo.setIndex(merged.index);
      const attrs: THREE.InstancedBufferAttribute[] = [];
      const arrays: Float32Array[] = [];
      for (const name of ['iA', 'iC0', 'iC1']) {
        const arr = new Float32Array(this.capacity * 4);
        const a = new THREE.InstancedBufferAttribute(arr, 4);
        a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(name, a);
        attrs.push(a);
        arrays.push(arr);
      }
      geo.instanceCount = 0;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const mesh = new THREE.Mesh(geo, this.mats[this.rig.parts[head]!.body]!);
      mesh.customDepthMaterial = this.depth;
      mesh.frustumCulled = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.name = 'crowd_' + [head, body, legs, feet].map((i) => this.rig.parts[i]!.name).join('+');
      this.group.add(mesh);
      c = { key, mesh, geo, attrs, arrays, n: 0, refs: 0, shadow: false, last: this.frame };
      this.combos.set(key, c);
    }
    c.refs++;
    return c;
  }

  private release(c: ComboMesh | null): void {
    if (!c) return;
    c.refs--;
    c.last = this.frame;
  }

  /** Free combinations nobody has worn for a while (keeps the most recent few warm). */
  private evict(): void {
    if (this.combos.size < 24) return;
    for (const [k, c] of this.combos) {
      if (c.refs > 0 || this.frame - c.last < 600) continue;
      this.group.remove(c.mesh);
      c.geo.dispose();
      this.combos.delete(k);
    }
  }

  setShadows(on: boolean): void {
    this.castShadows = on;
  }

  /** Float offset of a slot's skin matrices in `poseData` (for writeSkin). */
  rowOffset(slot: number): number {
    return slot * this.rowFloats;
  }

  /** Part indices (into rig.parts) worn by a slot: head, body, legs, feet. */
  setParts(slot: number, head: number, body: number, legs: number, feet: number): void {
    const key = `${head},${body},${legs},${feet}`;
    const cur = this.combo[slot];
    if (cur && cur.key === key) return;
    const next = this.acquire(head, body, legs, feet);
    this.release(cur ?? null);
    this.combo[slot] = next;
  }

  /** Slot freed: drop its combination reference. */
  clear(slot: number): void {
    this.release(this.combo[slot] ?? null);
    this.combo[slot] = null;
    this.visible[slot] = 0;
  }

  setLook(slot: number, l: InstanceLook): void {
    const p = this.params, o = slot * PARAMS;
    // iA: row, hat, item, tattoo kind + 8 × beard
    p[o] = slot; p[o + 1] = l.hatId; p[o + 2] = this.item[slot]!; p[o + 3] = l.tattooKind + 8 * l.beard;
    // colours as exact 24-bit integers in float
    p[o + 4] = l.skin; p[o + 5] = l.hair; p[o + 6] = l.top1; p[o + 7] = l.top2;
    p[o + 8] = l.bottom; p[o + 9] = l.shoes; p[o + 10] = l.hat; p[o + 11] = l.tattoo;
  }

  setItem(slot: number, itemId: number): void {
    this.item[slot] = itemId;
    this.params[slot * PARAMS + 2] = itemId;
  }

  /** `shadow`: this character is close enough to the camera for its shadow to matter. */
  setVisible(slot: number, v: boolean, shadow = false): void {
    this.visible[slot] = v ? 1 : 0;
    this.shadow[slot] = shadow ? 1 : 0;
  }

  isVisible(slot: number): boolean {
    return this.visible[slot] === 1;
  }

  /** Pack visible instances per combination and upload the pose texture. */
  commit(used: number): void {
    this.frame++;
    for (const c of this.combos.values()) {
      c.n = 0;
      c.shadow = false;
    }
    const P = this.params;
    for (let s = 0; s < used; s++) {
      const c = this.combo[s];
      if (!this.visible[s] || !c) continue;
      const o = s * PARAMS;
      const j = c.n++ * 4;
      if (this.shadow[s]) c.shadow = true;
      for (let a = 0; a < 3; a++) {
        const arr = c.arrays[a]!;
        arr[j] = P[o + a * 4]!;
        arr[j + 1] = P[o + a * 4 + 1]!;
        arr[j + 2] = P[o + a * 4 + 2]!;
        arr[j + 3] = P[o + a * 4 + 3]!;
      }
    }
    for (const c of this.combos.values()) {
      c.geo.instanceCount = c.n;
      c.mesh.visible = c.n > 0;
      c.mesh.castShadow = this.castShadows && c.shadow;
      if (c.n > 0) {
        c.last = this.frame;
        for (const a of c.attrs) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, c.n * 4);
          a.needsUpdate = true;
        }
      }
    }
    this.tex.needsUpdate = true;
    if ((this.frame & 63) === 0) this.evict();
  }

  /** Instanced draws issued last commit (one per worn combination). */
  get draws(): number {
    let n = 0;
    for (const c of this.combos.values()) if (c.n > 0) n++;
    return n;
  }

  get cached(): number {
    return this.combos.size;
  }
}

// ---------------------------------------------------------------- shaders

const VERT_PARS = /* glsl */ `
attribute vec4 aBones;
attribute vec4 aWeights;
attribute vec4 aColor;
attribute float aVar;
attribute vec4 iA;
attribute vec4 iC0;
attribute vec4 iC1;
uniform highp sampler2D uPose;
mat4 crowdBone(float b) {
  int x = int(b) * 3;
  int y = int(iA.x);
  vec4 r0 = texelFetch(uPose, ivec2(x, y), 0);
  vec4 r1 = texelFetch(uPose, ivec2(x + 1, y), 0);
  vec4 r2 = texelFetch(uPose, ivec2(x + 2, y), 0);
  return mat4(r0.x, r1.x, r2.x, 0.0, r0.y, r1.y, r2.y, 0.0, r0.z, r1.z, r2.z, 0.0, r0.w, r1.w, r2.w, 1.0);
}
bool crowdHidden() {
  float cat = floor(aVar / 32.0 + 0.001);
  if (cat < 0.5) return false;
  float id = aVar - cat * 32.0;
  float sel = cat < 3.5 ? iA.y : iA.z;
  return abs(sel - id) > 0.5;
}
`;

const VERT_SKIN = /* glsl */ `
  if (crowdHidden()) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  mat4 crowdSkin = crowdBone(aBones.x) * aWeights.x + crowdBone(aBones.y) * aWeights.y + crowdBone(aBones.z) * aWeights.z + crowdBone(aBones.w) * aWeights.w;
`;

const PAINT_PARS = /* glsl */ `
flat varying vec4 vC0;
flat varying vec4 vC1;
flat varying vec4 vOrig;
flat varying float vTattoo;
flat varying float vBeard;
varying vec3 vBind;
`;

const FRAG_PARS = /* glsl */ `
uniform vec4 uLimbs;
uniform vec4 uHead;
vec3 crowdLin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 crowdCol(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return crowdLin(vec3(r, g, b) / 255.0);
}
float crowdLum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

/** Paint slot colouring; sets diffuseColor.rgb and crowdRough / crowdMetal. */
const FRAG_PAINT = /* glsl */ `
  int paint = int(vOrig.w + 0.5);
  vec3 orig = crowdLin(vOrig.rgb / 255.0);
  vec3 col = orig;
  float crowdRough = 0.85;
  float crowdMetal = 0.0;
  if (paint == 0 || paint == 10) {
    // skin: tint, keeping the model's darker skin details (lips etc.) relative to its base tone
    vec3 cSkin = crowdCol(vC0.x);
    col = cSkin * clamp(crowdLum(orig) / crowdLum(crowdLin(vec3(0.616, 0.42, 0.239))), 0.4, 1.3);
    crowdRough = 0.65;
    float ax = abs(vBind.x);
    if (vTattoo > 0.5 && ax > uLimbs.x) {
      float u = (ax - uLimbs.x) / (uLimbs.y - uLimbs.x);
      float pat = step(0.45, fract(vBind.y * 70.0 + sin(ax * 90.0) * 0.6)) * 0.7;
      float tri = 1.0 - smoothstep(0.012, 0.02, abs(u - 0.32));
      bool sleeveTat = vTattoo > 1.5 && vTattoo < 2.5 || vTattoo > 3.5;
      col = mix(col, crowdCol(vC1.w), sleeveTat ? pat * step(0.2, u) * step(u, 0.95) : vTattoo < 1.5 ? tri * 0.85 : 0.0);
    }
    if (vTattoo > 2.5 && ax < 0.08 && vBind.y > uLimbs.z - 0.08 && vBind.y < uLimbs.z) col = mix(col, crowdCol(vC1.w), 0.6 * step(0.55, fract(vBind.x * 60.0 + vBind.y * 20.0)));
    if (paint == 10 && vBeard > 0.5) {
      // painted facial hair, relative to the head bone (chin ≈ 0, mouth ≈ +0.018, upper lip ≈ +0.033, nose ≈ +0.053 m)
      vec3 r = vBind - uHead.xyz;
      float front = smoothstep(0.03, 0.07, r.z);
      float jaw = smoothstep(-0.045, -0.035, r.y) * (1.0 - smoothstep(0.036, 0.044, r.y)) * front;
      float mouth = smoothstep(0.01, 0.014, r.y) * (1.0 - smoothstep(0.022, 0.026, r.y)) * (1.0 - smoothstep(0.016, 0.022, abs(r.x)));
      float tache = smoothstep(0.022, 0.027, r.y) * (1.0 - smoothstep(0.036, 0.041, r.y)) * (1.0 - smoothstep(0.022, 0.028, abs(r.x))) * step(0.1, r.z);
      float chin = (1.0 - smoothstep(0.014, 0.02, abs(r.x))) * smoothstep(-0.03, -0.024, r.y) * (1.0 - smoothstep(0.008, 0.013, r.y)) * step(0.08, r.z);
      vec3 cB = crowdCol(vC0.y) * 0.85;
      float k = vBeard < 1.5 ? 0.32 * max(jaw, tache) : vBeard < 2.5 ? 0.9 * max(chin, tache) : 0.9 * max(jaw, tache) * (1.0 - mouth);
      col = mix(col, cB, k);
    }
  } else if (paint == 1) {
    col = crowdCol(vC0.y);
    crowdRough = 0.7;
  } else if (paint == 2) {
    col = crowdCol(vC0.y) * 0.55;
  } else if (paint == 3) {
    crowdRough = 0.25;
  } else if (paint == 4) {
    col = crowdCol(vC0.z);
  } else if (paint == 5) {
    col = crowdCol(vC0.w);
  } else if (paint == 6) {
    col = crowdCol(vC1.x);
  } else if (paint == 7) {
    col = crowdCol(vC1.y);
    crowdRough = 0.5;
  } else if (paint == 8) {
    col = crowdCol(vC1.z);
  } else if (paint == 16 || paint == 17) {
    col = crowdCol(vC1.z) * (vOrig.r / 255.0);
    crowdRough = 0.8;
  } else if (paint == 20) {
    col = vec3(0.42 * vOrig.r / 255.0);
    crowdRough = 0.38;
    crowdMetal = 0.55;
  }
  diffuseColor.rgb = col;
`;

function patchVertex(shader: THREE.WebGLProgramParametersWithUniforms, tex: THREE.DataTexture, paint: boolean): void {
  shader.uniforms.uPose = { value: tex };
  shader.vertexShader = shader.vertexShader
    .replace('#include <skinning_pars_vertex>', VERT_PARS + (paint ? PAINT_PARS : ''))
    .replace('#include <skinbase_vertex>', VERT_SKIN)
    .replace('#include <skinnormal_vertex>', 'objectNormal = mat3(crowdSkin) * objectNormal;')
    .replace('#include <skinning_vertex>', 'transformed = (crowdSkin * vec4(transformed, 1.0)).xyz;');
  if (paint) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vC0 = iC0; vC1 = iC1; vOrig = aColor; vTattoo = mod(iA.w, 8.0); vBeard = floor(iA.w / 8.0 + 0.01); vBind = position;',
    );
  }
}

function makeMaterial(tex: THREE.DataTexture, limbs: THREE.Vector4, head: THREE.Vector4, nb: number): THREE.Material {
  const low = isLowQuality();
  // flat shading from screen-space derivatives keeps the faceted low-poly look on welded meshes
  const mat = low
    ? new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true })
    : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true });
  mat.onBeforeCompile = (shader) => {
    patchVertex(shader, tex, true);
    shader.uniforms.uLimbs = { value: limbs };
    shader.uniforms.uHead = { value: head };
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + PAINT_PARS + FRAG_PARS);
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_PAINT);
    if (!low) {
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = crowdRough;');
      fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = crowdMetal;');
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `crowd2-${nb}-${low ? 'L' : 'S'}`;
  return mat;
}

function makeDepthMaterial(tex: THREE.DataTexture, nb: number): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => patchVertex(shader, tex, false);
  mat.customProgramCacheKey = () => `crowd2-depth-${nb}`;
  return mat;
}
