import { computePose, makePose, type ActionAnim, type AnimState, type Pose } from '../Pose';
import { rotate, type RigBody, type RigClip, type RigData } from './RigData';
import { blendClip, blendPoseInto, forwardKinematics, LocalPose, ModelPose } from './PoseEval';
import { liftFoot } from './LegIK';
import { euler, ProcRetarget } from './ProcPose';

/**
 * Animation graph: turns the gameplay `AnimState` into blended motion-capture-style clips.
 *
 *  - Locomotion: idle / walk / jog / sprint (and crouch) blended by speed with a shared, foot-aligned
 *    gait phase and playback rate matched to ground speed (no foot sliding).
 *  - Full-body states (driving, swimming, airborne, sitting, dancing, knocked down…) and upper-body
 *    layers (aiming, punches while running, phone, reload…) cross-fade over ~0.1 s.
 *  - Actions without a matching clip use the procedural joint-angle pose, retargeted (ProcPose).
 *  - Model-space tweaks (lean into turns, aim pitch, lower-body twist when strafing) are FK overrides.
 */

export type Gait = 'normal' | 'formal' | 'drunk';
export interface AnimStyle {
  gait: Gait;
  /** Arms-folded idle for some bystanders. */
  folded: boolean;
}

export const enum Mask {
  Full = 0,
  Upper = 1,
  RArm = 2,
  Arms = 3,
}
type MaskMode = Mask | 'auto';
type Mode = 'loop' | 'warp' | 'once' | 'hold';

interface ActionDef {
  clip?: string;
  proc?: boolean;
  mask: MaskMode;
  mode: Mode;
  /** Clip time range (normalized) mapped over the action for 'warp'. */
  from?: number;
  to?: number;
}

/** How each gameplay action is animated. */
export const ACTIONS: Record<Exclude<ActionAnim, 'none'>, ActionDef> = {
  punch: { clip: 'Punch_Jab', mask: 'auto', mode: 'warp', from: 0.05, to: 0.75 },
  punch2: { clip: 'Punch_Cross', mask: 'auto', mode: 'warp', from: 0.05, to: 0.75 },
  kick: { proc: true, mask: Mask.Full, mode: 'warp' },
  swing: { clip: 'Sword_Regular_A', mask: 'auto', mode: 'warp' },
  stab: { clip: 'Punch_Cross', mask: 'auto', mode: 'warp', from: 0.05, to: 0.75 },
  throw: { clip: 'OverhandThrow', mask: 'auto', mode: 'warp', from: 0.1, to: 0.8 },
  reload: { clip: 'Pistol_Reload', mask: Mask.Upper, mode: 'warp' },
  phone: { clip: 'Idle_TalkingPhone_Loop', mask: 'auto', mode: 'loop' },
  handsup: { proc: true, mask: Mask.Upper, mode: 'warp' },
  pullout: { proc: true, mask: Mask.Full, mode: 'warp' },
  pulled: { proc: true, mask: Mask.Full, mode: 'warp' },
  open_door: { clip: 'Interact', mask: 'auto', mode: 'warp', from: 0.1, to: 0.7 },
  sit: { clip: 'Sitting_Idle_Loop', mask: Mask.Full, mode: 'loop' },
  dance: { clip: 'Dance_Loop', mask: Mask.Full, mode: 'loop' },
  talk: { clip: 'Idle_Talking_Loop', mask: 'auto', mode: 'loop' },
  hurt: { clip: 'Hit_Chest', mask: 'auto', mode: 'warp' },
  cower: { proc: true, mask: Mask.Full, mode: 'warp' },
  vault: { proc: true, mask: Mask.Full, mode: 'warp' },
  lockpick: { proc: true, mask: Mask.Full, mode: 'warp' },
  smash: { clip: 'Melee_Hook', mask: 'auto', mode: 'warp' },
  wave: { proc: true, mask: Mask.RArm, mode: 'warp' },
  fall: { clip: 'Hit_Knockback', mask: Mask.Full, mode: 'once' },
  getup: { clip: 'LayToIdle', mask: Mask.Full, mode: 'warp' },
};

interface Entry {
  key: string;
  /** Clip index, or −1 for the procedural pose, −2 pistol aim, −3 swim. */
  clip: number;
  mask: Mask;
  mode: Mode;
  from: number;
  to: number;
  t: number;
  w: number;
}

const PROC = -1, PISTOL = -2, SWIM = -3;

