/**
 * Transition announcements for a polite live region (WCAG 4.1.3).
 *
 * `useTransitionAnnouncement(value)` returns the text a `role="status"` region should hold:
 * - the value present at mount is never announced (only a change is a transition);
 * - a new non-empty value is announced after `delayMs`, so a state that flips back within that
 *   window ("Loading…" between two sentences) stays silent;
 * - an empty value clears the region at once, so the next identical announcement reads again.
 * Callers pass state-derived text only — never per-speaker lines, which would talk over the audio.
 */
import { useEffect, useRef, useState } from 'react';

export const ANNOUNCE_DELAY_MS = 700;

export function useTransitionAnnouncement(value: string, delayMs: number = ANNOUNCE_DELAY_MS): string {
  const [text, setText] = useState('');
  const previous = useRef(value);
  useEffect(() => {
    if (previous.current === value) return undefined;
    previous.current = value;
    if (!value) {
      setText('');
      return undefined;
    }
    const timer = window.setTimeout(() => setText(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return text;
}
