import React, { useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import { Bug, Copy, Power, Share2, Trash2 } from 'lucide-react';
import { Button } from '../ui';
import {
  clearEntries, disablePlayerDebug, exportLog, getEntries, subscribe, type DebugDetail,
} from './playerDebug';
import '../styles/shared/player-debug.css';

/**
 * Floating "Debug" toggle + non-modal panel for the on-device playback log
 * (`?debug=player`). Lazily loaded by main.tsx only when the log is on.
 */

const PANEL_ID = 'player-debug-panel';
const TITLE_ID = 'player-debug-title';
const IDLE_STATUS = 'Newest first. Kept on this device until cleared.';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** ISO time → local "HH:MM:SS.mmm". */
function clockOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 120 → "+120ms", 4200 → "+4.2s", 185000 → "+3m05s". */
function gapOf(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return s < 3600 ? `+${Math.floor(s / 60)}m${pad(s % 60)}s` : `+${Math.floor(s / 3600)}h${pad(Math.floor((s % 3600) / 60))}m`;
}

/** "audio[radio-audio] · 12.345/30s · readyState=4 · … · src=/media/pod-2.mp3". */
function summaryOf(detail: DebugDetail): string {
  const { el, testid, detached, currentTime, duration, ...rest } = detail;
  const parts: string[] = [];
  if (typeof el === 'string') parts.push(`${el}${testid ? `[${testid}]` : ''}${detached ? ' (detached)' : ''}`);
  if (currentTime !== undefined) {
    if (duration === undefined) parts.push(`@${currentTime}s`);
    else parts.push(`${currentTime}/${typeof duration === 'number' ? `${duration}s` : '?'}`);
  }
  for (const [key, value] of Object.entries(rest)) {
    if (value === null || value === '') continue;
    // Same origin for every source: the path is what tells episodes apart on a phone screen.
    const shown = key === 'src' && typeof value === 'string' ? value.replace(/^https?:\/\/[^/]+/, '') : value;
    parts.push(`${key}=${shown}`);
  }
  return parts.join(' · ');
}

class Guard extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    // A debugging aid must never take the app down with it.
    return this.state.failed ? null : this.props.children;
  }
}

function Panel() {
  const entries = useSyncExternalStore(subscribe, getEntries, getEntries);
  const newestFirst = useMemo(() => entries.slice().reverse(), [entries]);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState(IDLE_STATUS);
  const [manualCopy, setManualCopy] = useState<string | null>(null);
  const exportRef = useRef<HTMLPreElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const canShare = typeof navigator.share === 'function';
  const count = `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`;

  /** No clipboard access (e.g. plain HTTP): show the export and select it, without moving focus. */
  const selectForCopy = (text: string): boolean => {
    flushSync(() => setManualCopy(text));
    const pre = exportRef.current;
    const selection = window.getSelection();
    if (!pre || !selection) return false;
    const range = document.createRange();
    range.selectNodeContents(pre);
    selection.removeAllRanges();
    selection.addRange(range);
    pre.scrollIntoView({ block: 'nearest' });
    try { return document.execCommand('copy'); } catch { return false; }
  };

  const copy = async () => {
    const text = exportLog(entries);
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        setManualCopy(null);
        setStatus(`Copied ${count}.`);
        return;
      } catch { /* permission denied: fall back to a selection */ }
    }
    setStatus(selectForCopy(text)
      ? `Copied ${count}.`
      : 'No clipboard access: the log is selected below, copy it from the menu.');
  };

  const share = async () => {
    try {
      await navigator.share({ title: 'Oz Radio player log', text: exportLog(entries) });
      setStatus('Shared.');
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      setStatus(name === 'AbortError' ? 'Share cancelled.' : 'Sharing failed: use Copy instead.');
    }
  };

  const clear = () => {
    clearEntries();
    setManualCopy(null);
    setStatus('Log cleared.');
  };

  const turnOff = () => {
    disablePlayerDebug();
    const url = new URL(window.location.href);
    url.searchParams.delete('debug');
    if (url.href === window.location.href) window.location.reload();
    else window.location.replace(url.href);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    toggleRef.current?.focus();
  };

  return (
    <div className="player-debug" data-testid="player-debug" onKeyDown={onKeyDown}>
      <Button
        ref={toggleRef}
        size="sm"
        icon={Bug}
        className="player-debug__toggle"
        aria-expanded={open}
        aria-controls={PANEL_ID}
        data-testid="player-debug-toggle"
        onClick={() => setOpen((v) => !v)}
      >
        Debug<span className="player-debug__badge" aria-hidden data-testid="player-debug-count">{entries.length}</span>
      </Button>
      <section
        id={PANEL_ID}
        className="player-debug__panel"
        aria-labelledby={TITLE_ID}
        hidden={!open}
        data-testid="player-debug-panel"
      >
        <div className="player-debug__head">
          <h2 id={TITLE_ID} className="player-debug__title">Player debug log</h2>
          <span className="player-debug__count">{count}</span>
        </div>
        <div className="player-debug__actions">
          <Button size="sm" icon={Copy} onClick={() => { void copy(); }}>Copy</Button>
          {canShare && <Button size="sm" icon={Share2} onClick={() => { void share(); }}>Share</Button>}
          <Button size="sm" icon={Trash2} onClick={clear}>Clear</Button>
          <Button size="sm" variant="danger" icon={Power} onClick={turnOff}>Turn off</Button>
        </div>
        <p className="player-debug__status" role="status">{status}</p>
        {manualCopy !== null && (
          <pre ref={exportRef} className="player-debug__export" data-testid="player-debug-export">{manualCopy}</pre>
        )}
        {open && (
          <ol className="player-debug__list" aria-label="Log entries, newest first" tabIndex={0} data-testid="player-debug-entries">
            {newestFirst.map((entry, i) => (
              <li key={entries.length - i} className="player-debug__entry" data-testid="player-debug-entry" data-kind={entry.kind}>
                <div className="player-debug__line">
                  <time dateTime={entry.t}>{clockOf(entry.t)}</time>
                  <span className="player-debug__gap">{gapOf(entry.dt)}</span>
                  <strong className="player-debug__kind">{entry.kind}</strong>
                </div>
                <div className="player-debug__detail">{summaryOf(entry.detail)}</div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

export default function PlayerDebugPanel() {
  return <Guard><Panel /></Guard>;
}
