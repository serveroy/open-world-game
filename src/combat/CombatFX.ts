import * as THREE from 'three';

/** Bullet tracers (additive line segments that fade quickly). */
export class Tracers {
  readonly lines: THREE.LineSegments;
  private pos: Float32Array;
  private col: Float32Array;
  private life: Float32Array;
  private head = 0;
  constructor(scene: THREE.Scene, private max = 64) {
    this.pos = new Float32Array(max * 6);
    this.col = new Float32Array(max * 6);
    this.life = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 15;
    scene.add(this.lines);
  }
  add(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    // draw only the last ~70% of the path to avoid clipping through the gun
    const sx = ax + (bx - ax) * 0.08, sy = ay + (by - ay) * 0.08, sz = az + (bz - az) * 0.08;
    this.pos.set([sx, sy, sz, bx, by, bz], i * 6);
    this.life[i] = 0.07;
  }
  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! > 0) this.life[i]! -= dt;
      const a = Math.max(0, this.life[i]! / 0.07);
      this.col.set([1 * a, 0.85 * a, 0.5 * a, 0.6 * a, 0.4 * a, 0.2 * a], i * 6);
    }
    this.lines.geometry.attributes.position!.needsUpdate = true;
    this.lines.geometry.attributes.color!.needsUpdate = true;
  }
}

/** Bullet hole / scorch decals (instanced quads oriented to the surface normal). */
export class Decals {
  readonly mesh: THREE.InstancedMesh;
  private head = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3();
  private n = new THREE.Vector3();
  private readonly z = new THREE.Vector3(0, 0, 1);
  constructor(scene: THREE.Scene, private max = 160) {
    const geo = new THREE.CircleGeometry(0.5, 7);
    const mat = new THREE.MeshBasicMaterial({ color: 0x141210, transparent: true, opacity: 0.85, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }
  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, size = 0.12): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.n.set(nx, ny, nz);
    this.q.setFromUnitVectors(this.z, this.n);
    this.m.compose(this.v.set(x + nx * 0.01, y + ny * 0.01, z + nz * 0.01), this.q, this.s.set(size, size, size));
    this.mesh.setMatrixAt(i, this.m);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear(): void {
    this.mesh.count = 0;
    this.head = 0;
  }
}

/** Ejected shell casings with cheap ballistic simulation. */
export class Casings {
  readonly mesh: THREE.InstancedMesh;
  private p: Float32Array;
  private v: Float32Array;
  private r: Float32Array;
  private life: Float32Array;
  private ground: Float32Array;
  private head = 0;
  private m = new THREE.Matrix4();
  private e = new THREE.Euler();
  private q = new THREE.Quaternion();
  private t = new THREE.Vector3();
  private one = new THREE.Vector3(1, 1, 1);
  constructor(scene: THREE.Scene, private max = 48) {
    this.mesh = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.008, 0.008, 0.03, 5), new THREE.MeshStandardMaterial({ color: 0xc8a040, metalness: 0.8, roughness: 0.3 }), max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = max;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.r = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.ground = new Float32Array(max);
    for (let i = 0; i < max; i++) this.mesh.setMatrixAt(i, new THREE.Matrix4().makeScale(0, 0, 0));
    scene.add(this.mesh);
  }
  eject(x: number, y: number, z: number, rx: number, rz: number, groundY: number): void {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    this.p.set([x, y, z], i * 3);
    this.v.set([rx * 2 + (Math.random() - 0.5), 2 + Math.random(), rz * 2 + (Math.random() - 0.5)], i * 3);
    this.r.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
    this.life[i] = 2.5;
    this.ground[i] = groundY;
  }
  update(dt: number): void {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i]! -= dt;
      const o = i * 3;
      this.v[o + 1]! -= 9.8 * dt;
      this.p[o]! += this.v[o]! * dt;
      this.p[o + 1]! += this.v[o + 1]! * dt;
      this.p[o + 2]! += this.v[o + 2]! * dt;
      if (this.p[o + 1]! < this.ground[i]! + 0.01) {
        this.p[o + 1] = this.ground[i]! + 0.01;
        this.v[o + 1] = -this.v[o + 1]! * 0.3;
        this.v[o]! *= 0.5;
        this.v[o + 2]! *= 0.5;
      }
      this.r[o]! += dt * 12;
      this.r[o + 2]! += dt * 9;
      this.e.set(this.r[o]!, this.r[o + 1]!, this.r[o + 2]!);
      this.q.setFromEuler(this.e);
      this.m.compose(this.t.set(this.p[o]!, this.p[o + 1]!, this.p[o + 2]!), this.q, this.life[i]! > 0 ? this.one : this.t.set(0, 0, 0));
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
