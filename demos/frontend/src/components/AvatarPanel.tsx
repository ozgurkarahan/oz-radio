import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Presentation, type QaMode } from '../services/api';
import { useAuth } from '../services/auth';
import { pickDefaultAvatar, useAvatars } from '../services/avatars';
import { Mic, Pause, PhoneOff, Play, RotateCcw, Square, StepForward, Volume2 } from 'lucide-react';
import { Alert, Button, HostDisc, LivePill, Waveform, langAttr, languageName } from '../ui';
import { GateNotice } from './AuthGate';
import RaiseHandPanel, { type QaAnswerView, type QaPhase } from './RaiseHandPanel';
import DemoOutcome, { DemoNarrationDone } from './DemoOutcome';
import LiveCaptions from './LiveCaptions';
import '../styles/shared/avatar-panel.css';
import {
  DEMO_COPY, coverageNote, fetchDemoConfigFresh, formatClock, formatMinutes, loadRecordingLists, lookupRecording,
  timeWarningText, type DemoQaConfig,
} from '../services/demo';
import {
  DEMO_CLOSE_CODES, DEMO_PROTOCOL_VERSION, DEMO_QA_LIMIT_MESSAGES, DEMO_TIMING, DEMO_WARN_AT_SECONDS,
  outcomeFor, type DemoOutcome as DemoOutcomeInfo, type DemoQaLimitScope, type Recording,
} from '../services/demoProtocol';
import { CaptionPacer, type CaptionView } from '../services/demoCaptions';
import { ICE_WAIT_FOR_GATHERING, IceOfferPlanner } from '../services/demoIce';
import { narrationFor } from '../services/narration';
import { AvatarPlayback, NarrationRate, rmsDbfs, type Completion, type TurnSnapshot } from '../services/avatarPlayback';
import { VoiceCapture, micErrorMessage, type CaptureEnd } from '../services/voiceCapture';

interface Props {
  presentation: Presentation;
  currentSlide: number;
  language: string;
  onSlideChange: (index: number) => void;
  videoPlaying?: boolean;
  onRequestVideoAutoPlay?: () => void;
  selectedAvatar?: string;
  selectedVoice?: string;
  autoStart?: boolean;
  /**
   * Visual mode for the avatar tile.
   * - 'wide' (default, legacy): 16:9 framing matching older prebuilt avatars.
   * - 'portrait': 1:1 close-up framing tuned for photo avatars.
   *   Mirrors the server-side `crop=560:560:660:20` head-zoom used by
   *   video_compose.py so the live stream matches the rendered MP4 framing.
   */
  mode?: 'wide' | 'portrait';
  /**
   * Who drives the session.
   * - 'admin' (default): `/ws/voice`, full controls (signed-in allowlisted users).
   * - 'demo': anonymous narration-only `/ws/voice/demo` — the server picks the
   *   avatar/voice/language and reads the stored slide notes itself.
   */
  access?: 'admin' | 'demo';
  /** Demo only: server-side session cap (from `GET /api/demo/config`). */
  demoSessionSeconds?: number;
  /** Demo only: raise-hand Q&A settings (from `GET /api/demo/config`). */
  demoQa?: DemoQaConfig;
  /** Demo only: the deck's own title, to find its recording when the session ends ("the same demo, recorded"). */
  deckTitle?: string;
  /** Admin: catalog deck bound to the voice session (`session.deck_id`, `context.switch`). */
  deckId?: string;
  /** Admin: legacy Live upload bound to the voice session (`session.presentation_id`). */
  presentationId?: string;
}

type ResumeAction = 'next' | 'same' | 'stay';

interface QaRun {
  phase: QaPhase;
  requestId: string | null;
  mode: QaMode;
  /** What happens once the question is done: next slide, re-narrate this slide, or stay. */
  resume: ResumeAction;
  typed: string | null;
  transcript: string | null;
  answer: QaAnswerView | null;
  error: string | null;
}

const QA_IDLE: QaRun = {
  phase: 'idle', requestId: null, mode: 'after_slide', resume: 'stay', typed: null, transcript: null, answer: null, error: null,
};

const QA_ERROR_TEXT: Record<string, string> = {
  no_speech: "I didn't catch a question. Press Continue to go on.",
  too_long: 'That question was too long. Try a shorter one.',
  limit: DEMO_QA_LIMIT_MESSAGES.session,
  rate: 'Please wait a moment before asking another question.',
  stt_failed: "Your question couldn't be transcribed. Try again.",
  answer_failed: "The presenter couldn't answer that question.",
  bad_state: 'The presenter is busy. Try again in a moment.',
  disabled: 'Questions are turned off for this session.',
  time_low: 'Not enough demo time is left for a question.',
  bad_deck: "Questions aren't available for this presentation.",
};

const PRESENT_GAP_MS = 500;
/** A dropped media link gets this long to come back before the session is declared interrupted (T3-08b). */
const MEDIA_RECONNECT_MS = 8000;
/** "Finish demo" waits this long for the server's 4001 before ending the session locally. */
const FINISH_CLOSE_WAIT_MS = 3000;

