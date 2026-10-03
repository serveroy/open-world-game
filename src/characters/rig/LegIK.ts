import { mulQ, rotate } from './RigData';
import type { ModelPose } from './PoseEval';

const _q = new Float32Array(4);
const _r = new Float32Array(4);
const _v = new Float32Array(3);

/** Shortest-arc rotation taking direction a onto direction b (neither needs to be unit length). */
function fromTo(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Float32Array): void {
  const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
  ax /= la; ay /= la; az /= la; bx /= lb; by /= lb; bz /= lb;
  const d = ax * bx + ay * by + az * bz;
  if (d < -0.9999) {
    // opposite: half turn about any perpendicular axis
    const px = Math.abs(ax) < 0.9 ? 0 : -az, py = Math.abs(ax) < 0.9 ? -az : 0, pz = Math.abs(ax) < 0.9 ? ay : ax;
    const l = Math.hypot(px, py, pz) || 1;
    out[0] = px / l; out[1] = py / l; out[2] = pz / l; out[3] = 0;
    return;
  }
  let x = ay * bz - az * by, y = az * bx - ax * bz, z = ax * by - ay * bx, w = 1 + d;
  const l = Math.hypot(x, y, z, w);
  out[0] = x / l; out[1] = y / l; out[2] = z / l; out[3] = w / l;
}

function preRotate(m: ModelPose, bone: number, q: Float32Array): void {
  const j = bone * 4, Q = m.q;
  mulQ(q[0]!, q[1]!, q[2]!, q[3]!, Q[j]!, Q[j + 1]!, Q[j + 2]!, Q[j + 3]!, Q, j);
}

/**
 * Two-bone leg IK on a model pose: move the ankle `dy` metres along model up, keeping the foot's
 * animated orientation and the knee in its current bend plane. Targets out of reach stop at a
 * nearly straight leg (the ground lock lifts the body for the rest).
 */
export function liftFoot(m: ModelPose, thigh: number, calf: number, foot: number, ball: number, dy: number): void {
  if (Math.abs(dy) < 1e-4) return;
  const P = m.p;
  const hx = P[thigh * 3]!, hy = P[thigh * 3 + 1]!, hz = P[thigh * 3 + 2]!;
  const kx = P[calf * 3]!, ky = P[calf * 3 + 1]!, kz = P[calf * 3 + 2]!;
  const ax = P[foot * 3]!, ay = P[foot * 3 + 1]!, az = P[foot * 3 + 2]!;
  const a = Math.hypot(kx - hx, ky - hy, kz - hz), b = Math.hypot(ax - kx, ay - ky, az - kz);
  let tx = ax - hx, ty = ay + dy - hy, tz = az - hz;
  const c0 = Math.hypot(tx, ty, tz) || 1e-6;
  const c = Math.min(Math.max(c0, Math.abs(a - b) + 1e-4), (a + b) * 0.999);
  const dx = tx / c0, dyy = ty / c0, dz = tz / c0;
  tx = dx * c; ty = dyy * c; tz = dz * c; // ankle target, relative to the hip
  // knee bend direction: the knee's offset from the hip→target line (fallback: model forward)
  let bx = kx - hx, by = ky - hy, bz = kz - hz;
  const along = bx * dx + by * dyy + bz * dz;
  bx -= dx * along; by -= dyy * along; bz -= dz * along;
  let bl = Math.hypot(bx, by, bz);
  if (bl < 1e-5) {
    bx = -dx * dz; by = -dyy * dz; bz = 1 - dz * dz;
    bl = Math.hypot(bx, by, bz) || 1;
  }
  bx /= bl; by /= bl; bz /= bl;
  const cosA = Math.min(1, Math.max(-1, (a * a + c * c - b * b) / (2 * a * c)));
  const sinA = Math.sqrt(1 - cosA * cosA);
  const nkx = a * (cosA * dx + sinA * bx), nky = a * (cosA * dyy + sinA * by), nkz = a * (cosA * dz + sinA * bz);
  // thigh: swing the knee into place
  fromTo(kx - hx, ky - hy, kz - hz, nkx, nky, nkz, _q);
  preRotate(m, thigh, _q);
  // calf: the shin (as carried by the thigh's turn) onto knee→target
  rotate(_q[0]!, _q[1]!, _q[2]!, _q[3]!, ax - kx, ay - ky, az - kz, _v, 0);
  fromTo(_v[0]!, _v[1]!, _v[2]!, tx - nkx, ty - nky, tz - nkz, _r);
  mulQ(_r[0]!, _r[1]!, _r[2]!, _r[3]!, _q[0]!, _q[1]!, _q[2]!, _q[3]!, _q, 0);
  preRotate(m, calf, _q);
  P[calf * 3] = hx + nkx; P[calf * 3 + 1] = hy + nky; P[calf * 3 + 2] = hz + nkz;
  // foot (and toes) keep their orientation and ride along with the ankle
  const sx = hx + tx - ax, sy = hy + ty - ay, sz = hz + tz - az;
  P[foot * 3]! += sx; P[foot * 3 + 1]! += sy; P[foot * 3 + 2]! += sz;
  P[ball * 3]! += sx; P[ball * 3 + 1]! += sy; P[ball * 3 + 2]! += sz;
}
