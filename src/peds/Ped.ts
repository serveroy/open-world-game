import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { makeAnimState, makePose, type AnimState, type Pose } from '../characters/Pose';
import type { Appearance } from '../characters/Appearance';
import type { HeldItem } from '../characters/CharacterRenderer';
import type { Vehicle } from '../vehicles/Vehicle';

export type PedState =
  | 'walk' | 'idle' | 'chat' | 'sit' | 'dance' | 'wander' | 'cross'
  | 'flee' | 'cower' | 'fight' | 'call' | 'hide' | 'chase' | 'dodge'
  | 'down' | 'dead' | 'driving' | 'pulled' | 'scripted' | 'enterCar' | 'ragdoll' | 'handsup';

export type PedArchetype = 'normal' | 'brave' | 'snitch' | 'gang' | 'cop' | 'swat' | 'medic' | 'story';

let nextPedId = 1;

/** Pedestrian entity (AI state lives in PedManager). */
export class Ped {
  readonly id = nextPedId++;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  readonly pos = new THREE.Vector3();
  readonly prevPos = new THREE.Vector3();
  readonly renderPos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  state: PedState = 'walk';
  stateT = 0;
  archetype: PedArchetype = 'normal';
  health = 100;
  maxHealth = 100;
  armor = 0;
  slot: number;
  appearance: Appearance;
  readonly anim: AnimState = makeAnimState();
  readonly pose: Pose = makePose();
  readonly targetPose: Pose = makePose();
  held: HeldItem = 'none';
  /** Path following on a block perimeter */
  block = -1;
  pathS = 0;
  pathDir: 1 | -1 = 1;
  readonly target = new THREE.Vector3();
  readonly threat = new THREE.Vector3();
  partner: Ped | null = null;
  vehicle: Vehicle | null = null;
  /** Vehicle this ped rides in as a passenger (taxi fare, escort); excluded from vehicle hits. */
  riding: Vehicle | null = null;
  groundY = 0;
  groundTimer = 0;
  wallTimer = 0;
  /** Action animation timer */
  actionT = 0;
  actionDur = 0;
  /** Memory: has seen a crime and is reporting it */
  reportCrime: string | null = null;
  reportPos = new THREE.Vector3();
  /** Hostile toward player */
  hostile = false;
  /** Mission/story ped (never despawned) */
  persistent = false;
  tag: string | null = null;
  attackCooldown = 0;
  screamCooldown = 0;
  /** Female voice for screams */
  readonly female: boolean;
  /** Visible this frame */
  visible = true;
  lod = 0;
  /** Weapon for armed peds/cops (M5) */
  weapon: string | null = null;
  ammo = 0;
  /** Generic AI data blob for cops/missions */
  ai: Record<string, unknown> = {};
  wanderCenter = new THREE.Vector3();
  wanderR = 0;
  /** Ragdoll handle (M5) */
  ragdoll: unknown = null;
  deadTime = 0;
  cash = 0;

  constructor(private physics: Physics, slot: number, app: Appearance, x: number, y: number, z: number) {
    this.slot = slot;
    this.appearance = app;
    this.female = app.female;
    this.body = physics.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y + 0.85, z));
    this.collider = physics.world.createCollider(RAPIER.ColliderDesc.capsule(0.55, 0.3).setCollisionGroups(GROUPS.ped).setFriction(0), this.body);
    physics.setOwner(this.collider, { kind: 'ped', ref: this });
    this.pos.set(x, y, z);
    this.prevPos.copy(this.pos);
    this.renderPos.copy(this.pos);
    this.groundY = y;
  }

  get alive(): boolean {
    return this.state !== 'dead' && this.health > 0;
  }

  setState(s: PedState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateT = 0;
  }

  play(action: AnimState['action'], dur: number): void {
    this.anim.action = action;
    this.anim.actionT = 0;
    this.actionT = dur;
    this.actionDur = dur;
  }

  /** Move kinematic body to current pos. */
  sync(): void {
    this.body.setNextKinematicTranslation({ x: this.pos.x, y: this.pos.y + 0.85, z: this.pos.z });
  }

  setCollision(on: boolean): void {
    this.collider.setEnabled(on);
  }

  dispose(): void {
    this.physics.removeBody(this.body);
  }
}
