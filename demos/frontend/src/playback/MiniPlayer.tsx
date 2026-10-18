/**
 * MiniPlayer — the "Now playing" bar that keeps an episode on every route.
 *
 * Fixed to the bottom (64 px + the home-indicator inset; full width on phones, 720 px centred
 * on desktop), shown while an episode is loaded and no episode dialog is open. The title
 * area reopens the Now Playing sheet (`/podcast/library?episode=<id>&mode=listen`, pushed
 * with the `OPENED_HERE` history state so closing it returns here); Play/Pause; "Stop and
 * close player" only while paused. Publishes `--mini-player-h` on <html> (the bar height above
 * the inset, "0px" when hidden) for toasts and scroll padding, and renders an in-flow spacer so
 * the page's last content and focused controls are never hidden behind it.
 * Styles: styles/shared/mini-player.css (tokens only).
 */
import { useId, useLayoutEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Headphones, Pause, Play, X } from 'lucide-react';
import { Button, humanizeTitle } from '../ui';
import { usePlaybackCommands, usePlaybackState } from './PlaybackProvider';
import { OPENED_HERE, nowPlayingPath } from './types';
import '../styles/shared/mini-player.css';

const OPEN_ATTR = 'data-mini-player-open';

/**
 * Focus target when a dialog's opener is gone: the mini-player's open button when shown, else
 * `#main`. Pass to `<Modal fallbackFocus>`.
 */
export function miniPlayerFocusTarget(): HTMLElement | null {
  const open = document.querySelector<HTMLElement>(`[${OPEN_ATTR}]`);
  if (open && !open.closest('[hidden]')) return open;
  return document.getElementById('main');
}

export function MiniPlayer() {
  const state = usePlaybackState();
  const { play, pause, stop } = usePlaybackCommands();
  const navigate = useNavigate();
  const statusId = useId();
  const barRef = useRef<HTMLDivElement>(null);
  const { current, playing, time, duration, status, finished } = state;
  const visible = !!current && state.presentation === 'mini' && !state.miniSuppressed;

  // --mini-player-h: the bar's height above the safe-area inset (with a unit, "0px" when hidden).
  useLayoutEffect(() => {
    const root = document.documentElement;
    const hide = () => {
      root.style.setProperty('--mini-player-h', '0px');
      root.removeAttribute('data-mini-player');
    };
    const bar = barRef.current;
    if (!visible || !bar) {
      hide();
      return undefined;
    }
    const publish = () => root.style.setProperty('--mini-player-h', `${Math.ceil(bar.getBoundingClientRect().height)}px`);
    publish();
    root.setAttribute('data-mini-player', '');
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      hide();
    };
  }, [visible]);

  if (!current) return null;

  const { jobId, item } = current;
  const title = humanizeTitle(item.title);
  const cover = item.cover_url || item.thumbnail_url || null;
  const progress = duration > 0 ? Math.min(1, Math.max(0, finished ? 1 : time / duration)) : 0;

  const open = () => navigate(nowPlayingPath(jobId), { state: { [OPENED_HERE]: jobId } });
  const close = () => {
    stop();
    // The bar (and the focused Stop button) disappears: keep keyboard users on the page.
    document.getElementById('main')?.focus({ preventScroll: true });
  };

  return (
    <>
      {visible && <div className="mini-player-spacer" aria-hidden />}
      <section className="mini-player" aria-label="Now playing" hidden={!visible} data-testid="mini-player">
        <div className="mini-player__progress" aria-hidden>
          <span style={{ transform: `scaleX(${Math.round(progress * 1000) / 1000})` }} />
        </div>
        <div ref={barRef} className="mini-player__bar">
          <button
            type="button"
            className="mini-player__open"
            aria-label={`Open now playing: ${title}`}
            aria-describedby={statusId}
            data-testid="mini-player-open"
            {...{ [OPEN_ATTR]: '' }}
            onClick={open}
          >
            <span className="mini-player__thumb" aria-hidden>
              {cover ? <img src={cover} alt="" decoding="async" draggable={false} /> : <Headphones />}
            </span>
            <span className="mini-player__text">
              <span className="mini-player__title">{title}</span>
              <span className="mini-player__status" id={statusId} data-testid="mini-player-status">{status}</span>
            </span>
          </button>
          <Button
            variant="primary"
            iconOnly
            className="mini-player__play"
            icon={playing ? Pause : Play}
            aria-label={playing ? 'Pause' : 'Play'}
            data-testid="mini-player-play"
            onClick={() => { if (playing) pause(); else void play(); }}
          />
          {!playing && (
            <Button
              variant="ghost"
              iconOnly
              className="mini-player__stop"
              icon={X}
              aria-label="Stop and close player"
              data-testid="mini-player-stop"
              onClick={close}
            />
          )}
        </div>
      </section>
    </>
  );
}

export default MiniPlayer;
