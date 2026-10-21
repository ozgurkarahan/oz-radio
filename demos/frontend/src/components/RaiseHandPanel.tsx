import React, { useEffect, useRef } from 'react';
import { Check, Hand, Send, StepForward, X } from 'lucide-react';
import { Alert, Button, Field, Input } from '../ui';
import { DEMO_MAX_TEXT_QUESTION_CHARS } from '../services/demoProtocol';

export type QaPhase = 'idle' | 'raised' | 'sending' | 'inviting' | 'listening' | 'thinking' | 'answering' | 'resumed' | 'error';

export interface QaAnswerView {
  text: string;
  sources: number[];
  grounded: boolean;
}

interface Props {
  phase: QaPhase;
  /** Raise hand can be pressed (connected, Q&A available, not blocked). */
  available: boolean;
  disabledReason: string | null;
  narrating: boolean;
  canAskNow: boolean;
  canType: boolean;
  /** The public live demo (not the admin presenter): typed questions are direct, and stay available after a failure. */
  demo: boolean;
  /** The question in `raised` is typed (it is sent after the slide), not spoken. */
  typedQueued: boolean;
  /** The typed question being written; it stays when the question fails and is cleared by the parent once it is accepted. */
  draft: string;
  onDraftChange: (text: string) => void;
  /** The typed question field got focus (the demo tells the server the visitor is composing a question). */
  onTypedFocus?: () => void;
  remaining: number | null;
  level: number;
  /** Language of the presenter's answers (the deck's), so a screen reader pronounces them right. */
  lang?: string;
  transcript: string | null;
  answer: QaAnswerView | null;
  error: string | null;
  notice: string | null;
  onRaise: () => void;
  onAskNow: () => void;
  onSubmitText: (text: string) => void;
  onDone: () => void;
  onCancel: () => void;
  onContinue: () => void;
}

const MAX_TEXT = DEMO_MAX_TEXT_QUESTION_CHARS;

function sourcesLabel(sources: number[]): string | null {
  const nums = Array.from(new Set(sources)).sort((a, b) => a - b).map((i) => i + 1);
  if (nums.length === 0) return null;
  if (nums.length === 1) return `From slide ${nums[0]}`;
  return `From slides ${nums.slice(0, -1).join(', ')} and ${nums[nums.length - 1]}`;
}

const PHASE_TEXT: Partial<Record<QaPhase, string>> = {
  raised: 'Hand raised — after this slide',
  sending: 'Sending your question…',
  inviting: 'The presenter is inviting your question…',
  listening: 'Listening — ask your question',
};

