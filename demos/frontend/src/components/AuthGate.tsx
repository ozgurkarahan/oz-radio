import React, { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  ArrowRight, Ban, CircleCheck, CircleDashed, Clapperboard, Eye, EyeOff, Film, GraduationCap,
  Headphones, ListVideo, Lock, Mic, Play, Presentation, Radio, type LucideIcon,
} from 'lucide-react';
import { SIGN_OUT_URL, ownerSignInPath, useAuth } from '../services/auth';
import { type BootBlock, fetchBootFallback, pickDemoDeck, readBoot } from '../services/boot';
import { demoDeckPath } from '../services/demoProtocol';
import { Button, ButtonLink, Chip, buttonClass } from '../ui';
import '../styles/shared/auth-gate.css';

export const NOT_ENABLED_MESSAGE = "Your account isn't enabled for this demo.";

// ── The live-demo entry point (contracts §3.6) ──────────────────────────────────────────────────
// One decision per page load: the server's boot block when it is there (final on the first paint), else one bounded
// API read. Label and target never change afterwards; the quota only shows up as adjacent status text.

export const DEMO_LIVE_LABEL = 'Start the live demo';
export const DEMO_RECORDED_LABEL = 'Watch a recorded demo';
/** Where "Watch a recorded demo" goes. */
export const RECORDED_DEMO_PATH = '/video/library';
export const OWNER_SIGN_IN_HINT = 'For the site owner and invited users.';

export type DemoEntry =
  /** No boot block: a same-size skeleton while the bounded fallback read runs. */
  | { kind: 'pending' }
  | {
    kind: 'live';
    /** Exactly `/decks/{id}/present`. */
    to: string;
    deckTitle: string;
    deckLanguage: string;
    sessionSeconds: number;
    qa: boolean;
    /** Live sessions left today; null when unknown. */
    remaining: number | null;
  }
  /** The live demo cannot start (off, unavailable, no live deck) or today's allowance is spent. */
  | { kind: 'recorded'; to: string; reason: 'off' | 'quota' };

const PENDING_ENTRY: DemoEntry = { kind: 'pending' };

function decideEntry(boot: BootBlock | null): DemoEntry {
  const recorded = (reason: 'off' | 'quota'): DemoEntry => ({ kind: 'recorded', to: RECORDED_DEMO_PATH, reason });
  if (!boot || !boot.demo.enabled) return recorded('off');
  if (boot.demo.remaining_today === 0) return recorded('quota');
  const deck = pickDemoDeck(boot);
  if (!deck) return recorded('off');
  return {
    kind: 'live',
    to: demoDeckPath(deck.deck_id),
    deckTitle: deck.title,
    deckLanguage: deck.language,
    sessionSeconds: boot.demo.session_seconds,
    qa: boot.demo.qa.enabled,
    remaining: boot.demo.remaining_today,
  };
}

// Module-level on purpose: the decision is frozen for the page load, so a later route (Decks, a gate) reuses it
// instead of showing a skeleton or, worse, a different answer.
let settledEntry: DemoEntry | null = null;
let fallbackRead: Promise<DemoEntry> | null = null;

function initialEntry(): DemoEntry {
  if (settledEntry) return settledEntry;
  const boot = readBoot();
  if (boot) {
    settledEntry = decideEntry(boot);
    return settledEntry;
  }
  return PENDING_ENTRY;
}

function readFallbackOnce(): Promise<DemoEntry> {
  if (!fallbackRead) {
    fallbackRead = fetchBootFallback()
      .catch(() => null)
      .then((boot) => {
        settledEntry = decideEntry(boot);
        return settledEntry;
      });
  }
  return fallbackRead;
}

/**
 * The live-demo entry of this page load. With a boot block it is final on the first render; without one it is
 * `pending` (render a skeleton) until the bounded fallback read settles — once, never again.
 */
export function useDemoEntry(): DemoEntry {
  const [entry, setEntry] = useState<DemoEntry>(initialEntry);
  useEffect(() => {
    if (entry.kind !== 'pending') return undefined;
    let cancelled = false;
    readFallbackOnce().then((next) => { if (!cancelled) setEntry(next); });
    return () => { cancelled = true; };
  }, [entry.kind]);
  return entry;
}

/** "17 live sessions left today". */
export function liveSessionsLeft(n: number): string {
  return `${n} live ${n === 1 ? 'session' : 'sessions'} left today`;
}

/** Why the recorded demo is offered instead of the live one. */
export function recordedDemoReason(reason: 'off' | 'quota'): string {
  return reason === 'quota' ? "Today's live allowance has been reached." : "The live demo isn't available right now.";
}

/**
 * The one live-demo link of a surface: "Start the live demo" → `/decks/{id}/present`, or "Watch a recorded demo" →
 * `/video/library` when the live demo cannot run. A same-size skeleton while the entry is pending.
 */
