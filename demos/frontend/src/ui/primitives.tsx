import React from 'react';
import { AlertCircle, CheckCircle2, Info, X, type LucideIcon } from 'lucide-react';

/** Chip tones. 'clay' is the brand-indigo emphasis and 'sage' the success mark (names kept from the first palette); 'live' is the amber Live status. */
export type Tone = 'default' | 'clay' | 'sage' | 'ink' | 'danger' | 'live';

export function Chip({ tone = 'default', icon: Icon, className, children, ...rest }: {
  tone?: Tone; icon?: LucideIcon;
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={['chip', tone !== 'default' && `chip--${tone}`, className].filter(Boolean).join(' ')} {...rest}>
      {Icon && <Icon aria-hidden />}
      {children}
    </span>
  );
}

/**
 * Pulsing dot + label, e.g. "Speaking", "Playing", a step in progress (brand indigo).
 * `live` marks the one Live status a visitor can use now (the live avatar): amber, the brand's single accent.
 */
export function LivePill({ idle, live, children, className, ...rest }: { idle?: boolean; live?: boolean } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={['live-pill', idle && 'live-pill--idle', live && !idle && 'live-pill--live', className].filter(Boolean).join(' ')} {...rest}>
      {children}
    </span>
  );
}

export function Waveform({ active = true, className }: { active?: boolean; className?: string }) {
  return (
    <span className={['waveform', !active && 'waveform--idle', className].filter(Boolean).join(' ')} aria-hidden>
      <span /><span /><span /><span /><span />
    </span>
  );
}

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span className={['cluster', className].filter(Boolean).join(' ')} role="status">
      <span className="spinner" aria-hidden />
      {label ? <span className="muted small">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

const ALERT_ICON: Record<string, LucideIcon> = { info: Info, error: AlertCircle, success: CheckCircle2, clay: Info };

export function Alert({ tone = 'info', title, children, onClose, className, ...rest }: {
  tone?: 'info' | 'error' | 'success' | 'clay';
  title?: React.ReactNode;
  onClose?: () => void;
} & React.HTMLAttributes<HTMLDivElement>) {
  const Icon = ALERT_ICON[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={['alert', tone !== 'info' && `alert--${tone}`, className].filter(Boolean).join(' ')}
      {...rest}
    >
      <Icon aria-hidden />
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && <strong style={{ display: 'block', marginBottom: 2 }}>{title}</strong>}
        {children}
      </div>
      {onClose && (
        <button type="button" className="btn btn--ghost btn--sm btn--icon" aria-label="Dismiss" onClick={onClose}>
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action, className, ...rest }: {
  icon?: LucideIcon; title: React.ReactNode; action?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div className={['empty', className].filter(Boolean).join(' ')} {...rest}>
      {Icon && <span className="empty__icon"><Icon aria-hidden /></span>}
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {action}
    </div>
  );
}

/** Thin progress segments, one per slide/chapter. */
export function Segments({ total, current, label }: { total: number; current: number; label?: string }) {
  const n = Math.max(0, total);
  return (
    <div
      className="segments"
      role="progressbar"
      aria-label={label ?? 'Progress'}
      aria-valuemin={1}
      aria-valuemax={Math.max(1, n)}
      aria-valuenow={Math.min(n, current + 1)}
    >
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className={i < current ? 'is-done' : i === current ? 'is-current' : undefined} />
      ))}
    </div>
  );
}

export function Progress({ value, label }: { value: number; label?: string }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label ?? 'Progress'}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <div className="progress__bar" style={{ '--progress': v } as React.CSSProperties} />
    </div>
  );
}

/** Numbered steps for create flows. `current` is zero-based. */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="steps" aria-label="Steps">
      {steps.map((s, i) => (
        <li
          key={s}
          className={['steps__item', i === current && 'is-active', i < current && 'is-done'].filter(Boolean).join(' ')}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="steps__num">{i + 1}</span>
          {s}
        </li>
      ))}
    </ol>
  );
}
