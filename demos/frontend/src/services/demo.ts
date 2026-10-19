// Public live-avatar demo (anonymous, narration-only).
// The server tells the SPA whether the kill switch is on (boot block inlined into the page, else `GET /api/demo/config`);
// the actual guardrails (deck allowlist, quotas, time cap) are enforced server-side.
import { useEffect, useState } from 'react';
import { BOOT_FETCH_TIMEOUT_MS, readBoot, type BootBlock } from './boot';
import { findRecording, type Recording, type RecordingCandidate, type RecordingDeck } from './demoProtocol';

export interface DemoQaConfig {
  enabled: boolean;
  max_questions: number;
  max_audio_seconds: number;
}

export interface DemoConfig {
  enabled: boolean;
  /** Effective session cap (larger when demo Q&A is on, per the server). */
  session_seconds: number;
  remaining_today?: number;
  qa: DemoQaConfig;
  loading: boolean;
}

const QA_OFF: DemoQaConfig = { enabled: false, max_questions: 0, max_audio_seconds: 15 };
const DISABLED: DemoConfig = { enabled: false, session_seconds: 180, qa: QA_OFF, loading: false };

function parseQa(raw: any): DemoQaConfig {
  if (!raw || raw.enabled !== true) return QA_OFF;
  const max = Number(raw.max_questions);
  const audio = Number(raw.max_audio_seconds);
  return {
    enabled: true,
    max_questions: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    max_audio_seconds: Number.isFinite(audio) && audio > 0 ? audio : 15,
  };
}

function parseConfig(d: any): DemoConfig {
  const seconds = Number(d?.session_seconds);
  return {
    enabled: d?.enabled === true,
    session_seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 180,
    remaining_today: typeof d?.remaining_today === 'number' ? d.remaining_today : undefined,
    qa: parseQa(d?.qa),
    loading: false,
  };
}

/** The config the server inlined into the page (no request): final at first paint, like the Home CTA. */
function fromBoot(boot: BootBlock): DemoConfig {
  return {
    enabled: boot.demo.enabled,
    session_seconds: boot.demo.session_seconds,
    remaining_today: boot.demo.remaining_today ?? undefined,
    qa: boot.demo.qa.enabled
      ? { enabled: true, max_questions: boot.demo.qa.max_questions, max_audio_seconds: QA_OFF.max_audio_seconds }
      : QA_OFF,
    loading: false,
  };
}

let cache: Promise<DemoConfig> | null = null;

/** This page's demo config: from the boot block when the server sent one, else one `GET /api/demo/config` (never Home's cache). */
export function loadDemoConfig(): Promise<DemoConfig> {
  const boot = readBoot();
  if (boot) return Promise.resolve(fromBoot(boot));
  if (!cache) {
    cache = fetch('/api/demo/config', { credentials: 'same-origin' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return parseConfig(await r.json());
      })
      .catch((e) => {
        console.warn('[demo] /api/demo/config failed — demo disabled', e);
        cache = null;
        return DISABLED;
      });
  }
  return cache;
}

/**
 * The config as the server answers it now (the page cache is bypassed), bounded in time. Used to tell why a socket
 * that never opened failed: a closed handshake is ambiguous until we know whether the demo is switched off.
 * Null when it cannot be read (offline, timeout, error status).
 */
