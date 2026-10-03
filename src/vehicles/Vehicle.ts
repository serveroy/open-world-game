import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import type { VehicleDef } from './VehicleData';
import { vehicleMesh, type VehicleMeshInfo } from './VehicleMeshes';
import { makeVehicleMaterial, type VehicleMatUniforms } from './VehicleMaterial';
import { VehicleHealth, engineRpm, torqueCurve } from './Damage';
import { clamp, moveToward } from '../core/math';
import { WATER_Y } from '../world/constants';
import { waveHeight } from '../render/Water';

export type VehicleRole = 'traffic' | 'parked' | 'police' | 'mission' | 'player' | 'emergency' | 'static';

export interface Occupant {
  kind: 'player' | 'ped';
  ref: unknown;
}

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _m = new THREE.Matrix4();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
let nextId = 1;

/**
 * A drivable vehicle (car, bike, boat or helicopter) — physics, controls, damage state and
 * visual sync. Wheels/flares/particles are drawn by VehicleManager in shared batches.
 */
export class Vehicle {
  readonly id = nextId++;
  readonly info: VehicleMeshInfo;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController | null = null;
  readonly mesh: THREE.Mesh;
  readonly u: VehicleMatUniforms;
  rotor: THREE.Mesh | null = null;
  tailRotor: THREE.Mesh | null = null;
  readonly health: VehicleHealth;
  private basePos: Float32Array;
  private dentTotal = 0;
  // controls
  throttle = 0; // 0..1
  brake = 0; // 0..1 (also reverse when slow)
  steer = 0; // -1 left .. 1 right
  handbrake = false;
  /** Heli collective (-1..1) / pitch input (moveY) */
  lift = 0;
  pitchIn = 0;
  // state
  role: VehicleRole = 'traffic';
  driver: Occupant | null = null;
  passengers: Occupant[] = [];
  locked = false;
  alarm = 0;
  hot = false;
  engineOn = false;
  lights = false;
  siren = false;
  sirenT = 0;
  indicator: -1 | 0 | 1 = 0;
  horn = false;
  hornT = 0;
  speed = 0;
  rpm = 850;
  gear = 1;
  steerAngle = 0;
  readonly tirePopped = [false, false, false, false];
  readonly wheelSlip = [0, 0, 0, 0];
  readonly wheelContact = [false, false, false, false];
  readonly wheelPos: THREE.Vector3[] = [];
  readonly lastSkid: (THREE.Vector3 | null)[] = [null, null, null, null];
  flippedTime = 0;
  airborne = false;
  rotorSpeed = 0;
  inWater = false;
  submerged = 0;
  paint: number;
  /** Interpolation */
  readonly prevPos = new THREE.Vector3();
  readonly curPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly curQuat = new THREE.Quaternion();
  readonly renderPos = new THREE.Vector3();
  readonly renderQuat = new THREE.Quaternion();
  /** AI attachment (traffic / police / mission) */
  ai: unknown = null;
  /** Mission tags */
  tag: string | null = null;
  /** Time since last touched by player (for despawn) */
  idleTime = 0;
  /** Persistent (owned / mission) vehicles never auto-despawn */
  persistent = false;
  /** mod shop upgrades */
  mods = { engine: 0, brakes: 0, armor: 0, turbo: false, wheels: 0 };
  /** Lap/race data etc. */
  meta: Record<string, unknown> = {};
  sinking = 0;

