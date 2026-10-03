import * as THREE from 'three';
import type { RigData } from './rig/RigData';
import { buildBodyGeometry, type BodyGeometry } from './rig/Outfits';
import { isLowQuality } from '../render/materials';

/**
 * GPU-skinned, instanced characters. Every character slot owns one row of a float texture holding its
 * skin matrices (3 texels per bone); all characters of a body type are drawn in a single instanced call
 * (plus one for shadows). Outfits, hair, hats and held items are variants selected per instance in the
 * vertex shader; colours are painted per body region in the fragment shader.
 */

/** Per-instance float params (5 × vec4). */
const PARAMS = 20;

export interface InstanceLook {
  /** Packed 0xRRGGBB colours. */
  skin: number;
  hair: number;
  top: number;
  outer: number;
  bottom: number;
  shoes: number;
  hat: number;
  tattoo: number;
  /** Sleeve length 0 (sleeveless) … 1 (to the wrist), leg length 0 … 1 (to the ankle). */
  sleeve: number;
  legs: number;
  outerId: number;
  hairId: number;
  beardId: number;
  hatId: number;
  topKind: number;
  /** bit0 stubble, bit1 painted scalp (any hairstyle), bit2 shaved sides (mohawk), bits 3..5 tattoo kind. */
  flags: number;
}

export class SkinnedCrowd {
  readonly group = new THREE.Group();
  readonly poseData: Float32Array;
  readonly rowFloats: number;
  private readonly tex: THREE.DataTexture;
  private readonly params: Float32Array;
  private readonly body: Uint8Array;
  private readonly item: Uint8Array;
  private readonly visible: Uint8Array;
  private readonly meshes: { mesh: THREE.Mesh; geo: THREE.InstancedBufferGeometry; attrs: THREE.InstancedBufferAttribute[] }[] = [];
  readonly bodies: BodyGeometry[];

  constructor(scene: THREE.Scene, readonly rig: RigData, readonly capacity: number, castShadow: boolean) {
    const nb = rig.boneNames.length;
    this.rowFloats = nb * 12;
    this.poseData = new Float32Array(nb * 3 * 4 * capacity);
    this.tex = new THREE.DataTexture(this.poseData, nb * 3, capacity, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    this.params = new Float32Array(capacity * PARAMS);
    this.body = new Uint8Array(capacity);
    this.item = new Uint8Array(capacity);
    this.visible = new Uint8Array(capacity);
    this.bodies = rig.bodies.map((b) => buildBodyGeometry(rig, b));
    this.bodies.forEach((bg, bi) => {
      const geo = new THREE.InstancedBufferGeometry();
      for (const [k, a] of Object.entries(bg.geometry.attributes)) geo.setAttribute(k, a);
      geo.setIndex(bg.geometry.index);
      const attrs: THREE.InstancedBufferAttribute[] = [];
      for (const name of ['iA', 'iSel', 'iB', 'iC0', 'iC1']) {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        a.setUsage(THREE.DynamicDrawUsage);
        geo.setAttribute(name, a);
        attrs.push(a);
      }
      geo.instanceCount = 0;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
      const mat = makeMaterial(this.tex, bg, nb);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.customDepthMaterial = makeDepthMaterial(this.tex, nb);
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.name = `crowd_${rig.bodies[bi]!.name}`;
      this.group.add(mesh);
      this.meshes.push({ mesh, geo, attrs });
    });
    scene.add(this.group);
  }

  setShadows(on: boolean): void {
    for (const m of this.meshes) m.mesh.castShadow = on;
  }

  /** Float offset of a slot's skin matrices in `poseData` (for writeSkin). */
  rowOffset(slot: number): number {
    return slot * this.rowFloats;
  }

  setBody(slot: number, body: number): void {
    this.body[slot] = Math.min(body, this.meshes.length - 1);
  }

  setLook(slot: number, l: InstanceLook): void {
    const p = this.params, o = slot * PARAMS;
    // iA: row, sleeve, legs, outer
    p[o] = slot; p[o + 1] = l.sleeve; p[o + 2] = l.legs; p[o + 3] = l.outerId;
    // iSel: hair, beard, hat, item (item set per frame)
    p[o + 4] = l.hairId; p[o + 5] = l.beardId; p[o + 6] = l.hatId; p[o + 7] = this.item[slot]!;
    // iB: topKind, flags, -, -
    p[o + 8] = l.topKind; p[o + 9] = l.flags; p[o + 10] = 0; p[o + 11] = 0;
    // colours (exact 24-bit integers in float)
    p[o + 12] = l.skin; p[o + 13] = l.hair; p[o + 14] = l.top; p[o + 15] = l.outer;
    p[o + 16] = l.bottom; p[o + 17] = l.shoes; p[o + 18] = l.hat; p[o + 19] = l.tattoo;
  }

  setItem(slot: number, itemId: number): void {
    this.item[slot] = itemId;
    this.params[slot * PARAMS + 7] = itemId;
  }

  setVisible(slot: number, v: boolean): void {
    this.visible[slot] = v ? 1 : 0;
  }

  /** Pack visible instances per body and upload the pose texture. */
  commit(used: number): void {
    for (let b = 0; b < this.meshes.length; b++) {
      const m = this.meshes[b]!;
      const arrs = m.attrs.map((a) => a.array as Float32Array);
      let n = 0;
      for (let s = 0; s < used; s++) {
        if (!this.visible[s] || this.body[s] !== b) continue;
        const o = s * PARAMS;
        for (let k = 0; k < 5; k++) {
          const arr = arrs[k]!;
          arr[n * 4] = this.params[o + k * 4]!;
          arr[n * 4 + 1] = this.params[o + k * 4 + 1]!;
          arr[n * 4 + 2] = this.params[o + k * 4 + 2]!;
          arr[n * 4 + 3] = this.params[o + k * 4 + 3]!;
        }
        n++;
      }
      m.geo.instanceCount = n;
      m.mesh.visible = n > 0;
      if (n > 0) for (const a of m.attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n * 4);
        a.needsUpdate = true;
      }
    }
    this.tex.needsUpdate = true;
  }