export async function fetchDemoConfigFresh(timeoutMs = BOOT_FETCH_TIMEOUT_MS): Promise<DemoConfig | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch('/api/demo/config', { credentials: 'same-origin', signal: controller.signal });
    if (!r.ok) return null;
    return parseConfig(await r.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useDemoConfig(): DemoConfig {
  const [cfg, setCfg] = useState<DemoConfig>(() => {
    const boot = readBoot();
    return boot ? fromBoot(boot) : { ...DISABLED, loading: true };
  });
  useEffect(() => {
    if (readBoot()) return undefined; // already final
    let cancelled = false;
    loadDemoConfig().then((c) => { if (!cancelled) setCfg(c); });
    return () => { cancelled = true; };
  }, []);
  return cfg;
}

// ── Same-deck recordings (the value of every end and failure, contracts §2.6) ──────────────────────

export interface RecordingLists {
  videos: RecordingCandidate[];
  podcasts: RecordingCandidate[];
  /** Both lists were read. An incomplete answer is never cached: the next call asks again. */
  complete: boolean;
}

/** Long enough to cover a session, short enough that a newly published recording shows up. */
const RECORDINGS_TTL_MS = 5 * 60_000;
let recordings: { lists: RecordingLists; at: number } | null = null;
let recordingsInFlight: Promise<RecordingLists> | null = null;

async function fetchList(url: string, signal: AbortSignal): Promise<RecordingCandidate[]> {
  const r = await fetch(url, { credentials: 'same-origin', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const rows = Array.isArray(data) ? data : data?.items;
  return Array.isArray(rows) ? rows : [];
}

/** The public lists the recordings are picked from, if they are already known and fresh. */
export function peekRecordingLists(): RecordingLists | null {
  return recordings && Date.now() - recordings.at < RECORDINGS_TTL_MS ? recordings.lists : null;
}

/**
 * Reads the published video and podcast lists (public, published items only), bounded by `timeoutMs`. Concurrent calls
 * share one request. Whatever was read is returned even when one list failed (`complete: false`, not cached).
 */
export function loadRecordingLists(options: { force?: boolean; timeoutMs?: number } = {}): Promise<RecordingLists> {
  const cached = options.force ? null : peekRecordingLists();
  if (cached) return Promise.resolve(cached);
  if (recordingsInFlight) return recordingsInFlight;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? BOOT_FETCH_TIMEOUT_MS);
  recordingsInFlight = Promise.allSettled([
    fetchList('/api/video/library', controller.signal),
    fetchList('/api/podcast/library', controller.signal),
  ]).then(([videos, podcasts]) => {
    const lists: RecordingLists = {
      videos: videos.status === 'fulfilled' ? videos.value : [],
      podcasts: podcasts.status === 'fulfilled' ? podcasts.value : [],
      complete: videos.status === 'fulfilled' && podcasts.status === 'fulfilled',
    };
    if (lists.complete) recordings = { lists, at: Date.now() };
    return lists;
  }).finally(() => {
    clearTimeout(timer);
    recordingsInFlight = null;
  });
  return recordingsInFlight;
}

/**
 * Finds the recording of a live-demo deck (the value of every ending): at once from the lists already known, otherwise
 * after one bounded fetch — the caller shows the public fallback links meanwhile and is never blocked on it.
 * `apply` receives the recording (or null: use the fallback links); it may be called twice (cached, then fresh).
 * Returns a function that cancels the pending lookup.
 */
export function lookupRecording(deck: RecordingDeck, apply: (recording: Recording | null) => void): () => void {
  let cancelled = false;
  const pick = (lists: RecordingLists) => {
    if (!cancelled) apply(findRecording(deck, lists.videos, lists.podcasts));
  };
  const known = peekRecordingLists();
  if (known) pick(known); else void loadRecordingLists().then(pick);
  return () => { cancelled = true; };
}

/** m:ss for countdowns (seconds are rounded up by the caller). */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * How many slides fit in the remaining demo time, given per-slide narration
 * seconds (from the current slide onwards).
 */
export function slidesThatFit(slideSeconds: number[], secondsLeft: number): number {
  let used = 0;
  let n = 0;
  for (const s of slideSeconds) {
    used += s;
    if (used > secondsLeft) break;
    n += 1;
  }
  return n;
}

export function formatMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** "45 seconds" under a minute, else "3 minutes". */
function approximateDuration(seconds: number): string {
  if (seconds < 60) {
    const s = Math.max(1, Math.round(seconds));
    return `${s} second${s === 1 ? '' : 's'}`;
  }
  return formatMinutes(seconds);
}

/**
 * The note shown when the narration is longer than the time left, or null when it fits. Says how many slides fit;
 * when not even one does, it says so by duration — never "covers about 0 of N slides".
 */
export function coverageNote(slideSeconds: number[], secondsLeft: number): string | null {
  const total = slideSeconds.reduce((sum, s) => sum + s, 0);
  if (slideSeconds.length === 0 || total <= secondsLeft) return null;
  const fit = slidesThatFit(slideSeconds, secondsLeft);
  if (fit >= 1) return `This demo covers about ${fit} of ${slideSeconds.length} slides`;
  return `The narration takes about ${approximateDuration(total)}, more than the ${formatClock(secondsLeft)} left in this demo`;
}

/** Shown and announced once when the countdown crosses a warning threshold (`DEMO_WARN_AT_SECONDS`). */
export function timeWarningText(secondsLeft: number): string {
  if (secondsLeft < 60) return `${secondsLeft} seconds left in the live demo`;
  const minutes = Math.round(secondsLeft / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'} left in the live demo`;
}

/** What the visitor reads while the live avatar starts: nothing about the services behind it. */
export const DEMO_COPY = {
  starting: 'Starting the avatar…',
  gettingReady: 'The presenter is getting ready…',
  reconnecting: 'Reconnecting…',
  soundBlocked: 'Sound is blocked or muted',
  turnSoundOn: 'Tap to turn sound on',
  narrationLimit: "You've reached this session's narration limit",
  sending: 'Sending your question…',
  sendFailed: "The question couldn't be sent. Try again.",
  micStartFailed: 'The microphone could not be started. Try again or type your question.',
} as const;