export function DemoActionLink({ entry, size = 'md', variant = 'primary', className, testIdLive, testIdRecorded }: {
  entry: DemoEntry;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'primary' | 'outline';
  className?: string;
  testIdLive?: string;
  testIdRecorded?: string;
}) {
  if (entry.kind === 'pending') {
    return (
      <span
        className={['demo-skeleton', size === 'lg' && 'demo-skeleton--lg', className].filter(Boolean).join(' ')}
        data-testid="demo-cta-skeleton"
        aria-hidden
      />
    );
  }
  const live = entry.kind === 'live';
  return (
    <ButtonLink
      to={entry.to}
      variant={variant}
      size={size}
      icon={live ? Play : Clapperboard}
      className={className}
      data-testid={live ? testIdLive : testIdRecorded}
    >
      {live ? DEMO_LIVE_LABEL : DEMO_RECORDED_LABEL}
    </ButtonLink>
  );
}

/**
 * "Owner sign-in": the text link that replaces the filled "Sign in" button — only the site owner and invited users can
 * sign in, so it never competes with the public actions. The hint is read aloud as its description. It opens the in-app
 * explainer (`/sign-in?next=…`), not Microsoft's page: a visitor whose account is not invited would meet a single-tenant
 * error page with nothing but the browser's Back. A real `href`, so a new tab or a copied link works too.
 */
export function OwnerSignInLink({ className, visibleHint = false }: { className?: string; visibleHint?: boolean }) {
  const hintId = useId();
  const here = useLocation();
  return (
    <>
      <Link
        to={ownerSignInPath(here)}
        className={className}
        title="For the site owner and invited users"
        aria-describedby={hintId}
      >
        Owner sign-in
      </Link>
      <span id={hintId} className={visibleHint ? 'gate-notice__hint' : 'sr-only'}>{OWNER_SIGN_IN_HINT}</span>
    </>
  );
}

/** Returns true when the current visitor may use admin-only features. */
export function useIsAdmin(): boolean {
  return useAuth().is_admin;
}

const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Removes emoji (pages still pass legacy emoji labels) and tidies whitespace. */
function stripEmoji(text: string): string {
  return text.replace(EMOJI_RE, '').replace(/\s+/g, ' ').trim();
}

// Legacy emoji `icon` strings (keyed by code point, variation selectors removed) → lucide equivalents.
const LEGACY_ICONS: Record<number, LucideIcon> = {
  0x1F399: Mic, 0x1F3AC: Clapperboard, 0x1F3A7: Headphones, 0x1F6E4: ListVideo,
  0x1F393: GraduationCap, 0x1F39E: Film, 0x1F4DA: Presentation,
};

function legacyIcon(icon: string): LucideIcon {
  const cp = icon.replace(/\u{FE0F}/gu, '').trim().codePointAt(0);
  return (cp !== undefined && LEGACY_ICONS[cp]) || Lock;
}

function linkIcon(href: string): LucideIcon {
  if (href.startsWith('/decks')) return Presentation;
  if (href.startsWith('/video')) return Film;
  if (href.startsWith('/podcast')) return Headphones;
  if (href.startsWith('/playlists')) return ListVideo;
  return ArrowRight;
}

/**
 * Inline notice shown in place of an admin-only control.
 * - anonymous → "Owner tools need sign-in: {action}" + the text link "Owner sign-in". Visitors can already try the product
 *   (live demo, listening, watching), so the notice never invites them to sign in; a filled button would too
 * - signed in but not allowlisted → "Your account isn't enabled for this demo."
 */
export function GateNotice({ action, compact = false, style, force, className }: {
  action: string; compact?: boolean; style?: React.CSSProperties;
  /** Override the /api/me-derived state, e.g. after a 4401/4403 WebSocket close. */
  force?: 'signin' | 'forbidden';
  className?: string;
}) {
  const auth = useAuth();
  if (!force && (auth.loading || auth.is_admin)) return null;
  const forbidden = force ? force === 'forbidden' : auth.authenticated;
  const Icon = forbidden ? Ban : Lock;
  return (
    <div
      role="note"
      data-testid="auth-gate"
      className={['alert', 'gate-notice', forbidden && 'alert--error', compact && 'gate-notice--compact', className]
        .filter(Boolean).join(' ')}
      style={style}
    >
      <Icon aria-hidden className="gate-notice__icon" />
      <span className="gate-notice__text">
        {forbidden ? NOT_ENABLED_MESSAGE : `Owner tools need sign-in: ${action}`}
      </span>
      {!forbidden && auth.auth_mode !== 'disabled' && (
        <span className="gate-notice__aside">
          <OwnerSignInLink className="gate-notice__signin" visibleHint />
        </span>
      )}
    </div>
  );
}

/**
 * Renders children only for admins. Non-admins get <GateNotice/> (or the
 * provided fallback; pass `fallback={null}` to hide entirely).
 */
export function AdminOnly({ children, action = 'use this feature', fallback, compact }: {
  children: React.ReactNode; action?: string; fallback?: React.ReactNode; compact?: boolean;
}) {
  const auth = useAuth();
  if (auth.loading) return null;
  if (auth.is_admin) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  return <GateNotice action={action} compact={compact} />;
}

/**
 * Friendly full-panel replacement for generation pages when the visitor is
 * not an admin. The cause stays honest; the primary actions are the public ones
 * ("Start the live demo", "Listen to an episode") and sign-in is demoted to a text link.
 */
