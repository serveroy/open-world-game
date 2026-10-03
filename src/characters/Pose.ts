/**
 * Procedural humanoid animation. Pure math (no three.js) so it is unit-testable.
 * Angles in radians. Conventions (character faces +Z):
 *  - *Pitch > 0 swings a limb / bends the spine FORWARD.
 *  - shoulderRoll > 0 raises the arm sideways (away from body).
 *  - elbow/knee > 0 bend the joint naturally.
 */
export interface Pose {
  rootY: number;
  rootPitch: number;
  rootRoll: number;
  pelvisYaw: number;
  spinePitch: number;
  spineYaw: number;
  spineRoll: number;
  headPitch: number;
  headYaw: number;
  lShoulderPitch: number;
  lShoulderRoll: number;
  lShoulderYaw: number;
  lElbow: number;
  rShoulderPitch: number;
  rShoulderRoll: number;
  rShoulderYaw: number;
  rElbow: number;
  lHip: number;
  lHipRoll: number;
  lKnee: number;
  rHip: number;
  rHipRoll: number;
  rKnee: number;
}

export const POSE_KEYS: (keyof Pose)[] = [
  'rootY', 'rootPitch', 'rootRoll', 'pelvisYaw', 'spinePitch', 'spineYaw', 'spineRoll', 'headPitch', 'headYaw',
  'lShoulderPitch', 'lShoulderRoll', 'lShoulderYaw', 'lElbow', 'rShoulderPitch', 'rShoulderRoll', 'rShoulderYaw', 'rElbow',
  'lHip', 'lHipRoll', 'lKnee', 'rHip', 'rHipRoll', 'rKnee',
];

export function makePose(): Pose {
  const p = {} as Pose;
  for (const k of POSE_KEYS) p[k] = 0;
  p.lShoulderRoll = 0.08;
  p.rShoulderRoll = 0.08;
  p.lElbow = 0.15;
  p.rElbow = 0.15;
  return p;
}

export function copyPose(out: Pose, src: Pose): Pose {
  for (const k of POSE_KEYS) out[k] = src[k];
  return out;
}

/** out = lerp(out, target, t) */
export function blendPose(out: Pose, target: Pose, t: number): Pose {
  for (const k of POSE_KEYS) out[k] += (target[k] - out[k]) * t;
  return out;
}

export type AimStyle = 'none' | 'pistol' | 'rifle' | 'throw' | 'melee';
export type ActionAnim =
  | 'none' | 'punch' | 'punch2' | 'swing' | 'stab' | 'throw' | 'reload' | 'phone' | 'handsup'
  | 'pullout' | 'pulled' | 'open_door' | 'sit' | 'dance' | 'talk' | 'hurt' | 'cower' | 'vault'
  | 'lockpick' | 'smash' | 'wave' | 'fall' | 'getup' | 'kick';

export interface AnimState {
  /** Horizontal speed in m/s. */
  speed: number;
  /** Accumulated gait phase (radians), advanced by caller via `advancePhase`. */
  phase: number;
  grounded: boolean;
  vy: number;
  swimming: boolean;
  crouch: number; // 0..1
  cover: boolean;
  aim: AimStyle;
  aimPitch: number; // + up
  action: ActionAnim;
  actionT: number; // 0..1 progress
  driving: boolean;
  steer: number; // -1..1 for driving pose
  bike: boolean;
  time: number;
  /** Lean into turns (roll), e.g. from angular velocity. */
  lean: number;
  /** Move direction relative to facing (rad, + = toward the character's left); strafing/backpedalling. */
  moveYaw?: number;
}

export function makeAnimState(): AnimState {
  return {
    speed: 0, phase: 0, grounded: true, vy: 0, swimming: false, crouch: 0, cover: false,
    aim: 'none', aimPitch: 0, action: 'none', actionT: 0, driving: false, steer: 0, bike: false, time: 0, lean: 0,
  };
}

/** Advance gait phase based on speed (stride frequency rises with speed). */
export function advancePhase(s: AnimState, dt: number): void {
  const sp = s.speed;
  const freq = s.swimming ? 1.4 : sp < 0.1 ? 0 : 1.7 + Math.min(sp, 9) * 0.32; // Hz-ish
  s.phase = (s.phase + dt * freq * Math.PI * 2) % (Math.PI * 200);
  s.time += dt;
}

