import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { Vitals } from './Stats';
import { advancePhase, blendPose, computePose, makeAnimState, makePose, type AnimState, type Pose } from '../characters/Pose';
import type { CharacterRenderer, HeldItem } from '../characters/CharacterRenderer';
import { defaultPlayerAppearance, type Appearance } from '../characters/Appearance';
import { clamp, dampAngle, dampFactor, headingOf, lerp, angleDiff } from '../core/math';
import { WATER_Y } from '../world/constants';

export type PlayerMode = 'foot' | 'vault' | 'vehicle' | 'ragdoll' | 'scripted' | 'dead';

export interface MoveIntent {
  /** World-space desired direction (x,z), magnitude 0..1. */
  dx: number;
  dz: number;
  sprint: boolean;
  jump: boolean;
  crouch: boolean;
  /** When aiming the character faces this yaw and strafes. */
  faceYaw: number | null;
}

const HALF_H = 0.55;
const RADIUS = 0.3;
const CENTER_Y = HALF_H + RADIUS; // capsule center above feet
const WALK = 1.75;
const RUN = 4.6;
const SPRINT = 7.2;
const SWIM = 1.9;
const SWIM_FAST = 3.4;
const JUMP_V = 5.6;
const GRAV = 22;

const _dir = new THREE.Vector3();

export class Player {
  readonly vitals = new Vitals();
  mode: PlayerMode = 'foot';
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private kcc: RAPIER.KinematicCharacterController;
  /** Feet position (authoritative, physics step). */
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  /** Interpolated feet position for rendering. */
  readonly renderPos = new THREE.Vector3();
  yaw = 0;
  readonly vel = new THREE.Vector3();
  grounded = true;
  swimming = false;
  crouching = false;
  inCover = false;
  readonly coverNormal = new THREE.Vector3();
  coverLow = false;
  readonly anim: AnimState = makeAnimState();
  private targetPose: Pose = makePose();
  readonly pose: Pose = makePose();
  held: HeldItem = 'none';
  slot: number;
  appearance: Appearance;
  private vaultT = 0;
  private vaultDur = 0.6;
  private readonly vaultFrom = new THREE.Vector3();
  private readonly vaultTo = new THREE.Vector3();
  private vaultPeak = 0;
  private jumpBuffer = 0;
  private coyote = 0;
  private sinceLanded = 1;
  airTime = 0;
  /** Distance fallen (for fall damage). */
  private fallStartY = 0;
  /** Seconds left of an action animation (punch, reload …). */
  actionTimer = 0;
  actionDur = 0;
  onLanded: ((fallHeight: number) => void) | null = null;
  /** Sprinting this step (for noise/stamina UI). */
  sprinting = false;
  speedScale = 1;

