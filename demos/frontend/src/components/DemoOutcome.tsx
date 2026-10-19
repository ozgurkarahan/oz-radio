import React, { useEffect, useId, useRef } from 'react';
import { AlertCircle, CheckCircle2, Info, MessageCircleQuestionMark, Play, Square } from 'lucide-react';
import { Button, ButtonLink } from '../ui';
import { DEMO_FALLBACK_LINKS, type DemoOutcomeCopy, type Recording } from '../services/demoProtocol';
import { formatClock } from '../services/demo';

const ICONS = { error: AlertCircle, success: CheckCircle2, info: Info, clay: Info } as const;

interface OutcomeProps {
  title: string;
  detail: string;
  tone: DemoOutcomeCopy['tone'];
  /** `alert` for refusals and failures, `status` for normal endings (both move focus when `autoFocus`). */
  role: DemoOutcomeCopy['role'];
  /** Which ending this is (`data-outcome`: finished, idle, cap, busy, quota, outage, connect, interrupted, ended…). */
  kind: string;
  /** The same-deck recording; null while it is unknown or when there is none (the fallback links stand in). */
  recording: Recording | null;
  retry?: { label: string; onClick: () => void } | null;
  /** Extra actions after the recording and the retry (e.g. "Start the live demo" on a page where it cannot run). */
  actions?: React.ReactNode;
  /** Bring the card into view and move focus to it: an ending the visitor just lived through. */
  autoFocus?: boolean;
  className?: string;
}

/**
 * The card every live-demo ending or failure ends in: the cause (title + detail from `DEMO_OUTCOME_COPY`), the same-deck
 * recording as the primary action — or the public fallback links when there is none — and a retry only where it helps.
 */
export default function DemoOutcome({ title, detail, tone, role, kind, recording, retry, actions, autoFocus = false, className }: OutcomeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const detailId = useId();
  const Icon = ICONS[tone];

  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus({ preventScroll: true });
    ref.current.scrollIntoView({ block: 'center' });
  }, [autoFocus]);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={detailId}
      className={['alert', tone !== 'info' && `alert--${tone}`, 'demo-outcome', className].filter(Boolean).join(' ')}
      data-testid="demo-outcome"
      data-outcome={kind}
    >
      <Icon aria-hidden />
      <div className="demo-outcome__body">
        <h3 id={titleId} className="demo-outcome__title" data-testid="demo-outcome-title">{title}</h3>
        <p id={detailId} className="demo-outcome__detail" data-testid="demo-outcome-detail">{detail}</p>
        <div className="demo-outcome__actions">
          {recording ? (
            <ButtonLink to={recording.to} variant="primary" icon={Play} data-testid="demo-outcome-recording">
              {recording.label}
            </ButtonLink>
          ) : (
            DEMO_FALLBACK_LINKS.map((link, i) => (
              <ButtonLink key={link.to} to={link.to} variant={i === 0 ? 'primary' : 'outline'} data-testid="demo-outcome-fallback">
                {link.label}
              </ButtonLink>
            ))
          )}
          {retry && (
            <Button data-testid="demo-outcome-retry" onClick={retry.onClick}>{retry.label}</Button>
          )}
          {actions}
        </div>
      </div>
    </div>
  );
}

interface NarrationDoneProps {
  /** "The presentation is complete" or the narration-limit message. */
  title: string;
  /** Seconds left in the session, from the countdown. */
  secondsLeft: number | null;
  /**
   * Seconds until the server closes the session for idleness (`demo.narration_complete` / `demo.idle`); null = no idle
   * deadline known (the narration limit, an older server) or none that binds right now.
   */
  idleSecondsLeft?: number | null;
  /** Typed or voice questions are possible (Q&A on, questions left). */
  canAsk: boolean;
  onAsk: () => void;
  onFinish: () => void;
  finishing: boolean;
  /** Shown as a quiet third action (the narration limit case: the recording is the value that is left). */
  recording?: Recording | null;
}

/**
 * The time that is really left: the session cap, or the idle deadline when that comes first. The cap reads "{m:ss} left in
 * this live session"; the idle deadline reads "Closes in {m:ss}", with "unless you ask a question" while one can be asked.
 */
function remainingTimeText(secondsLeft: number | null, idleSecondsLeft: number | null, canAsk: boolean): string | null {
  if (idleSecondsLeft != null && (secondsLeft == null || idleSecondsLeft < secondsLeft)) {
    const clock = formatClock(idleSecondsLeft);
    return canAsk ? `Closes in ${clock} unless you ask a question` : `Closes in ${clock}`;
  }
  return secondsLeft != null ? `${formatClock(secondsLeft)} left in this live session` : null;
}

/**
 * After the narration: instead of an idle avatar offering "Present all" again, the visitor chooses — ask a question while
 * the session lasts, or finish (which ends it and frees the avatar for the next visitor).
 */
export function DemoNarrationDone({ title, secondsLeft, idleSecondsLeft = null, canAsk, onAsk, onFinish, finishing, recording }: NarrationDoneProps) {
  const ref = useRef<HTMLDivElement>(null);
  // The choice that ends the presentation must not wait below the fold of a short screen (no focus change: it is a status).
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest' }); }, []);
  const timeText = remainingTimeText(secondsLeft, idleSecondsLeft, canAsk);
  return (
    <div ref={ref} className="demo-done" role="status" data-testid="demo-narration-done">
      <p className="demo-done__title">{title}</p>
      {timeText != null && (
        <p className="demo-done__time small muted tabular" data-testid="demo-done-time">
          {timeText}
        </p>
      )}
      <div className="demo-done__actions">
        {canAsk && (
          <Button data-testid="demo-ask" variant="primary" icon={MessageCircleQuestionMark} onClick={onAsk} disabled={finishing}>
            Ask a question
          </Button>
        )}
        <Button data-testid="demo-finish" variant={canAsk ? 'outline' : 'primary'} icon={Square} onClick={onFinish} busy={finishing}>
          {finishing ? 'Finishing…' : 'Finish demo'}
        </Button>
        {recording && (
          <ButtonLink to={recording.to} variant="ghost" icon={Play} data-testid="demo-done-recording">{recording.label}</ButtonLink>
        )}
      </div>
    </div>
  );
}