const sin = Math.sin, cos = Math.cos;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const bump = (t: number, a: number, b: number): number => {
  // 0 → 1 → 0 over [a,b]
  if (t <= a || t >= b) return 0;
  return sin(((t - a) / (b - a)) * Math.PI);
};

/** Compute target pose for state into `out` (which is overwritten). */
export function computePose(out: Pose, s: AnimState): Pose {
  for (const k of POSE_KEYS) out[k] = 0;
  const t = s.time;
  const breathe = sin(t * 2.1) * 0.015;

  if (s.driving) {
    // seated
    out.rootY = -0.42;
    out.lHip = 1.45; out.rHip = 1.45; out.lKnee = 1.35; out.rKnee = 1.35;
    out.lHipRoll = 0.1; out.rHipRoll = 0.1;
    if (s.bike) {
      out.lHip = 1.1; out.rHip = 1.1; out.lKnee = 1.6; out.rKnee = 1.6;
      out.lHipRoll = 0.35; out.rHipRoll = 0.35;
      out.spinePitch = 0.45; out.rootY = -0.3;
      out.lShoulderPitch = 1.15; out.rShoulderPitch = 1.15; out.lElbow = 0.35; out.rElbow = 0.35;
      out.lShoulderRoll = 0.25; out.rShoulderRoll = 0.25;
    } else {
      out.spinePitch = -0.08;
      out.lShoulderPitch = 0.95 + s.steer * 0.25; out.rShoulderPitch = 0.95 - s.steer * 0.25;
      out.lElbow = 0.7; out.rElbow = 0.7;
      out.lShoulderRoll = 0.12; out.rShoulderRoll = 0.12;
    }
    out.headYaw = s.steer * 0.25;
    out.spineRoll = s.lean * 0.5;
    applyAim(out, s, true);
    applyAction(out, s);
    return out;
  }

  if (s.swimming) {
    const p = s.phase;
    const moving = s.speed > 0.3 ? 1 : 0.25;
    out.rootPitch = moving > 0.5 ? 1.1 : 0.25;
    out.rootY = 0.18 * moving;
    out.headPitch = -out.rootPitch * 0.75;
    out.lShoulderPitch = 1.6 + sin(p) * 1.4 * moving; out.rShoulderPitch = 1.6 + sin(p + Math.PI) * 1.4 * moving;
    out.lShoulderRoll = 0.4 + cos(p) * 0.3; out.rShoulderRoll = 0.4 + cos(p + Math.PI) * 0.3;
    out.lElbow = 0.4; out.rElbow = 0.4;
    out.lHip = sin(p * 2) * 0.35 * moving; out.rHip = -sin(p * 2) * 0.35 * moving;
    out.lKnee = 0.3 + cos(p * 2) * 0.2; out.rKnee = 0.3 - cos(p * 2) * 0.2;
    return out;
  }

  if (!s.grounded) {
    // airborne: tuck when rising, legs reach when falling
    const rising = s.vy > 0;
    out.lHip = rising ? 0.8 : 0.35; out.rHip = rising ? 0.2 : 0.5;
    out.lKnee = rising ? 1.2 : 0.4; out.rKnee = rising ? 0.6 : 0.5;
    out.lShoulderPitch = -0.3; out.rShoulderPitch = -0.3;
    out.lShoulderRoll = 0.9; out.rShoulderRoll = 0.9;
    out.lElbow = 0.4; out.rElbow = 0.4;
    out.spinePitch = 0.12;
    applyAim(out, s, false);
    applyAction(out, s);
    return out;
  }

  // ---- grounded locomotion ----
  const sp = s.speed;
  const walkW = clamp01(sp / 1.6);
  const runW = clamp01((sp - 2.4) / 3.0);
  const p = s.phase;
  const strideHip = 0.45 * walkW + 0.35 * runW;
  const kneeAmp = 0.55 * walkW + 0.85 * runW;
  out.lHip = sin(p) * strideHip;
  out.rHip = sin(p + Math.PI) * strideHip;
  out.lKnee = 0.08 + Math.max(0, -cos(p)) * kneeAmp + walkW * 0.05;
  out.rKnee = 0.08 + Math.max(0, cos(p)) * kneeAmp + walkW * 0.05;
  const armAmp = 0.35 * walkW + 0.55 * runW;
  out.lShoulderPitch = sin(p + Math.PI) * armAmp;
  out.rShoulderPitch = sin(p) * armAmp;
  out.lElbow = 0.2 + walkW * 0.25 + runW * 0.9;
  out.rElbow = 0.2 + walkW * 0.25 + runW * 0.9;
  out.lShoulderRoll = 0.08 + runW * 0.05;
  out.rShoulderRoll = 0.08 + runW * 0.05;
  out.rootY = -Math.abs(sin(p)) * (0.03 * walkW + 0.05 * runW) + breathe * (1 - walkW);
  out.spinePitch = 0.04 + runW * 0.22;
  out.spineYaw = sin(p) * 0.12 * walkW;
  out.pelvisYaw = -sin(p) * 0.1 * walkW;
  out.spineRoll = s.lean;
  out.headPitch = -out.spinePitch * 0.6;
  out.lShoulderRoll += breathe;
  out.rShoulderRoll += breathe;

  if (s.crouch > 0) {
    const c = s.crouch;
    out.rootY += -0.42 * c;
    out.lHip += 1.1 * c; out.rHip += 1.1 * c;
    out.lKnee += 1.9 * c; out.rKnee += 1.9 * c;
    out.spinePitch += 0.45 * c;
    out.headPitch -= 0.4 * c;
    out.rootPitch = -0.1 * c;
  }

  applyAim(out, s, false);
  applyAction(out, s);
  return out;
}

