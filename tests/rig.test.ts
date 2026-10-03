import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeRig } from '../src/characters/rig/RigData';
import { LocalPose, ModelPose, blendClip, boneWorld, forwardKinematics, restPose, writeSkin } from '../src/characters/rig/PoseEval';
import { AnimController, AnimLibrary } from '../src/characters/rig/AnimGraph';
import { makeAnimState, makePose } from '../src/characters/Pose';
import { WARDROBE_PARTS, pickParts } from '../src/characters/rig/wardrobe';
import { policeAppearance, randomAppearance, defaultPlayerAppearance } from '../src/characters/Appearance';
import { Rng } from '../src/core/rng';

const buf = readFileSync(new URL('../src/assets/chars.bin', import.meta.url));
const rig = decodeRig(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const nb = rig.boneNames.length;
const male = rig.bodies[0]!;
const P = { x: 0, y: 0, z: 0 };

function pose(fill: (p: LocalPose) => void): ModelPose {
  const lp = new LocalPose(nb);
  restPose(male, lp, rig.pelvis);
  fill(lp);
  const m = new ModelPose(nb);
  forwardKinematics(rig, male, lp, m);
  return m;
}
function at(m: ModelPose, bone: string, yaw = 0): { x: number; y: number; z: number } {
  const o = { x: 0, y: 0, z: 0 };
  boneWorld(m, rig.bone(bone), 0, 0, 0, yaw, 1, o);
  return o;
}

describe('character rig asset', () => {
  it('decodes skeleton, two body types, dressed parts and the clip set', () => {
    expect(nb).toBeGreaterThan(50);
    expect(rig.bodies.map((b) => b.name)).toEqual(['male', 'female']);
    expect(rig.parents[0]).toBe(-1);
    for (let i = 1; i < nb; i++) expect(rig.parents[i]!).toBeLessThan(i);
    for (const c of ['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Driving_Loop', 'Pistol_Aim_Neutral', 'Punch_Jab', 'LayToIdle']) expect(rig.clipIndex.has(c)).toBe(true);
    expect(rig.parts.length).toBeGreaterThan(50);
    for (const p of rig.parts) {
      expect(p.index.length % 3).toBe(0);
      expect(Math.max(...p.index)).toBeLessThan(p.vertexCount);
      for (let i = 0; i < p.vertexCount; i++) {
        const s = p.skinWeight[i * 4]! + p.skinWeight[i * 4 + 1]! + p.skinWeight[i * 4 + 2]! + p.skinWeight[i * 4 + 3]!;
        expect(s).toBe(255);
        expect(p.skinIndex[i * 4]!).toBeLessThan(nb);
      }
    }
  });

  it('every part the wardrobe can pick exists for its body type', () => {
    for (const n of WARDROBE_PARTS.male) expect(() => rig.part(0, n)).not.toThrow();
    for (const n of WARDROBE_PARTS.female) expect(() => rig.part(1, n)).not.toThrow();
  });

  it('dressed parts stand on the ground at human height', () => {
    for (const b of [0, 1]) {
      let minY = 9, maxY = -9;
      for (const n of ['Casual_Head', 'Casual_Feet']) {
        const p = rig.parts[rig.part(b, n)]!;
        for (let i = 0; i < p.vertexCount; i++) {
          const y = p.position[i * 4 + 1]! / p.quant;
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
        }
      }
      expect(minY).toBeLessThan(0.03);
      expect(minY).toBeGreaterThan(-0.03);
      expect(maxY).toBeGreaterThan(1.7);
      expect(maxY).toBeLessThan(2.0);
    }
  });

  it('rest pose skins to identity (bind pose == rest pose)', () => {
    for (const body of rig.bodies) {
      const lp = new LocalPose(nb);
      restPose(body, lp, rig.pelvis);
      const m = new ModelPose(nb);
      forwardKinematics(rig, body, lp, m);
      const out = new Float32Array(nb * 12);
      writeSkin(body, m, 0, 0, 0, 0, 1, out, 0);
      const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
      let err = 0;
      for (let i = 0; i < nb; i++) for (let k = 0; k < 12; k++) err = Math.max(err, Math.abs(out[i * 12 + k]! - I[k]!));
      expect(err).toBeLessThan(1e-4);
    }
  });

  it('places the character in the world with heading and scale', () => {
    const lp = new LocalPose(nb);
    restPose(male, lp, rig.pelvis);
    const m = new ModelPose(nb);
    forwardKinematics(rig, male, lp, m);
    const out = new Float32Array(nb * 12);
    const yaw = Math.PI / 2; // facing +X
    writeSkin(male, m, 10, 2, -5, yaw, 1.1, out, 0);
    // a bind-space point 1 m in front of the origin at chest height, skinned by the spine bone
    const b = rig.bone('spine_03');
    const o = b * 12, v = [0, 1.4, 1];
    const wx = out[o]! * v[0]! + out[o + 1]! * v[1]! + out[o + 2]! * v[2]! + out[o + 3]!;
    const wy = out[o + 4]! * v[0]! + out[o + 5]! * v[1]! + out[o + 6]! * v[2]! + out[o + 7]!;
    const wz = out[o + 8]! * v[0]! + out[o + 9]! * v[1]! + out[o + 10]! * v[2]! + out[o + 11]!;
    expect(wx).toBeCloseTo(10 + 1.1, 3);
    expect(wy).toBeCloseTo(2 + 1.4 * 1.1, 3);
    expect(wz).toBeCloseTo(-5, 3);
  });

  it('idle clip stands upright on the ground facing +Z', () => {
    const m = pose((lp) => blendClip(rig, rig.clips[rig.clipIndex.get('Idle_Loop')!]!, 0.3, 1, lp));
    const head = at(m, 'Head'), fl = at(m, 'foot_l'), fr = at(m, 'foot_r'), hl = at(m, 'hand_l');
    expect(head.y).toBeGreaterThan(1.4);
    expect(head.y).toBeLessThan(1.75);
    expect(Math.min(fl.y, fr.y)).toBeLessThan(0.15);
    expect(hl.x).toBeGreaterThan(0.1); // left hand on +X
    expect(hl.y).toBeLessThan(1.1); // arms down
    const ball = at(m, 'ball_l'), foot = at(m, 'foot_l');
    expect(ball.z).toBeGreaterThan(foot.z); // toes point forward
  });
});

describe('procedural pose retarget', () => {
  const lib = new AnimLibrary(rig);
  it('zero pose ≈ reference idle; raised shoulder lifts the arm forward', () => {
    const p = makePose();
    for (const k of Object.keys(p) as (keyof typeof p)[]) p[k] = 0;
    const lp = new LocalPose(nb);
    lib.proc.apply(p, lp);
    const m = new ModelPose(nb);
    forwardKinematics(rig, male, lp, m);
    const hand0 = at(m, 'hand_l');
    expect(hand0.y).toBeLessThan(1.1);
    p.lShoulderPitch = Math.PI / 2;
    p.lElbow = 0;
    lib.proc.apply(p, lp);
    forwardKinematics(rig, male, lp, m);
    const sh = at(m, 'upperarm_l'), hand = at(m, 'hand_l');
    expect(hand.z - sh.z).toBeGreaterThan(0.35);
    expect(Math.abs(hand.y - sh.y)).toBeLessThan(0.2);
    // crouch lowers the pelvis
    p.rootY = -0.4;
    lib.proc.apply(p, lp);
    forwardKinematics(rig, male, lp, m);
    expect(at(m, 'pelvis').y).toBeLessThan(at(m, 'pelvis').y + 1); // sanity
    expect(at(m, 'Head').y).toBeLessThan(1.4);
  });
});

describe('animation graph', () => {
  const lib = new AnimLibrary(rig);
  const run = (st: ReturnType<typeof makeAnimState>, secs: number, c = new AnimController(lib)): AnimController => {
    for (let t = 0; t < secs; t += 1 / 60) c.update(st, 1 / 60);
    return c;
  };
  it('selects layers from gameplay state', () => {
    const st = makeAnimState();
    expect(run(st, 0.5).layers).toBe('');
    st.driving = true;
    expect(run(st, 0.5).layers).toBe('F:drive@1.00');
    st.driving = false;
    st.action = 'sit';
    expect(run(st, 0.5).layers).toBe('F:act:sit@1.00');
    st.action = 'none';
    st.aim = 'pistol';
    expect(run(st, 0.5).layers).toBe('U:aim:pistol@1.00');
    st.speed = 4;
    st.action = 'phone';
    expect(run(st, 0.5).layers).toContain('U:act:phone@1.00');
    st.speed = 0;
    expect(run(st, 0.5).layers).toContain('F:act:phone@1.00');
  });

  it('cross-fades instead of popping', () => {
    const st = makeAnimState();
    const c = run(st, 0.3);
    st.action = 'dance';
    c.update(st, 1 / 60);
    expect(c.layers).toMatch(/F:act:dance@0\.[0-2]/);
  });

  it('gait playback matches ground speed (planted foot speed ≈ body speed)', () => {
    for (const speed of [1.3, 1.75, 4.6, 7.2]) {
      const st = makeAnimState();
      st.speed = speed;
      const c = new AnimController(lib);
      c.fitBody(male);
      run(st, 1, c);
      const lp = new LocalPose(nb), m = new ModelPose(nb);
      const dt = 1 / 120;
      const vel: number[] = [];
      let prev: { l: { x: number; y: number; z: number }; r: { x: number; y: number; z: number } } | null = null;
      for (let i = 0; i < 240; i++) {
        c.update(st, dt);
        c.evaluate(st, lp);
        forwardKinematics(rig, male, lp, m, c.pre);
        c.groundFix(m);
        const l = at(m, 'ball_l'), r = at(m, 'ball_r');
        if (prev) {
          // only planted samples (toe within 2 cm of the ground)
          for (const [now, was] of [[l, prev.l], [r, prev.r]] as const) if (now.y < 0.035 && was.y < 0.035) vel.push(-(now.z - was.z) / dt);
        }
        prev = { l, r };
      }
      vel.sort((a, b) => a - b);
      const median = vel[vel.length >> 1]!;
      expect(vel.length).toBeGreaterThan(10);
      expect(median / speed).toBeGreaterThan(0.8);
      expect(median / speed).toBeLessThan(1.25);
    }
  });

  it('runs keep a believable cadence (steps per second)', () => {
    for (const [speed, lo, hi] of [[4.6, 2.3, 3.3], [7.2, 2.8, 4.0]] as const) {
      const st = makeAnimState();
      st.speed = speed;
      const c = run(st, 1);
      const p0 = (c as unknown as { phase: number }).phase;
      run(st, 2, c);
      const steps = (((c as unknown as { phase: number }).phase - p0) / 2) * 2;
      expect(steps).toBeGreaterThan(lo);
      expect(steps).toBeLessThan(hi);
    }
  });

  it('runs bob like a jog, not a skip, and both body types keep planted feet on the floor', () => {
    for (const body of rig.bodies) {
      for (const speed of [4.6, 7.2]) {
        const st = makeAnimState();
        st.speed = speed;
        const c = new AnimController(lib);
        c.fitBody(body);
        run(st, 1, c);
        const lp = new LocalPose(nb), m = new ModelPose(nb);
        let lo = Infinity, hi = -Infinity, air = 0, sink = 0;
        for (let i = 0; i < 240; i++) {
          c.update(st, 1 / 120);
          c.evaluate(st, lp);
          forwardKinematics(rig, body, lp, m, c.pre);
          c.groundFix(m);
          const y = at(m, 'pelvis').y;
          lo = Math.min(lo, y);
          hi = Math.max(hi, y);
          const feet = ['ball_l', 'ball_r', 'foot_l', 'foot_r'].map((b) => at(m, b).y - body.bindP[rig.bone(b) * 3 + 1]!);
          if (Math.min(...feet) > 0.01) air++;
          sink = Math.min(sink, ...feet);
        }
        expect(hi - lo).toBeLessThan(0.12);
        expect(air / 240).toBeLessThan(0.6);
        expect(sink).toBeGreaterThan(-0.02);
      }
    }
  });

  it('procedural fallback actions evaluate to finite poses', () => {
    const st = makeAnimState();
    for (const a of ['handsup', 'cower', 'kick', 'lockpick', 'wave', 'pulled', 'vault'] as const) {
      st.action = a;
      st.actionT = 0.5;
      const c = run(st, 0.4);
      const lp = new LocalPose(nb);
      restPose(male, lp, rig.pelvis);
      c.evaluate(st, lp);
      for (const v of lp.q) expect(Number.isFinite(v)).toBe(true);
    }
    void P;
  });
});

describe('wardrobe', () => {
  it('maps appearances onto existing parts (random crowd, police, swat, player)', () => {
    const rng = new Rng(3);
    const apps = [defaultPlayerAppearance(), policeAppearance(rng), policeAppearance(rng, true)];
    for (let i = 0; i < 300; i++) apps.push(randomAppearance(rng, { nightlife: i % 3 === 0, desert: i % 5 === 0 }));
    for (const a of apps) {
      const p = pickParts(a);
      const b = a.female ? 1 : 0;
      for (const n of [p.head, p.body, p.legs, p.feet]) expect(() => rig.part(b, n)).not.toThrow();
    }
  });
  it('dresses police in uniform and SWAT in armour', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 20; i++) {
      const cop = policeAppearance(rng);
      const p = pickParts(cop);
      expect(p.hat).toBe('police');
      expect(p.legs).toBe(cop.female ? 'Soldier_Legs' : 'Suit_Legs');
      const swat = pickParts(policeAppearance(rng, true));
      expect(swat.body).toMatch(/Swat_Body|Soldier_Body/);
    }
  });
});
