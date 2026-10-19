/**
 * Shared states of the two public libraries (podcasts, videos) — contracts §2.4, §5.3, §6.2.
 *
 * - A failed list is an alert with "Try again" and the public actions, never the empty site: `LibraryListError`.
 * - A true empty list (`[]`) says so and offers the public actions before any sign-in: `LibraryEmpty`.
 * - An episode or video that cannot open says why (404 / unavailable / offline), keeps the list, takes focus and offers
 *   "Try again" or "Back to all …": `describeOpenFailure` + `LibraryOpenError`.
 * The wording comes from `ui/format.ts` (`loadErrorMessage`), so no raw transport text ("Failed to fetch", a proxy body)
 * ever reaches the page.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Clapperboard, Headphones, Layers, Play, type LucideIcon } from 'lucide-react';
import { GateNotice, useDemoEntry } from '../components/AuthGate';
import {
  Alert, Button, ButtonLink, EmptyState, classifyLoadError, loadErrorMessage, type LoadFailureKind,
} from '../ui';

// ---- The live-demo action ---------------------------------------------------------------------

/** "Start the live demo" is the one CTA verb of the app (contracts §5.3). */
export const LIVE_DEMO_LABEL = 'Start the live demo';

/**
 * Route of the live demo for the dead-end actions, or null when it cannot run (off, allowance spent, no live deck,
 * unknown). It reuses the page load's single live-demo decision (`useDemoEntry`), so Home, the gates and the
 * libraries always agree.
 */
export function useLiveDemoPath(): string | null {
  const entry = useDemoEntry();
  return entry.kind === 'live' ? entry.to : null;
}

/** The public ways out of a dead end: the live demo, the other library, the decks (never a sign-in). */
export function LibraryLinks({ library }: { library: 'podcast' | 'video' }) {
  const live = useLiveDemoPath();
  return (
    <div className="library__links" role="group" aria-label="Other ways to explore">
      {live && <ButtonLink to={live} variant="primary" icon={Play} data-testid="library-live-demo">{LIVE_DEMO_LABEL}</ButtonLink>}
      {library === 'podcast'
        ? <ButtonLink to="/video/library" icon={Clapperboard}>Browse the video library</ButtonLink>
        : <ButtonLink to="/podcast/library" icon={Headphones}>Listen to an episode</ButtonLink>}
      <ButtonLink to="/decks" icon={Layers}>Browse decks</ButtonLink>
    </div>
  );
}

// ---- Lists ----------------------------------------------------------------------------------------

/** A list that failed to load: the cause in plain words and "Try again" — instead of, never next to, "No … yet". */
export function LibraryListError({ error, what, onRetry, library, withLinks = true }: {
  error: unknown;
  /** Noun phrase of what failed to load: "the episodes", "the videos". */
  what: string;
  onRetry: () => void;
  library: 'podcast' | 'video';
  withLinks?: boolean;
}) {
  return (
    <div className="library__failure" data-testid="library-error">
      <Alert tone="error" className="library__alert">
        {loadErrorMessage(error, what)}{' '}
        <Button variant="link" onClick={onRetry}>Try again</Button>
      </Alert>
      {withLinks && <LibraryLinks library={library} />}
    </div>
  );
}

/** A published list that is truly empty (`[]`): says so honestly and offers the public actions before "Sign in". */
export function LibraryEmpty({ icon, title, children, library }: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
  library: 'podcast' | 'video';
}) {
  return (
    <EmptyState
      icon={icon}
      title={title}
      data-testid="library-empty"
      action={(
        <div className="library__empty-actions">
          <LibraryLinks library={library} />
          <GateNotice action={library === 'podcast' ? 'create your own podcast' : 'generate your own avatar video'} />
        </div>
      )}
    >
      {children}
    </EmptyState>
  );
}

// ---- Opening an item ----------------------------------------------------------------------------

export interface OpenFailure {
  /** The item that did not open (what "Try again" opens again). */
  id: string;
  kind: LoadFailureKind;
  message: string;
}

/**
 * Visitor-safe description of a failed open. A missing item says it is gone ("This episode isn't available any more.");
 * everything else reuses `loadErrorMessage` (unavailable → "We couldn't load this episode right now…", offline → "You
 * seem to be offline…"). `noun` is "episode" or "video".
 */
export function describeOpenFailure(error: unknown, id: string, noun: string): OpenFailure {
  const kind = classifyLoadError(error);
  const message = kind === 'not-found' ? `This ${noun} isn't available any more.` : loadErrorMessage(error, `this ${noun}`);
  return { id, kind, message };
}

/** The inline alert of a failed open, next to the list: takes focus when it appears. "Back to all …" for a gone item, else "Try again". */
export function LibraryOpenError({ failure, onRetry, onDismiss, backLabel }: {
  failure: OpenFailure;
  onRetry: () => void;
  onDismiss: () => void;
  backLabel: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, [failure]);
  return (
    <div ref={ref} tabIndex={-1} className="library__open-error" data-testid="library-open-error" data-kind={failure.kind}>
      <Alert tone="error" className="library__alert">
        {failure.message}{' '}
        {failure.kind === 'not-found'
          ? <Button variant="link" onClick={onDismiss}>{backLabel}</Button>
          : <Button variant="link" onClick={onRetry}>Try again</Button>}
      </Alert>
    </div>
  );
}

/** Admin actions (publish, delete): a short sentence, never the raw error text. */
export function actionFailureMessage(error: unknown, action: string): string {
  return classifyLoadError(error) === 'offline'
    ? loadErrorMessage(error)
    : `${action} didn't go through. Please try again.`;
}
