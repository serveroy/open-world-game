import * as THREE from 'three';

/** Ring buffer of dark quads laid on the ground behind slipping tyres. */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos: Float32Array;
  private alpha: Float32Array;
  private head = 0;
  private readonly max: number;
  private attr: THREE.BufferAttribute;
  private aAttr: THREE.BufferAttribute;

  constructor(scene: THREE.Scene, max = 1200) {
    this.max = max;
    this.pos = new Float32Array(max * 6 * 3);
    this.alpha = new Float32Array(max * 6);
    const g = new THREE.BufferGeometry();
    this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aAttr = new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.attr);
    g.setAttribute('alpha', this.aAttr);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      vertexShader: `attribute float alpha; varying float vA;
        #include <fog_pars_vertex>
        void main() { vA = alpha; vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
        }`,
      fragmentShader: `varying float vA;
        #include <fog_pars_fragment>
        void main() { gl_FragColor = vec4(0.05, 0.05, 0.05, vA * 0.55);
        #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    scene.add(this.mesh);
  }

  /** Add a segment from (ax,az) to (bx,bz) at heights ay/by. */
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number, width: number, strength: number): void {
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz);
    if (l < 0.05 || l > 4) return;
    const px = (-dz / l) * width * 0.5, pz = (dx / l) * width * 0.5;
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const o = i * 18;
    const y0 = ay + 0.03, y1 = by + 0.03;
    const v = [ax - px, y0, az - pz, bx - px, y1, bz - pz, bx + px, y1, bz + pz, ax - px, y0, az - pz, bx + px, y1, bz + pz, ax + px, y0, az + pz];
    for (let k = 0; k < 18; k++) this.pos[o + k] = v[k]!;
    for (let k = 0; k < 6; k++) this.alpha[i * 6 + k] = Math.min(1, strength);
    this.attr.needsUpdate = true;
    this.aAttr.needsUpdate = true;
  }

  clear(): void {
    this.alpha.fill(0);
    this.aAttr.needsUpdate = true;
  }
}
