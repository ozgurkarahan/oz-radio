/**
 * Playback-driven turn completion for the Voice Live avatar.
 *
 * `response.done` only means the server finished *generating* audio (it lands
 * 8–9 s before the avatar stops talking), so it is never treated as completion.
 * A turn completes when:
 *   1. the avatar data channel reports TURN_END / SWITCH_TO_IDLE for this turn
 *      AND the remote-audio analyser has been quiet (< -50 dBFS) for >= 700 ms
 *      after audio was heard;
 *   2. otherwise (no TURN_END): first audible + last word-timestamp end + 1 s,
 *      once the analyser is quiet;
 *   3. otherwise the turn goes "stalled" at expected end + 8 s (or a generous
 *      last-resort deadline when nothing is known) and the UI offers Continue.
 *      Stalled turns still complete if a late signal arrives.
 *   While the media link is interrupted (WebRTC `disconnected`) the silence is
 *   the network, not the end of speech: no rule fires, and quiet is measured
 *   again from the moment the link is restored (the buffered tail still plays).
 *
 * Pure TypeScript with an injectable clock: the host feeds WS events, data
 * channel payloads and audio levels, and calls `tick()` periodically.
 */

export type TurnKind = 'slide' | 'qa_invite' | 'qa_answer';
export type TurnPhase = 'waiting' | 'playing' | 'stalled' | 'done' | 'cancelled';
export type CompletionReason = 'turn_end' | 'turn_end_unheard' | 'word_timestamps' | 'manual';

export interface Completion {
  epoch: number;
  kind: TurnKind;
  reason: CompletionReason;
  chars: number;
  /** First audible sample → last loud sample, when the analyser heard the turn. */
  audibleMs: number | null;
  meta?: unknown;
  /** Azure response id of the turn (the key of its captions); null when it was never seen. */
  responseId?: string | null;
}

/** A turn started playing: the avatar's TURN_START, or the first audible sample, whichever came first. */
export interface PlayInfo {
  epoch: number;
  kind: TurnKind;
  responseId: string;
  itemId: string | null;
  /** Clock reading (`PlaybackOptions.now`) of that first sign of speech. */
  at: number;
}

/** A turn was dropped without completing (cancelled, or superseded by a new turn). */
export interface CancelInfo {
  kind: TurnKind;
  responseId: string | null;
}

export interface TurnSnapshot {
  epoch: number;
  kind: TurnKind;
  phase: TurnPhase;
  chars: number;
  heard: boolean;
  generated: boolean;
  turnEnded: boolean;
  expectedEndAt: number | null;
  deadlineAt: number;
  meta?: unknown;
}

export interface PlaybackOptions {
  /** Monotonic clock in ms (default: performance.now). */
  now?: () => number;
  silenceDb?: number;
  quietMs?: number;
  /** Tail after TURN_END when no analyser is available. */
  noAnalyserTailMs?: number;
  /** TURN_END received but the analyser never heard audio (e.g. suspended context). */
  unheardGraceMs?: number;
  fallbackPadMs?: number;
  safetyPadMs?: number;
  /** Seconds of speech per narration character (estimate only). */
  secondsPerChar?: number;
  /** Max age of an unclaimed server response that `begin({ adopt })` may claim. */
  adoptWindowMs?: number;
  onComplete?: (c: Completion) => void;
  onStalled?: (s: TurnSnapshot) => void;
  onChange?: (s: TurnSnapshot | null) => void;
  /** Once per turn, when it starts playing — the start of its captions. */
  onPlay?: (p: PlayInfo) => void;
  /** A turn was cancelled or superseded: its captions are void. */
  onCancel?: (c: CancelInfo) => void;
  log?: (message: string, data?: unknown) => void;
}

