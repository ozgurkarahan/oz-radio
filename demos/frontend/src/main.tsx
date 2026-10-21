import './styles/index.css';
import React, { useEffect, useLayoutEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Routes, Route, matchPath, useLocation, useNavigationType } from 'react-router-dom';
import { Headphones, Layers, Play } from 'lucide-react';
import HomePage from './pages/HomePage';
import TopNav from './components/TopNav';
import AuthToast from './components/AuthToast';
import ErrorBoundary, { liveDemoHref } from './components/ErrorBoundary';
import { AuthProvider, installAuthErrorInterceptor } from './services/auth';
import { initTelemetry } from './services/telemetry';
import { installPlayerDebug, isPlayerDebugEnabled } from './debug/playerDebug';
import { PlaybackProvider } from './playback/PlaybackProvider';
import { MiniPlayer } from './playback/MiniPlayer';
import { ButtonLink, Spinner } from './ui';

installAuthErrorInterceptor();
// Cookieless telemetry: does nothing unless the boot block enables it and the visitor has not opted out (GPC, DNT, opt-out key).
initTelemetry();

// Opt-in on-device playback log (?debug=player): hooks before render, panel as a lazy chunk.
const playerDebug = isPlayerDebugEnabled();
if (playerDebug) installPlayerDebug();
const PlayerDebugPanel = playerDebug
  ? React.lazy<React.ComponentType>(() => import('./debug/PlayerDebugPanel').catch(() => ({ default: () => null })))
  : null;

const HOME_TITLE = 'Oz Radio — AI hosts explain slide decks';
const NOT_FOUND_TITLE = 'Page not found · Oz Radio';

type PageModule = { default: React.ComponentType };

/** Every page except Home is its own chunk, downloaded the first time its route is visited. */
function lazyRoute(path: string, title: string, load: () => Promise<PageModule>) {
  return { path, title, load, Page: React.lazy(load) };
}

const ROUTES = [
  lazyRoute('/live', 'Present a deck live · Oz Radio', () => import('./pages/LivePage')),
  lazyRoute('/decks', 'Decks · Oz Radio', () => import('./pages/DecksPage')),
  lazyRoute('/decks/:deckId/present', 'Live demo · Oz Radio', () => import('./pages/DeckPresentPage')),
  lazyRoute('/search', 'Search · Oz Radio', () => import('./pages/SearchPage')),
  lazyRoute('/playlists', 'Playlists · Oz Radio', () => import('./pages/PlaylistsPage')),
  lazyRoute('/playlists/:playlistId', 'Playlist · Oz Radio', () => import('./pages/PlaylistPlayerPage')),
  lazyRoute('/podcast', 'Create a podcast · Oz Radio', () => import('./pages/PodcastPage')),
  lazyRoute('/podcast/library', 'Podcasts · Oz Radio', () => import('./pages/PodcastLibraryPage')),
  lazyRoute('/video', 'Create a video · Oz Radio', () => import('./pages/VideoPage')),
  lazyRoute('/video/library', 'Videos · Oz Radio', () => import('./pages/VideoLibraryPage')),
  lazyRoute('/sign-in', 'Owner sign-in · Oz Radio', () => import('./pages/SignInPage')),
];

/** The document title of a route: what a tab, the history and a screen reader announce after a navigation. */
function titleFor(pathname: string): string {
  if (pathname === '/' || pathname === '/index.html') return HOME_TITLE;
  return ROUTES.find((route) => matchPath({ path: route.path, end: true }, pathname))?.title ?? NOT_FOUND_TITLE;
}

/**
 * True while nothing has claimed focus: it is on the page itself or on nothing (the link that was clicked is gone), not on a
 * control of the new page, not in a dialog or the mini-player, and no modal is open — an open modal owns focus, and a Listen
 * sheet opened from the mini-player has to keep the mini-player as its opener, or closing the sheet would return focus to #main.
 */
function focusIsUnclaimed(): boolean {
  if (document.querySelector('[aria-modal="true"]')) return false;
  const active = document.activeElement;
  if (!active || active === document.body || active === document.documentElement) return true;
  if (document.getElementById('main')?.contains(active)) return false;
  return !active.closest('[role="dialog"], [role="alertdialog"], .mini-player');
}

/** Scrolls to the element a `#hash` names once it exists (a lazy page renders it a little later); false if none does. */
function scrollToHash(hash: string): boolean {
  const id = decodeURIComponent(hash.slice(1));
  const target = id ? document.getElementById(id) : null;
  if (!target) return false;
  target.scrollIntoView({ block: 'start' });
  return true;
}