function newRequestId(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function monoNow(): number {
  return performance.now();
}

export default function AvatarPanel({
  presentation, currentSlide, language, onSlideChange, videoPlaying = false, onRequestVideoAutoPlay,
  selectedAvatar, selectedVoice, autoStart = false, mode = 'wide', access = 'admin', demoSessionSeconds = 180,
  demoQa, deckTitle, deckId, presentationId,
}: Props) {
  const [connected, setConnected] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const [status, setStatus] = useState('Not connected');
  const videoRef = useRef<HTMLVideoElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const presentingRef = useRef(false);
  const currentSlideRef = useRef(currentSlide);
  const languageRef = useRef(language);
  const presentationRef = useRef(presentation);
  const onSlideChangeRef = useRef(onSlideChange);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReconnectSpeakRef = useRef(false);
  const stopSessionRef = useRef<() => void>(() => {});
  // The one <audio> element of the avatar's voice. It lives in the JSX for the whole life of the panel (not created per
  // session) so the Start tap can bank the user activation on it.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const handleMessageRef = useRef<(event: MessageEvent) => void>(() => {});
  const handleMediaStateRef = useRef<(state: string) => void>(() => {});
  const prevVideoPlayingRef = useRef(videoPlaying);
  const auth = useAuth();
  const isDemo = access === 'demo';
  const isDemoRef = useRef(isDemo);
  useEffect(() => { isDemoRef.current = isDemo; }, [isDemo]);
  const canUseAvatar = !auth.loading && auth.is_admin && !isDemo;
  // 'signin' / 'forbidden' when /ws/voice was refused with close code 4401 / 4403.
  const [authBlock, setAuthBlock] = useState<null | 'signin' | 'forbidden'>(null);
  // Demo-only UI state. The countdown runs on the monotonic clock and is
  // re-synced from the server's `remaining_ms` whenever it arrives.
  const [demoConnecting, setDemoConnecting] = useState(false);
  const [demoEndsAt, setDemoEndsAt] = useState<number | null>(null);
  const [demoNow, setDemoNow] = useState(() => monoNow());
  const demoSecondsRef = useRef(demoSessionSeconds);
  useEffect(() => { demoSecondsRef.current = demoSessionSeconds; }, [demoSessionSeconds]);
  useEffect(() => {
    if (!demoEndsAt) return;
    setDemoNow(monoNow());
    const t = setInterval(() => setDemoNow(monoNow()), 1000);
    return () => clearInterval(t);
  }, [demoEndsAt]);
  const syncDemoClock = useCallback((remainingMs: number) => {
    if (!Number.isFinite(remainingMs)) return;
    setDemoEndsAt(monoNow() + Math.max(0, remainingMs));
  }, []);
  // Narration length per slide in the demo (the visitor never receives notes):
  // `narration_chars` from `demo.started` when provided, else `demo.speaking` acks.
  const [demoChars, setDemoChars] = useState<Record<number, number>>({});
  // How the demo session ends or fails, and what the visitor still gets from it (contracts §4.5–4.6).
  const [outcome, setOutcome] = useState<DemoOutcomeInfo | null>(null);
  const [recording, setRecording] = useState<Recording | null>(null);
  const [narrationDone, setNarrationDone] = useState<null | 'complete' | 'limit'>(null);
  const [finishing, setFinishing] = useState(false);
  const [quotaBlocked, setQuotaBlocked] = useState(false);
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [avatarPlaying, setAvatarPlaying] = useState(false);
  const [captionView, setCaptionView] = useState<CaptionView | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [timeWarning, setTimeWarning] = useState('');
  const [draft, setDraft] = useState('');
  // `demo.started.protocol`: v2 servers send captions, accept typed questions and honour `demo.finish`; a v1 server does not.
  const [protocolV2, setProtocolV2] = useState(false);
  const protocolV2Ref = useRef(false);
  const startRef = useRef<HTMLButtonElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const sessionSeqRef = useRef(0);
  const sawServiceErrorRef = useRef(false);
  const mediaEverConnectedRef = useRef(false);
  const autoPresentedRef = useRef(false);
  const announcedWarningsRef = useRef(new Set<number>());
  const setupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mediaDropTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deckTitleRef = useRef(deckTitle);
  useEffect(() => { deckTitleRef.current = deckTitle; }, [deckTitle]);
  const { avatars } = useAvatars();
  const defaultAvatarIdRef = useRef<string>('');
  useEffect(() => { defaultAvatarIdRef.current = pickDefaultAvatar(avatars)?.id ?? ''; }, [avatars]);
  const deckIdRef = useRef(deckId);
  const presentationIdRef = useRef(presentationId);
  const boundDeckRef = useRef<string | null>(null);

  // ── Playback controller (WS3) ─────────────────────────────────────────
  const rateRef = useRef(new NarrationRate());
  const [secondsPerChar, setSecondsPerChar] = useState(rateRef.current.secondsPerChar);
  // Captions revealed at the pace of the avatar's audio (contracts §4.3).
  const pacerRef = useRef<CaptionPacer | null>(null);
  if (!pacerRef.current) {
    pacerRef.current = new CaptionPacer({
      secondsPerChar: () => rateRef.current.secondsPerChar,
      onChange: (view) => setCaptionView(view),
      // An answer is already written out (and announced) by the question panel: announce narration and invites only.
      // The same sentence twice in a row (a second invitation) still has to be read: the trailing no-break space makes it a change.
      onSentence: (sentence, view) => {
        if (view.kind !== 'answer') setAnnouncement((prev) => (prev === sentence ? `${sentence}\u00A0` : sentence));
      },
    });
  }
  const pacer = pacerRef.current;
  const fns = useRef<{
    onTurnComplete: (c: Completion) => void;
    onTurnStalled: (s: TurnSnapshot) => void;
  }>({ onTurnComplete: () => {}, onTurnStalled: () => {} });
  const playbackRef = useRef<AvatarPlayback | null>(null);
  if (!playbackRef.current) {
    playbackRef.current = new AvatarPlayback({
      onComplete: (c) => fns.current.onTurnComplete(c),
      onStalled: (s) => fns.current.onTurnStalled(s),
      onChange: (s) => {
        setSpeaking(!!s && (s.phase === 'waiting' || s.phase === 'playing' || s.phase === 'stalled'));
        setAvatarPlaying(!!s && s.phase === 'playing');
        setStalled(!!s && s.phase === 'stalled');
      },
      onPlay: (p) => pacerRef.current?.start(p.responseId, p.at),
      onCancel: (c) => pacerRef.current?.cancel(c.responseId),
      log: (m, d) => console.info(m, d ?? ''),
    });
  }
  const playback = playbackRef.current;
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Raise-hand Q&A (WS4) ──────────────────────────────────────────────
  const [qa, setQaState] = useState<QaRun>(QA_IDLE);
  const qaRef = useRef<QaRun>(QA_IDLE);
  const setQa = useCallback((next: QaRun | ((q: QaRun) => QaRun)) => {
    const v = typeof next === 'function' ? next(qaRef.current) : next;
    qaRef.current = v;
    setQaState(v);
  }, []);
  const [micLevel, setMicLevel] = useState(0);
  const [qaNotice, setQaNotice] = useState<string | null>(null);
  const [qaDisabled, setQaDisabled] = useState<string | null>(null);
  const [remainingQuestions, setRemainingQuestions] = useState<number | null>(null);
  const captureRef = useRef<VoiceCapture | null>(null);
  const qaTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const qaLimitsRef = useRef<{ maxBytes?: number; maxMs?: number }>({});
  const qaAvailable = isDemo ? demoQa?.enabled === true : !!(deckId || presentationId);

  // Keep refs in sync with state/props
  useEffect(() => { currentSlideRef.current = currentSlide; }, [currentSlide]);
  useEffect(() => { presentingRef.current = presenting; }, [presenting]);
  useEffect(() => { languageRef.current = language; }, [language]);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { presentationRef.current = presentation; }, [presentation]);
  useEffect(() => { onSlideChangeRef.current = onSlideChange; }, [onSlideChange]);
  useEffect(() => { presentationIdRef.current = presentationId; }, [presentationId]);
  const selectedAvatarRef = useRef(selectedAvatar);
  const selectedVoiceRef = useRef(selectedVoice);
  useEffect(() => { selectedAvatarRef.current = selectedAvatar; }, [selectedAvatar]);
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);
  const prevLanguageRef = useRef(language);

  const sendWs = useCallback((msg: unknown): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }, []);

  const clearAdvance = useCallback(() => {
    if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null; }
  }, []);

  const clearQaTimer = useCallback(() => {
    if (qaTimerRef.current) { clearTimeout(qaTimerRef.current); qaTimerRef.current = null; }
  }, []);

  // ── Remote audio analyser ─────────────────────────────────────────────

  /** Create/resume the shared AudioContext. Call from click handlers so it starts running. */
  const ensureAudioContext = useCallback((): AudioContext | null => {
    const AC: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return null;
    let ctx = audioCtxRef.current;
    if (!ctx || ctx.state === 'closed') {
      try { ctx = new AC(); } catch { return null; }
      audioCtxRef.current = ctx;
      const c = ctx;
      c.onstatechange = () => playback.setAnalyserAvailable(!!analyserRef.current && c.state === 'running');
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    return ctx;
  }, [playback]);

  const attachAnalyser = useCallback((stream: MediaStream) => {
    const ctx = ensureAudioContext();
    if (!ctx) { playback.setAnalyserAvailable(false); return; }
    try { remoteSourceRef.current?.disconnect(); } catch {}
    try {
      // The stream is already attached to an <audio> element (required by Chrome
      // for remote WebRTC audio to reach WebAudio); the analyser is not routed
      // to the speakers.
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      remoteSourceRef.current = src;
      analyserRef.current = analyser;
      playback.setAnalyserAvailable(ctx.state === 'running');
    } catch (e) {
      console.warn('[Playback] analyser unavailable', e);
      analyserRef.current = null;
      playback.setAnalyserAvailable(false);
    }
  }, [ensureAudioContext, playback]);

  const startTicker = useCallback(() => {
    if (tickerRef.current) return;
    const buf = new Float32Array(1024);
    tickerRef.current = setInterval(() => {
      const analyser = analyserRef.current;
      if (analyser && audioCtxRef.current?.state === 'running') {
        analyser.getFloatTimeDomainData(buf);
        playback.onAudioLevel(rmsDbfs(buf));
      } else {
        playback.tick();
      }
      pacer.tick();
    }, 50);
  }, [playback, pacer]);

  const stopTicker = useCallback(() => {
    if (tickerRef.current) { clearInterval(tickerRef.current); tickerRef.current = null; }
    try { remoteSourceRef.current?.disconnect(); } catch {}
    remoteSourceRef.current = null;
    analyserRef.current = null;
    playback.setAnalyserAvailable(false);
    playback.setMediaInterrupted(false);
  }, [playback]);

  // ── Slide flow ────────────────────────────────────────────────────────

  const speakSlideRef = useRef<(idx: number) => void>(() => {});

  const scheduleSpeak = useCallback((idx: number, ms: number) => {
    clearAdvance();
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null;
      speakSlideRef.current(idx);
    }, ms);
  }, [clearAdvance]);

  /** Move to the next slide and narrate it (or finish the presentation). */
  const goNext = useCallback((gapMs = PRESENT_GAP_MS) => {
    const next = currentSlideRef.current + 1;
    if (next < presentationRef.current.slide_count) {
      console.log(`[Advance] Moving to slide ${next + 1}`);
      currentSlideRef.current = next;
      onSlideChangeRef.current(next);
      scheduleSpeak(next, gapMs);
    } else {
      presentingRef.current = false;
      setPresenting(false);
      // Demo: the visitor chooses what happens next (ask, or finish) instead of facing an idle avatar.
      if (isDemoRef.current) { setNarrationDone('complete'); setStatus(''); } else setStatus('Presentation complete!');
    }
  }, [scheduleSpeak]);

  // When language changes while connected, tear down the session and reconnect with new language
  useEffect(() => {
    if (language === prevLanguageRef.current) return;
    prevLanguageRef.current = language;
    if (!connected) return;

    setStatus(`Switching language to ${language} — reconnecting avatar...`);
    pendingReconnectSpeakRef.current = true;
    // Full teardown, then reconnect with new language config
    stopSessionRef.current();
    // Small delay to let cleanup finish before reconnecting
    setTimeout(() => {
      startSessionRef.current();
    }, 500);
  }, [language, connected]);

  // The avatar's voice: one persistent <audio> element. `why`: 'start' = inside the Start tap (banks the user activation;
  // the element has no stream yet, so its rejection says nothing), 'track' = the remote audio arrived, 'user' = the visitor
  // asked for sound. A refusal by the browser's autoplay policy is what "Sound is blocked or muted" reports.
  const playRemoteAudio = useCallback((why: 'start' | 'track' | 'user') => {
    const el = audioRef.current;
    if (!el) return;
    if (why !== 'start') { el.muted = false; if (el.volume === 0) el.volume = 1; }
    const played = el.play();
    if (!played) return;
    played.then(() => { if (why !== 'start') setSoundBlocked(false); }).catch((err: unknown) => {
      if (why !== 'start' && (err as { name?: string } | null)?.name === 'NotAllowedError') setSoundBlocked(true);
    });
  }, []);

  const clearDemoTimer = useCallback((ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) { clearTimeout(ref.current); ref.current = null; }
  }, []);

  // Set up WebRTC peer connection with ICE servers from Azure
  const setupWebRTC = useCallback((iceServers: any, username?: string, credential?: string) => {
    let servers = Array.isArray(iceServers) ? iceServers : [{ urls: iceServers }];
    if (username && credential) {
      servers = servers.map((s: any) => ({
        urls: typeof s === 'string' ? s : s.urls,
        username,
        credential,
        credentialType: 'password' as const,
      }));
    }

    // TURN over TCP/TLS 443 as fallback: Azure only advertises UDP 3478, which
    // proxies and firewalls that block UDP cannot reach.
    servers = servers.map((s: any) => {
      const entry = typeof s === 'string' ? { urls: s } : s;
      const urls: string[] = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
      const extra = urls.flatMap((u) => {
        const host = /^turns?:([^:?]+)/.exec(u)?.[1];
        return host ? [`turn:${host}:443?transport=tcp`, `turns:${host}:443?transport=tcp`] : [];
      });
      return { ...entry, urls: Array.from(new Set([...urls, ...extra])) };
    });

    // Relay-only: on corporate / NAT-heavy networks the host and srflx pairs
    // never connect and ICE fails before it falls back to the TURN relay.
    const pc = new RTCPeerConnection({
      iceServers: servers,
      bundlePolicy: 'max-bundle',
      iceTransportPolicy: 'relay',
    });
    peerConnectionRef.current = pc;
    // The ICE servers arrived: the avatar is coming up, the setup watchdog (no ICE servers at all) is done.
    clearDemoTimer(setupTimerRef);

    pc.oniceconnectionstatechange = () => {
      console.log('[WebRTC] ICE state:', pc.iceConnectionState);
    };

    // Report the real media state: signalling success does not mean video flows.
    pc.onconnectionstatechange = () => {
      if (peerConnectionRef.current !== pc) return;
      handleMediaStateRef.current(pc.connectionState);
    };
    setTimeout(() => {
      if (peerConnectionRef.current === pc && pc.connectionState !== 'connected') handleMediaStateRef.current('timeout');
    }, 20000);

    // Avatar lifecycle events (TURN_START / TURN_END / SWITCH_TO_IDLE) arrive on
    // a server-created data channel labelled `events`.
    pc.ondatachannel = (e) => {
      if (e.channel.label !== 'events') return;
      e.channel.onmessage = (m) => {
        if (peerConnectionRef.current !== pc) return;
        const data = m.data;
        if (typeof data === 'string') playback.onDataChannelMessage(data);
        else if (data instanceof ArrayBuffer) playback.onDataChannelMessage(new TextDecoder().decode(data));
        else if (data instanceof Blob) void data.text().then((t) => playback.onDataChannelMessage(t));
      };
    };

    // Non-trickle ICE: one complete offer. The demo sends it when gathering completes, or soon after the first (TCP/TLS)
    // relay candidate — a UDP-blocked network no longer waits for the UDP attempts to time out; the admin presenter keeps
    // the old rule (gathering complete, or 5 s). Candidates are relay-only either way (iceTransportPolicy).
    const planner = new IceOfferPlanner(performance.now(), isDemoRef.current ? undefined : ICE_WAIT_FOR_GATHERING);
    let sdpSent = false;
    let offerTimer: ReturnType<typeof setTimeout> | null = null;
    const sendSdpOffer = (reason: string) => {
      if (sdpSent || !pc.localDescription) return;
      sdpSent = true;
      if (offerTimer) { clearTimeout(offerTimer); offerTimer = null; }
      const sdp = btoa(JSON.stringify({ type: 'offer', sdp: pc.localDescription.sdp }));
      console.log(`[WebRTC] Sending SDP offer (${reason}; ICE gathering state: ${pc.iceGatheringState})`);
      wsRef.current?.send(JSON.stringify({ type: 'session.avatar.connect', client_sdp: sdp }));
    };
    const scheduleOffer = () => {
      if (sdpSent) return;
      if (offerTimer) clearTimeout(offerTimer);
      const { at, reason } = planner.due();
      offerTimer = setTimeout(() => { offerTimer = null; sendSdpOffer(reason); }, Math.max(0, at - performance.now()));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) planner.candidate(e.candidate, performance.now()); else planner.complete(performance.now());
      scheduleOffer();
    };
    pc.onicegatheringstatechange = () => {
      console.log('[WebRTC] ICE gathering state:', pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') { planner.complete(performance.now()); scheduleOffer(); }
    };
    scheduleOffer();

    // Receive video/audio tracks from avatar
    pc.ontrack = (e) => {
      console.log('[WebRTC] Got track:', e.track.kind);
      if (e.track.kind === 'video' && videoRef.current) {
        videoRef.current.srcObject = e.streams[0];
        videoRef.current.play().catch(() => {});
      } else if (e.track.kind === 'audio') {
        if (audioRef.current) {
          audioRef.current.srcObject = e.streams[0];
          playRemoteAudio('track');
        }
        attachAnalyser(e.streams[0]);
      }
    };

    // Add recv-only transceivers (we only receive avatar stream)
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    // A client data channel puts an SCTP (m=application) section in the offer;
    // without it the service cannot open its `events` channel and TURN_END /
    // SWITCH_TO_IDLE never arrive (completion would fall back to estimates).
    pc.createDataChannel('eventChannel');

    // Create and set local SDP offer
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(scheduleOffer)
      .catch((err) => console.warn('[WebRTC] Could not create the offer', err));
  }, [attachAnalyser, playback, playRemoteAudio, clearDemoTimer]);

  // Handle SDP answer from Azure (via backend proxy)
  const handleAnswer = useCallback((msg: any) => {
    const pc = peerConnectionRef.current;
    if (!pc || pc.signalingState !== 'have-local-offer') return;

    const sdp = msg.server_sdp
      ? JSON.parse(atob(msg.server_sdp)).sdp
      : msg.sdp || msg.answer;

    if (sdp) {
      console.log('[WebRTC] Setting remote SDP answer');
      pc.setRemoteDescription({ type: 'answer', sdp });
    }
  }, []);

  // ── Q&A flow ──────────────────────────────────────────────────────────

  const performResume = useCallback((action: ResumeAction, afterError = false) => {
    if (action === 'next') {
      presentingRef.current = true;
      setPresenting(true);
      setStatus('Back to the presentation');
      goNext(800);
    } else if (action === 'same') {
      presentingRef.current = true;
      setPresenting(true);
      setStatus('Back to the presentation');
      scheduleSpeak(currentSlideRef.current, 800);
    } else {
      // After a refused question nothing was answered: do not claim it was.
      setStatus(afterError ? '' : 'Question answered');
    }
  }, [goNext, scheduleSpeak]);

  const releaseCapture = useCallback((mode: 'cancel' | 'close') => {
    const cap = captureRef.current;
    captureRef.current = null;
    if (!cap) return;
    if (mode === 'cancel') cap.cancel(); else cap.close();
    setMicLevel(0);
  }, []);

  const failQa = useCallback((message: string, notifyServer = false) => {
    const q = qaRef.current;
    clearQaTimer();
    if (notifyServer && q.requestId) sendWs({ type: 'qa.cancel', request_id: q.requestId });
    releaseCapture('cancel');
    const kind = playback.activeKind;
    if (kind === 'qa_invite' || kind === 'qa_answer') playback.cancel();
    setQa({ ...q, phase: 'error', error: message });
    // The demo shows a refused question once, in the question panel (not again in the status line).
    setStatus(isDemoRef.current ? '' : message);
  }, [clearQaTimer, sendWs, releaseCapture, playback, setQa]);

  const armQaTimer = useCallback((ms: number, message: string) => {
    clearQaTimer();
    qaTimerRef.current = setTimeout(() => {
      qaTimerRef.current = null;
      failQa(message, true);
    }, ms);
  }, [clearQaTimer, failQa]);

  const beginQa = useCallback((qaMode: QaMode) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      failQa('The connection to the presenter was lost.');
      return;
    }
    const requestId = newRequestId();
    setQa((q) => ({ ...q, phase: 'inviting', mode: qaMode, requestId }));
    setStatus('Asking the presenter to take your question…');
    sendWs({ type: 'qa.begin', request_id: requestId, slide: currentSlideRef.current, mode: qaMode });
    armQaTimer(12000, 'The presenter did not respond. Try again in a moment.');
  }, [failQa, setQa, sendWs, armQaTimer]);

  // Demo: a typed question goes out directly (`qa.ask_text`): no invite and no listening, the server accepts it within a
  // second (`qa.accepted`) or refuses it (`qa.error`). The panel says "Sending your question…" the moment it is submitted.
  const sendAskText = useCallback(() => {
    const q = qaRef.current;
    if (!q.typed) return;
    const requestId = newRequestId();
    setQa({ ...q, phase: 'sending', requestId, transcript: q.typed });
    if (!sendWs({ type: 'qa.ask_text', request_id: requestId, slide: currentSlideRef.current, text: q.typed })) {
      failQa(DEMO_COPY.sendFailed);
      return;
    }
    armQaTimer(DEMO_TIMING.askTextAckTimeoutMs, DEMO_COPY.sendFailed);
  }, [setQa, sendWs, failQa, armQaTimer]);

  /** A raised hand (or, in the demo, a queued typed question) is taken now that nothing is being said. */
  const takeRaisedQuestion = useCallback(() => {
    if (isDemoRef.current && qaRef.current.typed) sendAskText(); else beginQa('after_slide');
  }, [sendAskText, beginQa]);

  const onCaptureEnd = useCallback((requestId: string, end: CaptureEnd) => {
    captureRef.current = null;
    setMicLevel(0);
    const q = qaRef.current;
    if (q.requestId !== requestId || q.phase !== 'listening' || end.reason === 'cancelled') return;
    if (end.bytes === 0) {
      sendWs({ type: 'qa.cancel', request_id: requestId });
      failQa(QA_ERROR_TEXT.no_speech);
      return;
    }
    sendWs({ type: 'qa.commit', request_id: requestId });
    setQa({ ...q, phase: 'thinking' });
    setStatus('Transcribing your question…');
    armQaTimer(30000, 'The answer is taking too long. Try again.');
  }, [sendWs, failQa, setQa, armQaTimer]);

  const startListening = useCallback(() => {
    const q = qaRef.current;
    const cap = captureRef.current;
    const requestId = q.requestId;
    if (!cap || !requestId) { failQa('The microphone is not available.', true); return; }
    setQa({ ...q, phase: 'listening' });
    setStatus('Listening — ask your question');
    setMicLevel(0);
    const lim = qaLimitsRef.current;
    cap.start({
      onFrame: (audio, seq) => { sendWs({ type: 'qa.audio', request_id: requestId, seq, audio }); },
      onLevel: (rms) => setMicLevel(Math.min(1, rms * 8)),
      onEnd: (end) => onCaptureEnd(requestId, end),
    }, {
      ...(lim.maxBytes ? { maxBytes: lim.maxBytes } : {}),
      ...(lim.maxMs ? { maxMs: lim.maxMs } : {}),
    }).catch((e) => {
      console.warn('[QA] capture failed', e);
      failQa(DEMO_COPY.micStartFailed, true);
    });
  }, [failQa, setQa, sendWs, onCaptureEnd]);

  const onInviteDone = useCallback((requestId: unknown) => {
    const q = qaRef.current;
    if (q.requestId !== requestId || q.phase !== 'inviting') return;
    if (q.typed) {
      sendWs({ type: 'qa.text', request_id: q.requestId, text: q.typed });
      setQa({ ...q, phase: 'thinking', transcript: q.typed });
      setStatus('Finding the answer in the deck…');
      armQaTimer(30000, 'The answer is taking too long. Try again.');
      return;
    }
    startListening();
  }, [sendWs, setQa, armQaTimer, startListening]);

  const onAnswerDone = useCallback((requestId: unknown) => {
    const q = qaRef.current;
    if (q.requestId !== requestId || q.phase !== 'answering') return;
    sendWs({ type: 'qa.resume', request_id: q.requestId });
    setQa({ ...q, phase: 'resumed' });
    performResume(pausedRef.current ? 'stay' : q.resume);
  }, [sendWs, setQa, performResume]);

  /** Shared end-of-slide logic: a raised hand takes precedence over advancing. */
  const afterSlideNarration = useCallback(() => {
    const q = qaRef.current;
    if (q.phase === 'raised') {
      if (q.typed || captureRef.current) takeRaisedQuestion();
      else setStatus('Waiting for the microphone…');
      return;
    }
    if (pausedRef.current) {
      setStatus(`Paused after slide ${currentSlideRef.current + 1}`);
      return;
    }
    if (!isDemoRef.current) setStatus('Done speaking');
    if (presentingRef.current) goNext();
  }, [takeRaisedQuestion, goNext]);

  const cancelQa = useCallback((resume: boolean) => {
    const q = qaRef.current;
    clearQaTimer();
    const live = q.phase === 'sending' || q.phase === 'inviting' || q.phase === 'listening' || q.phase === 'thinking' || q.phase === 'answering';
    if (q.requestId && live) sendWs({ type: 'qa.cancel', request_id: q.requestId });
    releaseCapture('cancel');
    const kind = playback.activeKind;
    if (kind === 'qa_invite' || kind === 'qa_answer') {
      playback.cancel();
      sendWs({ type: 'response.cancel' });
    }
    setQa(QA_IDLE);
    if (!resume) return;
    // A hand lowered while the slide is still narrating needs nothing: the
    // normal end-of-slide flow continues.
    if (q.phase === 'raised' && playback.activeKind === 'slide') return;
    performResume(pausedRef.current ? 'stay' : q.resume);
  }, [clearQaTimer, sendWs, releaseCapture, playback, setQa, performResume]);

  const raiseHand = useCallback((typed?: string) => {
    if (!wsRef.current || !qaAvailable || qaDisabled) return;
    const phase = qaRef.current.phase;
    if (phase !== 'idle' && phase !== 'resumed' && phase !== 'error') return;
    setQaNotice(null);
    ensureAudioContext();
    // Opened synchronously inside the click so the capture context starts running.
    const micPromise = typed ? null : VoiceCapture.open();
    const narrating = playback.activeKind === 'slide';
    const pendingSpeak = advanceTimerRef.current != null;
    if (pendingSpeak) clearAdvance();
    const resume: ResumeAction = !presentingRef.current || pausedRef.current ? 'stay' : pendingSpeak ? 'same' : 'next';
    setQa({ ...QA_IDLE, phase: 'raised', resume, typed: typed ?? null, transcript: isDemoRef.current ? (typed ?? null) : null });
    setStatus(narrating ? 'Hand raised — the presenter takes your question after this slide' : 'Hand raised');
    const proceed = () => {
      if (qaRef.current.phase === 'raised' && playback.activeKind !== 'slide') takeRaisedQuestion();
    };
    if (!micPromise) { proceed(); return; }
    micPromise.then((cap) => {
      if (qaRef.current.phase !== 'raised') { cap.close(); return; }
      captureRef.current?.close();
      captureRef.current = cap;
      proceed();
    }).catch((e) => {
      console.warn('[QA] microphone unavailable', e);
      if (qaRef.current.phase === 'raised') setQa(QA_IDLE);
      setQaNotice(micErrorMessage(e));
      setStatus('Microphone unavailable');
      if (playback.activeKind !== 'slide' && resume !== 'stay') performResume(resume);
    });
  }, [qaAvailable, qaDisabled, ensureAudioContext, playback, clearAdvance, setQa, takeRaisedQuestion, performResume]);

  // Admin: interrupt the narration and take the question right away.
  const askNow = useCallback(() => {
    if (isDemoRef.current || !wsRef.current || !qaAvailable || qaDisabled) return;
    const phase = qaRef.current.phase;
    if (phase !== 'idle' && phase !== 'resumed' && phase !== 'error') return;
    setQaNotice(null);
    ensureAudioContext();
    const micPromise = VoiceCapture.open();
    const resume: ResumeAction = presentingRef.current && !pausedRef.current ? 'same' : 'stay';
    clearAdvance();
    setQa({ ...QA_IDLE, phase: 'inviting', mode: 'now', resume });
    setStatus('Stopping the narration…');
    sendWs({ type: 'response.cancel' });
    // Already-generated audio keeps playing after response.cancel; clear it too.
    sendWs({ type: 'output_audio_buffer.clear' });
    playback.cancel();
    const started = monoNow();
    micPromise.then((cap) => {
      const q = qaRef.current;
      if (q.phase !== 'inviting' || q.requestId) { cap.close(); return; }
      captureRef.current?.close();
      captureRef.current = cap;
      const waitForSilence = () => {
        const cur = qaRef.current;
        if (cur.phase !== 'inviting' || cur.requestId) return;
        const elapsed = monoNow() - started;
        const quiet = playback.analyserLive ? playback.quietForMs() >= 700 : elapsed >= 800;
        if (quiet || elapsed >= 15000) beginQa('now');
        else qaTimerRef.current = setTimeout(waitForSilence, 100);
      };
      waitForSilence();
    }).catch((e) => {
      console.warn('[QA] microphone unavailable', e);
      setQa(QA_IDLE);
      setQaNotice(micErrorMessage(e));
      setStatus('Microphone unavailable');
      if (resume === 'same') scheduleSpeak(currentSlideRef.current, 300);
    });
  }, [qaAvailable, qaDisabled, ensureAudioContext, clearAdvance, setQa, sendWs, playback, beginQa, scheduleSpeak]);

  const continueAfterQaError = useCallback(() => {
    const q = qaRef.current;
    setQa(QA_IDLE);
    performResume(pausedRef.current ? 'stay' : q.resume, true);
  }, [setQa, performResume]);

  /** qa.* / context.* server messages. Returns true when handled. */
  const handleQaMessage = useCallback((msg: any): boolean => {
    const type: string = typeof msg?.type === 'string' ? msg.type : '';
    if (type === 'context.switched') {
      console.info('[QA] context switched', msg.deck_id, msg.slide_count);
      setQaDisabled(null);
      return true;
    }
    if (!type.startsWith('qa.')) return false;
    const q = qaRef.current;
    if (type === 'qa.unavailable') {
      const reason = "Questions aren't available for this presentation.";
      setQaDisabled(reason);
      if (q.phase !== 'idle' && q.phase !== 'resumed' && q.phase !== 'error') failQa(reason);
      return true;
    }
    if (typeof msg.request_id === 'string' && msg.request_id !== q.requestId) return true; // stale
    switch (type) {
      case 'qa.ready': {
        if (q.phase !== 'inviting') return true;
        clearQaTimer();
        if (typeof msg.remaining_questions === 'number') setRemainingQuestions(msg.remaining_questions);
        qaLimitsRef.current = {
          maxBytes: typeof msg.max_audio_bytes === 'number' ? msg.max_audio_bytes : undefined,
          maxMs: typeof msg.max_audio_ms === 'number' ? msg.max_audio_ms : undefined,
        };
        playback.begin('qa_invite', { adopt: true, chars: 40, meta: q.requestId });
        setStatus('The presenter is inviting your question…');
        return true;
      }
      case 'qa.accepted': {
        // The typed question was taken (it counts now): the answer follows.
        if (q.phase !== 'sending') return true;
        clearQaTimer();
        if (typeof msg.remaining_questions === 'number') setRemainingQuestions(msg.remaining_questions);
        setDraft('');
        setQa({ ...q, phase: 'thinking' });
        setStatus('Finding the answer in the deck…');
        armQaTimer(30000, 'The answer is taking too long. Try again.');
        return true;
      }
      case 'qa.transcript': {
        if (typeof msg.text !== 'string') return true;
        setQa({ ...q, transcript: msg.text });
        setStatus('Finding the answer in the deck…');
        return true;
      }
      case 'qa.answer': {
        if (q.phase !== 'thinking' || typeof msg.text !== 'string') return true;
        clearQaTimer();
        const sources = Array.isArray(msg.source_slides)
          ? msg.source_slides.filter((n: unknown) => Number.isInteger(n) && (n as number) >= 0) : [];
        setQa({ ...q, phase: 'answering', answer: { text: msg.text, sources, grounded: msg.grounded !== false } });
        playback.begin('qa_answer', { adopt: true, chars: msg.text.length, meta: q.requestId });
        setStatus('Answering your question…');
        return true;
      }
      case 'qa.error': {
        const code = typeof msg.code === 'string' ? msg.code : '';
        let text = (typeof msg.message === 'string' && msg.message.trim()) || QA_ERROR_TEXT[code] || 'The question could not be answered.';
        if (code === 'limit') {
          // Which limit refused the question: the session's, today's budget, or a hiccup of the quota store. A server
          // that sends no scope (v1) means the session's. The server's own words are shown, not a paraphrase.
          const scope: DemoQaLimitScope = msg.scope === 'daily' || msg.scope === 'unavailable' ? msg.scope : 'session';
          text = (typeof msg.message === 'string' && msg.message.trim()) || DEMO_QA_LIMIT_MESSAGES[scope];
          if (scope === 'session') { setRemainingQuestions(0); setQaDisabled(text); }
          else if (scope === 'daily') setQaDisabled(text);
          // 'unavailable' is temporary: Raise hand stays enabled for another try.
        }
        if (code === 'time_low') setQaDisabled('Not enough demo time is left for a question.');
        if (code === 'disabled') setQaDisabled('Questions are turned off for this session.');
        if (code === 'bad_deck') setQaDisabled("Questions aren't available for this presentation.");
        // The presenter could not answer a question that was heard: it goes back into the field to ask again.
        if (code === 'answer_failed' && q.transcript) setDraft(q.transcript);
        if (q.phase === 'idle' || q.phase === 'resumed' || q.phase === 'error' || q.phase === 'raised') {
          if (code !== 'bad_deck') setStatus(text);
          return true;
        }
        failQa(text);
        return true;
      }
      default:
        return true;
    }
  }, [failQa, clearQaTimer, armQaTimer, playback, setQa]);

  // Completion callbacks from the playback controller.
  fns.current.onTurnComplete = (c: Completion) => {
    console.log(`[Playback] ${c.kind} turn complete (${c.reason})`);
    // Whatever ended the turn (the audio, the visitor's Continue), its captions show in full.
    if (c.responseId) pacer.end(c.responseId);
    if (c.kind === 'slide') {
      if (c.reason !== 'manual') {
        rateRef.current.record(c.chars, c.audibleMs);
        const spc = rateRef.current.secondsPerChar;
        playback.setSecondsPerChar(spc);
        setSecondsPerChar(spc);
      }
      afterSlideNarration();
    } else if (c.kind === 'qa_invite') {
      onInviteDone(c.meta);
    } else {
      onAnswerDone(c.meta);
    }
  };
  fns.current.onTurnStalled = (s: TurnSnapshot) => {
    pacer.end();
    setStatus(s.kind === 'qa_invite'
      ? 'Press Continue when the presenter has finished the invitation'
      : 'The avatar seems to have stopped — press Continue to go on');
  };

  // Handle incoming WebSocket messages from backend proxy
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      console.log('[WS] Message:', msg.type || 'unknown');
      playback.onServerEvent(msg);
      if (isDemoRef.current) {
        if (typeof msg.remaining_ms === 'number') syncDemoClock(msg.remaining_ms);
        // Captions follow the audio (contracts §4.3): the text of what is said, and when each word starts.
        if (msg.type === 'demo.caption') pacer.caption(msg);
        else if (msg.type === 'response.audio_timestamp.delta' || msg.type === 'response.output_audio_timestamp.delta') pacer.word(msg);
        else if (msg.type === 'response.done' && msg.response?.status === 'cancelled') pacer.cancel(msg.response.id);
      }
      if (handleQaMessage(msg)) return;

      // Demo-only acks / notices from the server-side message filter.
      if (msg.type === 'demo.started') {
        // A server that sends no `protocol` speaks v1: no captions, no typed questions, no `demo.finish`.
        const v2 = typeof msg.protocol === 'number' && msg.protocol >= DEMO_PROTOCOL_VERSION;
        protocolV2Ref.current = v2;
        setProtocolV2(v2);
        if (Array.isArray(msg.narration_chars)) {
          const chars: Record<number, number> = {};
          msg.narration_chars.forEach((n: unknown, i: number) => { if (typeof n === 'number' && n >= 0) chars[i] = n; });
          setDemoChars(chars);
        }
        return;
      }
      if (msg.type === 'demo.speaking') {
        if (typeof msg.chars === 'number') {
          playback.setChars(msg.chars);
          if (typeof msg.slide === 'number') setDemoChars((m) => (m[msg.slide] === msg.chars ? m : { ...m, [msg.slide]: msg.chars }));
        }
        return;
      }
      if (msg.type === 'demo.narration_complete') {
        // The server has asked for the last slide. The visitor is offered "Ask a question / Finish demo" when the avatar
        // has *finished saying* it (own playback), which is later: nothing to do here but the clock re-sync above.
        return;
      }
      if (msg.type === 'demo.notice') {
        if (playback.activeKind === 'slide') playback.cancel();
        const slideNo = (typeof msg.slide === 'number' ? msg.slide : currentSlideRef.current) + 1;
        if (msg.code === 'empty_slide') {
          setStatus(`No narration for slide ${slideNo}`);
          if (typeof msg.slide === 'number') setDemoChars((m) => ({ ...m, [msg.slide]: 0 }));
          if (presentingRef.current) goNext(1100);
        } else if (msg.code === 'rate_limited' && presentingRef.current) {
          scheduleSpeak(currentSlideRef.current, 1200);
        } else if (msg.code === 'speak_limit') {
          presentingRef.current = false;
          setPresenting(false);
          setNarrationDone('limit');
          setStatus('');
        } else {
          setStatus(typeof msg.message === 'string' ? msg.message : 'Request ignored');
        }
        return;
      }

      // Visitors read about the presenter, never about the services behind it.
      const progress = (adminText: string) => setStatus(isDemoRef.current ? DEMO_COPY.gettingReady : adminText);
      if (msg.type === 'proxy.connected') {
        progress('Connected to Azure Voice API');
      } else if (msg.type === 'session.updated' || msg.type === 'session.avatar.connecting') {
        const session = msg.session || msg;
        const servers = session?.avatar?.ice_servers || session?.rtc?.ice_servers || session?.ice_servers;
        const username = session?.avatar?.username || session?.avatar?.ice_username || session?.rtc?.ice_username || session?.ice_username;
        const cred = session?.avatar?.credential || session?.avatar?.ice_credential || session?.rtc?.ice_credential || session?.ice_credential;
        if (servers) {
          console.log('[WS] Got ICE servers from', msg.type, ', setting up WebRTC');
          progress('Setting up video connection...');
          setupWebRTC(servers, username, cred);
        }
        // session.avatar.connecting may also carry the server SDP answer
        const serverSdp = msg.server_sdp || msg.sdp;
        if (serverSdp) {
          console.log('[WS] server SDP received in', msg.type);
          handleAnswer(msg);
          retryCountRef.current = 0;
          progress('Connecting video…');
        }
      } else if ((msg.server_sdp || msg.sdp || msg.answer) && (!msg.type || msg.type === 'session.avatar.connected')) {
        handleAnswer(msg);
        retryCountRef.current = 0;
        if (pendingReconnectSpeakRef.current) {
          pendingReconnectSpeakRef.current = false;
          setStatus('Reconnected — speaking in new language...');
          scheduleSpeak(currentSlideRef.current, 1000);
        } else {
          progress('Connecting video…');
        }
      } else if (msg.type === 'error') {
        const errMsg = msg.error?.message || 'Unknown error';
        console.error('[WS] Error:', msg.error);
        if (/output_audio_buffer|no active response/i.test(errMsg)) {
          // Best-effort interrupt (Ask now / cancel) when nothing was playing — not user-facing.
        } else if (isDemoRef.current) {
          // The server closes the socket next: the outcome card then says what happened (never the service's own words).
          sawServiceErrorRef.current = true;
        } else if (errMsg.toLowerCase().includes('capacity') && retryCountRef.current < 3) {
          retryCountRef.current += 1;
          const delay = retryCountRef.current * 5;
          setStatus(`Avatar busy — retrying in ${delay}s (attempt ${retryCountRef.current}/3)...`);
          try { wsRef.current?.close(); } catch {}
          wsRef.current = null;
          retryTimerRef.current = setTimeout(() => { startSessionRef.current(); }, delay * 1000);
        } else {
          setStatus(`Error: ${errMsg}`);
        }
      }
    } catch (err) {
      console.error('[WS] Parse error:', err);
    }
  }, [setupWebRTC, handleAnswer, playback, pacer, syncDemoClock, handleQaMessage, goNext, scheduleSpeak]);

  // Keep handleMessage ref in sync so the WS handler always uses the latest version
  useEffect(() => { handleMessageRef.current = handleMessage; }, [handleMessage]);

  const startSessionRef = useRef<() => void>(() => {});

  const resetQa = useCallback(() => {
    clearQaTimer();
    releaseCapture('cancel');
    setQa(QA_IDLE);
    setMicLevel(0);
  }, [clearQaTimer, releaseCapture, setQa]);

  // ── Demo session: how it ends ─────────────────────────────────────────

  /** Demo state that belongs to one session: watchdogs, captions, prompts. */
  const resetDemoSession = useCallback(() => {
    clearDemoTimer(setupTimerRef);
    clearDemoTimer(mediaDropTimerRef);
    clearDemoTimer(finishTimerRef);
    pacer.reset();
    autoPresentedRef.current = false;
    setNarrationDone(null);
    setFinishing(false);
    setReconnecting(false);
    setSoundBlocked(false);
    setAvatarPlaying(false);
    setTimeWarning('');
    setAnnouncement('');
  }, [clearDemoTimer, pacer]);

  // Demo: release media + timers after the server ends the session (time cap, quota...).
  // The slide stays where it is.
  const teardownDemoMedia = useCallback(() => {
    clearAdvance();
    playback.cancel();
    stopTicker();
    resetQa();
    try {
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.srcObject = null; }
    } catch {}
    setConnected(false);
    setSpeaking(false);
    setPresenting(false);
    setPaused(false);
    setDemoConnecting(false);
    setDemoEndsAt(null);
    resetDemoSession();
  }, [clearAdvance, playback, stopTicker, resetQa, resetDemoSession]);

  /** The recording of this deck (else the public fallback links) is what every ending offers; never blocks the card. */
  const resolveRecording = useCallback(() => {
    const pres = presentationRef.current;
    const seq = sessionSeqRef.current;
    lookupRecording(
      { deck_id: pres.id, title: deckTitleRef.current ?? pres.filename, language: pres.language ?? languageRef.current },
      (found) => { if (seq === sessionSeqRef.current) setRecording(found); },
    );
  }, []);

  const showOutcome = useCallback((next: DemoOutcomeInfo) => {
    setOutcome(next);
    if (next.kind === 'quota') setQuotaBlocked(true);
    resolveRecording();
  }, [resolveRecording]);

  /**
   * Ends the demo from this side — setup or media failed, "Finish demo" — and closes the socket so the avatar is free for
   * the next visitor. `wsRef` is cleared first: the socket's own `onclose` must not produce a second outcome.
   */
  const endDemoLocally = useCallback((next: DemoOutcomeInfo) => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'demo.finish' })); } catch {}
      try { ws.close(1000); } catch {}
    }
    teardownDemoMedia();
    showOutcome(next);
  }, [teardownDemoMedia, showOutcome]);

  /** "Finish demo": a v2 server closes with 4001 at once; if that does not arrive in 3 s (or the server is v1) end it here. */
  const finishDemo = useCallback(() => {
    if (!wsRef.current || finishTimerRef.current) return;
    setFinishing(true);
    const finished = outcomeFor(DEMO_CLOSE_CODES.FINISHED, true);
    if (!protocolV2Ref.current) { endDemoLocally(finished); return; }
    sendWs({ type: 'demo.finish' });
    finishTimerRef.current = setTimeout(() => { finishTimerRef.current = null; endDemoLocally(finished); }, FINISH_CLOSE_WAIT_MS);
  }, [sendWs, endDemoLocally]);

  // The media link (WebRTC) changed state. Signalling success does not mean video flows: the demo gives a dropped link
  // 8 s to come back ("Reconnecting…"), then reports an interrupted session; a link that never came up is the network's.
  const handleMediaState = useCallback((state: string) => {
    // A dropped link is silent too: never read that silence as the end of speech.
    playback.setMediaInterrupted(state === 'disconnected');
    if (state === 'connected') {
      mediaEverConnectedRef.current = true;
      clearDemoTimer(mediaDropTimerRef);
      setReconnecting(false);
      setConnected(true);
      if (!isDemoRef.current) setStatus((s) => (s.startsWith('Reconnected') ? s : 'Avatar connected — ready to present'));
    } else if (state === 'disconnected') {
      if (!isDemoRef.current || !mediaEverConnectedRef.current) return;
      setReconnecting(true);
      if (!mediaDropTimerRef.current) {
        mediaDropTimerRef.current = setTimeout(() => {
          mediaDropTimerRef.current = null;
          endDemoLocally(outcomeFor(DEMO_CLOSE_CODES.ABNORMAL, true));
        }, MEDIA_RECONNECT_MS);
      }
    } else if (state === 'failed' || state === 'timeout') {
      if (isDemoRef.current) {
        endDemoLocally(outcomeFor(DEMO_CLOSE_CODES.ABNORMAL, mediaEverConnectedRef.current));
        return;
      }
      stopSessionRef.current();
      setStatus(state === 'failed'
        ? 'Video connection failed — your network blocks the avatar stream. Try another network.'
        : 'Video connection timed out — your network blocks the avatar stream. Try another network.');
    }
  }, [playback, clearDemoTimer, endDemoLocally]);
  useEffect(() => { handleMediaStateRef.current = handleMediaState; }, [handleMediaState]);

  const startDemoSession = useCallback(() => {
    if (wsRef.current) return;
    sessionSeqRef.current += 1;
    const seq = sessionSeqRef.current;
    openedRef.current = false;
    sawServiceErrorRef.current = false;
    mediaEverConnectedRef.current = false;
    announcedWarningsRef.current.clear();
    protocolV2Ref.current = false;
    setProtocolV2(false);
    resetDemoSession();
    setOutcome(null);
    setRecording(null);
    setDraft('');
    // Progress within a second of the tap: the first thing the visitor reads, before any network answer.
    setStatus(DEMO_COPY.starting);
    setDemoConnecting(true);
    setQaDisabled(null);
    setRemainingQuestions(demoQa?.enabled ? demoQa.max_questions : null);
    void loadRecordingLists(); // warm the cache: the recording is what every ending offers
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/voice/demo?deck_id=${encodeURIComponent(presentation.id)}`);
    wsRef.current = ws;
    ws.onopen = () => {
      openedRef.current = true;
      // No session.update: the server owns the whole demo session config.
      // The server's cap starts at accept; `demo.started` re-syncs it.
      setDemoEndsAt(monoNow() + demoSecondsRef.current * 1000);
      startTicker();
      // The avatar service never handed out its connection details: give up (and free the avatar) instead of letting
      // the countdown burn to the cap.
      setupTimerRef.current = setTimeout(() => {
        setupTimerRef.current = null;
        endDemoLocally(outcomeFor(DEMO_CLOSE_CODES.ABNORMAL, false));
      }, DEMO_TIMING.setupTimeoutMs);
    };
    ws.onmessage = (event) => handleMessageRef.current(event);
    ws.onerror = (e) => { console.error('[WS] Demo error:', e); };
    ws.onclose = (e) => {
      console.log('[WS] Demo closed:', e.code, e.reason);
      if (wsRef.current !== ws) return; // we closed it ourselves (Stop, "Finish demo", a local failure)
      wsRef.current = null;
      teardownDemoMedia();
      const ctx = { sawServiceError: sawServiceErrorRef.current };
      const next = outcomeFor(e.code, openedRef.current, ctx);
      showOutcome(next);
      if (next.kind === 'connect') {
        // A socket that never opened is ambiguous (a blocked network, or the demo was switched off): ask the server.
        void fetchDemoConfigFresh().then((cfg) => {
          if (!cfg || cfg.enabled || seq !== sessionSeqRef.current) return;
          showOutcome(outcomeFor(e.code, false, { ...ctx, configEnabled: false }));
        });
      }
    };
  }, [presentation.id, teardownDemoMedia, startTicker, demoQa, resetDemoSession, endDemoLocally, showOutcome]);

  useEffect(() => { if (connected) setDemoConnecting(false); }, [connected]);

  const startSession = useCallback(async () => {
    if (isDemoRef.current) {
      startDemoSession();
      return;
    }
    try {
      setStatus('Connecting to avatar service...');
      setQaDisabled(null);

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${location.host}/ws/voice`);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('[WS] Connected, sending session config with language:', languageRef.current);
        setStatus('Configuring avatar session...');
        startTicker();
        // Avatar ids come from GET /api/avatars; the backend voice proxy maps the
        // id to the Speech character/style server-side. Without an id, the
        // backend default avatar is used.
        const avatarId = selectedAvatarRef.current || defaultAvatarIdRef.current;
        const sessionConfig: Record<string, unknown> = {
          language: languageRef.current,
        };
        if (avatarId) sessionConfig.avatar = { character: avatarId, style: '' };
        if (selectedVoiceRef.current) {
          sessionConfig.voice = selectedVoiceRef.current;
        }
        // Deck binding for raise-hand Q&A (the server loads the slides itself).
        if (deckIdRef.current) sessionConfig.deck_id = deckIdRef.current;
        else if (presentationIdRef.current) sessionConfig.presentation_id = presentationIdRef.current;
        boundDeckRef.current = deckIdRef.current ?? null;
        ws.send(JSON.stringify({
          type: 'session.update',
          session: sessionConfig,
        }));
      };

      // Use ref to always call the latest handleMessage (avoids stale closure)
      ws.onmessage = (event) => handleMessageRef.current(event);

      ws.onerror = (e) => {
        console.error('[WS] Error:', e);
        setStatus('WebSocket connection failed');
      };

      ws.onclose = (e) => {
        console.log('[WS] Closed:', e.code, e.reason);
        const reason = e.reason || '';
        if (e.code === 4401 || e.code === 4403) {
          setAuthBlock(e.code === 4401 ? 'signin' : 'forbidden');
          setStatus(e.code === 4401 ? 'Sign-in required for the live avatar' : "Your account isn't enabled for this demo");
          if (wsRef.current === ws) wsRef.current = null;
          return;
        }
        if (reason.toLowerCase().includes('capacity') && retryCountRef.current < 3) {
          retryCountRef.current += 1;
          const delay = retryCountRef.current * 5;
          setStatus(`Avatar busy — retrying in ${delay}s (attempt ${retryCountRef.current}/3)...`);
          retryTimerRef.current = setTimeout(() => {
            startSessionRef.current();
          }, delay * 1000);
        } else if (!connected) {
          setStatus(reason ? `Connection closed: ${reason}` : 'Connection closed');
        }
      };
    } catch (err: any) {
      setStatus(`Connection failed: ${err.message || err}`);
      console.error('Avatar connection error:', err);
    }
  }, [language, connected, startDemoSession, startTicker]);

  useEffect(() => { startSessionRef.current = startSession; }, [startSession]);

  // Playlists: rebind Q&A to the new deck without reconnecting the avatar.
  useEffect(() => {
    deckIdRef.current = deckId;
    if (isDemo || !deckId) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || boundDeckRef.current === deckId) return;
    boundDeckRef.current = deckId;
    // Any question in flight belonged to the previous deck: tell the server first.
    if (qaRef.current.phase !== 'idle') cancelQa(false);
    setQaDisabled(null);
    ws.send(JSON.stringify({ type: 'context.switch', deck_id: deckId }));
  }, [deckId, isDemo, cancelQa]);

  // Speak a specific slide by index — reads languageRef so it always uses the latest language
  const speakSlide = useCallback((slideIndex: number) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const q = qaRef.current.phase;
    if (q !== 'idle' && q !== 'resumed' && q !== 'error' && q !== 'raised') return;
    if (q === 'raised') {
      if (qaRef.current.typed || captureRef.current) takeRaisedQuestion();
      return;
    }
    const pres = presentationRef.current;
    const slide = pres.slides[slideIndex];
    if (isDemoRef.current) {
      // The server looks up and reads the stored narration for this slide;
      // the visitor never sends text. The length arrives with `demo.speaking`.
      playback.begin('slide', { chars: 0, meta: slideIndex });
      setStatus(`Presenting slide ${slideIndex + 1} of ${pres.slide_count}`);
      wsRef.current.send(JSON.stringify({ type: 'demo.speak', slide: slide?.index ?? slideIndex }));
      return;
    }
    // If the slide has an embedded video, trigger auto-play and wait for it to end
    if (slide?.video_url) {
      if (presentingRef.current) {
        setStatus(`Playing video for slide ${slideIndex + 1}...`);
        onRequestVideoAutoPlay?.();
      }
      return;
    }
    const narration = narrationFor(slide, languageRef.current, pres.language);
    const text = narration.text;
    if (!text) {
      setStatus(`No text to speak for slide ${slideIndex + 1}`);
      if (presentingRef.current) goNext();
      return;
    }

    const lang = languageRef.current;
    // Pre-translated notes come from the Cosmos DB cache (see services/narration.ts).
    const speakText = text;
    if (narration.fallbackOriginal) {
      setStatus(`No cached translation for ${lang} — speaking original`);
    } else {
      setStatus(`Speaking slide ${slideIndex + 1} of ${pres.slide_count}...`);
    }

    playback.begin('slide', { chars: speakText.length, meta: slideIndex });

    // The session is already configured with the correct language voice & instructions,
    // so we just ask the avatar to read the text as-is.
    const prompt = `Please say the following exactly as written: ${speakText}`;

    // Send text to avatar via the realtime API conversation
    wsRef.current.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: prompt }],
      },
    }));
    wsRef.current.send(JSON.stringify({ type: 'response.create' }));
    // Completion comes from the playback controller (data channel + analyser).
  }, [playback, takeRaisedQuestion, goNext, onRequestVideoAutoPlay]);

  // Keep speakSlideRef in sync so stale closures (timers) call the latest version
  useEffect(() => { speakSlideRef.current = speakSlide; }, [speakSlide]);

  // When video starts playing, interrupt the avatar's speech
  useEffect(() => {
    if (!videoPlaying) return;
    if (!connected) return;
    clearAdvance();
    if (playback.activeKind === 'slide') playback.cancel();
    setStatus('Video playing — avatar paused');
    // Tell Azure to stop the current response immediately
    sendWs({ type: 'response.cancel' });
  }, [videoPlaying, connected, clearAdvance, playback, sendWs]);

  // Embedded slide video: advance only when it actually ended (not on pause).
  useEffect(() => {
    const wasPlaying = prevVideoPlayingRef.current;
    prevVideoPlayingRef.current = videoPlaying;
    if (!wasPlaying || videoPlaying || !presentingRef.current) return;
    const slideVideo = document.querySelector<HTMLVideoElement>('.slide-viewer video');
    if (slideVideo && !slideVideo.ended) {
      setStatus('Video paused — play it to continue the presentation');
      return;
    }
    afterSlideNarration();
  }, [videoPlaying, afterSlideNarration]);

  // Changing slide while the mic is open or an answer is pending cancels the question first.
  const prevSlideForQaRef = useRef(currentSlide);
  useEffect(() => {
    if (prevSlideForQaRef.current === currentSlide) return;
    prevSlideForQaRef.current = currentSlide;
    const phase = qaRef.current.phase;
    if (phase === 'inviting' || phase === 'listening' || phase === 'thinking') {
      cancelQa(false);
      setStatus('Question cancelled — the slide changed');
    }
  }, [currentSlide, cancelQa]);

  const speak = useCallback(() => {
    ensureAudioContext();
    speakSlide(currentSlide);
  }, [currentSlide, speakSlide, ensureAudioContext]);

  // Start auto-presenting from the current slide through the end
  const startPresenting = useCallback(() => {
    ensureAudioContext();
    presentingRef.current = true;
    setPresenting(true);
    setPaused(false);
    pausedRef.current = false;
    speakSlide(currentSlide);
  }, [currentSlide, speakSlide, ensureAudioContext]);

  // Pause: let the current slide finish speaking, then stop auto-advancing
  const pauseSpeech = useCallback(() => {
    setPaused(true);
    pausedRef.current = true;
    setStatus(`Pausing after slide ${currentSlideRef.current + 1}...`);
  }, []);

  // Resume: advance to the next slide and continue presenting
  const resumeSpeech = useCallback(() => {
    ensureAudioContext();
    setPaused(false);
    pausedRef.current = false;
    goNext();
  }, [goNext, ensureAudioContext]);

  // Stalled turn: the user decides to go on (never skipped silently).
  const continuePlayback = useCallback(() => {
    ensureAudioContext();
    playback.forceComplete();
  }, [playback, ensureAudioContext]);

  const stopSession = useCallback(() => {
    // Cancel any pending retry
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    clearAdvance();
    const q = qaRef.current;
    if (q.requestId && q.phase !== 'idle' && q.phase !== 'resumed' && q.phase !== 'error') {
      sendWs({ type: 'qa.cancel', request_id: q.requestId });
    }
    resetQa();
    playback.cancel();
    stopTicker();
    retryCountRef.current = 0;
    try {
      // Tell Azure to close the session before dropping the connection
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'session.close' }));
      }
      wsRef.current?.close();
      wsRef.current = null;
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (audioRef.current) { audioRef.current.pause(); audioRef.current.srcObject = null; }
    } catch {}
    if (isDemoRef.current) resetDemoSession();
    boundDeckRef.current = null;
    setConnected(false);
    setSpeaking(false);
    setStalled(false);
    setPresenting(false);
    presentingRef.current = false;
    setPaused(false);
    setDemoConnecting(false);
    setDemoEndsAt(null);
    setStatus('Disconnected');
  }, [clearAdvance, sendWs, resetQa, playback, stopTicker, resetDemoSession]);

  useEffect(() => { stopSessionRef.current = stopSession; }, [stopSession]);

  useEffect(() => {
    return () => {
      stopSessionRef.current();
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
    };
  }, []);

  // Demo: one Start tap = connect + present every slide. The session starts presenting by itself the moment the avatar's
  // media is up (never before the visitor's tap); admins keep "Present all" and the per-slide controls.
  useEffect(() => {
    if (!isDemo || !connected || autoPresentedRef.current) return;
    autoPresentedRef.current = true;
    startPresenting();
  }, [isDemo, connected, startPresenting]);

  // Demo: land on the page with the Start control focused (Home's CTA brings the visitor here); never start by itself.
  useEffect(() => {
    if (!isDemo) return;
    const active = document.activeElement;
    if (startRef.current && (!active || active === document.body || active.id === 'main')) startRef.current.focus({ preventScroll: true });
  }, [isDemo]);

  // Auto-start: connect on mount, and auto-present whenever the deck changes (playlist mode)
  const autoStartedForRef = useRef<string | null>(null);
  const userDisconnectedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || !canUseAvatar || authBlock) return;
    if (!connected) {
      // An explicit Disconnect must stick: only the Connect button reconnects then.
      if (!userDisconnectedRef.current) startSessionRef.current();
      return;
    }
    // Already connected — if presentation changed, auto-present from the current slide
    if (autoStartedForRef.current !== presentation.id) {
      const switching = autoStartedForRef.current != null;
      autoStartedForRef.current = presentation.id;
      const interrupted = switching && playback.activeEpoch != null;
      if (interrupted) {
        // Stop the previous deck's narration: generation and the audio already queued.
        playback.cancel();
        sendWs({ type: 'response.cancel' });
        sendWs({ type: 'output_audio_buffer.clear' });
      }
      presentingRef.current = true;
      setPresenting(true);
      setPaused(false);
      pausedRef.current = false;
      if (!interrupted) {
        scheduleSpeak(currentSlideRef.current, PRESENT_GAP_MS);
      } else {
        // Start the new deck only once the old audio has gone quiet (bounded wait),
        // so its tail can't count as the new turn's speech.
        clearAdvance();
        const started = monoNow();
        const waitQuiet = () => {
          const quiet = !playback.analyserLive || playback.quietForMs() >= 400;
          if (quiet || monoNow() - started >= 3000) {
            advanceTimerRef.current = null;
            speakSlideRef.current(currentSlideRef.current);
          } else {
            advanceTimerRef.current = setTimeout(waitQuiet, 100);
          }
        };
        advanceTimerRef.current = setTimeout(waitQuiet, PRESENT_GAP_MS);
      }
    }
  }, [autoStart, connected, presentation.id, canUseAvatar, authBlock, playback, sendWs, scheduleSpeak, clearAdvance]);

  // Test-only hooks (dev server / test builds): drive the playback controller
  // without real WebRTC. Compiled out of production builds.
  useEffect(() => {
    if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) return;
    const w = window as any;
    w.__ozRadioTest = {
      // What a real connection does when the media is up: the setup watchdog is done, the remote audio starts playing.
      mediaConnected: () => { clearDemoTimer(setupTimerRef); handleMediaStateRef.current('connected'); playRemoteAudio('track'); },
      // WebRTC connectionState: 'disconnected' | 'connected' | 'failed' (and the pseudo state 'timeout').
      mediaState: (state: string) => handleMediaStateRef.current(state),
      dataChannel: (payload: unknown) => playback.onDataChannelMessage(typeof payload === 'string' ? payload : JSON.stringify(payload)),
      audioLevel: (db: number) => { playback.setAnalyserAvailable(true); playback.onAudioLevel(db); },
      playback: () => playback.snapshot(),
    };
    return () => { if (w.__ozRadioTest) delete w.__ozRadioTest; };
  }, [playback, clearDemoTimer, playRemoteAudio]);

  // The voice element must really be playing while the avatar speaks: if the browser blocked or muted it (autoplay policy,
  // the visitor's mute), say so — a "Speaking" avatar nobody can hear is the worst state (T3-10).
  useEffect(() => {
    const el = audioRef.current;
    if (!isDemo || !connected || !el) return;
    const check = () => {
      if (!el.srcObject) return; // no stream attached (yet)
      setSoundBlocked(el.paused || el.muted || el.volume === 0);
    };
    const timer = setInterval(check, 1000);
    el.addEventListener('playing', check);
    el.addEventListener('pause', check);
    el.addEventListener('volumechange', check);
    return () => {
      clearInterval(timer);
      el.removeEventListener('playing', check);
      el.removeEventListener('pause', check);
      el.removeEventListener('volumechange', check);
    };
  }, [isDemo, connected]);

  const host = (!isDemo && selectedAvatar ? avatars.find((a) => a.id === selectedAvatar) : undefined)
    ?? pickDefaultAvatar(avatars) ?? null;
  const hostName = host?.display_name?.trim() || 'AI host';
  const qaBusy = qa.phase !== 'idle' && qa.phase !== 'resumed' && qa.phase !== 'error';
  // The idle stage already says the avatar is offline; skip the redundant default statuses. The demo also stays quiet
  // while a question is in flight (the question panel says where it is) and after an ending (the outcome card does).
  const statusText = status === 'Not connected' || (!connected && status === 'Disconnected') || (isDemo && (qaBusy || outcome))
    ? '' : status;
  const statusIsError = /^(Error|Connection (failed|closed)|Video connection|WebSocket connection failed|Could not)/.test(statusText);
  const connecting = !connected && (demoConnecting || /^(Connecting|Configuring|Setting up|Starting|Avatar busy)/.test(status));
  // The server's hard cap starts when the demo socket opens (connection setup
  // included), so the countdown is shown from that moment — not only once the
  // video connects — and rounds up so 0:00 coincides with the cutoff.
  // Clamped to the session cap: ceil() plus clock skew could briefly show 5:01.
  const demoSecondsLeft = isDemo && demoEndsAt
    ? Math.min(demoSecondsRef.current, Math.max(0, Math.ceil((demoEndsAt - demoNow) / 1000)))
    : null;

  // Countdown warnings (WCAG 2.2.1): shown and announced once at 60 s and 20 s before the cap. The server's
  // `remaining_ms` is the truth (it re-syncs the clock); this only reads the countdown.
  useEffect(() => {
    if (!isDemo || demoSecondsLeft == null) return;
    const crossed = DEMO_WARN_AT_SECONDS.filter((t) => demoSecondsLeft <= t && !announcedWarningsRef.current.has(t));
    if (crossed.length === 0) return;
    crossed.forEach((t) => announcedWarningsRef.current.add(t));
    setTimeWarning(timeWarningText(Math.min(...crossed)));
  }, [isDemo, demoSecondsLeft]);

  // Narration estimate: remaining slides' narration length × measured pace.
  const slideCount = presentation.slide_count;
  const observed = Object.entries(demoChars).filter(([, n]) => n > 0).map(([, n]) => n);
  const demoAvgChars = observed.length ? observed.reduce((a, b) => a + b, 0) / observed.length : null;
  const slideSeconds: (number | null)[] = [];
  for (let i = currentSlide; i < slideCount; i++) {
    let chars: number | null;
    if (isDemo) chars = demoChars[i] ?? demoAvgChars;
    else {
      const s = presentation.slides[i];
      chars = s?.video_url ? 0 : narrationFor(s, language, presentation.language).text.length;
    }
    slideSeconds.push(chars == null ? null : chars * secondsPerChar);
  }
  const narrationKnown = slideSeconds.length > 0 && slideSeconds.every((s) => s != null);
  const narrationLeft = narrationKnown ? Math.ceil((slideSeconds as number[]).reduce((a, b) => a + b, 0)) : null;
  const showTiming = connected || demoSecondsLeft != null;
  // Demo: the coverage note belongs to the run-up (connecting); once the presentation is over it would be stale.
  const coverageText = isDemo && !presenting && !narrationDone && !outcome && demoSecondsLeft != null && narrationKnown
    ? coverageNote(slideSeconds as number[], demoSecondsLeft)
    : null;

  const narrating = speaking && playback.activeKind === 'slide';
  const showRaiseHand = connected && qaAvailable;
  const canAskMore = qaAvailable && !qaDisabled && remainingQuestions !== 0;
  // The voice and the stage: what the avatar is doing right now, never claimed when nobody can hear it.
  const avatarSpeaking = isDemo ? avatarPlaying : speaking;
  const pillLabel = isDemo && soundBlocked ? 'Sound off'
    : isDemo && reconnecting ? DEMO_COPY.reconnecting
      : qa.phase === 'listening' ? 'Listening' : avatarSpeaking ? 'Speaking' : 'Live';

  const idleLine = isDemo
    ? (demoConnecting ? 'Starting…' : 'Live avatar demo')
    : canUseAvatar && !authBlock
      ? (connecting ? 'Connecting…' : 'Connect to start the avatar')
      : 'Live avatar preview';
  const statusLine = statusText && (statusIsError
    ? <Alert tone="error">{statusText}</Alert>
    : <p className="avatar-rail__status" role="status">{statusText}</p>);

  const timing = showTiming && (
    <div className="avatar-rail__timing small muted tabular">
      {demoSecondsLeft != null && (
        <span data-testid="demo-time-left" title="Demo time remaining">Demo time left {formatClock(demoSecondsLeft)}</span>
      )}
      {connected && narrationLeft != null && !narrationDone && (
        <span data-testid="narration-left">
          Slide {currentSlide + 1}/{slideCount} · ~{formatClock(narrationLeft)} narration left
        </span>
      )}
      {isDemo && (
        <span className="avatar-rail__warning" role="status" aria-live="polite" data-testid="demo-time-warning">{timeWarning}</span>
      )}
    </div>
  );

  const stalledButton = stalled && (
    <Button data-testid="playback-continue" size="sm" variant="primary" icon={StepForward} onClick={continuePlayback}>
      Continue
    </Button>
  );

  // "Ask a question" after the presentation: the typed field when there is one, else the spoken question.
  const askAfterNarration = () => {
    const input = dockRef.current?.querySelector<HTMLInputElement>('[data-testid="qa-text-input"]');
    if (input) input.focus(); else raiseHand();
  };

  // One Start tap = connect + present. The same tap banks the audio permission on the persistent <audio> element and
  // unlocks the audio context (a later, programmatic play() is then allowed on iOS and by autoplay policies).
  const startDemo = () => {
    ensureAudioContext();
    playRemoteAudio('start');
    void startSession();
  };

  const raiseHandPanel = showRaiseHand && (
    <RaiseHandPanel
      phase={qa.phase}
      available={!qaDisabled && remainingQuestions !== 0}
      disabledReason={qaDisabled ?? (isDemo && remainingQuestions === 0 ? DEMO_QA_LIMIT_MESSAGES.session : null)}
      narrating={narrating}
      canAskNow={!isDemo}
      canType={isDemo ? protocolV2 : true}
      demo={isDemo}
      typedQueued={isDemo && !!qa.typed}
      draft={draft}
      onDraftChange={setDraft}
      remaining={isDemo ? remainingQuestions : null}
      level={micLevel}
      transcript={qa.transcript}
      answer={qa.answer}
      error={qa.error}
      notice={qaNotice}
      onRaise={() => raiseHand()}
      onAskNow={askNow}
      onSubmitText={(t) => { if (!isDemo) setDraft(''); raiseHand(t); }}
      onDone={() => captureRef.current?.finish()}
      onCancel={() => cancelQa(true)}
      onContinue={continueAfterQaError}
    />
  );

  // Phones: the demo controls are a fixed bar at the bottom of the screen (see avatar-panel.css). Publish its height so
  // the end of the page stays clear of it and keyboard focus never lands underneath it (WCAG 2.4.11).
  useEffect(() => {
    const el = dockRef.current;
    if (!isDemo || !el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const update = () => {
      if (getComputedStyle(el).position === 'fixed') {
        root.style.setProperty('--demo-dock-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
        root.dataset.demoDock = '';
      } else {
        root.style.removeProperty('--demo-dock-h');
        delete root.dataset.demoDock;
      }
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener('resize', update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', update);
      root.style.removeProperty('--demo-dock-h');
      delete root.dataset.demoDock;
    };
  }, [isDemo]);

  // The recording is the value left when the presentation stops on the narration limit.
  useEffect(() => { if (narrationDone === 'limit') resolveRecording(); }, [narrationDone, resolveRecording]);

  const quotaReasonId = React.useId();
  const startButton = (
    <Button
      ref={startRef}
      data-testid="demo-start"
      variant="primary"
      icon={Play}
      busy={demoConnecting}
      disabled={quotaBlocked}
      aria-describedby={quotaBlocked ? quotaReasonId : undefined}
      className="avatar-rail__start"
      onClick={startDemo}
    >
      {demoConnecting ? 'Starting…' : 'Start the live demo'}
    </Button>
  );
  const demoControls = (
    <div className="avatar-rail__controls">
      {!connected && startButton}
      {stalledButton}
      {(connected || demoConnecting) && (
        <Button data-testid="demo-stop" size={connected ? 'sm' : 'md'} variant="ghost" icon={Square} onClick={stopSession}>
          Stop
        </Button>
      )}
    </div>
  );

  return (
    <section
      className={['avatar-rail', `avatar-rail--${mode}`, isDemo && 'avatar-rail--demo', connected && 'is-live', avatarSpeaking && !(isDemo && soundBlocked) && 'is-speaking']
        .filter(Boolean).join(' ')}
      aria-label="AI presenter"
    >
      <div className="avatar-rail__head">
        <span className="eyebrow">{connected ? 'Now presenting' : 'Ready to present'}</span>
        {connected ? (
          <span className="avatar-rail__live">
            <Waveform active={avatarSpeaking && !(isDemo && soundBlocked)} />
            <LivePill>{pillLabel}</LivePill>
          </span>
        ) : demoSecondsLeft != null && (
          <span className="avatar-rail__live">
            <LivePill idle>Connecting</LivePill>
          </span>
        )}
      </div>
      {/* The demo's countdown lives with its controls (in view on a phone, where they are a bar at the bottom). */}
      {!isDemo && timing}

      <div className="stage avatar-rail__stage">
        <video ref={videoRef} className="avatar-rail__video" autoPlay playsInline />
        {/* The avatar's voice: always in the page, so the Start tap can unlock it and the stream is just attached later. */}
        <audio ref={audioRef} className="avatar-rail__audio" autoPlay playsInline />
        {!connected && (
          <div className="avatar-rail__idle">
            <HostDisc host={host} ring={connecting} label="" />
            <span className="avatar-rail__idle-name">{hostName}</span>
            <span className="avatar-rail__idle-line">{idleLine}</span>
          </div>
        )}
      </div>

      {connected && (
        <div className="avatar-rail__host">
          <span className="avatar-rail__name">{hostName}</span>
          <span className="small muted">AI host · {languageName(language)}</span>
        </div>
      )}

      {isDemo ? (
        <>
          {outcome && (
            <DemoOutcome
              key={outcome.kind}
              title={outcome.title}
              detail={outcome.detail}
              tone={outcome.tone}
              role={outcome.role}
              kind={outcome.kind}
              recording={recording}
              retry={outcome.retry !== 'none' ? { label: outcome.retryLabel ?? 'Try again', onClick: startDemo } : null}
              autoFocus
            />
          )}
          <div ref={dockRef} data-testid="demo-avatar-controls" role="group" aria-label="Live demo controls" className="avatar-rail__panel avatar-dock">
            {timing}
            {connected ? (
              <>
                {protocolV2 && (
                  <LiveCaptions
                    view={captionView}
                    announcement={announcement}
                    lang={langAttr(language)}
                    suppressed={!!qa.answer && (qa.phase === 'answering' || qa.phase === 'resumed')}
                  />
                )}
                {soundBlocked && (
                  <div className="avatar-rail__sound" role="status" data-testid="demo-sound-blocked">
                    <span>{DEMO_COPY.soundBlocked}</span>
                    <Button size="sm" variant="primary" icon={Volume2} data-testid="demo-sound-on" onClick={() => { ensureAudioContext(); playRemoteAudio('user'); }}>
                      {DEMO_COPY.turnSoundOn}
                    </Button>
                  </div>
                )}
                {reconnecting && <p className="avatar-rail__status" role="status" data-testid="demo-reconnecting">{DEMO_COPY.reconnecting}</p>}
                {narrationDone && (
                  <DemoNarrationDone
                    title={narrationDone === 'limit' ? DEMO_COPY.narrationLimit : 'The presentation is complete'}
                    secondsLeft={demoSecondsLeft}
                    canAsk={canAskMore}
                    onAsk={askAfterNarration}
                    onFinish={finishDemo}
                    finishing={finishing}
                    recording={narrationDone === 'limit' ? recording : null}
                  />
                )}
                {statusText && <p className="avatar-rail__status" role="status" data-testid="demo-status">{statusText}</p>}
                {raiseHandPanel}
                {demoControls}
              </>
            ) : (
              <>
                {demoControls}
                {quotaBlocked && (
                  <p id={quotaReasonId} className="avatar-rail__note" data-testid="demo-start-reason">
                    Today&rsquo;s live allowance has been reached.
                  </p>
                )}
                {coverageText && <p className="avatar-rail__note" data-testid="demo-coverage-note">{coverageText}</p>}
                {!outcome && (
                  <p className="avatar-rail__note">
                    {demoQa?.enabled ? 'Narration demo with questions' : 'Narration-only demo'} · up to {formatMinutes(demoSessionSeconds)} · no uploads
                  </p>
                )}
                {statusText && <p className="avatar-rail__status" role="status" data-testid="demo-status">{statusText}</p>}
              </>
            )}
          </div>
        </>
      ) : !auth.loading && (!canUseAvatar || authBlock) ? (
        <div className="avatar-rail__panel">
          <GateNotice action="try the live avatar" force={authBlock ?? undefined} />
          {authBlock && auth.is_admin && (
            <div className="avatar-rail__controls">
              <Button
                size="sm"
                variant="ghost"
                icon={RotateCcw}
                onClick={() => { setAuthBlock(null); setStatus('Not connected'); }}
              >
                Retry
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="avatar-rail__panel">
          <div className="avatar-rail__controls">
            {!connected ? (
              <Button
                variant="primary"
                icon={Play}
                className="avatar-rail__start"
                onClick={() => { userDisconnectedRef.current = false; ensureAudioContext(); void startSession(); }}
              >
                Connect avatar
              </Button>
            ) : (
              <>
                <Button size="sm" icon={Mic} disabled={speaking || paused || qaBusy} onClick={speak}>
                  Speak slide {currentSlide + 1}
                </Button>
                {speaking && paused ? (
                  <Button size="sm" icon={Pause} disabled>
                    Pausing…
                  </Button>
                ) : paused ? (
                  <Button size="sm" variant="primary" icon={Play} disabled={qaBusy} onClick={resumeSpeech}>
                    Resume
                  </Button>
                ) : speaking ? (
                  <Button size="sm" icon={Pause} disabled={qaBusy} onClick={pauseSpeech}>
                    Pause
                  </Button>
                ) : !presenting ? (
                  <Button size="sm" variant="primary" icon={Play} disabled={qaBusy} onClick={startPresenting}>
                    Present all
                  </Button>
                ) : null}
                {stalledButton}
                <Button size="sm" variant="ghost" icon={PhoneOff} onClick={() => { userDisconnectedRef.current = true; stopSession(); }}>
                  Disconnect
                </Button>
              </>
            )}
          </div>
          {raiseHandPanel}
          {statusLine}
        </div>
      )}
    </section>
  );
}