  constructor(private physics: Physics, private chars: CharacterRenderer, x: number, y: number, z: number) {
    const world = physics.world;
    this.body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + CENTER_Y, z));
    this.collider = world.createCollider(
      RAPIER.ColliderDesc.capsule(HALF_H, RADIUS).setCollisionGroups(GROUPS.player).setFriction(0),
      this.body,
    );
    physics.setOwner(this.collider, { kind: 'player', ref: this });
    this.kcc = world.createCharacterController(0.03);
    this.kcc.setUp({ x: 0, y: 1, z: 0 });
    this.kcc.enableAutostep(0.45, 0.2, false);
    this.kcc.enableSnapToGround(0.35);
    this.kcc.setMaxSlopeClimbAngle((52 * Math.PI) / 180);
    this.kcc.setMinSlopeSlideAngle((60 * Math.PI) / 180);
    this.kcc.setSlideEnabled(true);
    this.kcc.setApplyImpulsesToDynamicBodies(true);
    this.kcc.setCharacterMass(80);
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.renderPos.copy(this.pos);
    this.appearance = defaultPlayerAppearance();
    this.slot = chars.alloc(this.appearance);
  }

  setAppearance(a: Appearance): void {
    this.appearance = a;
    this.chars.setAppearance(this.slot, a);
  }

  /** Instantly place the player (feet position). */
  teleport(x: number, y: number, z: number, yaw = this.yaw): void {
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.renderPos.copy(this.pos);
    this.yaw = yaw;
    this.vel.set(0, 0, 0);
    this.body.setTranslation({ x, y: y + CENTER_Y, z }, true);
    this.body.setNextKinematicTranslation({ x, y: y + CENTER_Y, z });
    this.fallStartY = y;
  }

  setCollisionEnabled(on: boolean): void {
    this.collider.setEnabled(on);
  }

  playAction(action: AnimState['action'], duration: number): void {
    this.anim.action = action;
    this.anim.actionT = 0;
    this.actionTimer = duration;
    this.actionDur = duration;
  }

  /** Fixed-step locomotion. */
  step(dt: number, intent: MoveIntent): void {
    this.prevPos.copy(this.pos);
    if (this.actionTimer > 0) {
      this.actionTimer -= dt;
      this.anim.actionT = 1 - Math.max(0, this.actionTimer) / this.actionDur;
      if (this.actionTimer <= 0) {
        this.anim.action = 'none';
        this.anim.actionT = 0;
      }
    }
    if (this.mode === 'vault') {
      this.stepVault(dt);
      return;
    }
    if (this.mode === 'scripted') return;
    if (this.mode !== 'foot') return;

    const mag = Math.min(1, Math.hypot(intent.dx, intent.dz));
    // ---- swimming detection ----
    const groundBelow = this.physics.groundY(this.pos.x, this.pos.z, this.pos.y + 1.5, GROUPS.rayWorld);
    const depth = WATER_Y - groundBelow;
    const wasSwimming = this.swimming;
    this.swimming = depth > 1.25 && this.pos.y < WATER_Y - 0.6;
    if (wasSwimming && depth > 1.05 && this.pos.y < WATER_Y - 0.3) this.swimming = true;

    let speed: number;
    if (this.swimming) {
      const fast = intent.sprint && mag > 0.5 && this.vitals.useStamina(12 * dt);
      speed = (fast ? SWIM_FAST : SWIM) * mag;
      this.sprinting = fast;
    } else {
      this.sprinting = intent.sprint && mag > 0.3 && !this.crouching && intent.faceYaw === null && this.vitals.stamina > 0;
      if (this.sprinting) this.vitals.useStamina(13 * dt);
      const base = this.crouching ? WALK * 0.9 : intent.faceYaw !== null ? RUN * 0.62 : mag < 0.55 ? lerp(0, WALK, mag / 0.55) : lerp(WALK, RUN, (mag - 0.55) / 0.45);
      speed = this.sprinting ? SPRINT : base;
    }
    speed *= this.speedScale;

    // desired horizontal velocity with acceleration
    const tx = mag > 0.01 ? (intent.dx / (mag || 1)) * speed : 0;
    const tz = mag > 0.01 ? (intent.dz / (mag || 1)) * speed : 0;
    const accel = this.grounded || this.swimming ? 14 : 3;
    const k = dampFactor(accel, dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.z += (tz - this.vel.z) * k;

    // facing
    if (intent.faceYaw !== null) this.yaw = dampAngle(this.yaw, intent.faceYaw, 18, dt);
    else if (this.inCover) this.yaw = dampAngle(this.yaw, headingOf(this.coverNormal.x, this.coverNormal.z), 12, dt);
    else if (mag > 0.05) this.yaw = dampAngle(this.yaw, headingOf(intent.dx, intent.dz), this.sprinting ? 9 : 12, dt);

    // vertical
    this.jumpBuffer = intent.jump ? 0.15 : Math.max(0, this.jumpBuffer - dt);
    if (this.swimming) {
      const targetY = WATER_Y - 1.32;
      this.vel.y = (targetY - this.pos.y) * 4;
      this.grounded = false;
      this.coyote = 0;
    } else {
      this.vel.y -= GRAV * dt;
      if (this.grounded) this.coyote = 0.12;
      else this.coyote -= dt;
      if (this.jumpBuffer > 0 && this.coyote > 0 && !this.crouching) {
        // try vault/climb first when pushing into an obstacle
        if (mag > 0.3 && this.tryVault()) return;
        this.vel.y = JUMP_V;
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.grounded = false;
        this.fallStartY = this.pos.y;
      }
    }

    const dx = this.vel.x * dt, dy = this.vel.y * dt, dz = this.vel.z * dt;
    this.kcc.computeColliderMovement(this.collider, { x: dx, y: dy, z: dz }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.kccPlayer);
    const mv = this.kcc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.swimming ? false : this.kcc.computedGrounded();
    // auto-vault when running into a low wall while sprinting
    if (this.grounded && this.sprinting && mag > 0.8) {
      const blocked = Math.hypot(mv.x, mv.z) < Math.hypot(dx, dz) * 0.3;
      if (blocked && this.tryVault()) return;
    }
    this.pos.x += mv.x;
    this.pos.y += mv.y;
    this.pos.z += mv.z;
    if (dt > 0) {
      // keep velocity consistent with collisions (prevents wall sticking build-up)
      this.vel.x = mv.x / dt;
      this.vel.z = mv.z / dt;
    }
    if (this.grounded && this.vel.y < 0) this.vel.y = -1;
    if (!wasGrounded && this.grounded) {
      const fall = this.fallStartY - this.pos.y;
      this.onLanded?.(fall);
      this.sinceLanded = 0;
      this.airTime = 0;
    }
    if (this.grounded || this.swimming) this.fallStartY = this.pos.y;
    else {
      this.airTime += dt;
      if (this.vel.y > 0) this.fallStartY = Math.max(this.fallStartY, this.pos.y);
    }
    this.sinceLanded += dt;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + CENTER_Y, z: this.pos.z });
    this.vitals.update(dt, this.swimming ? 6 : 22);
  }

  /** Probe for a low wall in front; start a vault/climb if suitable. */
  tryVault(): boolean {
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const p = this.physics;
    const feet = this.pos.y;
    const knee = p.raycast(this.pos.x, feet + 0.5, this.pos.z, fx, 0, fz, 1.1, GROUPS.rayWorldVehicles, this.body);
    if (!knee || Math.abs(knee.ny) > 0.5) return false;
    const head = p.raycast(this.pos.x, feet + 1.95, this.pos.z, fx, 0, fz, 1.4, GROUPS.rayWorldVehicles, this.body);
    if (head) return false;
    // find top surface just past the wall face
    const px = knee.x + fx * 0.25, pz = knee.z + fz * 0.25;
    const top = p.raycast(px, feet + 2.2, pz, 0, -1, 0, 2.2, GROUPS.rayWorldVehicles, this.body);
    if (!top) return false;
    const h = top.y - feet;
    if (h < 0.4 || h > 1.75) return false;
    // is there floor space on top (climb) or a drop behind (vault)?
    const fx2 = knee.x + fx * 0.9, fz2 = knee.z + fz * 0.9;
    const beyond = p.raycast(fx2, feet + 2.2, fz2, 0, -1, 0, 6, GROUPS.rayWorldVehicles, this.body);
    this.vaultFrom.copy(this.pos);
    if (beyond && Math.abs(beyond.y - top.y) < 0.25) {
      this.vaultTo.set(fx2, top.y, fz2); // climb onto
      this.vaultDur = 0.45 + h * 0.25;
    } else {
      const land = beyond ? beyond.y : feet;
      const lx = knee.x + fx * 1.1, lz = knee.z + fz * 1.1;
      this.vaultTo.set(lx, Math.max(land, feet - 3), lz);
      this.vaultDur = 0.55;
    }
    // make sure landing spot is free (capsule-sized ray up from landing)
    const blockedUp = p.raycast(this.vaultTo.x, this.vaultTo.y + 0.1, this.vaultTo.z, 0, 1, 0, 1.7, GROUPS.rayWorldVehicles, this.body);
    if (blockedUp) return false;
    this.vaultPeak = top.y + 0.35;
    this.vaultT = 0;
    this.mode = 'vault';
    this.playAction('vault', this.vaultDur);
    this.setCollisionEnabled(false);
    this.vel.set(0, 0, 0);
    return true;
  }

  private stepVault(dt: number): void {
    this.vaultT += dt / this.vaultDur;
    const t = Math.min(1, this.vaultT);
    const e = t * t * (3 - 2 * t);
    this.pos.lerpVectors(this.vaultFrom, this.vaultTo, e);
    // arc over the top
    const arcBase = lerp(this.vaultFrom.y, this.vaultTo.y, e);
    const up = Math.sin(Math.min(1, t * 1.25) * Math.PI) * Math.max(0, this.vaultPeak - Math.min(this.vaultFrom.y, this.vaultTo.y));
    this.pos.y = Math.max(arcBase, Math.min(this.vaultPeak, arcBase + up));
    if (t < 0.6) this.pos.y = Math.max(this.pos.y, lerp(this.vaultFrom.y, this.vaultPeak, t / 0.6));
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + CENTER_Y, z: this.pos.z });
    if (t >= 1) {
      this.mode = 'foot';
      this.setCollisionEnabled(true);
      this.grounded = true;
      this.fallStartY = this.pos.y;
    }
  }

  /** Try to take cover against a wall in front (or along `dirYaw`). */
  tryCover(dirYaw: number): boolean {
    if (this.inCover) {
      this.inCover = false;
      this.crouching = false;
      return true;
    }
    const fx = Math.sin(dirYaw), fz = Math.cos(dirYaw);
    const hit = this.physics.raycast(this.pos.x, this.pos.y + 0.8, this.pos.z, fx, 0, fz, 2.2, GROUPS.rayWorldVehicles, this.body);
    if (!hit || Math.abs(hit.ny) > 0.4) return false;
    this.coverNormal.set(hit.nx, 0, hit.nz).normalize();
    const tall = this.physics.raycast(this.pos.x, this.pos.y + 1.55, this.pos.z, fx, 0, fz, 2.6, GROUPS.rayWorldVehicles, this.body);
    this.coverLow = !tall;
    this.inCover = true;
    this.crouching = true;
    // slide to wall
    const tx = hit.x + this.coverNormal.x * (RADIUS + 0.12);
    const tz = hit.z + this.coverNormal.z * (RADIUS + 0.12);
    this.kcc.computeColliderMovement(this.collider, { x: tx - this.pos.x, y: -0.05, z: tz - this.pos.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, GROUPS.kccPlayer);
    const mv = this.kcc.computedMovement();
    this.pos.x += mv.x;
    this.pos.z += mv.z;
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + CENTER_Y, z: this.pos.z });
    return true;
  }

  /** Convert stick input to motion while in cover (slide along wall). Returns intent. */
  coverIntent(intent: MoveIntent): MoveIntent {
    if (!this.inCover) return intent;
    const nx = this.coverNormal.x, nz = this.coverNormal.z;
    // tangent
    const tx = -nz, tz = nx;
    const along = intent.dx * tx + intent.dz * tz;
    const away = intent.dx * nx + intent.dz * nz;
    if (away > 0.75) {
      this.inCover = false;
      this.crouching = false;
      return intent;
    }
    // keep pressed against the wall
    _dir.set(tx * along - nx * 0.15, 0, tz * along - nz * 0.15);
    return { ...intent, dx: _dir.x * 0.6, dz: _dir.z * 0.6, sprint: false };
  }

  /** Per-render-frame animation & visual update. */
  updateVisual(dt: number, alpha: number, aimPitch: number, aimStyle: AnimState['aim']): void {
    if (this.mode === 'vehicle' || this.mode === 'ragdoll' || this.mode === 'dead') return;
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha);
    const a = this.anim;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    a.speed = this.mode === 'vault' ? 2 : hs;
    a.grounded = this.grounded || this.mode === 'vault';
    a.vy = this.vel.y;
    a.swimming = this.swimming;
    const crouchTarget = this.crouching ? (this.inCover && aimStyle !== 'none' && this.coverLow ? 0.2 : this.inCover && aimStyle !== 'none' ? 0 : 1) : 0;
    a.crouch += (crouchTarget - a.crouch) * dampFactor(10, dt);
    a.aim = this.swimming ? 'none' : aimStyle;
    a.aimPitch = clamp(aimPitch, -1.1, 1.1);
    const turn = angleDiff(this.lastYaw, this.yaw) / Math.max(dt, 1e-4);
    this.lastYaw = this.yaw;
    a.lean = clamp(-turn * 0.03 * Math.min(1, hs / 5), -0.25, 0.25);
    // direction of travel relative to facing (strafing / backpedalling while aiming)
    // (only while aiming: otherwise the body turns toward the stick and the lag is just a turn)
    a.moveYaw = hs > 0.3 && aimStyle !== 'none' ? angleDiff(this.yaw, Math.atan2(this.vel.x, this.vel.z)) : 0;
    advancePhase(a, dt);
    computePose(this.targetPose, a);
    blendPose(this.pose, this.targetPose, dampFactor(a.action !== 'none' ? 30 : 16, dt));
    const swimBob = this.swimming ? Math.sin(a.time * 2.2) * 0.04 : 0;
    this.chars.update(this.slot, this.renderPos.x, this.renderPos.y + swimBob, this.renderPos.z, this.yaw, this.pose, this.swimming ? 'none' : this.held, a);
  }
  private lastYaw = 0;

  /** Chest-height world position (aim origin, cops' LOS target). */
  get chestY(): number {
    return this.pos.y + 1.35;
  }

  dispose(): void {
    this.chars.free(this.slot);
    this.physics.removeBody(this.body);
    this.physics.world.removeCharacterController(this.kcc);
  }
}
