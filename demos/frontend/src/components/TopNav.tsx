import React, { useEffect, useId, useRef, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { ChevronDown, Clapperboard, Headphones, ListMusic, Menu, Mic, Search, X, type LucideIcon } from 'lucide-react';
import { SIGN_OUT_URL, useAuth } from '../services/auth';
import { syncDocumentThemeWithTeams } from '../services/teams';
import { buttonClass } from '../ui';
import { OWNER_SIGN_IN_HINT, OwnerSignInLink } from './AuthGate';
import '../styles/shell.css';

type NavItem = { to: string; label: string; end?: boolean };
type Tool = { to: string; label: string; desc: string; icon: LucideIcon };

/** What every visitor can open. */
const PUBLIC_NAV: NavItem[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/decks', label: 'Decks' },
  { to: '/video/library', label: 'Videos' },
  { to: '/podcast/library', label: 'Podcasts' },
];

/** Owner tools that are plain links for the owner and "Sign-in required" entries of the Owner tools group for visitors. */
const OWNER_NAV: Tool[] = [
  { to: '/playlists', label: 'Playlists', desc: 'Chain decks into learning paths.', icon: ListMusic },
  { to: '/search', label: 'Search', desc: 'Ask a question across every deck.', icon: Search },
];

const CREATE: Tool[] = [
  { to: '/live', label: 'Live presentation', desc: 'Upload a deck; the live avatar presents it with Q&A.', icon: Mic },
  { to: '/video', label: 'Narrated video', desc: 'Render a narrated avatar video from a .pptx.', icon: Clapperboard },
  { to: '/podcast', label: 'Two-host podcast', desc: 'Turn a document into a two-avatar conversation.', icon: Headphones },
];

/** The sheet's own breakpoint (shell.css): the open sheet must not outlive it. */
const SHEET_QUERY = '(max-width: 1040px)';

/**
 * Marks everything around `keep` (its siblings, and the siblings of each ancestor up to <body>) inert and returns the undo.
 * Used while the phone menu sheet is open: the page behind is neither focusable nor read by a screen reader.
 */
function inertAround(keep: HTMLElement): () => void {
  const marked: Element[] = [];
  for (let node: HTMLElement | null = keep; node && node !== document.body && node.parentElement; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling === node || sibling.hasAttribute('inert') || /^(SCRIPT|STYLE|LINK)$/.test(sibling.tagName)) continue;
      sibling.setAttribute('inert', '');
      marked.push(sibling);
    }
  }
  return () => { for (const el of marked) el.removeAttribute('inert'); };
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Editorial masthead: wordmark, public sections, owner tools, auth controls, modal phone sheet. */
export default function TopNav() {
  const auth = useAuth();
  // Default deny: until /api/me says otherwise a visitor is anonymous, so owner tools never flash up as open links.
  const locked = !auth.is_admin;
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  // The sheet is open for the route it was opened on only: a navigation closes it in the very render that changes the
  // route, so its `inert` page is released before the route's focus handling (focus to #main) runs.
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const sheetOpen = sheetFor === pathname;
  const setSheetOpen = (next: boolean | ((open: boolean) => boolean)) => {
    const open = typeof next === 'function' ? next(sheetOpen) : next;
    setSheetFor(open ? pathname : null);
  };
  const headerRef = useRef<HTMLElement>(null);
  const createRef = useRef<HTMLDivElement>(null);
  const createBtnRef = useRef<HTMLButtonElement>(null);
  const sheetBtnRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const toolsLabel = locked ? 'Owner tools' : 'Create';
  const tools: Tool[] = locked ? [...OWNER_NAV, ...CREATE] : CREATE;
  const sections: NavItem[] = locked ? PUBLIC_NAV : [...PUBLIC_NAV, ...OWNER_NAV];
  const toolsActive = tools.some((t) => t.to === pathname);

  useEffect(() => { syncDocumentThemeWithTeams().catch(() => { /* not in Teams */ }); }, []);

  useEffect(() => { setMenuOpen(false); setSheetFor(null); }, [pathname]);

  // A link inside the sheet closes it. A different route moves focus to the page; the same route keeps it on the menu button.
  const closeSheetFor = (to: string) => {
    if (!sheetOpen) return;
    setSheetOpen(false);
    if (to === pathname) sheetBtnRef.current?.focus();
  };

  // The tools list is a disclosure, not an ARIA menu: Escape closes it and hands focus back to its button.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent) => { if (!createRef.current?.contains(e.target as Node)) setMenuOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      createBtnRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  // The phone sheet is modal: the page behind is inert, Tab cycles through the masthead and the sheet,
  // Escape closes it and returns focus to the menu button (a route change moves focus to the page instead).
  useEffect(() => {
    const header = headerRef.current;
    if (!sheetOpen || !header) return undefined;
    const release = inertAround(header);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sheetRef.current?.querySelector<HTMLElement>('a[href]')?.focus();
    const stops = () => Array.from(header.querySelectorAll<HTMLElement>(TABBABLE))
      .filter((el) => !el.classList.contains('skip-link') && el.getClientRects().length > 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setSheetOpen(false);
        sheetBtnRef.current?.focus();
        return;
      }
      if (e.key !== 'Tab') return;
      const all = stops();
      if (all.length === 0) return;
      const first = all[0];
      const last = all[all.length - 1];
      const active = document.activeElement;
      if (!header.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    // Rotating or resizing past the sheet's breakpoint hides it: close it so the page does not stay inert.
    const query = window.matchMedia(SHEET_QUERY);
    const onQuery = () => { if (!query.matches) setSheetOpen(false); };
    document.addEventListener('keydown', onKey);
    query.addEventListener('change', onQuery);
    return () => {
      release();
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKey);
      query.removeEventListener('change', onQuery);
    };
  }, [sheetOpen]);

  return (
    <header className="masthead" ref={headerRef}>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="container masthead__inner">
        <Link to="/" className="masthead__brand" aria-label="Oz Radio home" onClick={() => closeSheetFor('/')}>Oz <em>Radio</em></Link>

        <nav className="masthead__nav" aria-label="Main">
          {sections.map((it) => (
            <NavLink key={it.to} to={it.to} end={it.end} className="masthead__link">{it.label}</NavLink>
          ))}
          <div
            className="masthead__create"
            ref={createRef}
            // Tabbing out of the disclosure closes it (relatedTarget is null when focus just leaves the page: keep it open).
            onBlur={(e) => {
              if (menuOpen && e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget)) setMenuOpen(false);
            }}
          >
            <button
              ref={createBtnRef}
              type="button"
              className={['masthead__link', toolsActive && 'is-active'].filter(Boolean).join(' ')}
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen((o) => !o)}
            >
              {toolsLabel} <ChevronDown aria-hidden />
            </button>
            {menuOpen && (
              <div className="menu" id={menuId}>
                {locked && <p className="menu__hint">Sign-in required. {OWNER_SIGN_IN_HINT}</p>}
                <ul className="menu__list" aria-label={toolsLabel}>
                  {tools.map((c) => (
                    <li key={c.to}>
                      <NavLink to={c.to} end className="menu__item">
                        <c.icon aria-hidden />
                        <span>
                          {c.label}
                          <small>{locked ? 'Sign-in required' : c.desc}</small>
                        </span>
                      </NavLink>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </nav>

        <div className="masthead__actions">
          <AuthControls />
          <button
            ref={sheetBtnRef}
            type="button"
            className={buttonClass({ variant: 'ghost', iconOnly: true }, 'masthead__menu-btn')}
            aria-label={sheetOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={sheetOpen}
            aria-controls="site-sheet"
            onClick={() => setSheetOpen((o) => !o)}
          >
            {sheetOpen ? <X aria-hidden /> : <Menu aria-hidden />}
          </button>
        </div>
      </div>

      <div id="site-sheet" ref={sheetRef} className="masthead__sheet" data-open={sheetOpen}>
        {sheetOpen && (
          <>
            <nav className="sheet__group" aria-label="Sections">
              <span className="eyebrow">Explore</span>
              {sections.map((it) => (
                <NavLink key={it.to} to={it.to} end={it.end} className="sheet__link" onClick={() => closeSheetFor(it.to)}>{it.label}</NavLink>
              ))}
            </nav>
            <nav className="sheet__group" aria-label={toolsLabel}>
              <span className="eyebrow">{toolsLabel}</span>
              {locked && <p className="sheet__hint">Sign-in required. {OWNER_SIGN_IN_HINT}</p>}
              {tools.map((c) => (
                <NavLink key={c.to} to={c.to} end className="sheet__link" onClick={() => closeSheetFor(c.to)}>
                  {c.label}
                  {locked && <small>Sign-in required</small>}
                </NavLink>
              ))}
            </nav>
          </>
        )}
      </div>
    </header>
  );
}

function AuthControls() {
  const auth = useAuth();
  if (!auth.loading && auth.auth_mode === 'disabled') {
    return <div data-testid="auth-controls" />;
  }
  return (
    <div className="cluster" style={{ '--cluster-gap': 'var(--sp-3)', flexWrap: 'nowrap' } as React.CSSProperties} data-testid="auth-controls">
      {auth.authenticated ? (
        <>
          <span className="masthead__user" title={auth.is_admin ? 'Signed in — full demo access' : 'Signed in — read-only access'}>
            {auth.name ?? 'Signed in'}{!auth.is_admin && ' · read-only'}
          </span>
          <a href={SIGN_OUT_URL} className={buttonClass({ size: 'sm' })}>Sign out</a>
        </>
      ) : (
        // Anonymous until proven otherwise, so the masthead never shifts when /api/me answers.
        <OwnerSignInLink className="masthead__signin" />
      )}
    </div>
  );
}