interface Turn {
  epoch: number;
  kind: TurnKind;
  meta?: unknown;
  chars: number;
  beganAt: number;
  responseId: string | null;
  itemId: string | null;
  /** turnID seen on TURN_START before the item id was known. */
  dcTurnId: string | null;
  createdAt: number | null;
  generated: boolean;
  turnStartAt: number | null;
  turnEndAt: number | null;
  lastWordEndMs: number | null;
  heardAt: number | null;
  /** Began while the previous turn's audio was still audible: not "heard" until silence is observed. */
  gated: boolean;
  endSeen: boolean;
  idleSeen: boolean;
  /** `onPlay` was reported. */
  playFired: boolean;
  phase: TurnPhase;
}

type Lifecycle = 'TURN_START' | 'TURN_END' | 'IDLE';

const DC_START = new Set(['TURN_START', 'SWITCH_TO_SPEAKING']);
const DC_END = new Set(['TURN_END', 'SWITCH_TO_IDLE']);
const RETIRED_MAX = 32;
/** Quiet needed after residual audio before a new turn can be "heard". */
const GATE_QUIET_MS = 400;
/** Window in which an id-less end/idle event is attributed to the turn that just ended. */
const STALE_IDLE_WINDOW_MS = 4000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

export class AvatarPlayback {
  private opts: Required<Omit<PlaybackOptions, 'onComplete' | 'onStalled' | 'onChange' | 'onPlay' | 'onCancel' | 'log'>> & PlaybackOptions;
  private epochSeq = 0;
  private current: Turn | null = null;
  private unclaimed: Turn | null = null;
  private loud = false;
  private lastLoudAt: number | null = null;
  private lastSampleAt: number | null = null;
  private analyserAvailable = false;
  private mediaInterrupted = false;
  /** Silence before this instant does not count as quiet (media link was down). */
  private quietFloorAt: number | null = null;
  private loggedShapes = new Set<string>();
  /** Item / turn ids of completed or cancelled turns: their late events are dropped. */
  private retired: string[] = [];
  private staleIdleUntil = 0;
  private staleEndUntil = 0;

  constructor(options: PlaybackOptions = {}) {
    this.opts = {
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      silenceDb: -50,
      quietMs: 700,
      noAnalyserTailMs: 400,
      unheardGraceMs: 1500,
      fallbackPadMs: 1000,
      safetyPadMs: 8000,
      secondsPerChar: 1 / 13,
      adoptWindowMs: 5000,
      ...options,
    };
  }

  // ── Turn lifecycle ────────────────────────────────────────────────────

  /** Start tracking a new turn; any previous turn becomes stale. Returns its epoch. */
  begin(kind: TurnKind, init: { chars?: number; meta?: unknown; adopt?: boolean } = {}): number {
    const now = this.opts.now();
    if (this.current && this.current.phase !== 'done' && this.current.phase !== 'cancelled') {
      this.current.phase = 'cancelled';
      this.retire(this.current);
      this.opts.onCancel?.({ kind: this.current.kind, responseId: this.current.responseId });
    }
    const turn = this.newTurn(kind, now, init.meta, init.chars ?? 0);
    const u = this.unclaimed;
    if (init.adopt && u && u.createdAt != null && now - u.createdAt <= this.opts.adoptWindowMs) {
      Object.assign(turn, {
        responseId: u.responseId, itemId: u.itemId, dcTurnId: u.dcTurnId, createdAt: u.createdAt,
        generated: u.generated, turnStartAt: u.turnStartAt, turnEndAt: u.turnEndAt,
        lastWordEndMs: u.lastWordEndMs, heardAt: u.heardAt, gated: u.gated,
        endSeen: u.endSeen, idleSeen: u.idleSeen, playFired: u.playFired,
      });
      if (turn.heardAt != null || turn.turnStartAt != null) turn.phase = 'playing';
      this.firePlay(turn);
    } else if (u) {
      this.retire(u);
      this.opts.onCancel?.({ kind: u.kind, responseId: u.responseId });
    }
    this.unclaimed = null;
    this.current = turn;
    this.emit();
    return turn.epoch;
  }