/** Gait speed knots (m/s): idle→walk, walk→jog, jog→sprint blend ranges. */
const IDLE_WALK = [0.12, 0.7];
const WALK_JOG = [2.2, 3.0];
const JOG_SPRINT = [5.6, 6.6];
/**
 * Ground speed (m/s) each run cycle is played at, at rate 1. The mocap jog and sprint have stylised
 * strides (their planted feet imply ~5.9 and ~8.9 m/s), so matching feet exactly at gameplay speeds
 * would slow them to a floaty slow-motion bound. Cadence reads as "running" far more than a little
 * foot slip does, so they are pinned to believable speeds instead. Walks keep their measured speed.
 */
export const GAIT_SPEED: Record<string, number> = { Jog_Fwd_Loop: 3.9, Sprint_Loop: 6.9 };
const gaitSpeed = (c: RigClip): number => GAIT_SPEED[c.name] ?? c.speed;
/**
 * Stride shortening: the mocap runs swing the legs almost into the splits. Their leg rotations are
 * pulled this far toward the cycle's average leg pose, which shortens the stride to suit the speeds
 * above (the planted foot then roughly matches the ground again).
 */
const STRIDE: Record<string, number> = { Jog_Fwd_Loop: 0.36, Sprint_Loop: 0.26 };
/**
 * Bounce kept (0..1) of the runs' pelvis rise above its lowest point. The mocap jog spends ~90% of
 * its cycle airborne with a 24 cm bounce, which reads as skipping. The pelvis is flattened and leg
 * IK keeps planted feet on the floor and lifting / swinging feet clear of it (see runFit).
 */
export const BOUNCE: Record<string, number> = { Jog_Fwd_Loop: 0.4, Sprint_Loop: 0.6 };
/** Toe/heel clearance (m) the leg IK keeps under a foot that is pushing off or swinging. */
const SWING_CLEAR = 0.03;

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Shared, immutable per-rig data (clip lookups, masks, retargeter). */
export class AnimLibrary {
  readonly masks: Float32Array[];
  readonly proc: ProcRetarget;
  readonly c: Record<string, number> = {};
  /** Leg bones and each run cycle's average leg pose (see STRIDE). */
  readonly legBones: number[];
  readonly legMean = new Map<string, Float32Array>();
  /** Per body type, each run cycle's per-frame pelvis correction and foot lifts (see runFit). */
  readonly runFit: Map<string, RunFit>[] = [];
  /** Model-space +Z (forward) and +Y (up) expressed in the root bone's local frame (pelvis offsets). */
  readonly fwd = new Float32Array(3);
  readonly up = new Float32Array(3);
  constructor(readonly rig: RigData) {
    const q = rig.bodies[0]!.restQ;
    rotate(-q[0]!, -q[1]!, -q[2]!, q[3]!, 0, 0, 1, this.fwd, 0);
    rotate(-q[0]!, -q[1]!, -q[2]!, q[3]!, 0, 1, 0, this.up, 0);
    const nb = rig.boneNames.length;
    const full = new Float32Array(nb).fill(1);
    const upper = new Float32Array(nb), rarm = new Float32Array(nb), arms = new Float32Array(nb);
    rig.boneNames.forEach((n, i) => {
      const leg = /^(thigh|calf|foot|ball)/.test(n);
      const side = n.endsWith('_l') ? 'l' : n.endsWith('_r') ? 'r' : '';
      if (n === 'spine_01') upper[i] = 0.25;
      else if (n === 'spine_02') upper[i] = 0.6;
      else if (n === 'spine_03') upper[i] = 0.9;
      else if (n === 'neck_01' || n === 'Head') upper[i] = 1;
      else if (side && !leg) {
        upper[i] = 1;
        arms[i] = n.startsWith('clavicle') ? 0.6 : 1;
        if (side === 'r') rarm[i] = n.startsWith('clavicle') ? 0.5 : 1;
      }
    });
    this.masks = [full, upper, rarm, arms];
    this.proc = new ProcRetarget(rig);
    // per-run-cycle average leg pose (stride shortening target)
    const legs = rig.boneNames.map((n, i) => (/^(thigh|calf|foot|ball)_/.test(n) ? i : -1)).filter((i) => i >= 0);
    this.legBones = legs;
    for (const name of Object.keys(STRIDE)) {
      const ci = rig.clipIndex.get(name);
      if (ci === undefined) continue;
      const c = rig.clips[ci]!, nb = rig.boneNames.length;
      const mean = new Float32Array(nb * 4);
      for (const b of legs) {
        let x = 0, y = 0, z = 0, w = 0;
        const r0 = c.rot.subarray(b * 4, b * 4 + 4);
        for (let f = 0; f < c.frames; f++) {
          const o = (f * nb + b) * 4;
          const sg = c.rot[o]! * r0[0]! + c.rot[o + 1]! * r0[1]! + c.rot[o + 2]! * r0[2]! + c.rot[o + 3]! * r0[3]! < 0 ? -1 : 1;
          x += c.rot[o]! * sg; y += c.rot[o + 1]! * sg; z += c.rot[o + 2]! * sg; w += c.rot[o + 3]! * sg;
        }
        const l = Math.hypot(x, y, z, w) || 1;
        mean.set([x / l, y / l, z / l, w / l], b * 4);
      }
      this.legMean.set(name, mean);
    }
    for (const body of rig.bodies) {
      const m = new Map<string, RunFit>();
      for (const name of Object.keys(BOUNCE)) {
        const ci = rig.clipIndex.get(name);
        if (ci !== undefined) m.set(name, runFit(this, body, rig.clips[ci]!));
      }
      this.runFit.push(m);
    }
    rig.clips.forEach((cl, i) => (this.c[cl.name] = i));
  }
  clip(name: string): RigClip {
    return this.rig.clips[this.c[name]!]!;
  }
}

