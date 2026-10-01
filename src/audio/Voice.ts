import { CHARACTERS } from '../data/characters';
import { hash2 } from '../core/rng';

export type VoiceMode = 'speech' | 'babble' | 'off';

const FEMALE_HINTS = /samantha|karen|moira|tessa|victoria|fiona|serena|susan|allison|ava|zira|female|hazel|kate|libby|sonia|natasha|jenny|aria|google uk english female|google us english/i;
const MALE_HINTS = /daniel|alex|fred|rishi|tom|aaron|arthur|oliver|male|david|mark|george|ryan|guy|google uk english male/i;

export interface Speaker {
  female: boolean;
  /** 0..1 stable per speaker, picks voice & pitch variation */
  seed: number;
}

/** Who is speaking: story characters by (first/nick) name, otherwise a stable hash. */
export function speakerFor(who: string | null): Speaker {
  const w = (who ?? '').trim().toLowerCase();
  for (const c of Object.values(CHARACTERS)) {
    const n = c.name.toLowerCase();
    if (w && (n.includes(w) || c.id === w)) return { female: c.app.female, seed: (hash2(c.id.length * 31, c.id.charCodeAt(0)) % 1000) / 1000 };
  }
  const h = hash2(w.length + 7, (w.charCodeAt(0) || 1) * 13 + (w.charCodeAt(1) || 0));
  return { female: w === 'victim' ? h % 3 !== 0 : h % 2 === 0, seed: (h % 1000) / 1000 };
}

/**
 * Spoken dialogue through the device's speech engine (Web Speech API). Each speaker gets a
 * stable voice and pitch; when no speech engine is available the caller falls back to babble.
 */
export class SpeechVoice {
  private voices: SpeechSynthesisVoice[] = [];
  private synth: SpeechSynthesis | null;
  private primed = false;
  private current: SpeechSynthesisUtterance | null = null;

  constructor() {
    this.synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    const load = (): void => {
      this.voices = (this.synth?.getVoices() ?? []).filter((v) => /^en(-|_|$)/i.test(v.lang));
    };
    load();
    this.synth?.addEventListener?.('voiceschanged', load);
  }

  get available(): boolean {
    return !!this.synth && this.voices.length > 0;
  }

  get speaking(): boolean {
    return !!this.current && !!this.synth?.speaking;
  }

  /** iOS only allows speech after a gesture-initiated utterance. */
  prime(): void {
    if (this.primed || !this.synth) return;
    this.primed = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      this.synth.speak(u);
    } catch {
      /* ignore */
    }
    if (!this.voices.length) this.voices = this.synth.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang));
  }

  private pick(s: Speaker): SpeechSynthesisVoice | null {
    if (!this.voices.length) return null;
    const pool = this.voices.filter((v) => (s.female ? FEMALE_HINTS : MALE_HINTS).test(v.name));
    const list = pool.length ? pool : this.voices;
    return list[Math.floor(s.seed * list.length) % list.length] ?? null;
  }

  speak(text: string, s: Speaker, volume: number): boolean {
    if (!this.synth || !this.available || volume <= 0) return false;
    try {
      this.synth.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g, ''));
      const v = this.pick(s);
      if (v) u.voice = v;
      // pitch keeps characters apart even when the device has only a couple of voices
      u.pitch = s.female ? 1.05 + s.seed * 0.25 : 0.75 + s.seed * 0.3;
      u.rate = 1.04;
      u.volume = Math.min(1, volume);
      u.onend = u.onerror = () => {
        if (this.current === u) this.current = null;
      };
      this.current = u;
      this.synth.speak(u);
      return true;
    } catch {
      return false;
    }
  }

  cancel(): void {
    this.current = null;
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
  }
}