  /** Drop the current turn without completing it (stale events are then ignored). */
  cancel(): void {
    if (!this.current) return;
    const t = this.current;
    t.phase = 'cancelled';
    this.retire(t);
    this.current = null;
    this.opts.onCancel?.({ kind: t.kind, responseId: t.responseId });
    this.emit();
  }

  /** User pressed Continue on a stalled (or any) turn. */
  forceComplete(): void {
    if (this.current) this.complete(this.current, 'manual');
  }

  /** Narration length learned after `begin` (demo: from the server ack). */
  setChars(chars: number): void {
    if (this.current && Number.isFinite(chars) && chars > 0) this.current.chars = chars;
  }

  setSecondsPerChar(spc: number): void {
    if (Number.isFinite(spc) && spc > 0) this.opts.secondsPerChar = spc;
  }

  setAnalyserAvailable(available: boolean): void {
    this.analyserAvailable = available;
  }

  /** WebRTC media link down (`disconnected`) / restored (`connected`). */
  setMediaInterrupted(interrupted: boolean): void {
    if (interrupted === this.mediaInterrupted) return;
    this.mediaInterrupted = interrupted;
    if (!interrupted) {
      this.quietFloorAt = this.opts.now();
      this.tick();
    }
  }

  get activeEpoch(): number | null {
    return this.current && (this.current.phase === 'waiting' || this.current.phase === 'playing' || this.current.phase === 'stalled')
      ? this.current.epoch : null;
  }

  get activeKind(): TurnKind | null {
    return this.activeEpoch != null ? this.current!.kind : null;
  }

  snapshot(): TurnSnapshot | null {
    const t = this.current;
    if (!t) return null;
    return {
      epoch: t.epoch, kind: t.kind, phase: t.phase, chars: t.chars, heard: t.heardAt != null,
      generated: t.generated, turnEnded: t.turnEndAt != null, expectedEndAt: this.expectedEnd(t),
      deadlineAt: this.deadline(t), meta: t.meta,
    };
  }

  /** How long the remote audio has been quiet (0 while loud, Infinity if never loud). */
  quietForMs(): number {
    if (this.loud || this.mediaInterrupted) return 0;
    const since = Math.max(this.lastLoudAt ?? Number.NEGATIVE_INFINITY, this.quietFloorAt ?? Number.NEGATIVE_INFINITY);
    if (!Number.isFinite(since)) return Number.POSITIVE_INFINITY;
    return this.opts.now() - since;
  }

  /** True while the analyser is feeding samples (otherwise silence cannot be measured). */
  get analyserLive(): boolean {
    return this.analyserAvailable && this.lastSampleAt != null && this.opts.now() - this.lastSampleAt < 1000;
  }

  // ── Inputs ────────────────────────────────────────────────────────────

  /** Voice Live server events relayed over the WebSocket. */
  onServerEvent(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    const type = msg.type;
    const now = this.opts.now();
    const responseId = str(msg.response?.id) ?? str(msg.response_id);
    const itemId = str(msg.item?.id) ?? str(msg.item_id);
    switch (type) {
      case 'response.created': {
        const t = this.current;
        if (t && t.phase !== 'cancelled' && t.phase !== 'done' && !t.responseId) {
          t.responseId = responseId;
          t.createdAt = now;
          this.firePlay(t);
        } else {
          // Server-initiated speech (Q&A invite / answer) may precede the client's begin().
          if (this.unclaimed) this.retire(this.unclaimed);
          const u = this.newTurn('slide', now, undefined, 0);
          u.epoch = -1;
          u.responseId = responseId;
          u.createdAt = now;
          this.unclaimed = u;
        }
        break;
      }
      case 'response.output_item.added': {
        const t = this.byResponse(responseId);
        if (t && itemId && !t.itemId) t.itemId = itemId;
        break;
      }
      case 'response.audio_timestamp.delta':
      case 'response.output_audio_timestamp.delta': {
        const t = this.byResponse(responseId) ?? this.byItem(itemId);
        const off = Number(msg.audio_offset_ms);
        const dur = Number(msg.audio_duration_ms);
        if (t && Number.isFinite(off)) {
          const end = off + (Number.isFinite(dur) ? dur : 0);
          t.lastWordEndMs = Math.max(t.lastWordEndMs ?? 0, end);
        }
        break;
      }
      case 'response.done': {
        const t = this.byResponse(responseId);
        if (t) t.generated = true;
        break;
      }
      case 'session.avatar.switch_to_speaking':
        this.onLifecycle('TURN_START', str(msg.turn_id));
        return;
      case 'session.avatar.switch_to_idle':
        this.onLifecycle('IDLE', str(msg.turn_id));
        return;
      default:
        return;
    }
    this.tick();
  }

