/**
 * Live-demo captions paced to the avatar's audio (contracts §4.3 — the client sync rule).
 *
 * Azure sends the text of a spoken turn long before the avatar says it (`response.done` precedes the end of the audio by
 * 13–23 s), so a caption shown on arrival would run ahead of the voice by tens of seconds. `CaptionPacer` reveals it
 * as the audio plays:
 *
 *   1. the turn starts when the playback engine says so (`start`: TURN_START, or the first audible sample);
 *   2. word i appears at `start + audio_offset_ms(i)` from `response.audio_timestamp.delta`; without word timestamps the
 *      text is paced at the learned narration speed (`secondsPerChar`, default 13 characters a second);
 *   3. when the turn ends (`end`) the whole final text is shown — it replaces the accumulated deltas;
 *   4. a cancelled turn (`cancel`) is cleared;
 *   5. every sentence is reported once, whole, as it finishes revealing (`onSentence`) — for a visually hidden polite
 *      region, never word by word (sentences that finish together are reported together).
 *
 * Pure TypeScript with an injectable clock (no DOM): the host feeds the messages and calls `tick()` periodically.
 */
import type { DemoCaptionKind } from './demoProtocol';

export interface CaptionView {
  /** Azure response id of the spoken turn. */
  responseId: string;
  kind: DemoCaptionKind;
  slide: number | null;
  /** What has been said so far — the whole text once the turn ended. */
  text: string;
  /** The whole final text is showing. */
  complete: boolean;
}

export interface CaptionPacerOptions {
  /** Monotonic clock in ms (default performance.now) — the one the playback engine uses. */
  now?: () => number;
  /** Seconds per character of narration (default 1/13), for turns without word timestamps. */
  secondsPerChar?: () => number;
  /**
   * Safety net: a turn with text whose start was never signalled (no TURN_START, nothing audible) starts pacing this
   * long after its text first arrived, so the captions are never blank for a whole slide. Default 4000.
   */
  startFallbackMs?: number;
  onChange?: (view: CaptionView | null) => void;
  /** Whole sentences finished revealing (or the turn ended): once per sentence, in order, joined when several finish at once. */
  onSentence?: (sentence: string, view: CaptionView) => void;
}

export interface CaptionMessage { response_id: string; slide: number | null; kind: DemoCaptionKind; text: string; final: boolean }
export interface CaptionWordMessage { response_id: string; audio_offset_ms: number; text: string }

export interface Sentence {
  text: string;
  /** Index in the source text just after the sentence (terminator and closing quotes included). */
  end: number;
  /** Ends with a terminator (an unterminated tail is announced only once the turn ended). */
  terminated: boolean;
}

const LATIN_END = '.!?…';
const CJK_END = '。！？';
const CLOSERS = '"\'”’»)]}';

/**
 * Splits text into sentences. A Latin terminator ends a sentence only before whitespace or the end of the text, so
 * "3.5 million" stays whole, and a lone period before a lowercase word ("U.S.A. it", "e.g. this") does not end one either;
 * CJK terminators end a sentence wherever they are.
 */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const cjk = CJK_END.includes(ch);
    if (!cjk && !LATIN_END.includes(ch)) continue;
    let j = i + 1;
    while (j < text.length && (LATIN_END.includes(text[j]) || CJK_END.includes(text[j]))) j += 1;
    while (j < text.length && CLOSERS.includes(text[j])) j += 1;
    // "In the U.S.A. it doubled", "e.g. this": a lone period followed by a lowercase letter continues the sentence.
    const continues = ch === '.' && j === i + 1 && /^\p{Ll}/u.test(text.slice(j).trimStart());
    if (!continues && (cjk || j >= text.length || /\s/.test(text[j]))) {
      const sentence = text.slice(start, j).trim();
      if (sentence) out.push({ text: sentence, end: j, terminated: true });
      start = j;
    }
    i = j - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push({ text: tail, end: text.length, terminated: false });
  return out;
}