const _poseOld: Pose = makePose();
const _off = new Float32Array(3);

/** Per-character animation state machine + evaluator. */
export class AnimController {
  /** Shared gait phase (cycles). */
  private phase = 0;
  private idleT = Math.random() * 10;
  private crouchT = 0;
  private full: Entry[] = [];
  private upper: Entry[] = [];
  private lastAction: ActionAnim = 'none';
  private lastActionT = 0;
  private airT = 0;
  private landT = 9;
  private wasGrounded = true;
  private gw = [1, 0, 0, 0]; // idle, walk, jog, sprint
  private rate = 0;
  private reverse = false;
  /** Lower-body twist (rad) when moving sideways relative to facing. */
  twist = 0;
  /** Leg length of the animated body relative to the clips' skeleton (stride → ground speed). */
  legScale = 1;
  private bodyIx = 0;
  /** Pelvis shift (m) that puts seated clips' hips over the seat anchor, and swim lift to the surface. */
  seatShift = 0.31;
  swimLift = 1.16;

  /** Adapt gameplay anchors to a body type's proportions. */
  fitBody(body: RigBody): void {
    this.legScale = body.legScale;
    this.bodyIx = Math.max(0, this.lib.rig.bodies.indexOf(body));
    const q = this.lib.rig.bodies[0]!.restQ;
    rotate(q[0]!, q[1]!, q[2]!, q[3]!, body.pelvisOffset[0]!, body.pelvisOffset[1]!, body.pelvisOffset[2]!, _off, 0);
    this.seatShift = 0.31 - _off[2]!;
    this.swimLift = 1.16 - _off[1]!;
    const r = this.lib.rig;
    this.feet = ['ball_l', 'ball_r', 'foot_l', 'foot_r'].map((n) => r.bone(n));
    this.feetRest = this.feet.map((b) => body.bindP[b * 3 + 1]!);
  }

  private feet: number[] = [];
  private feetRest: number[] = [];
  /** Set by evaluate(): plain on-foot locomotion, where the feet must not sink into the ground. */
  private groundLock = false;

  /**
   * Leg IK + ground lock (after FK): run cycles move each ankle by its precomputed lift (planted
   * feet onto the floor, lifting feet clear of it); then, since the dressed bodies' legs are longer
   * than the clips' skeleton, lift the whole body by the deepest remaining dip below the floor.
   */
  groundFix(model: ModelPose): void {
    if (!this.groundLock || !this.feet.length) return;
    const L = this.legs;
    if (this.lift[0] !== 0) liftFoot(model, L[0]!, L[1]!, L[2]!, L[3]!, this.lift[0]!);
    if (this.lift[1] !== 0) liftFoot(model, L[4]!, L[5]!, L[6]!, L[7]!, this.lift[1]!);
    let lift = 0;
    for (let k = 0; k < this.feet.length; k++) {
      const y = model.p[this.feet[k]! * 3 + 1]!;
      lift = Math.max(lift, this.feetRest[k]! - 0.012 - y);
    }
    if (lift <= 0) return;
    for (let i = 1; i < model.p.length; i += 3) model.p[i]! += lift;
  }
  /** Per-side ankle lift (m) for the leg IK, set by evaluate() from the run cycles. */
  private readonly lift = new Float32Array(2);
  private readonly legs: number[];
  /** Model-space FK pre-rotations per bone (null = none). Rebuilt each evaluate. */
  readonly pre: (Float32Array | null)[];
  private readonly preBuf: Float32Array[];
  private readonly procLocal: LocalPose;
  private readonly tmp: LocalPose;
  private readonly bSpine: number[];
  private readonly bPelvis: number;
  private readonly bHead: number;
  private readonly bNeck: number;

