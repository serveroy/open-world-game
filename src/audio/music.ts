/** Pure procedural-music theory for the radio stations (seeded, unit-testable). */
import { Rng } from '../core/rng';

export type StationId = 'neon' | 'dust' | 'lowtide';

export interface StationDef {
  id: StationId;
  name: string;
  tagline: string;
  bpm: [number, number];
  /** 0 = straight, 0.33 = triplet shuffle */
  swing: number;
  mode: 'minor' | 'major' | 'dorian' | 'mixolydian';
  rootRange: [number, number];
}

export const STATIONS: StationDef[] = [
  { id: 'neon', name: 'NEON FM 101.9', tagline: 'Synthwave for the night shift', bpm: [104, 118], swing: 0, mode: 'minor', rootRange: [40, 46] },
  { id: 'dust', name: 'DUST RADIO 88.4', tagline: 'Desert twang & highway blues', bpm: [88, 100], swing: 0.3, mode: 'mixolydian', rootRange: [38, 45] },
  { id: 'lowtide', name: 'LOW TIDE 94.2', tagline: 'Lo-fi beats from the boardwalk', bpm: [74, 86], swing: 0.18, mode: 'dorian', rootRange: [41, 47] },
];

const MODES: Record<StationDef['mode'], number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** MIDI notes of a scale starting at root, spanning `octaves`. */
export function scaleNotes(root: number, mode: StationDef['mode'], octaves = 2): number[] {
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) for (const s of MODES[mode]) out.push(root + o * 12 + s);
  out.push(root + octaves * 12);
  return out;
}

/** Triad (or 7th) on a scale degree (0-based). */
export function chordOn(root: number, mode: StationDef['mode'], degree: number, seventh = false): number[] {
  const sc = MODES[mode];
  const n = (k: number): number => {
    const d = degree + k;
    return root + sc[d % 7]! + Math.floor(d / 7) * 12;
  };
  return seventh ? [n(0), n(2), n(4), n(6)] : [n(0), n(2), n(4)];
}

const PROGRESSIONS: Record<StationId, number[][]> = {
  neon: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6], [5, 3, 0, 4]],
  dust: [[0, 3, 0, 4], [0, 6, 3, 0], [0, 3, 4, 3], [0, 4, 6, 3]],
  lowtide: [[1, 4, 0, 5], [0, 3, 1, 4], [3, 4, 2, 5], [1, 4, 2, 5]],
};

export type SectionKind = 'intro' | 'verse' | 'chorus' | 'bridge' | 'outro';

export interface Section {
  kind: SectionKind;
  bars: number;
  /** Chord degrees cycled one per bar. */
  prog: number[];
  /** 0..1 arrangement density (which instruments play). */
  energy: number;
}

export interface Song {
  title: string;
  artist: string;
  station: StationId;
  bpm: number;
  swing: number;
  root: number;
  mode: StationDef['mode'];
  /** Chord degrees, one per bar. */
  progression: number[];
  /** 16-step drum patterns (1 = hit, 0.5 = ghost). */
  kick: number[];
  snare: number[];
  hat: number[];
  /** Bass: scale-degree offsets per 16th (null = rest), relative to the bar chord root. */
  bass: (number | null)[];
  /** Lead melody over 4 bars (64 16ths): MIDI note or null. */
  lead: (number | null)[];
  /** Bars before the song changes (sum of section bars). */
  bars: number;
  /** Song form: intro, verses, choruses, bridge, outro. */
  sections: Section[];
  /** Chorus "vocal" hook over 2 bars (32 16ths), MIDI or null; sung on vowels. */
  hook: (number | null)[];
  vocalFemale: boolean;
}

const ARTIST_A = ['The', 'DJ', 'Lady', 'Johnny', 'Marisol', 'Static', 'Midnight', 'Coastal', 'Velvet', 'Rio', 'Neon', 'Desert'];
const ARTIST_B = ['Saints', 'Kestrel', 'Hollow Pines', 'Riptide', 'Cassette', 'Mirage', 'Vela', 'Dune Riders', 'Low Fidelity', 'Palms', 'Avenues', 'Gold Coast'];

