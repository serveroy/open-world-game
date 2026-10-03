/**
 * Mission data schema (missions are authored as JSON in src/data/missions/*.json).
 * Steps run sequentially; "instant" steps complete immediately, objective steps wait.
 */
export interface Line {
  who: string;
  text: string;
  dur?: number;
}

export interface Shot {
  /** Absolute camera position & look target … */
  pos?: [number, number, number];
  look?: [number, number, number];
  /** … or orbit around a tagged entity / the player ("player") */
  orbit?: string;
  dist?: number;
  height?: number;
  angle?: number;
  dur: number;
  fov?: number;
}

export type AppearanceKey = 'civil' | 'gang' | 'cop' | 'swat' | 'thug' | 'biker' | 'worker' | `story:${string}`;

export type Step =
  | { type: 'dialogue'; lines: Line[]; shots?: Shot[]; letterbox?: boolean }
  | { type: 'cutscene'; shots: Shot[]; lines?: Line[] }
  | { type: 'goto'; x: number; z: number; y?: number; radius?: number; text: string; vehicle?: boolean; onFoot?: boolean; kind?: 'car' | 'boat' | 'heli' | 'bike'; tag?: string; help?: string; marker?: boolean }
  | { type: 'enterVehicle'; tag: string; text: string; help?: string }
  | { type: 'enterAny'; text: string; kind?: 'car' | 'boat' | 'heli' | 'bike'; hot?: number; police?: boolean; help?: string }
  | { type: 'spawnVehicle'; tag: string; def: string; x: number; z: number; yaw?: number; y?: number; paint?: number; locked?: boolean; driver?: AppearanceKey; driverTag?: string; health?: number; persistent?: boolean }
  | { type: 'spawnPed'; tag: string; x: number; z: number; yaw?: number; app: AppearanceKey; weapon?: string; hostile?: boolean; health?: number; armor?: number; state?: 'idle' | 'guard' | 'patrol' | 'dance' | 'talk' | 'sit' | 'cower' | 'follow'; name?: string }
  | { type: 'spawnGroup'; tag: string; count: number; x: number; z: number; r?: number; app: AppearanceKey; weapon?: string; hostile?: boolean; health?: number; armor?: number; state?: 'idle' | 'guard' | 'patrol' }
  | { type: 'kill'; tag: string; text: string; count?: number; help?: string }
  | { type: 'destroy'; tag: string; text: string }
  | { type: 'deliver'; tag: string; x: number; z: number; radius?: number; text: string; minHealth?: number }
  | { type: 'follow'; tag: string; text: string; route: [number, number][]; speed?: number; maxDist?: number; minDist?: number }
  | { type: 'chase'; tag: string; text: string; route: [number, number][]; speed?: number; catchDist?: number; escape?: boolean; maxDist?: number }
  | { type: 'escort'; tag: string; x: number; z: number; radius?: number; text: string }
  | { type: 'survive'; time: number; text: string; waves?: { at: number; tag: string; count: number; x: number; z: number; r?: number; app: AppearanceKey; weapon?: string; vehicle?: string }[] }
  | { type: 'wanted'; stars: number; text?: string; lock?: boolean }
  | { type: 'loseWanted'; text: string }
  | { type: 'timer'; time: number; label?: string }
  | { type: 'clearTimer' }
  | { type: 'collect'; items: [number, number][]; text: string; tag?: string; atTag?: string }
  | { type: 'stealth'; x: number; z: number; radius?: number; text: string; guards: string; detect?: number }
  | { type: 'wait'; time: number }
  | { type: 'checkpoint'; x: number; z: number; yaw?: number; vehicle?: string; y?: number }
  | { type: 'choice'; text: string; options: { label: string; flag: string; value: string }[] }
  | { type: 'branch'; flag: string; value: string; mission: string }
  | { type: 'setFlag'; flag: string; value: string }
  | { type: 'give'; weapon: string; ammo?: number }
  | { type: 'cash'; amount: number }
  | { type: 'armor'; amount: number }
  | { type: 'teleport'; x: number; z: number; yaw?: number; y?: number; vehicle?: string }
  | { type: 'time'; hour: number }
  | { type: 'weather'; kind: 'clear' | 'cloudy' | 'rain' | 'storm' | 'sandstorm' | 'fog' }
  | { type: 'despawn'; tag: string }
  | { type: 'drive'; tag: string; route: [number, number][]; speed?: number; loop?: boolean; aggressive?: boolean }
  | { type: 'pedAction'; tag: string; action: 'follow' | 'flee' | 'fight' | 'enterPlayerVehicle' | 'idle' | 'leaveVehicle' | 'dance' | 'handsup' | 'cower' | 'hostile' }
  | { type: 'fadeOut'; time?: number }
  | { type: 'fadeIn'; time?: number }
  | { type: 'help'; text: string; time?: number }
  | { type: 'unlock'; what: 'property' | 'contact' | 'shop' | 'weapon'; id: string }
  | { type: 'hint'; text: string };

export interface FailRule {
  type: 'dead' | 'destroyed' | 'far' | 'timer' | 'spotted' | 'arrives';
  tag?: string;
  dist?: number;
  text?: string;
}