  constructor(private lib: AnimLibrary, public style: AnimStyle = { gait: 'normal', folded: false }) {
    const rig = lib.rig, nb = rig.boneNames.length;
    this.pre = new Array<Float32Array | null>(nb).fill(null);
    this.preBuf = Array.from({ length: nb }, () => new Float32Array(4));
    this.procLocal = new LocalPose(nb);
    this.tmp = new LocalPose(nb);
    this.bSpine = ['spine_01', 'spine_02', 'spine_03'].map((n) => rig.bone(n));
    this.bPelvis = rig.pelvis;
    this.bHead = rig.bone('Head');
    this.bNeck = rig.bone('neck_01');
    this.legs = ['thigh_l', 'calf_l', 'foot_l', 'ball_l', 'thigh_r', 'calf_r', 'foot_r', 'ball_r'].map((n) => rig.bone(n));
    this.phase = Math.random();
  }

  /** Current upper-body / full-body layer keys (debug + tests). */
  get layers(): string {
    return [...this.full.map((e) => `F:${e.key}@${e.w.toFixed(2)}`), ...this.upper.map((e) => `U:${e.key}@${e.w.toFixed(2)}`)].join(' ');
  }

  update(s: AnimState, dt: number): void {
    const lib = this.lib;
    const moving = s.speed > 0.6;
    // ---- locomotion gait weights + phase ----
    const sp = s.speed;
    const wWalk = smooth(IDLE_WALK[0]!, IDLE_WALK[1]!, sp);
    const wJog = smooth(WALK_JOG[0]!, WALK_JOG[1]!, sp);
    const wSprint = smooth(JOG_SPRINT[0]!, JOG_SPRINT[1]!, sp);
    const g = this.gw;
    g[0] = 1 - wWalk;
    g[1] = wWalk * (1 - wJog);
    g[2] = wWalk * wJog * (1 - wSprint);
    g[3] = wWalk * wJog * wSprint;
    const walk = lib.clip(this.walkClip()), jog = lib.clip('Jog_Fwd_Loop'), sprint = lib.clip('Sprint_Loop');
    const mv = g[1]! + g[2]! + g[3]!;
    if (mv > 1e-3) {
      const v = ((g[1]! * gaitSpeed(walk) + g[2]! * gaitSpeed(jog) + g[3]! * gaitSpeed(sprint)) / mv) * this.legScale;
      const f = (g[1]! / walk.duration + g[2]! / jog.duration + g[3]! / sprint.duration) / mv;
      // ground-speed match, softened in the slow-walk range (very quick shuffles look odd); runs never
      // drop into slow motion
      let r = Math.max(0.05, sp) / v;
      const running = g[2]! + g[3]! > 0.5;
      if (r > 1 && !running) r = Math.pow(r, 0.8);
      if (running) r = Math.min(1.35, Math.max(0.92, r));
      this.rate = f * r;
    } else this.rate = 1 / walk.duration;
    // strafing / backpedalling: lower body follows the move direction, upper body keeps facing
    const my = s.moveYaw ?? 0;
    this.reverse = sp > 0.3 && Math.abs(my) > 1.95;
    const twistTarget = sp > 0.3 && !s.driving && !s.swimming ? clampAbs(this.reverse ? wrap(my - Math.PI) : my, 1.25) : 0;
    this.twist += (twistTarget - this.twist) * Math.min(1, dt * 10);
    this.phase += dt * this.rate * (this.reverse ? -1 : 1);
    if (this.phase > 1e3 || this.phase < -1e3) this.phase %= 1;
    this.idleT += dt;
    this.crouchT += dt;

    // ---- airborne / landing ----
    const airborne = !s.grounded && !s.swimming && !s.driving;
    if (airborne) this.airT += dt;
    if (!this.wasGrounded && s.grounded && this.airT > 0.45) this.landT = 0;
    if (!airborne) this.airT = 0;
    this.wasGrounded = s.grounded || s.swimming || s.driving;
    this.landT += dt;

    // ---- action bookkeeping ----
    const act = s.action;
    const restarted = act !== 'none' && act === this.lastAction && s.actionT < this.lastActionT - 0.05;
    this.lastAction = act;
    this.lastActionT = s.actionT;
    const def = act !== 'none' ? ACTIONS[act] : null;
    const actMask: Mask | null = def ? (def.mask === 'auto' ? (moving || airborne ? Mask.Upper : Mask.Full) : def.mask) : null;

    // ---- full-body target ----
    let fk: string | null = null;
    let fClip = 0, fMode: Mode = 'loop', fFrom = 0, fTo = 1;
    if (s.driving) {
      if (s.bike) {
        fk = 'bike';
        fClip = PROC;
      } else {
        fk = 'drive';
        fClip = lib.c['Driving_Loop']!;
      }
    } else if (s.swimming) {
      fk = 'swim';
      fClip = SWIM;
    } else if (def && actMask === Mask.Full) {
      fk = 'act:' + act;
      fClip = def.proc ? PROC : lib.c[def.clip!]!;
      fMode = def.mode;
      fFrom = def.from ?? 0;
      fTo = def.to ?? 1;
    } else if (airborne && this.airT > 0.08) {
      const rising = s.vy > 1 && this.airT < 0.5;
      fk = rising ? 'jump' : 'fall';
      fClip = lib.c[rising ? 'Jump_Start' : 'Jump_Loop']!;
      fMode = rising ? 'once' : 'loop';
      fFrom = rising ? 0.25 : 0;
    } else if (this.landT < 0.28 && s.speed < 2.5) {
      fk = 'land';
      fClip = lib.c['Jump_Land']!;
      fMode = 'once';
      fFrom = 0.15;
    }
    // ---- upper-body target ----
    let uk: string | null = null;
    let uClip = 0, uMode: Mode = 'loop', uMask = Mask.Upper, uFrom = 0, uTo = 1;
    if (def && actMask !== Mask.Full && actMask !== null) {
      uk = 'act:' + act;
      uClip = def.proc ? PROC : lib.c[def.clip!]!;
      uMode = def.mode;
      uMask = actMask;
      uFrom = def.from ?? 0;
      uTo = def.to ?? 1;
    } else if (s.aim !== 'none' && !(def && actMask === Mask.Full) && !s.swimming) {
      uk = 'aim:' + s.aim;
      if (s.aim === 'pistol' || s.aim === 'rifle') uClip = PISTOL; // two-handed mocap aim (pitch-blended)
      else if (s.aim === 'melee') {
        uClip = lib.c['Punch_Jab']!;
        uMode = 'hold';
      } else {
        uClip = lib.c['OverhandThrow']!; // wind-up
        uMode = 'hold';
        uFrom = 0.32;
      }
      uMask = s.driving ? Mask.Arms : Mask.Upper;
    }
    stepFader(this.full, fk, fClip, Mask.Full, fMode, fFrom, fTo, dt, fk === 'land' || fk === 'jump' ? 14 : 9, restarted && fk === 'act:' + act);
    stepFader(this.upper, uk, uClip, uMask, uMode, uFrom, uTo, dt, 12, restarted && uk === 'act:' + act);
    for (const e of this.full) advance(e, s, dt, this.lib.rig);
    for (const e of this.upper) advance(e, s, dt, this.lib.rig);
  }