  /** Raw payload from the server-created WebRTC data channel labelled `events`. */
  onDataChannelMessage(raw: unknown): void {
    let obj: any = raw;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch { this.logShape('non-json'); return; }
    }
    const ev = obj && typeof obj === 'object' ? (obj.event && typeof obj.event === 'object' ? obj.event : obj) : null;
    const rawType = ev ? str(ev.eventType) ?? str(ev.event_type) ?? str(ev.type) : null;
    if (!rawType) { this.logShape(`no-type:${Object.keys(ev ?? {}).sort().join(',')}`); return; }
    const kind = rawType.toUpperCase().replace(/^EVENT_TYPE_/, '');
    if (!DC_START.has(kind) && !DC_END.has(kind)) { this.logShape(`type:${rawType}`); return; }
    const lifecycle: Lifecycle = DC_START.has(kind) ? 'TURN_START' : kind === 'TURN_END' ? 'TURN_END' : 'IDLE';
    this.onLifecycle(lifecycle, str(ev.turnID) ?? str(ev.turnId) ?? str(ev.turn_id));
  }

  /** One remote-audio analyser sample (dBFS). */
  onAudioLevel(db: number): void {
    const now = this.opts.now();
    this.lastSampleAt = now;
    const loud = Number.isFinite(db) && db > this.opts.silenceDb;
    this.loud = loud;
    if (loud) this.lastLoudAt = now;
    for (const t of [this.current, this.unclaimed]) {
      if (!t || t.phase === 'cancelled' || t.phase === 'done') continue;
      if (t.gated) {
        // Residual audio from the previous turn: wait for real silence first.
        if (!loud && (this.lastLoudAt == null || now - this.lastLoudAt >= GATE_QUIET_MS)) t.gated = false;
        continue;
      }
      if (loud && t.heardAt == null) {
        t.heardAt = now;
        if (t.phase === 'waiting') t.phase = 'playing';
        this.firePlay(t);
        if (t === this.current) this.emit();
      }
    }
    this.tick();
  }

  /** Evaluate completion / stall rules; call periodically (e.g. every 100 ms). */
  tick(): void {
    const t = this.current;
    if (!t || (t.phase !== 'waiting' && t.phase !== 'playing' && t.phase !== 'stalled')) return;
    if (this.mediaInterrupted) return;
    const now = this.opts.now();
    const analyser = this.analyserLive;
    const quiet = this.quietForMs();
    const heard = t.heardAt != null;

    if (t.turnEndAt != null) {
      if (!analyser) {
        if (now - t.turnEndAt >= this.opts.noAnalyserTailMs) return this.complete(t, 'turn_end');
      } else if (heard) {
        if (quiet >= this.opts.quietMs) return this.complete(t, 'turn_end');
      } else if (now - t.turnEndAt >= this.opts.unheardGraceMs) {
        return this.complete(t, 'turn_end_unheard');
      }
    }

    if (t.lastWordEndMs != null && t.generated) {
      const expected = this.expectedEnd(t)!;
      if (now >= expected + this.opts.fallbackPadMs && (!analyser || quiet >= this.opts.quietMs)) {
        return this.complete(t, 'word_timestamps');
      }
    }

    if (t.phase !== 'stalled') {
      const deadline = this.deadline(t);
      // Audio still flowing past the estimate: allow a bounded grace before stalling.
      const stillTalking = analyser && quiet < this.opts.quietMs && now < deadline + 20000;
      if (now >= deadline && !stillTalking) {
        t.phase = 'stalled';
        this.opts.log?.('[playback] turn stalled', { epoch: t.epoch, kind: t.kind });
        const snap = this.snapshot()!;
        this.opts.onStalled?.(snap);
        this.emit();
      }
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private onLifecycle(kind: Lifecycle, turnId: string | null): void {
    const now = this.opts.now();
    if (turnId && this.retired.includes(turnId)) { this.tick(); return; }
    if (!turnId && kind !== 'TURN_START') {
      // Id-less end/idle right after a turn ended belongs to that turn (photo avatars).
      if (kind === 'IDLE' && now < this.staleIdleUntil) { this.staleIdleUntil = 0; this.tick(); return; }
      if (kind === 'TURN_END' && now < this.staleEndUntil) { this.staleEndUntil = 0; this.tick(); return; }
    }
    const t = this.matchLifecycle(turnId, kind);
    if (!t) { this.tick(); return; }
    if (kind === 'TURN_START') {
      if (turnId && !t.itemId && !t.dcTurnId) t.dcTurnId = turnId;
      if (t.turnStartAt == null) t.turnStartAt = now;
      if (t.phase === 'waiting') t.phase = 'playing';
      this.firePlay(t);
      if (t === this.current) this.emit();
    } else {
      if (kind === 'IDLE') t.idleSeen = true; else t.endSeen = true;
      if (t.turnEndAt == null) t.turnEndAt = now;
    }
    this.tick();
  }

  private matchLifecycle(turnId: string | null, kind: Lifecycle): Turn | null {
    for (const t of [this.current, this.unclaimed]) {
      if (!t || t.phase === 'cancelled' || t.phase === 'done') continue;
      const bound = t.itemId != null || t.dcTurnId != null;
      if (turnId) {
        if (bound) { if (turnId === t.itemId || turnId === t.dcTurnId) return t; continue; }
        // Only a TURN_START may bind an unbound turn, once its response exists.
        // An end/idle event never binds: it may be the tail of the previous turn.
        if (kind === 'TURN_START' && (t.responseId || t.createdAt != null)) return t;
        continue;
      }
      // No turn id (photo avatars / on-connect idle).
      if (kind === 'TURN_START') { if (t.createdAt != null) return t; continue; }
      // Ends count only after this turn's own TURN_START.
      if (t.turnStartAt != null) return t;
    }
    return null;
  }

  private newTurn(kind: TurnKind, now: number, meta: unknown, chars: number): Turn {
    return {
      epoch: ++this.epochSeq, kind, meta, chars: Math.max(0, chars), beganAt: now,
      responseId: null, itemId: null, dcTurnId: null, createdAt: null, generated: false,
      turnStartAt: null, turnEndAt: null, lastWordEndMs: null, heardAt: null,
      gated: this.loud || (this.lastLoudAt != null && now - this.lastLoudAt < GATE_QUIET_MS),
      endSeen: false, idleSeen: false, playFired: false, phase: 'waiting',
    };
  }

  /** Report the start of a turn once, as soon as both its first sign of speech and its response id are known. */
  private firePlay(t: Turn): void {
    if (t.playFired || !t.responseId || (t.turnStartAt == null && t.heardAt == null)) return;
    t.playFired = true;
    const at = Math.min(t.turnStartAt ?? Number.POSITIVE_INFINITY, t.heardAt ?? Number.POSITIVE_INFINITY);
    this.opts.onPlay?.({ epoch: t.epoch, kind: t.kind, responseId: t.responseId, itemId: t.itemId, at });
  }

  /** Remember a finished/cancelled turn so its late lifecycle events are ignored. */
  private retire(t: Turn): void {
    for (const id of [t.itemId, t.dcTurnId]) {
      if (id && !this.retired.includes(id)) this.retired.push(id);
    }
    while (this.retired.length > RETIRED_MAX) this.retired.shift();
    if (t.turnStartAt != null) {
      const until = this.opts.now() + STALE_IDLE_WINDOW_MS;
      if (!t.idleSeen) this.staleIdleUntil = until;
      if (!t.endSeen) this.staleEndUntil = until;
    }
  }

  private byResponse(responseId: string | null): Turn | null {
    if (!responseId) return null;
    for (const t of [this.current, this.unclaimed]) {
      if (t && t.phase !== 'cancelled' && t.phase !== 'done' && t.responseId === responseId) return t;
    }
    return null;
  }

  private byItem(itemId: string | null): Turn | null {
    if (!itemId) return null;
    for (const t of [this.current, this.unclaimed]) {
      if (t && t.phase !== 'cancelled' && t.phase !== 'done' && t.itemId === itemId) return t;
    }
    return null;
  }

  private expectedEnd(t: Turn): number | null {
    const durationMs = t.lastWordEndMs ?? (t.chars > 0 ? t.chars * this.opts.secondsPerChar * 1000 : null);
    if (durationMs == null) return null;
    // First audible sample, else TURN_START + typical lead, else response start + typical latency.
    const base = t.heardAt ?? (t.turnStartAt != null ? t.turnStartAt + 550 : (t.createdAt ?? t.beganAt) + 1300);
    return base + durationMs;
  }

  private deadline(t: Turn): number {
    const expected = this.expectedEnd(t);
    if (expected != null && (t.generated || t.lastWordEndMs != null)) {
      const estimate = t.chars > 0 ? (t.createdAt ?? t.beganAt) + t.chars * this.opts.secondsPerChar * 1000 : expected;
      return Math.max(expected, estimate) + this.opts.safetyPadMs;
    }
    // Generous last resort: nothing usable arrived for this turn.
    const est = t.chars * this.opts.secondsPerChar * 1000;
    return t.beganAt + Math.max(45000, est * 1.5 + 30000);
  }

  private complete(t: Turn, reason: CompletionReason): void {
    if (t.phase === 'done' || t.phase === 'cancelled') return;
    t.phase = 'done';
    this.retire(t);
    const audibleMs = t.heardAt != null && this.lastLoudAt != null && this.lastLoudAt >= t.heardAt
      ? this.lastLoudAt - t.heardAt : null;
    if (this.current === t) this.current = null;
    this.emit();
    this.opts.onComplete?.({ epoch: t.epoch, kind: t.kind, reason, chars: t.chars, audibleMs, meta: t.meta, responseId: t.responseId });
  }

  private emit(): void {
    this.opts.onChange?.(this.snapshot());
  }

  private logShape(key: string): void {
    if (this.loggedShapes.has(key)) return;
    this.loggedShapes.add(key);
    this.opts.log?.('[playback] unknown data-channel message', key);
  }
}

/** RMS of time-domain samples → dBFS (-Infinity for digital silence). */
export function rmsDbfs(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

/** Running seconds-per-character estimate from completed narration turns. */
export class NarrationRate {
  private ms = 0;
  private chars = 0;
  constructor(private seed = 1 / 13) {}
  record(chars: number, audibleMs: number | null): void {
    if (!audibleMs || audibleMs < 1000 || chars < 20) return;
    this.ms += audibleMs;
    this.chars += chars;
  }
  get secondsPerChar(): number {
    return this.chars > 0 ? this.ms / 1000 / this.chars : this.seed;
  }
}