export interface MissionDef {
  id: string;
  act: 1 | 2 | 3;
  title: string;
  giver: string;
  /** Start marker; mission begins when the player steps into it. */
  start: { x: number; z: number; radius?: number };
  requires: string[];
  /** Mission only available when a flag has a value (endings). */
  requiresFlag?: { flag: string; value: string };
  reward: number;
  hour?: number;
  weather?: 'clear' | 'cloudy' | 'rain' | 'storm' | 'sandstorm' | 'fog';
  summary: string;
  steps: Step[];
  fail?: FailRule[];
  /** Ending missions roll credits. */
  ending?: 'A' | 'B';
}

const STEP_FIELDS: Record<string, string[]> = {
  dialogue: ['lines'], cutscene: ['shots'], goto: ['x', 'z', 'text'], enterVehicle: ['tag', 'text'], enterAny: ['text'],
  spawnVehicle: ['tag', 'def', 'x', 'z'], spawnPed: ['tag', 'x', 'z', 'app'], spawnGroup: ['tag', 'count', 'x', 'z', 'app'],
  kill: ['tag', 'text'], destroy: ['tag', 'text'], deliver: ['tag', 'x', 'z', 'text'], follow: ['tag', 'text', 'route'],
  chase: ['tag', 'text', 'route'], escort: ['tag', 'x', 'z', 'text'], survive: ['time', 'text'], wanted: ['stars'], loseWanted: ['text'],
  timer: ['time'], clearTimer: [], collect: ['items', 'text'], stealth: ['x', 'z', 'text', 'guards'], wait: ['time'], checkpoint: ['x', 'z'],
  choice: ['text', 'options'], branch: ['flag', 'value', 'mission'], setFlag: ['flag', 'value'], give: ['weapon'], cash: ['amount'], armor: ['amount'],
  teleport: ['x', 'z'], time: ['hour'], weather: ['kind'], despawn: ['tag'], drive: ['tag', 'route'], pedAction: ['tag', 'action'],
  fadeOut: [], fadeIn: [], help: ['text'], unlock: ['what', 'id'], hint: ['text'],
};

/** Validate a mission definition; returns a list of problems (empty = valid). */
export function validateMission(m: MissionDef, known: { vehicles: Set<string>; weapons: Set<string>; missions: Set<string> }): string[] {
  const errs: string[] = [];
  const req = (cond: boolean, msg: string): void => {
    if (!cond) errs.push(`${m.id ?? '?'}: ${msg}`);
  };
  req(typeof m.id === 'string' && m.id.length > 0, 'missing id');
  req(typeof m.title === 'string', 'missing title');
  req([1, 2, 3].includes(m.act), 'bad act');
  req(Array.isArray(m.steps) && m.steps.length > 0, 'no steps');
  req(!!m.start && typeof m.start.x === 'number', 'missing start');
  for (const r of m.requires ?? []) req(known.missions.has(r), `unknown prerequisite ${r}`);
  const tags = new Set<string>(['player']);
  (m.steps ?? []).forEach((s, i) => {
    const fields = STEP_FIELDS[s.type];
    if (!fields) {
      errs.push(`${m.id}: step ${i} unknown type ${(s as { type: string }).type}`);
      return;
    }
    for (const f of fields) req((s as unknown as Record<string, unknown>)[f] !== undefined, `step ${i} (${s.type}) missing ${f}`);
    if (s.type === 'spawnVehicle') {
      req(known.vehicles.has(s.def), `step ${i} unknown vehicle ${s.def}`);
      tags.add(s.tag);
      if (s.driverTag) tags.add(s.driverTag);
    }
    if (s.type === 'spawnPed' || s.type === 'spawnGroup') {
      tags.add(s.tag);
      if (s.weapon) req(known.weapons.has(s.weapon), `step ${i} unknown weapon ${s.weapon}`);
    }
    if (s.type === 'survive') for (const w of s.waves ?? []) {
      tags.add(w.tag);
      if (w.vehicle) req(known.vehicles.has(w.vehicle), `step ${i} unknown wave vehicle ${w.vehicle}`);
    }
    if (s.type === 'give') req(known.weapons.has(s.weapon), `step ${i} unknown weapon ${s.weapon}`);
    if (s.type === 'checkpoint' && s.vehicle) req(known.vehicles.has(s.vehicle), `step ${i} unknown checkpoint vehicle ${s.vehicle}`);
    if (s.type === 'teleport' && s.vehicle) req(known.vehicles.has(s.vehicle), `step ${i} unknown teleport vehicle ${s.vehicle}`);
    if (s.type === 'collect') tags.add(s.tag ?? 'collect');
    const tagged = ['kill', 'destroy', 'deliver', 'follow', 'chase', 'escort', 'enterVehicle', 'despawn', 'drive', 'pedAction'];
    if (tagged.includes(s.type)) req(tags.has((s as { tag: string }).tag), `step ${i} (${s.type}) references unknown tag ${(s as { tag: string }).tag}`);
    if (s.type === 'stealth') req(tags.has(s.guards), `step ${i} unknown guards ${s.guards}`);
    if (s.type === 'branch') req(known.missions.has(s.mission), `step ${i} unknown branch mission ${s.mission}`);
    if (s.type === 'dialogue') for (const l of s.lines) req(typeof l.who === 'string' && typeof l.text === 'string', `step ${i} bad line`);
  });
  for (const f of m.fail ?? []) if (f.tag) req(tags.has(f.tag), `fail rule references unknown tag ${f.tag}`);
  return errs;
}