export function artistName(rng: Rng): string {
  return `${rng.pick(ARTIST_A)} ${rng.pick(ARTIST_B)}`;
}

/** Standard pop form; section lengths in bars. */
export function songForm(rng: Rng, verse: number[], chorus: number[]): Section[] {
  const bridge = [verse[2] ?? 3, verse[3] ?? 4, chorus[0] ?? 0, chorus[3] ?? 4];
  const s: Section[] = [
    { kind: 'intro', bars: 4, prog: chorus, energy: 0.25 },
    { kind: 'verse', bars: 8, prog: verse, energy: 0.6 },
    { kind: 'chorus', bars: 8, prog: chorus, energy: 1 },
    { kind: 'verse', bars: 8, prog: verse, energy: 0.65 },
    { kind: 'chorus', bars: 8, prog: chorus, energy: 1 },
  ];
  if (rng.chance(0.75)) s.push({ kind: 'bridge', bars: 4, prog: bridge, energy: 0.35 });
  s.push({ kind: 'chorus', bars: 8, prog: chorus, energy: 1 }, { kind: 'outro', bars: 4, prog: chorus, energy: 0.3 });
  return s;
}

/** Section active at a bar index (clamped to the last section). */
export function sectionAt(song: Pick<Song, 'sections'>, bar: number): { section: Section; barInSection: number } {
  let b = bar;
  for (const sec of song.sections) {
    if (b < sec.bars) return { section: sec, barInSection: b };
    b -= sec.bars;
  }
  const last = song.sections[song.sections.length - 1]!;
  return { section: last, barInSection: last.bars - 1 };
}

/** A singable 2-bar chorus hook: stepwise, on chord tones on strong beats, ends on the tonic. */
function hookLine(rng: Rng, root: number, mode: StationDef['mode']): (number | null)[] {
  const sc = scaleNotes(root, mode, 2);
  const out: (number | null)[] = new Array(32).fill(null);
  const rhythm = rng.pick([
    [0, 3, 6, 8, 10, 12, 16, 19, 22, 24, 26],
    [0, 2, 4, 6, 8, 12, 16, 18, 20, 22, 24],
    [0, 4, 6, 8, 12, 14, 16, 20, 22, 24, 28],
  ]);
  let idx = rng.int(4, 7);
  for (const step of rhythm) {
    if (step % 8 === 0) idx = [4, 6, 7, 9][rng.int(0, 3)]!; // chord tones on the beat
    else idx = Math.max(2, Math.min(9, idx + rng.pick([-1, -1, 1, 1, 2, -2])));
    out[step] = sc[idx]!;
  }
  out[rhythm[rhythm.length - 1]!] = sc[7]!; // resolve to the octave tonic
  return out;
}

const WORDS_A = ['Midnight', 'Neon', 'Coastal', 'Velvet', 'Crimson', 'Silver', 'Desert', 'Lonely', 'Electric', 'Salt', 'Paper', 'Golden', 'Broken', 'Highway', 'Harbor'];
const WORDS_B = ['Drive', 'Protocol', 'Heart', 'Mirage', 'Signal', 'Lights', 'Rider', 'Tide', 'Motel', 'Dreams', 'Static', 'Sunset', 'Getaway', 'Avenue', 'Echoes'];

export function songTitle(rng: Rng): string {
  return `${rng.pick(WORDS_A)} ${rng.pick(WORDS_B)}`;
}

function drums(rng: Rng, st: StationId): { kick: number[]; snare: number[]; hat: number[] } {
  const kick = new Array(16).fill(0), snare = new Array(16).fill(0), hat = new Array(16).fill(0);
  if (st === 'neon') {
    for (const i of [0, 4, 8, 12]) kick[i] = 1;
    if (rng.chance(0.5)) kick[14] = 0.6;
    snare[4] = snare[12] = 1;
    for (let i = 0; i < 16; i += 2) hat[i] = 0.6;
    for (let i = 1; i < 16; i += 2) hat[i] = rng.chance(0.4) ? 0.35 : 0;
  } else if (st === 'dust') {
    kick[0] = kick[8] = 1;
    if (rng.chance(0.6)) kick[10] = 0.7;
    snare[4] = snare[12] = 1;
    for (let i = 0; i < 16; i += 2) hat[i] = 0.5;
  } else {
    kick[0] = 1;
    kick[rng.pick([7, 10])] = 0.8;
    if (rng.chance(0.5)) kick[3] = 0.5;
    snare[4] = snare[12] = 1;
    if (rng.chance(0.5)) snare[15] = 0.4;
    for (let i = 0; i < 16; i += 2) hat[i] = 0.45;
    for (let i = 1; i < 16; i += 4) hat[i] = 0.25;
  }
  return { kick, snare, hat };
}