/** A word further than this from where the previous one ended is not where the timestamps say: skip it. */
const MAX_ALIGN_GAP = 60;
const TRAILING_PUNCTUATION = /[.,;:!?…。！？、，)\]}"'”’»—–-]/;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const KEEP_TURNS = 12;

interface Aligned { endPos: number; offsetMs: number }

class Turn {
  deltas = '';
  final: string | null = null;
  words: { text: string; offsetMs: number }[] = [];
  firstTextAt: number | null = null;
  startedAt: number | null = null;
  ended = false;
  /** Sentences already reported. */
  announced = 0;
  // Word → text alignment cache (rebuilt when the text is replaced by a different final text).
  alignedFrom = '';
  aligned: Aligned[] = [];
  nextWord = 0;
  cursor = 0;
  revealedWords = 0;

  constructor(public id: string, public kind: DemoCaptionKind = 'narration', public slide: number | null = null) {}

  get full(): string { return this.final ?? this.deltas; }
}

export class CaptionPacer {
  private readonly turns = new Map<string, Turn>();
  private shownId: string | null = null;
  private last: CaptionView | null = null;
  private readonly now: () => number;
  private readonly secondsPerChar: () => number;
  private readonly startFallbackMs: number;

  constructor(private readonly options: CaptionPacerOptions = {}) {
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.secondsPerChar = options.secondsPerChar ?? (() => 1 / 13);
    this.startFallbackMs = options.startFallbackMs ?? 4000;
  }

  /** `demo.caption`: a delta to append, or (final) the complete text that replaces the deltas. */
  caption(m: CaptionMessage): void {
    if (typeof m.response_id !== 'string' || typeof m.text !== 'string') return;
    const t = this.turnFor(m.response_id);
    t.kind = m.kind;
    t.slide = m.slide;
    if (m.final) t.final = m.text; else t.deltas += m.text;
    if (t.firstTextAt === null && t.full) t.firstTextAt = this.now();
    this.refresh();
  }

  /** `response.audio_timestamp.delta`: the word `text` starts `audio_offset_ms` into the turn's audio. */
  word(m: CaptionWordMessage): void {
    const offset = Number(m.audio_offset_ms);
    if (typeof m.response_id !== 'string' || typeof m.text !== 'string' || !Number.isFinite(offset)) return;
    this.turnFor(m.response_id).words.push({ text: m.text, offsetMs: Math.max(0, offset) });
    this.refresh();
  }

  /** The avatar started speaking this turn (TURN_START, or the first audible sample) at `at` (the host's clock). */
  start(responseId: string, at: number = this.now()): void {
    const t = this.turnFor(responseId);
    if (t.startedAt === null) t.startedAt = at;
    this.shownId = responseId;
    this.refresh();
  }

  /** The turn finished playing (or stalled, or the visitor pressed Continue): show the whole final text. */
  end(responseId?: string | null): void {
    const id = responseId ?? this.shownId;
    const t = id ? this.turns.get(id) : undefined;
    if (!t) return;
    t.ended = true;
    this.shownId = t.id;
    this.refresh();
    this.prune();
  }

  /** The turn was cancelled: its captions are cleared. */
  cancel(responseId?: string | null): void {
    const id = responseId ?? this.shownId;
    if (!id || !this.turns.delete(id)) return;
    if (this.shownId === id) this.shownId = null;
    this.refresh();
  }

  /** Forget everything (a new session). */
  reset(): void {
    this.turns.clear();
    this.shownId = null;
    this.refresh();
  }

  /** Reveal what is due; call every ~50–100 ms while a session is open. */
  tick(): void {
    this.refresh();
  }

  get view(): CaptionView | null {
    return this.last;
  }

  private turnFor(id: string): Turn {
    let t = this.turns.get(id);
    if (!t) {
      t = new Turn(id);
      this.turns.set(id, t);
    }
    return t;
  }

  private prune(): void {
    if (this.turns.size <= KEEP_TURNS) return;
    for (const [id, t] of this.turns) {
      if (this.turns.size <= KEEP_TURNS) break;
      if (t.ended && id !== this.shownId) this.turns.delete(id);
    }
  }