  private walkClip(): string {
    return this.style.gait === 'formal' ? 'Walk_Formal_Loop' : this.style.gait === 'drunk' ? 'Zombie_Walk_Fwd_Loop' : 'Walk_Loop';
  }

  /** Evaluate the blended local pose into `out` and fill `pre` FK overrides. */
  evaluate(s: AnimState, out: LocalPose): void {
    const lib = this.lib;
    this.groundLock = s.grounded && !s.driving && !s.swimming && this.full.length === 0;
    const top = this.full[this.full.length - 1];
    const fullCover = top && top.w >= 0.999 && this.full.length === 1;
    let procDone = false;
    const proc = (): LocalPose => {
      if (!procDone) {
        computePose(_poseOld, s);
        lib.proc.apply(_poseOld, this.procLocal);
        procDone = true;
      }
      return this.procLocal;
    };
    if (!fullCover) this.locomotion(s, out);
    for (const e of this.full) {
      if (fullCover && e !== top) continue;
      this.apply(e, s, out, proc, fullCover && e === top ? 1 : ease(e.w));
    }
    for (const e of this.upper) this.apply(e, s, out, proc, ease(e.w));
    this.seatAndSwim(out);
    this.overrides(s);
  }

  /**
   * Gameplay anchors: seated clips put the pelvis ~0.3 m behind the root, but seats/benches anchor the
   * root under the hips; swim clips float around the root, but the player's root sits at the feet
   * 1.3 m below the surface. Shift the pelvis accordingly (weighted by the layer).
   */
  private seatAndSwim(out: LocalPose): void {
    let seat = 0, swim = 0;
    for (const e of this.full) {
      const w = ease(e.w);
      if (e.key === 'drive' || e.key === 'act:sit') seat += w;
      else if (e.key === 'swim') swim += w;
    }
    const f = this.lib.fwd, u = this.lib.up;
    const dz = this.seatShift * Math.min(1, seat), dy = this.swimLift * Math.min(1, swim);
    if (dz === 0 && dy === 0) return;
    for (let a = 0; a < 3; a++) out.pelvis[a]! += f[a]! * dz + u[a]! * dy;
  }