  constructor(readonly def: VehicleDef, private physics: Physics, scene: THREE.Scene, x: number, y: number, z: number, yaw: number, paint: number, low: boolean, castShadow: boolean) {
    this.info = vehicleMesh(def);
    this.paint = paint;
    this.health = new VehicleHealth(def.health, !!def.armored);
    const m = makeVehicleMaterial(low);
    this.u = m.u;
    this.u.uPaint.value.setHex(paint);
    const geo = this.info.body.clone();
    this.basePos = (geo.attributes.position!.array as Float32Array).slice();
    this.mesh = new THREE.Mesh(geo, m.mat);
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    scene.add(this.mesh);
    if (this.info.rotor) {
      this.rotor = new THREE.Mesh(this.info.rotor, m.mat);
      this.tailRotor = new THREE.Mesh(this.info.tailRotor!, m.mat);
      this.rotor.matrixAutoUpdate = false;
      this.tailRotor.matrixAutoUpdate = false;
      scene.add(this.rotor, this.tailRotor);
    }
    const world = physics.world;
    _q.setFromAxisAngle(WORLD_UP, yaw);
    const bd = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w })
      .setLinearDamping(def.kind === 'heli' ? 0.4 : def.kind === 'boat' ? 0.15 : 0.04)
      .setAngularDamping(def.kind === 'heli' ? 2.5 : def.kind === 'boat' ? 1.2 : 0.4)
      .setCanSleep(true);
    this.body = world.createRigidBody(bd);
    const [hx, hy, hz] = this.info.half;
    const [cx, cy, cz] = this.info.center;
    const mass = def.mass;
    const ix = (mass / 12) * (4 * hy * hy + 4 * hz * hz) * 1.3;
    const iy = (mass / 12) * (4 * hx * hx + 4 * hz * hz) * 1.3;
    const iz = (mass / 12) * (4 * hx * hx + 4 * hy * hy) * 1.3;
    const comY = def.kind === 'car' ? Math.max(0.25, cy - hy * 0.55) : def.kind === 'bike' ? def.wheelRadius + 0.25 : cy;
    const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(cx, cy, cz)
      .setCollisionGroups(GROUPS.vehicle)
      .setFriction(def.kind === 'boat' ? 0.3 : 0.45)
      .setRestitution(0.1)
      .setMassProperties(mass, { x: 0, y: comY, z: 0 }, { x: ix, y: iy, z: iz }, { x: 0, y: 0, z: 0, w: 1 })
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(mass * 25);
    this.collider = world.createCollider(cd, this.body);
    physics.setOwner(this.collider, { kind: 'vehicle', ref: this });

    if (def.kind === 'car' || def.kind === 'bike') {
      const ctrl = world.createVehicleController(this.body);
      ctrl.setIndexForwardAxis = 2;
      ctrl.indexUpAxis = 1;
      const susp = def.suspension;
      for (const [wx, wy, wz] of this.info.physWheels) {
        ctrl.addWheel({ x: wx, y: wy + susp * 0.6, z: wz }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, susp, def.wheelRadius);
      }
      for (let i = 0; i < this.info.physWheels.length; i++) {
        ctrl.setWheelSuspensionStiffness(i, def.stiffness);
        ctrl.setWheelSuspensionCompression(i, def.stiffness * 0.09);
        ctrl.setWheelSuspensionRelaxation(i, def.stiffness * 0.12);
        ctrl.setWheelMaxSuspensionTravel(i, susp * 1.6);
        ctrl.setWheelMaxSuspensionForce(i, mass * 60);
        ctrl.setWheelFrictionSlip(i, def.grip);
        ctrl.setWheelSideFrictionStiffness(i, 1.0);
        this.wheelPos.push(new THREE.Vector3());
      }
      this.ctrl = ctrl;
    }
    this.captureTransform(true);
  }

  get kind(): VehicleDef['kind'] {
    return this.def.kind;
  }
  get destroyed(): boolean {
    return this.health.state === 'wrecked';
  }
  get position(): THREE.Vector3 {
    return this.curPos;
  }
  get yaw(): number {
    _fwd.set(0, 0, 1).applyQuaternion(this.curQuat);
    return Math.atan2(_fwd.x, _fwd.z);
  }
  get upY(): number {
    return _up.set(0, 1, 0).applyQuaternion(this.curQuat).y;
  }
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, 1).applyQuaternion(this.curQuat);
  }
  /** Local → world point. */
  toWorld(local: [number, number, number] | THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    if (Array.isArray(local)) out.set(local[0], local[1], local[2]);
    else out.copy(local);
    return out.applyQuaternion(this.curQuat).add(this.curPos);
  }
  velocity(out: THREE.Vector3): THREE.Vector3 {
    const v = this.body.linvel();
    return out.set(v.x, v.y, v.z);
  }

  setPaint(hex: number): void {
    this.paint = hex;
    this.u.uPaint.value.setHex(hex);
  }

  teleport(x: number, y: number, z: number, yaw: number): void {
    _q.setFromAxisAngle(WORLD_UP, yaw);
    this.body.setTranslation({ x, y, z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.captureTransform(true);
  }

  /** Apply controls & forces; call before physics step. */
  fixedUpdate(dt: number): void {
    const d = this.def;
    // Rapier keeps user forces between steps — clear them, we re-apply every step
    this.body.resetForces(false);
    this.body.resetTorques(false);
    this.health.update(dt);
    const dead = this.destroyed || this.health.state === 'burning';
    const occupied = this.driver !== null;
    if (occupied && !dead) this.engineOn = true;
    if (dead) this.engineOn = false;
    if (this.hornT > 0) this.hornT -= dt;
    if (this.siren) this.sirenT += dt;
    if (this.alarm > 0) this.alarm -= dt;
    if (!occupied) {
      this.throttle = 0;
      this.steer *= 0.9;
      this.brake = this.role === 'parked' || this.role === 'static' ? 1 : 0.3;
      this.handbrake = this.role === 'parked';
    }
    if (d.kind === 'boat') this.stepBoat(dt);
    else if (d.kind === 'heli') this.stepHeli(dt);
    else this.stepGround(dt);
    // water damage / sinking for land vehicles
    const p = this.body.translation();
    const water = WATER_Y - p.y;
    if (d.kind !== 'boat' && d.kind !== 'heli') {
      this.inWater = water > 0.4;
      if (water > 0.6) {
        this.engineOn = false;
        this.submerged += dt;
        const lv = this.body.linvel();
        this.body.setLinearDamping(2.5);
        // weak buoyancy so cars sink slowly
        this.body.addForce({ x: -lv.x * d.mass * 0.4, y: d.mass * 9.81 * 0.55, z: -lv.z * d.mass * 0.4 }, true);
      } else this.body.setLinearDamping(0.04);
    }
  }

  private stepGround(dt: number): void {
    const ctrl = this.ctrl!;
    const d = this.def;
    const n = this.info.physWheels.length;
    const sp = ctrl.currentVehicleSpeed();
    this.speed = sp;
    const engine = this.engineOn && !this.inWater;
    const eng = d.engineForce * (1 + this.mods.engine * 0.12) * (this.mods.turbo ? 1.15 : 1);
    const maxSp = d.maxSpeed * (1 + this.mods.engine * 0.04);
    let force = 0;
    let brake = 0;
    if (engine) {
      if (this.throttle > 0.01) {
        if (sp < -1) brake = d.brakeForce * this.throttle;
        else force = eng * this.throttle * torqueCurve(sp, maxSp);
      }
      if (this.brake > 0.01) {
        if (sp > 1) brake = Math.max(brake, d.brakeForce * 1.45 * (1 + this.mods.brakes * 0.15) * this.brake);
        else if (sp > -10) force = -eng * 0.55 * this.brake;
      }
    } else if (this.brake > 0) brake = d.brakeForce * this.brake * 0.6;
    if (!engine && this.throttle === 0 && Math.abs(sp) > 0.1) brake = Math.max(brake, d.brakeForce * 0.03);
    // rolling resistance when coasting
    if (engine && this.throttle < 0.01 && this.brake < 0.01) brake = Math.max(brake, d.brakeForce * 0.025);
    const drivenFront = d.drive !== 'rwd';
    const drivenRear = d.drive !== 'fwd';
    const nDriven = n === 4 ? (drivenFront && drivenRear ? 4 : 2) : 2;
    // steering eases off at speed
    const steerLimit = d.steer / (1 + Math.abs(sp) * (d.kind === 'bike' ? 0.025 : 0.035));
    const target = -this.steer * steerLimit;
    this.steerAngle = moveToward(this.steerAngle, target, dt * (d.kind === 'bike' ? 2.2 : 3.2));
    for (let i = 0; i < n; i++) {
      const front = i < 2;
      const driven = front ? drivenFront : drivenRear;
      ctrl.setWheelEngineForce(i, driven ? force / nDriven : 0);
      ctrl.setWheelSteering(i, front ? this.steerAngle : 0);
      let b = brake;
      let grip = d.grip * (1 + this.mods.wheels * 0.05) * (this.tirePopped[i] ? 0.45 : 1);
      if (this.handbrake && !front) {
        b = Math.max(b, d.brakeForce * 1.6);
        grip *= 0.42;
      }
      ctrl.setWheelBrake(i, b);
      ctrl.setWheelFrictionSlip(i, grip);
    }
    ctrl.updateVehicle(dt, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.wheels, (c) => c.parent() !== this.body);
    // engine state
    const r = engineRpm(sp, maxSp, d.gears, this.throttle);
    this.rpm += (r.rpm - this.rpm) * Math.min(1, dt * 8);
    this.gear = r.gear;

    // contacts / slip / air
    let contacts = 0;
    for (let i = 0; i < n; i++) {
      const c = ctrl.wheelIsInContact(i);
      this.wheelContact[i] = c;
      if (c) contacts++;
      const side = Math.abs(ctrl.wheelSideImpulse(i) ?? 0);
      const fwdI = Math.abs(ctrl.wheelForwardImpulse(i) ?? 0);
      // slip proxy: lateral impulse relative to suspension load + handbrake/burnout
      const load = Math.max(1, ctrl.wheelSuspensionForce(i) ?? 1) * dt;
      let slip = c ? side / load : 0;
      if (c && this.handbrake && i >= 2 && Math.abs(sp) > 4) slip += 0.8;
      if (c && this.throttle > 0.8 && Math.abs(sp) < 6 && d.engineForce / d.mass > 4) slip += 0.9;
      if (c && brake > d.brakeForce * 0.6 && Math.abs(sp) > 10) slip += 0.6;
      void fwdI;
      this.wheelSlip[i] = slip;
    }
    this.airborne = contacts === 0;
    const bodyRot = this.body.rotation();
    _q.set(bodyRot.x, bodyRot.y, bodyRot.z, bodyRot.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    const av = this.body.angvel();
    const mass = d.mass;
    if (d.kind === 'bike') {
      // keep upright with a lean proportional to steering × speed
      const lean = clamp(-this.steerAngle * Math.min(1, Math.abs(sp) / 12) * 1.6, -0.75, 0.75);
      _q2.setFromAxisAngle(_fwd, lean);
      _v.copy(WORLD_UP).applyQuaternion(_q2);
      _v2.crossVectors(_up, _v);
      const k = contacts > 0 ? 24 : 6;
      const rollRate = av.x * _fwd.x + av.y * _fwd.y + av.z * _fwd.z;
      const damp = 5;
      this.body.applyTorqueImpulse({
        x: (_v2.x * k - _fwd.x * rollRate * damp) * mass * dt,
        y: (_v2.y * k - _fwd.y * rollRate * damp) * mass * dt,
        z: (_v2.z * k - _fwd.z * rollRate * damp) * mass * dt,
      }, true);
    } else if (contacts >= 2) {
      // anti-roll: resist roll about the forward axis
      _v2.crossVectors(_up, WORLD_UP);
      const rollAmt = _v2.dot(_fwd);
      const k = 3.5 * mass;
      this.body.applyTorqueImpulse({ x: _fwd.x * rollAmt * k * dt, y: _fwd.y * rollAmt * k * dt, z: _fwd.z * rollAmt * k * dt }, true);
    }
    // downforce
    const v2 = sp * sp;
    if (contacts > 0) this.body.addForce({ x: -_up.x * v2 * mass * 0.006, y: -_up.y * v2 * mass * 0.006, z: -_up.z * v2 * mass * 0.006 }, true);
    else if (this.driver) {
      // light air control
      _right.crossVectors(WORLD_UP, _fwd).normalize();
      this.body.applyTorqueImpulse({ x: _right.x * -this.throttle * mass * 0.5 * dt + _fwd.x * this.steer * mass * 0.4 * dt, y: 0, z: _right.z * -this.throttle * mass * 0.5 * dt + _fwd.z * this.steer * mass * 0.4 * dt }, true);
    }
    // flip recovery
    if (_up.y < 0.25 && Math.abs(sp) < 2) {
      this.flippedTime += dt;
      if (this.flippedTime > (this.driver ? 2.5 : 6)) this.unflip();
    } else this.flippedTime = 0;
  }

  unflip(): void {
    const p = this.body.translation();
    const y = this.yaw;
    _q.setFromAxisAngle(WORLD_UP, y);
    this.body.setTranslation({ x: p.x, y: p.y + 1.2, z: p.z }, true);
    this.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.flippedTime = 0;
  }

  private stepBoat(dt: number): void {
    const d = this.def;
    const L = d.length, W = d.width;
    const t = performance.now() / 1000;
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    const p = this.body.translation();
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const pts: [number, number][] = [[W * 0.42, L * 0.38], [-W * 0.42, L * 0.38], [W * 0.45, -L * 0.42], [-W * 0.45, -L * 0.42], [0, 0]];
    let wet = 0;
    const per = (d.mass * 9.81) / pts.length;
    for (const [lx, lz] of pts) {
      _v.set(lx, 0.05, lz).applyQuaternion(_q).add(_v2.set(p.x, p.y, p.z));
      const wh = WATER_Y + waveHeight(_v.x, _v.z, t);
      const depth = wh - _v.y;
      if (depth > 0) {
        wet++;
        const pv = this.body.velocityAtPoint({ x: _v.x, y: _v.y, z: _v.z });
        const f = per * Math.min(depth / 0.35, 2.6) - pv.y * per * 0.35;
        this.body.addForceAtPoint({ x: 0, y: f, z: 0 }, { x: _v.x, y: _v.y, z: _v.z }, true);
      }
    }
    this.inWater = wet > 0;
    const lv = this.body.linvel();
    const vf = lv.x * _fwd.x + lv.y * _fwd.y + lv.z * _fwd.z;
    const vr = lv.x * _right.x + lv.z * _right.z;
    this.speed = vf;
    if (wet > 0) {
      const eng = this.engineOn ? d.engineForce * (1 + this.mods.engine * 0.12) : 0;
      let thrust = 0;
      if (this.throttle > 0) thrust = eng * this.throttle * torqueCurve(vf, d.maxSpeed);
      else if (this.brake > 0) thrust = -eng * 0.4 * this.brake * (vf > -6 ? 1 : 0);
      // thrust along hull-forward projected on the horizontal plane
      const fx = _fwd.x, fz = _fwd.z;
      this.body.addForce({ x: fx * thrust, y: 0, z: fz * thrust }, true);
      // hydrodynamic drag: strong lateral, quadratic forward
      const lat = -vr * d.mass * 1.6;
      const fdrag = -vf * Math.abs(vf) * d.mass * 0.012;
      this.body.addForce({ x: _right.x * lat + fx * fdrag, y: 0, z: _right.z * lat + fz * fdrag }, true);
      // rudder yaw torque
      const yawT = -this.steer * d.steer * d.mass * (1.5 + Math.abs(vf) * 0.55) * (vf < -0.5 ? -1 : 1);
      this.body.applyTorqueImpulse({ x: 0, y: yawT * dt, z: 0 }, true);
      // planing: lift the bow at speed
      const lift = Math.min(1, Math.abs(vf) / d.maxSpeed) * d.mass * 1.2;
      this.body.addForceAtPoint({ x: 0, y: lift, z: 0 }, { x: p.x + _fwd.x * L * 0.3, y: p.y, z: p.z + _fwd.z * L * 0.3 }, true);
      // self-right
      _v2.crossVectors(_up, WORLD_UP);
      this.body.applyTorqueImpulse({ x: _v2.x * d.mass * 6 * dt, y: 0, z: _v2.z * d.mass * 6 * dt }, true);
    }
    this.rpm += ((this.engineOn ? 900 + this.throttle * 4500 + Math.abs(vf) * 80 : 0) - this.rpm) * Math.min(1, dt * 5);
  }

  private stepHeli(dt: number): void {
    const d = this.def;
    const mass = d.mass;
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w);
    _up.set(0, 1, 0).applyQuaternion(_q);
    _fwd.set(0, 0, 1).applyQuaternion(_q);
    _right.set(1, 0, 0).applyQuaternion(_q);
    const on = this.engineOn;
    this.rotorSpeed = moveToward(this.rotorSpeed, on ? 1 : 0, dt * (on ? 0.6 : 0.15));
    const power = this.rotorSpeed * this.rotorSpeed;
    const lv = this.body.linvel();
    this.speed = Math.hypot(lv.x, lv.z);
    // collective: hover + input; damping on vertical velocity for stable hover
    const collective = this.lift;
    const liftF = mass * 9.81 * power * (1 + collective * 0.75) - lv.y * mass * 0.9 * power;
    // lift along rotor axis, normalised so tilting trades lift for thrust without dropping
    const ups = Math.max(0.5, _up.y);
    this.body.addForce({ x: (_up.x * liftF) / ups, y: liftF, z: (_up.z * liftF) / ups }, true);
    // attitude PD: pitch from pitchIn (forward = nose down), roll from steer
    const targetPitch = this.pitchIn * 0.42 * power;
    const targetRoll = this.steer * 0.32 * power;
    // current pitch: angle of forward below horizon; roll: right vector vertical component
    const pitch = Math.asin(clamp(-_fwd.y, -1, 1));
    const roll = Math.asin(clamp(-_right.y, -1, 1));
    const av = this.body.angvel();
    const kP = 5.5 * mass, kD = 2.2 * mass;
    const rateR = av.x * _right.x + av.y * _right.y + av.z * _right.z;
    const rateF = av.x * _fwd.x + av.y * _fwd.y + av.z * _fwd.z;
    const tp = (targetPitch - pitch) * kP - rateR * kD;
    const tr = (targetRoll - roll) * kP - rateF * kD;
    // yaw from steer (turning)
    const yawRate = av.y;
    const ty = (-this.steer * 1.4 * power - yawRate) * mass * 1.6;
    this.body.applyTorqueImpulse({
      x: (_right.x * tp - _fwd.x * tr) * dt,
      y: (_right.y * tp - _fwd.y * tr + ty) * dt,
      z: (_right.z * tp - _fwd.z * tr) * dt,
    }, true);
    // air drag
    this.body.addForce({ x: -lv.x * mass * 0.12, y: 0, z: -lv.z * mass * 0.12 }, true);
    this.rpm = this.rotorSpeed * 6000;
  }

  /** Called after the physics step: cache transforms for interpolation. */
  captureTransform(snap = false): void {
    const p = this.body.translation();
    const r = this.body.rotation();
    if (snap) {
      this.prevPos.set(p.x, p.y, p.z);
      this.prevQuat.set(r.x, r.y, r.z, r.w);
    } else {
      this.prevPos.copy(this.curPos);
      this.prevQuat.copy(this.curQuat);
    }
    this.curPos.set(p.x, p.y, p.z);
    this.curQuat.set(r.x, r.y, r.z, r.w);
    if (snap) {
      this.renderPos.copy(this.curPos);
      this.renderQuat.copy(this.curQuat);
    }
  }

  /** Per-frame visuals. */
  updateVisual(dt: number, alpha: number, night: number): void {
    this.renderPos.lerpVectors(this.prevPos, this.curPos, alpha);
    this.renderQuat.slerpQuaternions(this.prevQuat, this.curQuat, alpha);
    this.mesh.matrix.compose(this.renderPos, this.renderQuat, _v.set(1, 1, 1));
    this.mesh.matrixWorldNeedsUpdate = true;
    if (this.rotor && this.tailRotor && this.info.rotorPos) {
      const spin = (performance.now() / 1000) * 28 * this.rotorSpeed;
      _q.setFromAxisAngle(WORLD_UP, spin);
      _q2.copy(this.renderQuat).multiply(_q);
      _v.set(...this.info.rotorPos).applyQuaternion(this.renderQuat).add(this.renderPos);
      this.rotor.matrix.compose(_v, _q2, _v2.set(1, 1, 1));
      this.rotor.matrixWorldNeedsUpdate = true;
      _q.setFromAxisAngle(_v2.set(1, 0, 0), spin * 1.7);
      _q2.copy(this.renderQuat).multiply(_q);
      _v.set(...this.info.tailRotorPos!).applyQuaternion(this.renderQuat).add(this.renderPos);
      this.tailRotor.matrix.compose(_v, _q2, _v2.set(1, 1, 1));
      this.tailRotor.matrixWorldNeedsUpdate = true;
    }
    const dead = this.destroyed;
    const blink = Math.floor(performance.now() / 380) % 2;
    this.u.uLights.value.set(
      this.lights && !dead ? 1 : 0,
      !dead && this.engineOn && (this.brake > 0.1 && this.speed > 0.5) ? 1 : 0,
      !dead && this.engineOn && this.brake > 0.1 && this.speed < -0.2 ? 1 : 0,
      this.siren && !dead ? 1 : 0,
    );
    const hazard = this.alarm > 0 || (this.role === 'traffic' && this.health.state === 'smoking');
    this.u.uInd.value.set(
      !dead && (this.indicator === -1 || hazard) && blink ? 1 : 0,
      !dead && (this.indicator === 1 || hazard) && blink ? 1 : 0,
      Math.floor(this.sirenT * 5) % 2,
      this.def.cls === 'taxi' || this.def.cls === 'bus' ? (this.driver ? 1 : 0.3) : 0,
    );
    this.u.uGlass.value = this.u.uGlass.value > 0.5 || dead ? 1 : 0;
    this.u.uDamage.value = dead ? 1 : Math.min(0.6, this.dentTotal * 0.08);
    this.u.uNight.value = night;
    void dt;
  }

  /** Deform the body mesh around an impact direction (local). */
  dent(localDir: THREE.Vector3, severity: number): void {
    if (severity <= 0.02 || this.dentTotal > 8) return;
    const pos = this.mesh.geometry.attributes.position!;
    const arr = pos.array as Float32Array;
    const [cx, cy, cz] = this.info.center;
    const [hx, hy, hz] = this.info.half;
    const dir = _v.copy(localDir).normalize();
    const amt = Math.min(0.35, severity * 0.25);
    for (let i = 0; i < pos.count; i++) {
      const x = arr[i * 3]!, y = arr[i * 3 + 1]!, z = arr[i * 3 + 2]!;
      // normalised position inside the bounding box
      _v2.set((x - cx) / hx, (y - cy) / hy, (z - cz) / hz);
      const l = _v2.length();
      if (l < 0.5) continue;
      const dot = _v2.dot(dir) / l;
      if (dot < 0.72) continue;
      const k = ((dot - 0.72) / 0.28) * amt;
      arr[i * 3] = x - dir.x * k * hx * 0.25;
      arr[i * 3 + 1] = y - dir.y * k * hy * 0.12;
      arr[i * 3 + 2] = z - dir.z * k * hz * 0.18;
    }
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.dentTotal += amt * 3;
    if (severity > 0.6) this.u.uGlass.value = 1;
  }

  resetDamage(): void {
    const pos = this.mesh.geometry.attributes.position!;
    (pos.array as Float32Array).set(this.basePos);
    pos.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.dentTotal = 0;
    this.u.uGlass.value = 0;
    this.health.repair();
    this.tirePopped.fill(false);
    if (this.ctrl) for (let i = 0; i < this.info.physWheels.length; i++) this.ctrl.setWheelRadius(i, this.def.wheelRadius);
  }

  popTire(i: number): void {
    if (!this.ctrl || this.tirePopped[i] || i >= this.info.physWheels.length) return;
    this.tirePopped[i] = true;
    this.ctrl.setWheelRadius(i, this.def.wheelRadius * 0.72);
  }

  /** Wheel visual transforms (call after updateVisual). */
  wheelMatrix(i: number, out: THREE.Matrix4): THREE.Matrix4 {
    const ctrl = this.ctrl!;
    const w = this.info.wheels[i]!;
    const physI = this.def.kind === 'bike' ? (i === 0 ? 0 : 2) : i;
    const susp = ctrl.wheelSuspensionLength(physI) ?? this.def.suspension;
    const conn = this.info.physWheels[physI]!;
    const rot = ctrl.wheelRotation(physI) ?? 0;
    const steerA = i < (this.def.kind === 'bike' ? 1 : 2) ? this.steerAngle : 0;
    const popped = this.tirePopped[physI] ? 0.72 : 1;
    const r = this.def.wheelRadius;
    _v.set(w[0], conn[1] + this.def.suspension * 0.6 - susp, w[2]);
    _q.setFromAxisAngle(WORLD_UP, steerA);
    _q2.setFromAxisAngle(_v2.set(1, 0, 0), rot);
    _q.multiply(_q2);
    _m.compose(_v, _q, _v2.set(this.def.wheelWidth, r * popped, r));
    out.compose(this.renderPos, this.renderQuat, _v2.set(1, 1, 1)).multiply(_m);
    // ground contact point for skid marks
    this.wheelPos[i]?.set(w[0], _v.y - r * popped, w[2]).applyQuaternion(this.renderQuat).add(this.renderPos);
    return out;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    if (this.rotor) scene.remove(this.rotor);
    if (this.tailRotor) scene.remove(this.tailRotor);
    if (this.ctrl) this.physics.world.removeVehicleController(this.ctrl);
    this.physics.removeBody(this.body);
  }
}