  private refresh(): void {
    const now = this.now();
    for (const t of this.turns.values()) {
      if (t.startedAt === null && !t.ended && t.firstTextAt !== null && now - t.firstTextAt >= this.startFallbackMs) {
        t.startedAt = now;
        this.shownId = t.id;
      }
    }
    const t = this.shownId ? this.turns.get(this.shownId) : undefined;
    this.publish(t ? this.reveal(t, now) : null);
  }

  private reveal(t: Turn, now: number): CaptionView {
    const full = t.full;
    let end = 0;
    if (t.ended) {
      end = full.length;
    } else if (t.startedAt !== null) {
      const elapsed = Math.max(0, now - t.startedAt);
      end = t.words.length > 0 ? this.wordEnd(t, elapsed) : this.paceEnd(full, elapsed);
    }
    const view: CaptionView = {
      responseId: t.id,
      kind: t.kind,
      slide: t.slide,
      text: full.slice(0, end),
      complete: t.ended || (t.final !== null && end >= full.length),
    };
    this.announce(t, view, end);
    return view;
  }

  /** End of the text revealed by the word timestamps `elapsed` ms into the turn. */
  private wordEnd(t: Turn, elapsed: number): number {
    this.align(t);
    while (t.revealedWords < t.aligned.length && t.aligned[t.revealedWords].offsetMs <= elapsed) t.revealedWords += 1;
    return t.revealedWords > 0 ? t.aligned[t.revealedWords - 1].endPos : 0;
  }

  /** Without word timestamps: characters at the learned pace, rounded up to the end of the word being spoken. */
  private paceEnd(full: string, elapsed: number): number {
    const perSecond = 1 / Math.max(0.001, this.secondsPerChar());
    let end = Math.min(full.length, Math.max(1, Math.floor((elapsed / 1000) * perSecond)));
    while (end < full.length && !/\s/.test(full[end])) end += 1;
    return end;
  }

  /** Locates each timestamped word in the caption text, in order, so a word's offset reveals the text up to its end. */
  private align(t: Turn): void {
    const full = t.full;
    if (!full.startsWith(t.alignedFrom)) {
      // The final text differs from the deltas heard so far: align again from the start.
      t.aligned = [];
      t.nextWord = 0;
      t.cursor = 0;
      t.revealedWords = 0;
    }
    t.alignedFrom = full;
    while (t.nextWord < t.words.length) {
      const w = t.words[t.nextWord];
      if (!HAS_LETTER_OR_DIGIT.test(w.text)) { t.nextWord += 1; continue; } // punctuation rides on the previous word
      const at = full.indexOf(w.text, t.cursor);
      if (at < 0) {
        // Not here yet (its delta is still on the way) — unless the text is final, then it never will be.
        if (t.final === null) break;
        t.nextWord += 1;
        continue;
      }
      if (at - t.cursor > MAX_ALIGN_GAP) { t.nextWord += 1; continue; }
      let end = at + w.text.length;
      while (end < full.length && TRAILING_PUNCTUATION.test(full[end])) end += 1;
      t.aligned.push({ endPos: end, offsetMs: w.offsetMs });
      t.cursor = end;
      t.nextWord += 1;
    }
  }

  private announce(t: Turn, view: CaptionView, revealedEnd: number): void {
    if (!this.options.onSentence) return;
    const sentences = splitSentences(t.full);
    const due: string[] = [];
    while (t.announced < sentences.length) {
      const s = sentences[t.announced];
      if (!t.ended && !(s.terminated && s.end <= revealedEnd)) break;
      t.announced += 1;
      due.push(s.text);
    }
    // Several sentences due at once (the turn ended, or Continue was pressed) are one announcement: a live region
    // replaced twice in the same frame would only ever read the last one.
    if (due.length > 0) this.options.onSentence(due.join(' '), view);
  }

  private publish(view: CaptionView | null): void {
    const a = this.last;
    const same = a === view || (!!a && !!view && a.responseId === view.responseId && a.text === view.text
      && a.complete === view.complete && a.kind === view.kind && a.slide === view.slide);
    if (same) return;
    this.last = view;
    this.options.onChange?.(view);
  }
}