/** Raise-hand voice Q&A controls and status (rendered inside the avatar rail). */
export default function RaiseHandPanel(props: Props) {
  const {
    phase, available, disabledReason, narrating, canAskNow, canType, demo, typedQueued, draft, onDraftChange, onTypedFocus, remaining,
    level, lang, transcript, answer, error, notice, onRaise, onAskNow, onSubmitText, onDone, onCancel, onContinue,
  } = props;
  const rootRef = useRef<HTMLElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);
  const continueRef = useRef<HTMLButtonElement>(null);
  const raiseRef = useRef<HTMLButtonElement>(null);
  const prevPhase = useRef<QaPhase>(phase);

  // Move focus to the control that matters for the new phase, without
  // stealing it from elsewhere on the page.
  useEffect(() => {
    const prev = prevPhase.current;
    prevPhase.current = phase;
    if (prev === phase) return;
    const active = document.activeElement;
    const ours = !active || active === document.body || !!rootRef.current?.contains(active);
    if (!ours) return;
    if (phase === 'listening') doneRef.current?.focus();
    else if (phase === 'error') continueRef.current?.focus();
    else if (phase === 'idle' || phase === 'resumed') raiseRef.current?.focus();
  }, [phase]);

  const idleLike = phase === 'idle' || phase === 'resumed';
  const busy = !idleLike && phase !== 'error';
  const source = answer ? sourcesLabel(answer.sources) : null;
  const queuedText = typedQueued ? 'Your question is queued — answered after this slide' : PHASE_TEXT.raised;

  let live = '';
  if (phase === 'thinking') live = transcript ? `You asked: ${transcript}. Finding the answer in the deck.` : 'Transcribing your question.';
  else if (phase === 'answering' && answer) live = `Answer: ${answer.text}`;
  else if (phase === 'error' && error) live = error;
  else live = phase === 'raised' ? (queuedText ?? '') : (PHASE_TEXT[phase] ?? '');

  // The typed question is part of the panel whenever questions are possible: next to Raise hand, and (demo) next to
  // Continue after a failed question, so the visitor can type instead of speaking again.
  const typeForm = canType && (idleLike || (demo && phase === 'error')) && available && (
    <form
      className="raise-hand__type"
      onSubmit={(e) => {
        e.preventDefault();
        const q = draft.trim();
        if (!q) return;
        onSubmitText(q.slice(0, MAX_TEXT));
      }}
    >
      <Field label="Type a question" labelHidden={demo} size="sm">
        <Input
          data-testid="qa-text-input"
          value={draft}
          maxLength={MAX_TEXT}
          placeholder={demo ? 'Type a question' : 'Ask about this deck'}
          autoComplete="off"
          onChange={(e) => onDraftChange(e.target.value)}
          onFocus={onTypedFocus}
        />
      </Field>
      <Button data-testid="qa-text-submit" type="submit" size="sm" icon={Send} disabled={!draft.trim()}>
        Ask
      </Button>
    </form>
  );

  return (
    <section ref={rootRef} className="raise-hand" aria-label="Questions" data-testid="raise-hand-panel" data-phase={phase}>
      {idleLike && (
        <div className="raise-hand__row">
          <Button
            ref={raiseRef}
            data-testid="raise-hand"
            size="sm"
            icon={Hand}
            disabled={!available}
            onClick={onRaise}
          >
            Raise hand
          </Button>
          {canAskNow && narrating && available && (
            <Button data-testid="ask-now" size="sm" variant="ghost" onClick={onAskNow}>
              Ask now
            </Button>
          )}
          {remaining != null && (available || remaining === 0) && (
            <span className="small muted tabular" data-testid="qa-remaining">
              {remaining === 1 ? '1 question left' : `${remaining} questions left`}
            </span>
          )}
        </div>
      )}

      {busy && (
        <div className="raise-hand__row">
          <span className="raise-hand__state" data-testid="qa-state">
            {phase === 'thinking'
              ? (transcript ? 'Finding the answer in the deck…' : 'Transcribing your question…')
              : phase === 'answering' ? 'Answering your question' : phase === 'raised' ? queuedText : PHASE_TEXT[phase]}
          </span>
        </div>
      )}

      {phase === 'listening' && (
        <div className="raise-hand__listen">
          <div
            className="raise-hand__meter"
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(level * 100)}
            data-testid="qa-mic-level"
          >
            <span style={{ '--level': Math.max(0, Math.min(1, level)) } as React.CSSProperties} />
          </div>
          <div className="raise-hand__row">
            <Button ref={doneRef} data-testid="qa-done" size="sm" variant="primary" icon={Check} onClick={onDone}>
              Done
            </Button>
            <Button data-testid="qa-cancel" size="sm" variant="ghost" icon={X} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {(phase === 'raised' || phase === 'sending' || phase === 'inviting' || phase === 'thinking') && (
        <div className="raise-hand__row">
          <Button data-testid="qa-cancel" size="sm" variant="ghost" icon={X} onClick={onCancel}>
            {phase === 'raised' ? (typedQueued ? 'Cancel question' : 'Lower hand') : 'Cancel question'}
          </Button>
        </div>
      )}

      {transcript && (phase === 'raised' || phase === 'sending' || phase === 'thinking' || phase === 'answering' || phase === 'resumed' || phase === 'error') && (
        <p className="raise-hand__question" data-testid="qa-transcript">
          <span className="eyebrow">Your question</span>
          {transcript}
        </p>
      )}

      {answer && (phase === 'answering' || phase === 'resumed') && (
        <div className="raise-hand__answer" data-testid="qa-answer">
          <span className="eyebrow">Answer</span>
          <p lang={lang}>{answer.text}</p>
          {source && <span className="small muted" data-testid="qa-answer-source">{source}</span>}
        </div>
      )}

      {phase === 'error' && (
        <div className="raise-hand__error">
          <Alert tone="error" data-testid="qa-error">{error ?? 'The question could not be answered.'}</Alert>
          <div className="raise-hand__row">
            <Button ref={continueRef} data-testid="qa-continue" size="sm" variant="primary" icon={StepForward} onClick={onContinue}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {notice && idleLike && <Alert tone="error" data-testid="qa-notice">{notice}</Alert>}
      {disabledReason && idleLike && (
        <p className="small muted" data-testid="qa-disabled">{disabledReason}</p>
      )}

      {typeForm}

      <p className="sr-only" aria-live="polite" data-testid="qa-live" lang={phase === 'answering' && answer ? lang : undefined}>{live}</p>
    </section>
  );
}
