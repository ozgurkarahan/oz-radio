import { useSyncExternalStore } from 'react';

/**
 * Touch-first phones: an episode opened without a mode starts in Listen when it has audio, and
 * episode rows lead with Listen (the owner listens with the screen locked; video stops there).
 * Kept in its own small module so Home can use it without pulling the podcast library page into the main chunk.
 */
export const PHONE_QUERY = '(hover: none) and (pointer: coarse)';

export function prefersListen(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;
}

function onPhoneQueryChange(listener: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener?.('change', listener);
  return () => query.removeEventListener?.('change', listener);
}

/** `prefersListen()` for rendering (library rows, Home episode links); follows input changes (a docked tablet). */
export function usePrefersListen(): boolean {
  return useSyncExternalStore(onPhoneQueryChange, prefersListen);
}