  get drawn(): number {
    let n = 0;
    for (const m of this.meshes) n += m.geo.instanceCount;
    return n;
  }
}

// ---------------------------------------------------------------- shaders

const VERT_PARS = /* glsl */ `
attribute vec4 aBones;
attribute vec4 aWeights;
attribute float aRegion;
attribute float aVar;
attribute float aShade;
attribute vec4 iA;
attribute vec4 iSel;
attribute vec4 iB;
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
  float sel = cat < 1.5 ? iSel.x : cat < 2.5 ? iSel.y : cat < 3.5 ? iSel.z : cat < 4.5 ? iSel.w : iA.w;
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
flat varying vec4 vInfo;
flat varying float vRegion;
varying float vShade;
varying vec3 vBind;
`;

const FRAG_PARS = /* glsl */ `
uniform vec4 uHead;
uniform vec4 uFace;
uniform vec4 uLimbs;
uniform vec4 uTorso;
uniform vec4 uEye;
vec3 crowdCol(float v) {
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  vec3 c = vec3(r, g, b) / 255.0;
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
float crowdHairline(float phi, float front, float side, float back) {
  float c = cos(phi);
  float a = abs(c);
  float s = a * a * (3.0 - 2.0 * a);
  return c >= 0.0 ? side + (front - side) * s : side + (back - side) * s;
}
/** Jacket / suit front opening: 0 = jacket, 1 = shirt, 2 = tie. */
float crowdOpening(vec3 b, float topKind) {
  if (b.z < 0.02) return 0.0;
  float ax = abs(b.x);
  if (topKind > 2.5 && topKind < 3.5) return ax < 0.038 ? 1.0 : 0.0;
  if (topKind > 3.5 && topKind < 4.5) {
    float w = 0.012 + max(0.0, b.y - uTorso.x - 0.17) * 0.36;
    if (ax > w) return 0.0;
    return ax < 0.011 + (uTorso.z - b.y) * 0.012 && b.y > uTorso.x + 0.14 ? 2.0 : 1.0;
  }
  return 0.0;
}
float crowdEllipse(vec2 p, vec2 c, vec2 r) {
  vec2 d = (p - c) / r;
  return 1.0 - smoothstep(0.75, 1.0, dot(d, d));
}
`;