  private apply(e: Entry, s: AnimState, out: LocalPose, proc: () => LocalPose, w: number): void {
    const lib = this.lib, rig = lib.rig;
    const mask = e.mask === Mask.Full ? null : lib.masks[e.mask]!;
    const pw = e.mask === Mask.Full ? 1 : 0;
    if (w <= 0.001) return;
    if (e.clip === PROC) blendPoseInto(proc(), w, out, mask, pw);
    else if (e.clip === PISTOL) {
      const n = lib.clip('Pistol_Aim_Neutral');
      const ap = s.aimPitch;
      if (w >= 1 && !mask) blendClip(rig, n, 0, 1, out);
      else {
        // build the aim pose separately, then layer it
        this.tmp.copy(out);
        blendClip(rig, n, 0, 1, this.tmp);
        if (Math.abs(ap) > 0.02) blendClip(rig, lib.clip(ap > 0 ? 'Pistol_Aim_Up' : 'Pistol_Aim_Down'), 0, Math.min(1, Math.abs(ap) / 0.9), this.tmp);
        blendPoseInto(this.tmp, w, out, mask, pw);
        return;
      }
      if (Math.abs(ap) > 0.02) blendClip(rig, lib.clip(ap > 0 ? 'Pistol_Aim_Up' : 'Pistol_Aim_Down'), 0, Math.min(1, Math.abs(ap) / 0.9), out);
    } else if (e.clip === SWIM) {
      const k = Math.min(1, s.speed / 1.6);
      const idle = lib.clip('Swim_Idle_Loop'), fwd = lib.clip('Swim_Fwd_Loop');
      if (w >= 1) {
        blendClip(rig, idle, e.t, 1, out);
        blendClip(rig, fwd, e.t, k, out);
      } else {
        this.tmp.copy(out);
        blendClip(rig, idle, e.t, 1, this.tmp);
        blendClip(rig, fwd, e.t, k, this.tmp);
        blendPoseInto(this.tmp, w, out, mask, pw);
      }
    } else {
      const clip = rig.clips[e.clip]!;
      blendClip(rig, clip, e.t, w, out, mask, pw);
    }
  }

  private locomotion(s: AnimState, out: LocalPose): void {
    const lib = this.lib, rig = lib.rig, g = this.gw;
    const idle = lib.clip(this.style.gait === 'drunk' ? 'Zombie_Idle_Loop' : this.style.folded ? 'Idle_FoldArms_Loop' : 'Idle_Loop');
    blendClip(rig, idle, this.idleT, 1, out);
    let acc = g[0]!;
    const gaits: [number, RigClip][] = [[g[1]!, lib.clip(this.walkClip())], [g[2]!, lib.clip('Jog_Fwd_Loop')], [g[3]!, lib.clip('Sprint_Loop')]];
    for (const [w, c] of gaits) {
      if (w <= 0.001) continue;
      acc += w;
      blendClip(rig, c, gaitTime(c, this.phase), w / acc, out);
    }
    // runs: flattened pelvis (+ foot lifts for the leg IK in groundFix), shortened strides
    const fits = lib.runFit[this.bodyIx];
    this.lift[0] = this.lift[1] = 0;
    for (const [w, c] of gaits) {
      const fit = fits?.get(c.name);
      if (!fit || w <= 0.001) continue;
      const wn = w / Math.max(acc, 1e-3);
      let fp = (gaitTime(c, this.phase) * rig.fps) % c.frames;
      if (fp < 0) fp += c.frames;
      const f0 = Math.floor(fp), f1 = f0 + 1 >= c.frames ? 0 : f0 + 1, t = fp - f0;
      const d = sampleAt(fit.pelvis, f0, f1, t) * wn;
      const u = lib.up, P = out.pelvis;
      P[0]! += u[0]! * d; P[1]! += u[1]! * d; P[2]! += u[2]! * d;
      this.lift[0]! += sampleAt(fit.lift[0], f0, f1, t) * wn;
      this.lift[1]! += sampleAt(fit.lift[1], f0, f1, t) * wn;
      const k = STRIDE[c.name];
      if (k) shortenStride(lib, c.name, k * wn, out.q);
    }
    if (s.crouch > 0.01) {
      const ci = lib.clip('Crouch_Idle_Loop'), cf = lib.clip('Crouch_Fwd_Loop');
      const k = smooth(0.15, 0.8, s.speed);
      if (s.crouch >= 0.999 && k <= 0) blendClip(rig, ci, this.crouchT, 1, out);
      else {
        this.tmp.copy(out);
        blendClip(rig, ci, this.crouchT, 1, this.tmp);
        if (k > 0) blendClip(rig, cf, gaitTime(cf, this.phase), k, this.tmp);
        blendPoseInto(this.tmp, s.crouch, out);
      }
    }
  }