function RoutedContent({ children }: { children: React.ReactNode }) {
  const { pathname, hash } = useLocation();
  const navigationType = useNavigationType();
  const shownPath = useRef(pathname);
  const scrolledPath = useRef(pathname);

  // Layout effects run before every passive effect of the commit: a page that sets its own title (or refines it once its
  // data is there) wins over this generic one, and it is never overwritten later.
  useLayoutEffect(() => { document.title = titleFor(pathname); }, [pathname]);

  // A new page opens at its top (or at its `#anchor`), before it paints: without this the previous page's scroll offset
  // carries over and the new title is hidden. Only for a link (PUSH) to another pathname: Back/Forward (POP) keep the
  // browser's own restoration, redirects (REPLACE) and query-only changes (`?episode=…`) keep the current position.
  // Focus is untouched: the effect below and the pages' own focus calls use `preventScroll`.
  useLayoutEffect(() => {
    if (scrolledPath.current === pathname) return undefined;
    scrolledPath.current = pathname;
    if (navigationType !== 'PUSH') return undefined;
    if (hash && scrollToHash(hash)) return undefined;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (!hash) return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { scrollToHash(hash); });
    });
    return () => cancelAnimationFrame(frame);
    // Only a change of pathname re-runs this; it reads the navigation type and hash of the render that changed it.
  }, [pathname]);

  // After a change of pathname (never the first load, never a search, hash or state-only navigation such as
  // `?episode=…&mode=…`, not a redirect) focus goes to #main — but only once the new route has painted (two animation
  // frames: every effect of the commit and the retries of a closing dialog have had their say) and only if nobody claimed it
  // meanwhile. The next Tab then starts on the new page and a screen reader hears the change.
  useEffect(() => {
    if (shownPath.current === pathname) return undefined;
    shownPath.current = pathname;
    if (navigationType === 'REPLACE') return undefined;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (focusIsUnclaimed()) document.getElementById('main')?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
    // Only a change of pathname re-runs this; it reads the navigation type of the render that changed it.
  }, [pathname]);

  return (
    <main id="main" tabIndex={-1} style={{ flex: 1, display: 'flex', flexDirection: 'column', outline: 'none' }}>
      <ErrorBoundary scope="page" resetKey={pathname}>
        <React.Suspense fallback={<RouteFallback />}>{children}</React.Suspense>
      </ErrorBoundary>
    </main>
  );
}

/** The main area while a page chunk arrives: same height as the page, so nothing collapses or jumps. */
function RouteFallback() {
  return (
    <div className="route-fallback" data-testid="route-fallback">
      <Spinner label="Loading…" />
    </div>
  );
}

function NotFound() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    document.title = NOT_FOUND_TITLE;
    heading.current?.focus();
  }, []);
  return (
    <section className="container page not-found" aria-labelledby="not-found-title" data-testid="not-found">
      <p className="eyebrow">Error 404</p>
      <h1 id="not-found-title" ref={heading} tabIndex={-1} className="not-found__title">Page not found</h1>
      <p className="lead">This link may be out of date or mistyped. Here is where you can go from here:</p>
      <div className="next-steps">
        <ButtonLink to="/">Home</ButtonLink>
        <ButtonLink to={liveDemoHref()} variant="primary" icon={Play}>Start the live demo</ButtonLink>
        <ButtonLink to="/podcast/library" icon={Headphones}>Listen to an episode</ButtonLink>
        <ButtonLink to="/decks" icon={Layers}>Browse decks</ButtonLink>
      </div>
    </section>
  );
}

/** Starts downloading a page's chunk when the visitor shows intent (hover, focus, touch), so the click finds it ready. */
function prefetchPagesOnIntent() {
  const requested = new Set<string>();
  const onIntent = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;
    const pathname = href.split(/[?#]/)[0];
    if (requested.has(pathname)) return;
    requested.add(pathname);
    ROUTES.find((route) => matchPath({ path: route.path, end: true }, pathname))?.load().catch(() => requested.delete(pathname));
  };
  for (const type of ['pointerover', 'touchstart', 'focusin']) {
    document.addEventListener(type, onIntent, { capture: true, passive: true });
  }
}
prefetchPagesOnIntent();

/**
 * The production build loads the entry stylesheet without blocking the first paint (see `nonBlockingEntryCss` in
 * vite.config.ts), so the inline shell shows before it arrives. React must not render unstyled: it waits for the sheet.
 * Resolves at once in dev and when the stylesheet is already applied; a failed sheet resolves too (render anyway).
 */
function entryCssReady(): Promise<void> {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[data-oz-entry-css]'));
  return Promise.all(links.map((link) => new Promise<void>((resolve) => {
    const done = () => { link.media = 'all'; resolve(); };
    if (link.sheet) done();
    else {
      link.addEventListener('load', done, { once: true });
      link.addEventListener('error', done, { once: true });
    }
  }))).then(() => undefined);
}

const rootElement = document.getElementById('root')!;
entryCssReady().then(() => ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* A crash in a provider, the masthead or the mini-player lands here instead of a blank page. */}
    <ErrorBoundary scope="app">
      <AuthProvider>
        <BrowserRouter>
          <PlaybackProvider>
            <TopNav />
            <AuthToast />
            <RoutedContent>
              <Routes>
                <Route path="/" element={<HomePage />} />
                {ROUTES.map(({ path, Page }) => <Route key={path} path={path} element={<Page />} />)}
                <Route path="/index.html" element={<Navigate to="/" replace />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </RoutedContent>
            <MiniPlayer />
          </PlaybackProvider>
        </BrowserRouter>
      </AuthProvider>
      {PlayerDebugPanel && <React.Suspense fallback={null}><PlayerDebugPanel /></React.Suspense>}
    </ErrorBoundary>
  </React.StrictMode>
));
