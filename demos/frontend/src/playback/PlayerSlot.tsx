/**
 * PlayerSlot — where the app's root radio player appears (the episode dialog's Listen panel).
 *
 * While mounted, the provider's player host node is moved into this element (presentation
 * "dialog", the mini-player hides); on unmount it is parked again — in the layout-effect
 * cleanup, which runs before React removes the dialog DOM, so playback never stops. Render at
 * most one at a time. Idempotent under StrictMode (attach → park → attach in one commit).
 */
import { useLayoutEffect, useRef } from 'react';
import { usePlaybackInternals } from './PlaybackProvider';

export function PlayerSlot({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { attachSlot } = usePlaybackInternals();
  useLayoutEffect(() => {
    const el = ref.current;
    return el ? attachSlot(el) : undefined;
  }, [attachSlot]);
  return <div ref={ref} className={['player-slot', className].filter(Boolean).join(' ')} data-testid="player-slot" />;
}

export default PlayerSlot;
