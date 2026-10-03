import * as THREE from 'three';

/** World-space markers: objective beacons, mission start rings, pickups. */
export class Markers {
  private beamGeo: THREE.CylinderGeometry;
  private ringGeo: THREE.RingGeometry;
  private boxGeo: THREE.BoxGeometry;
  private pool: { beam: THREE.Mesh; ring: THREE.Mesh; used: boolean; mat: THREE.MeshBasicMaterial; rmat: THREE.MeshBasicMaterial }[] = [];
  private pickups: { mesh: THREE.Mesh; x: number; y: number; z: number; tag: string; alive: boolean }[] = [];
  private pickupMat: THREE.MeshStandardMaterial;
  private t = 0;

  constructor(private scene: THREE.Scene) {
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 20, 1, true);
    this.beamGeo.translate(0, 0.5, 0);
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 32);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.boxGeo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
    this.pickupMat = new THREE.MeshStandardMaterial({ color: 0x7dffa1, emissive: 0x2a8a4a, emissiveIntensity: 1.2, roughness: 0.4 });
  }

  begin(): void {
    for (const p of this.pool) p.used = false;
  }

  /** Draw a beacon (call every frame between begin/end). */
  beacon(x: number, y: number, z: number, radius: number, color: number, height = 40): void {
    let p = this.pool.find((q) => !q.used);
    if (!p) {
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const rmat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
      p = { beam: new THREE.Mesh(this.beamGeo, mat), ring: new THREE.Mesh(this.ringGeo, rmat), used: false, mat, rmat };
      p.beam.renderOrder = 8;
      p.ring.renderOrder = 8;
      this.scene.add(p.beam, p.ring);
      this.pool.push(p);
    }
    p.used = true;
    p.mat.color.setHex(color);
    p.rmat.color.setHex(color);
    const pulse = 1 + Math.sin(this.t * 3) * 0.06;
    p.beam.position.set(x, y, z);
    p.beam.scale.set(radius * 0.18, height, radius * 0.18);
    p.ring.position.set(x, y + 0.08, z);
    p.ring.scale.set(radius * pulse, 1, radius * pulse);
    p.beam.visible = p.ring.visible = true;
  }

  end(dt: number): void {
    this.t += dt;
    for (const p of this.pool) if (!p.used) p.beam.visible = p.ring.visible = false;
    for (const pk of this.pickups) {
      if (!pk.alive) continue;
      pk.mesh.rotation.y += dt * 2;
      pk.mesh.position.y = pk.y + 0.8 + Math.sin(this.t * 3 + pk.x) * 0.15;
    }
  }

  addPickup(tag: string, x: number, y: number, z: number): void {
    const mesh = new THREE.Mesh(this.boxGeo, this.pickupMat);
    mesh.position.set(x, y + 0.8, z);
    this.scene.add(mesh);
    this.pickups.push({ mesh, x, y, z, tag, alive: true });
  }

  /** Collect pickups within reach; returns number collected this call. */
  collect(px: number, py: number, pz: number, reach: number, onCollect?: (tag: string) => void): number {
    let n = 0;
    for (const pk of this.pickups) {
      if (!pk.alive) continue;
      if (Math.hypot(pk.x - px, pk.z - pz) < reach && Math.abs(pk.y - py) < 3) {
        pk.alive = false;
        this.scene.remove(pk.mesh);
        n++;
        onCollect?.(pk.tag);
      }
    }
    return n;
  }

  remaining(tag: string): number {
    let n = 0;
    for (const pk of this.pickups) if (pk.alive && pk.tag === tag) n++;
    return n;
  }

  pickupPositions(tag?: string): { x: number; z: number }[] {
    return this.pickups.filter((p) => p.alive && (!tag || p.tag === tag)).map((p) => ({ x: p.x, z: p.z }));
  }

  clearPickups(tag?: string): void {
    for (const pk of this.pickups) {
      if (tag && pk.tag !== tag) continue;
      if (pk.alive) this.scene.remove(pk.mesh);
      pk.alive = false;
    }
    this.pickups = this.pickups.filter((p) => p.alive);
  }
}
