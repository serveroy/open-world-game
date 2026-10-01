import * as THREE from 'three';

/**
 * Additive camera-facing glow sprites (headlights, tail lights, sirens, muzzle flashes at
 * distance). Rebuilt every frame from `add()` calls; one draw call.
 */
export class Flares {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private aPos: THREE.InstancedBufferAttribute;
  private aCol: THREE.InstancedBufferAttribute;
  private n = 0;
  private readonly max: number;
  private c = new THREE.Color();

  constructor(scene: THREE.Scene, max = 600) {
    this.max = max;
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.attributes.position!);
    this.geo.setAttribute('uv', base.attributes.uv!);
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.aPos);
    this.geo.setAttribute('iCol', this.aCol);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec4 iPos; attribute vec3 iCol; varying vec3 vC; varying vec2 vUv;
        void main() { vC = iCol; vUv = uv; vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
          // pull slightly toward camera to avoid clipping into the light housing
          mv.xyz += normalize(-mv.xyz) * 0.25;
          mv.xy += position.xy * iPos.w; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vC; varying vec2 vUv;
        void main() { vec2 d = vUv - 0.5; float r = length(d) * 2.0; float a = pow(max(0.0, 1.0 - r), 2.2);
          a += max(0.0, 1.0 - abs(d.y) * 40.0) * max(0.0, 1.0 - abs(d.x) * 2.2) * 0.25;
          gl_FragColor = vec4(vC * a, a); }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    scene.add(this.mesh);
  }

  begin(): void {
    this.n = 0;
  }
  add(x: number, y: number, z: number, size: number, hex: number, intensity = 1): void {
    if (this.n >= this.max || intensity <= 0.01) return;
    const i = this.n++;
    this.aPos.setXYZW(i, x, y, z, size);
    this.c.setHex(hex).multiplyScalar(intensity);
    this.aCol.setXYZ(i, this.c.r, this.c.g, this.c.b);
  }
  end(): void {
    this.geo.instanceCount = this.n;
    this.aPos.needsUpdate = true;
    this.aCol.needsUpdate = true;
  }
}