  private overrides(s: AnimState): void {
    const pre = this.pre;
    pre.fill(null);
    // lower-body twist: pelvis turns toward the move direction, spine turns back
    const tw = this.twist;
    // lean into turns (roll about the forward axis), distributed over the spine
    const lean = s.driving || s.swimming ? 0 : s.lean * 0.5;
    if (Math.abs(tw) > 1e-3 || Math.abs(lean) > 1e-3) {
      const p = this.preBuf[this.bPelvis]!;
      euler(0, tw, 0, 'YXZ', p, 0);
      pre[this.bPelvis] = p;
      for (const b of this.bSpine) {
        const q = this.preBuf[b]!;
        euler(0, -tw / 3, lean / 3, 'YXZ', q, 0);
        pre[b] = q;
      }
    }
    if (s.driving && !s.bike && Math.abs(s.steer) > 0.02) {
      const q = this.preBuf[this.bHead]!;
      euler(0, s.steer * 0.22, 0, 'YXZ', q, 0);
      pre[this.bHead] = q;
    }
    void this.bNeck;
  }
}

const sampleAt = (a: Float32Array, f0: number, f1: number, t: number): number => a[f0]! + (a[f1]! - a[f0]!) * t;

/** Pull the leg rotations in `q` a fraction `a` toward a run cycle's average leg pose (see STRIDE). */
function shortenStride(lib: AnimLibrary, clip: string, a: number, q: Float32Array): void {
  const mean = lib.legMean.get(clip);
  if (!mean || a <= 0) return;
  for (const b of lib.legBones) {
    const j = b * 4;
    let mx = mean[j]!, my = mean[j + 1]!, mz = mean[j + 2]!, mw = mean[j + 3]!;
    if (q[j]! * mx + q[j + 1]! * my + q[j + 2]! * mz + q[j + 3]! * mw < 0) {
      mx = -mx; my = -my; mz = -mz; mw = -mw;
    }
    const x = q[j]! + (mx - q[j]!) * a, y = q[j + 1]! + (my - q[j + 1]!) * a, z = q[j + 2]! + (mz - q[j + 2]!) * a, ww = q[j + 3]! + (mw - q[j + 3]!) * a;
    const l = 1 / Math.sqrt(x * x + y * y + z * z + ww * ww);
    q[j] = x * l; q[j + 1] = y * l; q[j + 2] = z * l; q[j + 3] = ww * l;
  }
}

/** A run cycle's per-frame pelvis correction (m, along model up) and per-side ankle lifts (m). */
export interface RunFit {
  pelvis: Float32Array;
  lift: [Float32Array, Float32Array];
}

/**
 * Fit a run cycle to one body type, measured on the stride-shortened cycle. The pelvis keeps only
 * BOUNCE of its rise; a foot counts as planted while it sweeps backward at about the cycle's ground
 * speed and is then lifted/lowered exactly onto the floor, otherwise it keeps SWING_CLEAR above it.
 */
