/**
 * Non-trickle ICE offer timing for the live avatar (contracts §4.7).
 *
 * The browser gathers ICE candidates and only then sends one complete SDP offer. Waiting for the gathering to
 * *finish* can take as long as the slowest TURN attempt: on a network that blocks UDP the UDP attempts time out while a
 * TCP/TLS relay was ready after a second or so (measured: 5.03 s of the 10.98 s to the first word). The planner answers
 * "when does the offer leave?" from the candidates seen so far. It is pure (an injected clock, no DOM) so the rules are
 * unit-tested; AvatarPanel wires the timer.
 *
 *   gathering complete          → send at once                                   ('complete')
 *   a TCP/TLS relay candidate   → send `preferredSettleMs` after it              ('preferred-relay')
 *   any relay candidate         → send `relayGraceMs` (2 s) after the first one  ('relay-grace')
 *   otherwise                   → send `maxWaitMs` (5 s) after the start         ('max-wait')
 *
 * Why a TCP/TLS relay is preferred: it is the candidate that still works behind a firewall that drops UDP, i.e. exactly
 * the network where gathering stays open longest. A UDP-only relay waits the full grace in case a TCP/TLS one follows.
 * `iceTransportPolicy: 'relay'` stays: only relay candidates ever appear.
 */
import { DEMO_TIMING } from './demoProtocol';

/** Wait this long after a TCP/TLS relay candidate so candidates arriving at the same time join the offer. */
export const ICE_PREFERRED_SETTLE_MS = 250;

export type IceSendReason = 'complete' | 'preferred-relay' | 'relay-grace' | 'max-wait';

/** What `classifyIceCandidate` reads: an `RTCIceCandidate` (or its init) — every field optional. */
export interface IceCandidateLike {
  candidate?: string | null;
  type?: string | null;
  protocol?: string | null;
  /** Transport between the browser and the TURN server ('udp' | 'tcp' | 'tls'), where the browser exposes it. */
  relayProtocol?: string | null;
  /** The ICE server URL the candidate came from, where the browser exposes it. */
  url?: string | null;
}

/** `preferred` = a relay reached over TCP/TLS (e.g. `turns:` on 443); `relay` = any other relay; `other` = not a relay. */
export type IceCandidateClass = 'other' | 'relay' | 'preferred';

export function classifyIceCandidate(c: IceCandidateLike | null | undefined): IceCandidateClass {
  if (!c) return 'other';
  const line = typeof c.candidate === 'string' ? c.candidate : '';
  const type = (c.type ?? /\btyp\s+(\w+)/.exec(line)?.[1] ?? '').toLowerCase();
  if (type !== 'relay') return 'other';
  // "candidate:<foundation> <component> <protocol> <priority> <address> <port> typ relay ..."
  const protocol = (c.protocol ?? line.replace(/^a=/, '').replace(/^candidate:/, '').trim().split(/\s+/)[2] ?? '').toLowerCase();
  const relayProtocol = (c.relayProtocol ?? '').toLowerCase();
  const url = (c.url ?? '').toLowerCase();
  const overTcp = relayProtocol === 'tcp' || relayProtocol === 'tls' || protocol === 'tcp'
    || /^turns:/.test(url) || /transport=tcp/.test(url) || /:443(?:\?|$)/.test(url);
  return overTcp ? 'preferred' : 'relay';
}

export interface IcePlannerOptions {
  /** Send this long after the first relay candidate (default DEMO_TIMING.iceRelayGraceMs). */
  relayGraceMs?: number;
  /** Send this long after the first TCP/TLS relay candidate (default ICE_PREFERRED_SETTLE_MS). */
  preferredSettleMs?: number;
  /** Never wait longer than this after the start (default DEMO_TIMING.iceGatherMaxMs). */
  maxWaitMs?: number;
}

/** The rule used before the demo had its own: send when gathering completes, or after the 5 s safety timer. */
export const ICE_WAIT_FOR_GATHERING: IcePlannerOptions = {
  relayGraceMs: Number.POSITIVE_INFINITY,
  preferredSettleMs: Number.POSITIVE_INFINITY,
  maxWaitMs: DEMO_TIMING.iceGatherMaxMs,
};

export class IceOfferPlanner {
  private firstRelayAt: number | null = null;
  private firstPreferredAt: number | null = null;
  private completedAt: number | null = null;
  private readonly relayGraceMs: number;
  private readonly preferredSettleMs: number;
  private readonly maxWaitMs: number;

  /** `startedAt`: the clock reading when gathering began (the offer was created). All times share one clock. */
  constructor(private readonly startedAt: number, options: IcePlannerOptions = {}) {
    this.relayGraceMs = options.relayGraceMs ?? DEMO_TIMING.iceRelayGraceMs;
    this.preferredSettleMs = options.preferredSettleMs ?? ICE_PREFERRED_SETTLE_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEMO_TIMING.iceGatherMaxMs;
  }

  /** A candidate was gathered at `at`. Only relay candidates move the deadline. */
  candidate(c: IceCandidateLike | null | undefined, at: number): IceCandidateClass {
    const kind = classifyIceCandidate(c);
    if (kind !== 'other' && this.firstRelayAt === null) this.firstRelayAt = at;
    if (kind === 'preferred' && this.firstPreferredAt === null) this.firstPreferredAt = at;
    return kind;
  }

  /** Gathering finished (the end-of-candidates marker or `iceGatheringState === 'complete'`). */
  complete(at: number): void {
    if (this.completedAt === null) this.completedAt = at;
  }

  /** When the offer must go out (the planner's clock) and why. Never later than `startedAt + maxWaitMs`. */
  due(): { at: number; reason: IceSendReason } {
    if (this.completedAt !== null) return { at: this.completedAt, reason: 'complete' };
    let best: { at: number; reason: IceSendReason } = { at: this.startedAt + this.maxWaitMs, reason: 'max-wait' };
    if (this.firstRelayAt !== null && this.firstRelayAt + this.relayGraceMs <= best.at) {
      best = { at: this.firstRelayAt + this.relayGraceMs, reason: 'relay-grace' };
    }
    if (this.firstPreferredAt !== null && this.firstPreferredAt + this.preferredSettleMs <= best.at) {
      best = { at: this.firstPreferredAt + this.preferredSettleMs, reason: 'preferred-relay' };
    }
    return best;
  }
}
