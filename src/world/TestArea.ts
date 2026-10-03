import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { litMaterial } from '../render/materials';
import { WATER_Y } from './constants';

/**
 * M1 sandbox: flat ground, ramps, steps, vaultable walls of several heights,
 * cover blocks, a swimming pool, and dynamic crates. Reached with `?test=1`.
 */
export class TestArea {
  readonly group = new THREE.Group();
  readonly sun: THREE.DirectionalLight;
  private crates: { body: RAPIER.RigidBody; mesh: THREE.Mesh }[] = [];

  constructor(scene: THREE.Scene, private physics: Physics, shadows: boolean) {
    scene.add(this.group);
    scene.background = new THREE.Color(0x9cc4e4);
    scene.fog = new THREE.Fog(0x9cc4e4, 80, 260);
    const hemi = new THREE.HemisphereLight(0xdfeeff, 0x6a5a48, 1.1);
    this.group.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff1dd, 2.4);
    this.sun.position.set(40, 80, 30);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(1024, 1024);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -40;
    sc.right = sc.top = 40;
    sc.far = 200;
    this.group.add(this.sun, this.sun.target);

    const ground = litMaterial('test-ground', { color: 0x7d8a6a, roughness: 0.95 });
    const concrete = litMaterial('test-concrete', { color: 0xb8b2a8, roughness: 0.9 });
    const brick = litMaterial('test-brick', { color: 0xa65a44, roughness: 0.9 });
    const water = new THREE.MeshStandardMaterial({ color: 0x2a7ab8, transparent: true, opacity: 0.72, roughness: 0.1, metalness: 0.1 });

    // ground split into 4 slabs around a pool hole at (20..36, -8..8)
    const slab = (x0: number, z0: number, x1: number, z1: number): void => {
      const w = x1 - x0, d = z1 - z0;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 1, d), ground);
      m.position.set((x0 + x1) / 2, -0.5, (z0 + z1) / 2);
      m.receiveShadow = true;
      this.group.add(m);
      physics.addStaticBox(m.position.x, -0.5, m.position.z, w / 2, 0.5, d / 2);
    };
    slab(-100, -100, 100, -8);
    slab(-100, 8, 100, 100);
    slab(-100, -8, 20, 8);
    slab(36, -8, 100, 8);
    // pool basin
    const floor = new THREE.Mesh(new THREE.BoxGeometry(16, 0.5, 16), concrete);
    floor.position.set(28, -3.25, 0);
    this.group.add(floor);
    physics.addStaticBox(28, -3.25, 0, 8, 0.25, 8);
    const poolWall = (x: number, z: number, hx: number, hz: number): void => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, 3, hz * 2), concrete);
      m.position.set(x, -1.5, z);
      this.group.add(m);
      physics.addStaticBox(x, -1.5, z, hx, 1.5, hz);
    };
    poolWall(19.75, 0, 0.25, 8);
    poolWall(36.25, 0, 0.25, 8);
    poolWall(28, -8.25, 8, 0.25);
    poolWall(28, 8.25, 8, 0.25);
    const wplane = new THREE.Mesh(new THREE.PlaneGeometry(16, 16), water);
    wplane.rotation.x = -Math.PI / 2;
    wplane.position.set(28, WATER_Y - 0.03, 0);
    this.group.add(wplane);
    // pool steps
    for (let i = 0; i < 4; i++) {
      const top = -0.45 - i * 0.65;
      this.box(20.3 + i * 0.6, 0, 6.5, 0.6, top + 3, 2.5, concrete, false, (top - 3) / 2);
    }

    // vaultable walls 0.6 / 1.0 / 1.4 / 2.4 (too high)
    const heights = [0.6, 1.0, 1.4, 2.4];
    heights.forEach((h, i) => this.box(-10 + i * 6, h / 2, -12, 4, h, 0.4, brick));
    // climbable crate stack
    this.box(-10, 0.6, -20, 3, 1.2, 3, concrete);
    this.box(-10, 1.8, -21, 3, 1.2, 1, concrete);
    // ramps
    this.ramp(8, 0, -24, 4, 12, 0.32, concrete);
    this.ramp(-24, 0, 4, 6, 18, 0.18, concrete);
    // stairs
    for (let i = 0; i < 10; i++) this.box(-30, 0.15 + i * 0.3, -6 - i * 0.45, 3, 0.3 * (i + 1), 0.45, concrete, false, (0.3 * (i + 1)) / 2);
    this.box(-30, 1.5, -12, 3, 3, 3, concrete);
    // cover blocks
    for (let i = 0; i < 5; i++) this.box(-16 + i * 7, 0.55, 14, 2.5, 1.1, 0.6, concrete);
    this.box(14, 1.4, 16, 0.6, 2.8, 4, brick);
    // tall building-ish block
    this.box(-44, 6, 22, 14, 12, 10, brick);

    // dynamic crates
    const crateMat = litMaterial('test-crate', { color: 0xc89a5a, roughness: 0.8 });
    for (let i = 0; i < 8; i++) {
      const x = 4 + (i % 4) * 1.2, z = 8 + Math.floor(i / 4) * 1.2;
      const body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 0.5 + Math.floor(i / 8), z));
      const col = physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5).setDensity(40).setCollisionGroups(GROUPS.prop), body);
      physics.setOwner(col, { kind: 'prop', ref: body });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), crateMat);
      mesh.castShadow = shadows;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.crates.push({ body, mesh });
    }
  }

  private box(x: number, y: number, z: number, w: number, h: number, d: number, mat: THREE.Material, cast = true, yOverride?: number): void {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    const cy = yOverride ?? y;
    m.position.set(x, cy, z);
    m.castShadow = cast;
    m.receiveShadow = true;
    this.group.add(m);
    this.physics.addStaticBox(x, cy, z, w / 2, h / 2, d / 2);
  }

  private ramp(x: number, y: number, z: number, w: number, len: number, angle: number, mat: THREE.Material): void {
    const t = 0.4;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, t, len), mat);
    const rise = Math.sin(angle) * len;
    m.position.set(x, y + rise / 2 - t / 2 + 0.05, z);
    m.rotation.x = -angle;
    m.receiveShadow = true;
    m.castShadow = true;
    this.group.add(m);
    const q = new THREE.Quaternion().setFromEuler(m.rotation);
    const col = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(w / 2, t / 2, len / 2).setTranslation(m.position.x, m.position.y, m.position.z).setRotation(q).setCollisionGroups(GROUPS.static),
    );
    this.physics.setOwner(col, { kind: 'static', ref: null });
  }

  update(focus: THREE.Vector3): void {
    for (const c of this.crates) {
      const p = c.body.translation();
      const r = c.body.rotation();
      c.mesh.position.set(p.x, p.y, p.z);
      c.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    this.sun.position.set(focus.x + 40, 80, focus.z + 30);
    this.sun.target.position.copy(focus);
  }
}