/** Region painting; sets diffuseColor.rgb and crowdRough / crowdMetal. */
const FRAG_PAINT = /* glsl */ `
  vec3 cSkin = crowdCol(vC0.x), cHair = crowdCol(vC0.y), cTop = crowdCol(vC0.z), cOuter = crowdCol(vC0.w);
  vec3 cBottom = crowdCol(vC1.x), cShoes = crowdCol(vC1.y), cHat = crowdCol(vC1.z), cTat = crowdCol(vC1.w);
  float topKind = vInfo.x;
  float flags = vInfo.y;
  float sleeve = vInfo.z;
  float legs = vInfo.w;
  float fStubble = mod(flags, 2.0);
  float fScalp = mod(floor(flags / 2.0), 2.0);
  float fShaved = mod(floor(flags / 4.0), 2.0);
  float tattoo = floor(flags / 8.0);
  int reg = int(vRegion + 0.5);
  vec3 b = vBind;
  vec3 col = cSkin;
  float crowdRough = 0.86;
  float crowdMetal = 0.0;
  if (reg == 0) {
    // head: scalp hair, stubble, face
    crowdRough = 0.62;
    vec3 d = normalize(b - uHead.xyz);
    float theta = acos(clamp(d.y, -1.0, 1.0));
    float phi = atan(d.x, d.z);
    if (fScalp > 0.5) {
      float cut = crowdHairline(phi, 0.98, 1.5, 2.15);
      float k = 1.0 - smoothstep(cut - 0.06, cut + 0.02, theta);
      if (fShaved > 0.5) k *= 0.35;
      col = mix(col, cHair * 0.8, k);
    }
    if (b.z > uHead.z + uHead.w * 0.45) {
      vec2 p = vec2(abs(b.x - uHead.x), b.y);
      // brows (hair colour), upper-lid line, lips
      float browY = uFace.y - pow((p.x - uFace.w) / 0.02, 2.0) * 0.005 + (p.x - uFace.w) * 0.06;
      float brow = (1.0 - smoothstep(0.0032, 0.005, abs(b.y - browY))) * (1.0 - smoothstep(0.015, 0.021, abs(p.x - uFace.w + 0.002)));
      col = mix(col, cHair * 0.55, brow);
      float lid = (1.0 - smoothstep(0.0012, 0.0024, abs(b.y - (uEye.y + uEye.w * 0.62) + pow((p.x - uEye.x) / 0.012, 2.0) * 0.0035))) * (1.0 - smoothstep(0.011, 0.014, abs(p.x - uEye.x)));
      col = mix(col, cSkin * 0.35, lid * 0.8);
      float lips = crowdEllipse(p, vec2(0.0, uFace.z), vec2(0.021, 0.0075));
      col = mix(col, cSkin * vec3(0.78, 0.52, 0.5), lips * 0.85);
      float line = (1.0 - smoothstep(0.0006, 0.0016, abs(b.y - uFace.z))) * (1.0 - smoothstep(0.016, 0.021, p.x));
      col = mix(col, cSkin * 0.3, line * 0.9);
    }
    if (fStubble > 0.5) {
      // jaw, chin and upper lip; not the cheeks' upper half
      vec3 dd = normalize(b - uHead.xyz);
      float jaw = smoothstep(-0.28, -0.5, dd.y) * smoothstep(-0.45, 0.1, dd.z);
      float lip = (1.0 - smoothstep(0.004, 0.008, abs(b.y - uFace.z - 0.011))) * step(0.5, dd.z) * (1.0 - smoothstep(0.02, 0.026, abs(b.x - uHead.x)));
      col = mix(col, cHair * 0.85, 0.22 * max(jaw, lip));
    }
  } else if (reg == 11) {
    // eyeballs: sclera, iris, pupil looking forward
    vec3 q = vec3(abs(b.x) - uEye.x, b.y - uEye.y, b.z - uEye.z) / uEye.w;
    float r = length(q.xy);
    col = vec3(0.92, 0.9, 0.86);
    if (q.z > 0.0) {
      col = mix(col, vec3(0.2, 0.12, 0.06), 1.0 - smoothstep(0.5, 0.58, r));
      col = mix(col, vec3(0.02), 1.0 - smoothstep(0.22, 0.28, r));
    }
    crowdRough = 0.2;
  } else if (reg <= 10) {
    // body: zones from the bind-pose position (T-pose), so colour borders are smooth curves rather
    // than triangle edges: arms beyond the shoulder joint, legs below the hip, torso + neck between
    crowdRough = 0.9;
    float ax = abs(b.x);
    if (ax > uLimbs.x - 0.01 && b.y > uTorso.x + 0.12) {
      float u = (ax - uLimbs.x) / (uLimbs.y - uLimbs.x);
      bool sleeveOn = u < sleeve;
      col = sleeveOn ? (topKind > 2.5 && topKind < 4.5 ? cOuter : cTop) : cSkin;
      if (!sleeveOn) {
        crowdRough = 0.62;
        if (tattoo > 0.5) {
          float pat = step(0.45, fract(b.y * 70.0 + sin(ax * 90.0) * 0.6)) * 0.7;
          float tri = (1.0 - smoothstep(0.012, 0.02, abs(u - 0.32)));
          bool sleeveTat = tattoo > 1.5 && tattoo < 2.5 || tattoo > 3.5;
          col = mix(col, cTat, sleeveTat ? pat * step(0.25, u) * step(u, 0.95) : tattoo < 1.5 ? tri * 0.85 : 0.0);
        }
      }
    } else if (b.y < uLimbs.z) {
      float v = (uLimbs.z - b.y) / (uLimbs.z - uLimbs.w);
      col = v < legs ? cBottom : (v > 0.9 ? vec3(0.85) : cSkin);
      if (v >= legs) crowdRough = 0.62;
      if (b.y < uLimbs.w - 0.02) {
        // shoes, darker sole
        col = b.y < 0.022 ? cShoes * 0.3 + vec3(0.02) : cShoes;
        crowdRough = 0.5;
      }
    } else {
      bool upper = b.y > uTorso.x;
      col = upper ? cTop : cBottom;
      // neckline (dips at the front); tank tops are cut lower with bare shoulders
      float neck = uTorso.z + 0.018 - 0.03 * smoothstep(0.0, 0.07, b.z) - (topKind > 1.5 && topKind < 2.5 ? 0.025 : 0.0);
      if (b.y > neck && topKind < 2.5) col = cSkin;
      if (b.y > neck + 0.025 && topKind > 2.5) col = cSkin;
      if (upper && topKind > 1.5 && topKind < 2.5 && ax > 0.085 && b.y > uTorso.z - 0.12) col = cSkin; // tank straps
      if (topKind > 2.5 && b.y > uTorso.x - 0.04 && b.y < neck + 0.025) {
        float o = crowdOpening(b, topKind);
        col = o > 1.5 ? mix(cOuter, vec3(0.45, 0.05, 0.08), 0.65) : o > 0.5 ? cTop : cOuter;
      }
      float belt = 1.0 - smoothstep(0.009, 0.014, abs(b.y - uTorso.w));
      col = mix(col, cBottom * 0.35 + vec3(0.03, 0.02, 0.01), belt * step(b.y, uTorso.x + 0.03));
      if (tattoo > 3.5 && upper && b.z > 0.04 && b.y > uTorso.z - 0.18 && topKind > 1.5 && topKind < 2.5) col = mix(col, cTat, 0.6 * step(0.5, fract((b.x + b.y) * 30.0)));
      if (col == cSkin) crowdRough = 0.62;
      if (tattoo > 2.5 && tattoo < 3.5 || tattoo > 3.5) if (b.y > neck && b.y < neck + 0.06) col = mix(col, cTat, 0.6 * step(0.55, fract(b.x * 60.0 + b.y * 20.0)));
    }
  } else if (reg == 16) {
    float strand = 0.9 + 0.1 * sin(b.x * 900.0 + b.y * 300.0) * sin(b.z * 700.0);
    col = cHair * vShade * strand;
    crowdRough = 0.78;
  } else if (reg == 17) {
    col = cHair * 0.92;
    crowdRough = 0.7;
  } else if (reg == 18 || reg == 19) {
    col = cHat * vShade;
    crowdRough = 0.8;
  } else if (reg == 20) {
    col = vec3(0.42 * vShade);
    crowdRough = 0.38;
    crowdMetal = 0.55;
  } else if (reg == 22) {
    float o = crowdOpening(b, topKind);
    col = o > 1.5 ? mix(cOuter, vec3(0.45, 0.05, 0.08), 0.65) : o > 0.5 ? cTop : cOuter * vShade;
    crowdRough = 0.88;
  } else if (reg == 24) {
    col = cOuter;
    crowdRough = 0.95;
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
      '#include <begin_vertex>\n  vC0 = iC0; vC1 = iC1; vInfo = vec4(iB.x, iB.y, iA.y, iA.z); vRegion = aRegion; vShade = aShade; vBind = position;',
    );
  }
}

function makeMaterial(tex: THREE.DataTexture, bg: BodyGeometry, nb: number): THREE.Material {
  const low = isLowQuality();
  const mat = low ? new THREE.MeshLambertMaterial({ color: 0xffffff }) : new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.onBeforeCompile = (shader) => {
    patchVertex(shader, tex, true);
    shader.uniforms.uHead = { value: bg.head };
    shader.uniforms.uFace = { value: bg.face };
    shader.uniforms.uLimbs = { value: bg.limbs };
    shader.uniforms.uTorso = { value: bg.torso };
    shader.uniforms.uEye = { value: bg.eye };
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + PAINT_PARS + FRAG_PARS);
    fs = fs.replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_PAINT);
    if (!low) {
      fs = fs.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = crowdRough;');
      fs = fs.replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n  metalnessFactor = crowdMetal;');
    }
    shader.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => `crowd-${nb}-${low ? 'L' : 'S'}`;
  return mat;
}

function makeDepthMaterial(tex: THREE.DataTexture, nb: number): THREE.MeshDepthMaterial {
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.onBeforeCompile = (shader) => patchVertex(shader, tex, false);
  mat.customProgramCacheKey = () => `crowd-depth-${nb}`;
  return mat;
}