function runFit(lib: AnimLibrary, body: RigBody, c: RigClip): RunFit {
  const rig = lib.rig, nb = rig.boneNames.length, n = c.frames, u = lib.up;
  const sides = [['ball_l', 'foot_l'], ['ball_r', 'foot_r']].map((p) => p.map((b) => rig.bone(b)));
  const lp = new LocalPose(nb), mp = new ModelPose(nb);
  const h = new Float32Array(n), low = sides.map(() => new Float32Array(n)), z = sides.map(() => new Float32Array(n));
  for (let f = 0; f < n; f++) {
    h[f] = c.pelvis[f * 3]! * u[0]! + c.pelvis[f * 3 + 1]! * u[1]! + c.pelvis[f * 3 + 2]! * u[2]!;
    blendClip(rig, c, f / rig.fps, 1, lp);
    shortenStride(lib, c.name, STRIDE[c.name] ?? 0, lp.q);
    forwardKinematics(rig, body, lp, mp);
    sides.forEach((bones, k) => {
      let lo = Infinity, zz = 0;
      for (const b of bones) {
        lo = Math.min(lo, mp.p[b * 3 + 1]! - (body.bindP[b * 3 + 1]! - 0.012));
        zz += mp.p[b * 3 + 2]! / bones.length;
      }
      low[k]![f] = lo;
      z[k]![f] = zz;
    });
  }
  const ground = gaitSpeed(c) * body.legScale, keep = BOUNCE[c.name] ?? 1, mn = Math.min(...h);
  const planted = sides.map((_, k) => {
    const zs = z[k]!, e = new Float32Array(n);
    for (let f = 0; f < n; f++) e[f] = smooth(0.45, 0.8, ((zs[(f + n - 1) % n]! - zs[(f + 1) % n]!) * rig.fps) / 2 / ground);
    return e;
  });
  // pelvis: flattened rise, offset so planted feet sit on the floor on average
  const pelvis = new Float32Array(n);
  let sum = 0, wsum = 0;
  for (let f = 0; f < n; f++) {
    pelvis[f] = -(h[f]! - mn) * (1 - keep);
    for (let k = 0; k < sides.length; k++) {
      sum += -(low[k]![f]! + pelvis[f]!) * planted[k]![f]!;
      wsum += planted[k]![f]!;
    }
  }
  const base = wsum > 0 ? sum / wsum : 0;
  for (let f = 0; f < n; f++) pelvis[f]! += base;
  const lift = sides.map((_, k) => {
    const raw = new Float32Array(n), out = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const y = low[k]![f]! + pelvis[f]!, e = planted[k]![f]!;
      raw[f] = e * -y + (1 - e) * Math.max(0, SWING_CLEAR - y);
    }
    for (let f = 0; f < n; f++) out[f] = (raw[(f + n - 1) % n]! + 2 * raw[f]! + raw[(f + 1) % n]!) / 4;
    return out;
  }) as [Float32Array, Float32Array];
  return { pelvis, lift };
}

function gaitTime(c: RigClip, phase: number): number {
  let u = (phase + c.phase0) % 1;
  if (u < 0) u += 1;
  return u * c.duration;
}

function stepFader(list: Entry[], key: string | null, clip: number, mask: Mask, mode: Mode, from: number, to: number, dt: number, speed: number, restart: boolean): void {
  const top = list[list.length - 1];
  if (key && (!top || top.key !== key || restart)) {
    // reuse a fading-out entry with the same key (no pop when toggling quickly), else push a new one
    const i = list.findIndex((e) => e.key === key);
    if (i >= 0 && !restart) {
      const [e] = list.splice(i, 1);
      list.push(e!);
    } else {
      list.push({ key, clip, mask, mode, from, to, t: 0, w: 0 });
      if (list.length > 3) list.shift();
    }
  }
  // linear fades (≈1/speed seconds); weights are eased when applied
  const k = dt * speed;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]!;
    const target = key && i === list.length - 1 && e.key === key ? 1 : 0;
    e.w = target ? Math.min(1, e.w + k) : e.w - k;
    if (target === 0 && e.w <= 0) list.splice(i, 1);
  }
  // once the top entry fully covers, older ones are irrelevant
  const t2 = list[list.length - 1];
  if (t2 && t2.w >= 1) list.splice(0, list.length - 1);
}

function advance(e: Entry, s: AnimState, dt: number, rig: RigData): void {
  if (e.clip < 0 && e.clip !== SWIM) return;
  if (e.clip === SWIM) {
    e.t += dt;
    return;
  }
  const c = rig.clips[e.clip]!;
  if (e.mode === 'loop') e.t += dt;
  else if (e.mode === 'hold') e.t = e.from * c.duration;
  else if (e.mode === 'once') e.t = Math.min(c.duration, Math.max(e.t, e.from * c.duration) + dt);
  else if (e.key.startsWith('act:') && s.action !== 'none') e.t = (e.from + (e.to - e.from) * s.actionT) * c.duration;
}

const ease = (w: number): number => (w >= 1 ? 1 : w <= 0 ? 0 : w * w * (3 - 2 * w));
const wrap = (a: number): number => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const clampAbs = (v: number, m: number): number => (v > m ? m : v < -m ? -m : v);
