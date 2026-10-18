/**
 * Exclusive podcast playback: exactly one podcast medium is heard at a time.
 *
 * `installExclusivePlayback({ getRadio, onRadioTakenOver })` adds ONE document capture-phase
 * `play` listener (media events do not bubble, capture still sees them) and returns its
 * uninstaller. On every `play`:
 * - the root radio (`getRadio()`) starts → every other playing `[data-oz-media]` element
 *   (library / creator videos, the creator page's radio) is paused;
 * - any other AUDIBLE element starts (not muted, volume > 0 — videos, the creator page's radio,
 *   WebRTC avatar audio) → `onRadioTakenOver(element)` (the provider pauses the root radio);
 * - in both cases the Media Session owner, when it is another media element, releases its claim
 *   (the newcomer — or the browser's default session for a video — gets the OS controls).
 */
import { mediaSessionOwner, releaseMediaSession } from './mediaSession';

/** Marker of podcast media that pause when the root radio starts: `data-oz-media="radio|video"`. */
export const OZ_MEDIA_ATTR = 'data-oz-media';

export function isAudible(el: HTMLMediaElement): boolean {
  return !el.muted && el.volume > 0;
}

/** Pauses every playing `[data-oz-media]` element except `keep`. */
export function pauseOtherMedia(keep: HTMLMediaElement | null): void {
  document.querySelectorAll<HTMLMediaElement>(`[${OZ_MEDIA_ATTR}]`).forEach((el) => {
    if (el !== keep && el instanceof HTMLMediaElement && !el.paused) {
      try { el.pause(); } catch { /* ignore */ }
    }
  });
}

export interface ExclusiveOptions {
  getRadio(): HTMLMediaElement | null;
  onRadioTakenOver(by: HTMLMediaElement): void;
}

export function installExclusivePlayback({ getRadio, onRadioTakenOver }: ExclusiveOptions): () => void {
  const onPlay = (event: Event) => {
    const el = event.target;
    if (!(el instanceof HTMLMediaElement)) return;
    const radio = getRadio();
    if (el === radio) {
      pauseOtherMedia(radio);
    } else {
      if (!isAudible(el)) return;
      if (radio) onRadioTakenOver(el);
    }
    const owner = mediaSessionOwner();
    if (owner && owner !== el && owner instanceof HTMLMediaElement) releaseMediaSession(owner);
  };
  document.addEventListener('play', onPlay, true);
  return () => document.removeEventListener('play', onPlay, true);
}