function applyAim(out: Pose, s: AnimState, seated: boolean): void {
  if (s.aim === 'none') return;
  const ap = s.aimPitch;
  if (s.aim === 'pistol') {
    out.rShoulderPitch = 1.5 + ap;
    out.rShoulderRoll = 0.05;
    out.rShoulderYaw = 0;
    out.rElbow = 0.05;
    out.lShoulderPitch = 1.35 + ap;
    out.lShoulderRoll = -0.35;
    out.lElbow = 0.35;
    out.spineYaw += 0.12;
    out.headPitch = -ap * 0.8;
  } else if (s.aim === 'rifle') {
    out.rShoulderPitch = 1.2 + ap;
    out.rShoulderRoll = 0.45;
    out.rElbow = 1.0;
    out.lShoulderPitch = 1.45 + ap;
    out.lShoulderRoll = -0.3;
    out.lElbow = 0.25;
    out.spineYaw += 0.35;
    out.headYaw -= 0.3;
    out.headPitch = -ap * 0.8;
  } else if (s.aim === 'throw') {
    out.rShoulderPitch = -0.6 + ap * 0.5;
    out.rShoulderRoll = 0.9;
    out.rElbow = 1.4;
    out.lShoulderPitch = 0.9;
    out.lShoulderRoll = 0.2;
  } else if (s.aim === 'melee') {
    out.rShoulderPitch = 0.9; out.lShoulderPitch = 0.9;
    out.rElbow = 1.9; out.lElbow = 1.9;
    out.rShoulderRoll = 0.15; out.lShoulderRoll = 0.15;
  }
  if (!seated) out.spinePitch -= ap * 0.25;
}

