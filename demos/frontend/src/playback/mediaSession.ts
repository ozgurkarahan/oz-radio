/**
 * Media Session arbiter: one owner of the OS media controls (lock screen, notification,
 * earbuds, keyboard media keys) at a time — the last medium that claimed them.
 *
 * - `claimMediaSession(owner, { metadata, handlers, playbackState })` sets EVERY action of
 *   `MEDIA_SESSION_ACTIONS` (null when absent from `handlers`, so a previous owner's handlers
 *   never leak), the metadata and the playback state.
 * - `updateMediaSession` / `setMediaPositionState` apply only while `owner` still owns it.
 * - `releaseMediaSession(owner)` clears every action, the metadata and the state — only if
 *   `owner` is still the owner (a later claimer is never disturbed).
 *
 * RadioPlayer instances claim with their <audio> element as `owner` (on play) and release on
 * unmount; exclusive.ts releases the owner when another audible medium starts (takeover).
 * Every call is a no-op where the API is missing and never throws.
 */

export const MEDIA_SESSION_ACTIONS: readonly MediaSessionAction[] = [
  'play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack', 'stop',
];

export interface MediaArtworkInit {
  src: string;
  /** e.g. "512x512" — only when known. */
  sizes?: string;
  type?: string;
}

export interface MediaMetadataInit {
  title: string;
  artist?: string;
  album?: string;
  artwork?: MediaArtworkInit[];
}

export type MediaSessionHandlers = Partial<Record<MediaSessionAction, MediaSessionActionHandler>>;

export interface MediaSessionClaim {
  metadata?: MediaMetadataInit | null;
  handlers?: MediaSessionHandlers;
  playbackState?: MediaSessionPlaybackState;
}

let owner: object | null = null;

export function hasMediaSession(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator && !!navigator.mediaSession;
}

export function mediaSessionOwner(): object | null {
  return owner;
}

export function isMediaSessionOwner(candidate: object | null | undefined): boolean {
  return !!candidate && owner === candidate;
}

function applyMetadata(metadata: MediaMetadataInit | null | undefined): void {
  const session = navigator.mediaSession;
  if (!metadata) {
    try { session.metadata = null; } catch { /* ignore */ }
    return;
  }
  if (typeof MediaMetadata === 'undefined') return;
  const artwork = (metadata.artwork ?? []).filter((a) => !!a?.src).map((a) => ({
    src: a.src,
    ...(a.sizes ? { sizes: a.sizes } : {}),
    ...(a.type ? { type: a.type } : {}),
  }));
  try {
    session.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist ?? '',
      album: metadata.album ?? '',
      artwork,
    });
  } catch {
    try {
      session.metadata = new MediaMetadata({ title: metadata.title, artist: metadata.artist ?? '', album: metadata.album ?? '' });
    } catch { /* invalid metadata */ }
  }
}

function applyHandlers(handlers: MediaSessionHandlers | undefined): void {
  const session = navigator.mediaSession;
  for (const action of MEDIA_SESSION_ACTIONS) {
    try { session.setActionHandler(action, handlers?.[action] ?? null); } catch { /* action not supported */ }
  }
}

function applyPlaybackState(state: MediaSessionPlaybackState | undefined): void {
  if (!state) return;
  try { navigator.mediaSession.playbackState = state; } catch { /* ignore */ }
}

export function claimMediaSession(next: object, claim: MediaSessionClaim): void {
  if (!hasMediaSession()) return;
  owner = next;
  applyHandlers(claim.handlers);
  applyMetadata(claim.metadata);
  applyPlaybackState(claim.playbackState);
}

export function updateMediaSession(who: object, patch: MediaSessionClaim): void {
  if (!hasMediaSession() || owner !== who) return;
  if (patch.handlers) applyHandlers(patch.handlers);
  if (patch.metadata !== undefined) applyMetadata(patch.metadata);
  applyPlaybackState(patch.playbackState);
}

export function setMediaPositionState(who: object, state: MediaPositionState): void {
  if (!hasMediaSession() || owner !== who || typeof navigator.mediaSession.setPositionState !== 'function') return;
  try { navigator.mediaSession.setPositionState(state); } catch { /* inconsistent state while loading */ }
}

export function releaseMediaSession(who: object | null | undefined): void {
  if (!who || owner !== who) return;
  owner = null;
  if (!hasMediaSession()) return;
  applyHandlers(undefined);
  applyMetadata(null);
  try { navigator.mediaSession.playbackState = 'none'; } catch { /* ignore */ }
}