function bassLine(rng: Rng, st: StationId): (number | null)[] {
  const b: (number | null)[] = new Array(16).fill(null);
  if (st === 'neon') {
    // driving 8ths with octave jumps
    for (let i = 0; i < 16; i += 2) b[i] = rng.chance(0.25) ? 7 : 0;
  } else if (st === 'dust') {
    // root-fifth walk
    b[0] = 0; b[4] = 4; b[8] = 0; b[12] = rng.chance(0.5) ? 4 : 5;
    if (rng.chance(0.5)) b[14] = 6;
  } else {
    b[0] = 0; b[6] = rng.chance(0.5) ? 0 : 2; b[10] = 4; if (rng.chance(0.5)) b[14] = 3;
  }
  return b;
}

function melody(rng: Rng, notes: number[], st: StationId): (number | null)[] {
  const out: (number | null)[] = new Array(64).fill(null);
  // pentatonic-ish subset (drop 2nd & 6th degree) for consonance
  const pool = notes.filter((_, i) => i % 7 !== 1 && i % 7 !== 5);
  let idx = Math.floor(pool.length / 2);
  const density = st === 'neon' ? 0.55 : st === 'dust' ? 0.35 : 0.3;
  const motif: (number | null)[] = [];
  for (let i = 0; i < 16; i++) {
    if (rng.chance(i % 4 === 0 ? density + 0.25 : density * 0.7)) {
      idx = Math.max(0, Math.min(pool.length - 1, idx + rng.pick([-2, -1, -1, 0, 1, 1, 2])));
      motif.push(pool[idx]!);
    } else motif.push(null);
  }
  // A A' A B structure
  for (let bar = 0; bar < 4; bar++) {
    for (let i = 0; i < 16; i++) {
      let n = motif[i] ?? null;
      if (bar === 1 && n !== null && i >= 12) n = pool[Math.max(0, pool.indexOf(n) - 1)] ?? n;
      if (bar === 3 && n !== null && i >= 8) n = pool[Math.min(pool.length - 1, pool.indexOf(n) + 1)] ?? n;
      out[bar * 16 + i] = n;
    }
  }
  return out;
}

export function makeSong(station: StationDef, seed: number): Song {
  const rng = new Rng(seed);
  const root = rng.int(station.rootRange[0], station.rootRange[1]);
  const progs = PROGRESSIONS[station.id];
  const prog = rng.pick(progs);
  const chorusProg = progs[(progs.indexOf(prog) + 1 + rng.int(0, progs.length - 2)) % progs.length]!;
  const d = drums(rng, station.id);
  const sections = songForm(rng, prog, chorusProg);
  const vocalFemale = rng.chance(0.55);
  return {
    title: songTitle(rng),
    artist: artistName(rng),
    station: station.id,
    bpm: rng.int(station.bpm[0], station.bpm[1]),
    swing: station.swing,
    root,
    mode: station.mode,
    progression: [...prog],
    ...d,
    bass: bassLine(rng, station.id),
    lead: melody(rng, scaleNotes(root + 24, station.mode, 2), station.id),
    sections,
    bars: sections.reduce((a, s) => a + s.bars, 0),
    hook: hookLine(rng, root + (vocalFemale ? 24 : 12), station.mode),
    vocalFemale,
  };
}

/** Seconds per 16th note with swing applied to odd steps. */
export function stepTime(bpm: number, swing: number, step: number): number {
  const s16 = 60 / bpm / 4;
  const pair = Math.floor(step / 2) * s16 * 2;
  return step % 2 === 0 ? pair : pair + s16 * (1 + swing);
}