function applyAction(out: Pose, s: AnimState): void {
  const a = s.action;
  if (a === 'none') return;
  const k = s.actionT;
  switch (a) {
    case 'punch':
    case 'punch2': {
      const r = a === 'punch';
      const w = bump(k, 0, 1);
      const ext = k < 0.4 ? k / 0.4 : 1 - (k - 0.4) / 0.6;
      if (r) {
        out.rShoulderPitch = 0.9 + ext * 0.7; out.rElbow = 1.9 - ext * 1.8; out.rShoulderRoll = 0.1;
        out.lShoulderPitch = 0.9; out.lElbow = 1.9;
      } else {
        out.lShoulderPitch = 0.9 + ext * 0.7; out.lElbow = 1.9 - ext * 1.8; out.lShoulderRoll = 0.1;
        out.rShoulderPitch = 0.9; out.rElbow = 1.9;
      }
      out.spineYaw += (r ? -0.4 : 0.4) * w;
      break;
    }
    case 'kick': {
      const ext = bump(k, 0, 1);
      out.rHip = 1.4 * ext; out.rKnee = 0.6 * (1 - ext) + 0.1;
      out.spinePitch -= 0.3 * ext;
      out.lShoulderRoll = 0.6; out.rShoulderRoll = 0.6;
      break;
    }
    case 'swing': {
      // bat: wind up back-right, swing across
      const wind = k < 0.35 ? k / 0.35 : 1;
      const sw = k < 0.35 ? 0 : clamp01((k - 0.35) / 0.3);
      out.rShoulderPitch = 1.2; out.lShoulderPitch = 1.2;
      out.rShoulderRoll = 0.6 - sw * 0.9; out.lShoulderRoll = -0.4 + sw * 0.3;
      out.rElbow = 0.6; out.lElbow = 0.9;
      out.spineYaw = 0.9 * wind - sw * 1.8;
      break;
    }
    case 'stab': {
      const ext = bump(k, 0.1, 0.8);
      out.rShoulderPitch = 0.6 + ext * 1.0; out.rElbow = 1.6 - ext * 1.4;
      out.spineYaw -= 0.3 * ext;
      break;
    }
    case 'throw': {
      const sw = clamp01((k - 0.3) / 0.35);
      out.rShoulderPitch = -0.8 + sw * 2.6; out.rShoulderRoll = 0.6; out.rElbow = 1.4 - sw * 1.2;
      out.lShoulderPitch = 1.0 - sw * 0.8;
      out.spineYaw = 0.5 - sw * 1.0;
      break;
    }
    case 'reload': {
      const w = bump(k, 0, 1);
      out.lShoulderPitch = 0.7 + w * 0.3; out.lElbow = 1.4; out.lShoulderRoll = -0.2;
      out.rShoulderPitch = 0.8; out.rElbow = 1.2;
      out.headPitch = 0.4 * w;
      break;
    }
    case 'phone': {
      out.rShoulderPitch = 0.4; out.rShoulderRoll = 0.5; out.rElbow = 2.4; out.rShoulderYaw = -0.4;
      out.headYaw = 0.15; out.headPitch = 0.05;
      break;
    }
    case 'handsup': {
      out.lShoulderPitch = 2.9; out.rShoulderPitch = 2.9;
      out.lShoulderRoll = 0.4; out.rShoulderRoll = 0.4;
      out.lElbow = 0.7; out.rElbow = 0.7;
      break;
    }
    case 'cower': {
      out.rootY = -0.45;
      out.lHip = 1.5; out.rHip = 1.5; out.lKnee = 2.2; out.rKnee = 2.2;
      out.spinePitch = 0.9; out.headPitch = 0.5;
      out.lShoulderPitch = 2.4; out.rShoulderPitch = 2.4; out.lElbow = 2.2; out.rElbow = 2.2;
      break;
    }
    case 'open_door':
    case 'pullout': {
      // reach forward-left (driver door / driver), then yank back
      const reach = bump(k, 0, 0.7);
      const yank = clamp01((k - 0.45) / 0.4);
      out.rShoulderPitch = 1.4 * reach + 0.4; out.rElbow = 0.3 + yank * 1.2;
      out.lShoulderPitch = 1.2 * reach + 0.3; out.lElbow = 0.4 + yank;
      out.spinePitch = 0.25 * reach - 0.2 * yank;
      out.lHip = 0.3 * yank; out.rKnee = 0.3 * yank;
      break;
    }
    case 'pulled': {
      // being dragged out: flailing then stumbling
      out.lShoulderPitch = 2.0 + sin(s.time * 14) * 0.4; out.rShoulderPitch = 1.6 + cos(s.time * 12) * 0.4;
      out.lShoulderRoll = 0.6; out.rShoulderRoll = 0.6;
      out.spinePitch = -0.35; out.rootPitch = -0.2 * (1 - k);
      out.lHip = 0.5; out.rKnee = 0.6;
      break;
    }
    case 'sit': {
      out.rootY = -0.45; out.lHip = 1.5; out.rHip = 1.5; out.lKnee = 1.5; out.rKnee = 1.5;
      out.lShoulderPitch = 0.4; out.rShoulderPitch = 0.4; out.lElbow = 1.0; out.rElbow = 1.0;
      break;
    }
    case 'dance': {
      const tt = s.time * 7.5;
      out.rootY = -Math.abs(sin(tt)) * 0.08;
      out.lShoulderPitch = 1.2 + sin(tt) * 0.9; out.rShoulderPitch = 1.2 + sin(tt + Math.PI) * 0.9;
      out.lShoulderRoll = 0.6 + cos(tt) * 0.4; out.rShoulderRoll = 0.6 - cos(tt) * 0.4;
      out.lElbow = 1.2; out.rElbow = 1.2;
      out.spineYaw = sin(tt * 0.5) * 0.4; out.spineRoll = sin(tt) * 0.12;
      out.lHip = 0.2 + sin(tt) * 0.2; out.rHip = 0.2 - sin(tt) * 0.2;
      out.lKnee = 0.35 + sin(tt) * 0.25; out.rKnee = 0.35 - sin(tt) * 0.25;
      out.headPitch = sin(tt * 2) * 0.15;
      break;
    }
    case 'talk': {
      const tt = s.time * 2.3;
      out.rShoulderPitch = 0.5 + sin(tt) * 0.25; out.rElbow = 1.2 + sin(tt * 1.7) * 0.3;
      out.lShoulderPitch = 0.3 + sin(tt * 0.8 + 1) * 0.15; out.lElbow = 0.9;
      out.headYaw = sin(tt * 0.6) * 0.2; out.headPitch = sin(tt * 1.3) * 0.06;
      break;
    }
    case 'wave': {
      out.rShoulderPitch = 0.4; out.rShoulderRoll = 2.4; out.rElbow = 0.4 + sin(s.time * 10) * 0.5;
      break;
    }
    case 'hurt': {
      const w = bump(k, 0, 1);
      out.spinePitch = -0.5 * w; out.headPitch = -0.4 * w;
      out.lShoulderRoll = 0.5 * w; out.rShoulderRoll = 0.5 * w;
      break;
    }
    case 'vault': {
      const w = bump(k, 0, 1);
      out.lHip = 1.3 * w; out.rHip = 0.9 * w; out.lKnee = 1.6 * w; out.rKnee = 1.0 * w;
      out.lShoulderPitch = 1.2 * w; out.rShoulderPitch = 1.2 * w; out.lElbow = 0.2; out.rElbow = 0.2;
      out.spinePitch = 0.4 * w;
      out.rootRoll = 0.3 * w;
      break;
    }
    case 'lockpick': {
      out.spinePitch = 0.35; out.headPitch = 0.35;
      out.rShoulderPitch = 1.1; out.rElbow = 1.0 + sin(s.time * 9) * 0.1;
      out.lShoulderPitch = 1.15; out.lElbow = 1.1;
      out.lKnee = 0.25; out.rKnee = 0.25; out.rootY -= 0.05;
      break;
    }
    case 'smash': {
      const sw = clamp01((k - 0.25) / 0.25);
      out.rShoulderPitch = 2.4 - sw * 1.6; out.rElbow = 1.6 - sw * 1.4; out.rShoulderRoll = 0.3;
      out.spinePitch = 0.1 + sw * 0.3;
      break;
    }
    case 'fall': {
      out.rootY = -0.75; out.rootPitch = -1.45;
      out.lShoulderRoll = 1.1; out.rShoulderRoll = 1.1;
      out.lHip = 0.2; out.rHip = 0.4; out.lKnee = 0.3; out.rKnee = 0.6;
      break;
    }
    case 'getup': {
      const w = 1 - k;
      out.rootY = -0.75 * w; out.rootPitch = -1.45 * w * w;
      out.lHip = 1.4 * w; out.rHip = 1.4 * w; out.lKnee = 2.0 * w; out.rKnee = 2.0 * w;
      break;
    }
  }
}