export function GatedPanel({ icon, title, description, action, links = [], eyebrow = 'Sign-in required' }: {
  /** A lucide icon; legacy emoji strings are mapped to an icon (fallback: Lock). */
  icon?: LucideIcon | string;
  title: string; description: string; action: string;
  /** Secondary "browse" links to public content (the podcast library and the demo target are already covered). */
  links?: { href: string; label: string }[];
  /** Short label above the title. */
  eyebrow?: string;
}) {
  const Icon: LucideIcon = typeof icon === 'string' ? legacyIcon(icon) : (icon ?? Lock);
  const titleId = useId();
  const auth = useAuth();
  const entry = useDemoEntry();
  const signedInGuest = auth.authenticated && !auth.is_admin;
  const covered = new Set(['/podcast/library', entry.kind === 'pending' ? '' : entry.to]);
  const browse = links.filter((l) => !covered.has(l.href));
  return (
    <section data-testid="gated-panel" className="empty gated-panel" aria-labelledby={titleId}>
      <span className="empty__icon"><Icon aria-hidden /></span>
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h2 id={titleId} className="empty__title gated-panel__title">{stripEmoji(title)}</h2>
      <p className="empty__text gated-panel__text">{description}</p>
      <div
        className="gated-panel__actions"
        role="group"
        aria-label="Try Oz Radio without signing in"
        aria-busy={entry.kind === 'pending' || undefined}
      >
        <DemoActionLink
          entry={entry}
          className="gated-panel__demo"
          testIdLive="gate-demo-action"
          testIdRecorded="gate-demo-action"
        />
        <ButtonLink to="/podcast/library" icon={Headphones} data-testid="gate-listen-action">Listen to an episode</ButtonLink>
      </div>
      {browse.length > 0 && (
        <nav className="gated-panel__links" aria-label="Browse public content">
          {browse.map((l) => {
            const label = stripEmoji(l.label);
            const LinkIcon = linkIcon(l.href);
            return l.href.startsWith('/') ? (
              <ButtonLink key={l.href} to={l.href} size="sm" icon={LinkIcon}>{label}</ButtonLink>
            ) : (
              <a key={l.href} href={l.href} className={buttonClass({ size: 'sm' })}>
                <LinkIcon aria-hidden />{label}
              </a>
            );
          })}
        </nav>
      )}
      <GateNotice action={action} className="gated-panel__notice" />
      {signedInGuest && (
        <p className="gated-panel__account" data-testid="gate-account">
          <span>{auth.name ?? 'Signed in'} · read-only</span>
          <a href={SIGN_OUT_URL} className="gate-notice__signin">Sign out</a>
        </p>
      )}
    </section>
  );
}

/** Small Published / Draft pill shown to admins. */
export function PublishBadge({ published }: { published: boolean | undefined }) {
  const on = !!published;
  return (
    <Chip data-testid="publish-badge" tone={on ? 'sage' : 'default'} icon={on ? CircleCheck : CircleDashed}>
      {on ? 'Published' : 'Draft'}
    </Chip>
  );
}

/** Admin toggle that publishes / unpublishes an item. */
export function PublishToggle({ published, busy, onToggle }: {
  published: boolean | undefined; busy?: boolean; onToggle: (next: boolean) => void;
}) {
  const on = !!published;
  return (
    <Button
      size="sm"
      data-testid="publish-toggle"
      busy={busy}
      icon={on ? EyeOff : Eye}
      onClick={(e) => { e.stopPropagation(); onToggle(!on); }}
      title={on ? 'Hide from anonymous visitors' : 'Make visible to anonymous visitors'}
    >
      {on ? 'Unpublish' : 'Publish'}
    </Button>
  );
}

/** "Live demo" pill: anonymous visitors can try the narration-only live avatar on this deck. */
export function LiveDemoBadge({ liveDemo }: { liveDemo: boolean | undefined }) {
  if (!liveDemo) return null;
  return (
    <Chip
      data-testid="live-demo-badge"
      tone="live"
      icon={Radio}
      title="Visitors can try the live avatar narrating this deck"
    >
      Live demo
    </Chip>
  );
}

/** Admin toggle for the anonymous live avatar demo (only on published items). */
export function LiveDemoToggle({ liveDemo, published, busy, onToggle }: {
  liveDemo: boolean | undefined; published: boolean | undefined; busy?: boolean; onToggle: (next: boolean) => void;
}) {
  const on = !!liveDemo;
  const blocked = !on && !published;
  return (
    <Button
      size="sm"
      data-testid="live-demo-toggle"
      className={['live-demo-toggle', on && 'is-on'].filter(Boolean).join(' ')}
      busy={busy}
      disabled={blocked}
      aria-pressed={on}
      icon={Radio}
      onClick={(e) => { e.stopPropagation(); onToggle(!on); }}
      title={blocked
        ? 'Publish the deck first'
        : on ? 'Stop anonymous visitors from running the live avatar on this deck'
          : 'Let anonymous visitors try the narration-only live avatar on this deck'}
    >
      {on ? 'Live demo on' : 'Live demo off'}
    </Button>
  );
}
