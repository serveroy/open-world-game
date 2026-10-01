import { describe, expect, it } from 'vitest';
import { STATIONS, chordOn, makeSong, midiToFreq, scaleNotes, sectionAt, stepTime } from '../src/audio/music';
import { encodeWav, normalize } from '../src/audio/wav';

describe('procedural music', () => {
  it('maps MIDI to frequency', () => {
    expect(midiToFreq(69)).toBeCloseTo(440);
    expect(midiToFreq(81)).toBeCloseTo(880);
  });

  it('builds scales and diatonic chords', () => {
    expect(scaleNotes(60, 'major', 1)).toEqual([60, 62, 64, 65, 67, 69, 71, 72]);
    expect(chordOn(60, 'major', 0)).toEqual([60, 64, 67]);
    expect(chordOn(60, 'major', 4, true)).toEqual([67, 71, 74, 77]); // G7
    expect(chordOn(57, 'minor', 0)).toEqual([57, 60, 64]);
  });

  it('generates deterministic, well-formed songs for every station', () => {
    for (const st of STATIONS) {
      const a = makeSong(st, 42), b = makeSong(st, 42), c = makeSong(st, 43);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).not.toEqual(JSON.stringify(c));
      expect(a.kick).toHaveLength(16);
      expect(a.bass).toHaveLength(16);
      expect(a.lead).toHaveLength(64);
      expect(a.bpm).toBeGreaterThanOrEqual(st.bpm[0]);
      expect(a.bpm).toBeLessThanOrEqual(st.bpm[1]);
      expect(a.kick[0]).toBe(1);
      // lead stays in a singable range
      for (const n of a.lead) if (n !== null) expect(n).toBeGreaterThan(40), expect(n).toBeLessThan(110);
    }
  });

  it('songs have a real form: intro, verse/chorus alternation, outro', () => {
    for (const st of STATIONS) {
      for (let seed = 1; seed < 20; seed++) {
        const s = makeSong(st, seed);
        const kinds = s.sections.map((x) => x.kind);
        expect(kinds[0]).toBe('intro');
        expect(kinds[kinds.length - 1]).toBe('outro');
        expect(kinds.filter((k) => k === 'chorus').length).toBeGreaterThanOrEqual(3);
        expect(s.bars).toBe(s.sections.reduce((a, x) => a + x.bars, 0));
        expect(s.artist.length).toBeGreaterThan(3);
        // chorus uses a different progression than the verse
        const verse = s.sections.find((x) => x.kind === 'verse')!, chorus = s.sections.find((x) => x.kind === 'chorus')!;
        expect(verse.prog).not.toEqual(chorus.prog);
        // the sung hook stays in a human vocal range
        const notes = s.hook.filter((n): n is number => n !== null);
        expect(notes.length).toBeGreaterThanOrEqual(8);
        for (const n of notes) {
          expect(n).toBeGreaterThanOrEqual(s.vocalFemale ? 60 : 48);
          expect(n).toBeLessThanOrEqual(s.vocalFemale ? 86 : 74);
        }
      }
    }
  });

  it('finds the section for a bar', () => {
    const s = makeSong(STATIONS[0]!, 5);
    expect(sectionAt(s, 0).section.kind).toBe('intro');
    expect(sectionAt(s, 4)).toEqual({ section: s.sections[1], barInSection: 0 });
    expect(sectionAt(s, 9999).section.kind).toBe('outro');
  });

  it('applies swing to off-beats only', () => {
    const s16 = 60 / 120 / 4;
    expect(stepTime(120, 0, 2)).toBeCloseTo(2 * s16);
    expect(stepTime(120, 0.3, 2)).toBeCloseTo(2 * s16);
    expect(stepTime(120, 0.3, 3)).toBeCloseTo(2 * s16 + 1.3 * s16);
  });
});

describe('wav encoding', () => {
  it('writes a valid 16-bit mono header and clamps samples', () => {
    const s = new Float32Array([0, 0.5, -0.5, 2, -2]);
    const w = encodeWav(s, 22050);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...w.subarray(8, 12))).toBe('WAVE');
    expect(v.getUint32(24, true)).toBe(22050);
    expect(v.getUint16(34, true)).toBe(16);
    expect(v.getUint32(40, true)).toBe(10);
    expect(v.getInt16(44 + 6, true)).toBe(32767);
    expect(v.getInt16(44 + 8, true)).toBe(-32768);
  });

  it('normalises to the requested peak', () => {
    const s = normalize(new Float32Array([0.1, -0.2, 0.05]), 0.8);
    expect(Math.max(...s.map(Math.abs))).toBeCloseTo(0.8);
  });
});
