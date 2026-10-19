/**
 * Microsoft Teams integration helpers.
 * Detects if the app is running inside a Teams tab (iframe or Teams mobile webview)
 * and provides context/theme information.
 *
 * The Teams SDK is imported dynamically and only inside a Teams host: evaluating the SDK module
 * fetches its valid-origins list from the Office CDN, a cross-origin request every ordinary
 * visitor would otherwise pay on every page load (and the SDK would weigh on the main bundle).
 */
import type { app } from '@microsoft/teams-js';

type TeamsSdk = typeof import('@microsoft/teams-js');

let _initialized = false;
let _inTeams = false;
let _context: app.Context | null = null;
let _sdk: TeamsSdk | null = null;
let _pending: Promise<boolean> | null = null;

/** Hosts that embed Oz Radio as a tab: the same family the server allows in `frame-ancestors` (FRAME_ANCESTORS). */
const TEAMS_HOST = /(^|\.)(teams\.microsoft\.com|teams\.microsoft\.us|teams\.live\.com|office\.com|office365\.com|microsoft365\.com|cloud\.microsoft)$/i;

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

/** Origins of the embedding pages: `ancestorOrigins` (Chromium), else the referrer of the frame (Firefox, Safari). */
function ancestorHosts(): string[] {
  const origins: string[] = [];
  const list = window.location.ancestorOrigins;
  for (let i = 0; list && i < list.length; i += 1) origins.push(list[i]);
  if (origins.length === 0 && document.referrer) origins.push(document.referrer);
  return origins.map(hostnameOf).filter((host): host is string => host !== null);
}

/**
 * True only inside a Teams host. Teams mobile apps run the tab in a native webview that injects `nativeInterface`;
 * the web and desktop clients embed it in an iframe of a Microsoft host. A frame whose parent is known and is not a
 * Teams host (any other site) is not Teams; a frame whose parent cannot be read is treated as Teams, because the
 * server only allows Teams and Office hosts to frame the app.
 */
function runsInsideTeamsHost(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { nativeInterface?: unknown }).nativeInterface) return true;
  let framed = false;
  try {
    framed = window.self !== window.top;
  } catch {
    framed = true;
  }
  if (!framed) return false;
  const hosts = ancestorHosts();
  return hosts.length === 0 || hosts.some((host) => TEAMS_HOST.test(host));
}

/**
 * Initialize the Teams SDK. Safe to call outside Teams — resolves false without loading the SDK
 * or touching the network, and sets _inTeams accordingly.
 */
export async function initializeTeams(): Promise<boolean> {
  if (_initialized) return _inTeams;
  if (!_pending) {
    _pending = (async () => {
      let detected = false;
      if (runsInsideTeamsHost()) {
        try {
          const sdk = await import('@microsoft/teams-js');
          await sdk.app.initialize();
          _sdk = sdk;
          _inTeams = true;
          _context = await sdk.app.getContext();

          // Notify Teams that the tab content is ready
          sdk.app.notifySuccess();
          detected = true;
        } catch {
          // Looked like Teams but is not (or the SDK did not answer) — that's fine
          _inTeams = false;
        }
      }
      _initialized = true;
      return detected;
    })();
  }
  return _pending;
}

/** Returns true if the app is running inside a Teams tab. */
export function isInTeams(): boolean {
  return _inTeams;
}

/** Get the Teams context (theme, locale, user, etc.). */
export function getTeamsContext(): app.Context | null {
  return _context;
}

/**
 * Get the current Teams theme name.
 * Returns 'default' (light), 'dark', or 'contrast'.
 * Falls back to 'default' when not in Teams.
 */
export function getTeamsTheme(): string {
  return _context?.app?.theme ?? 'default';
}

/**
 * Register a callback for Teams theme changes.
 */
export function onTeamsThemeChange(callback: (theme: string) => void): void {
  if (_inTeams && _sdk) {
    _sdk.app.registerOnThemeChangeHandler(callback);
  }
}

/** Maps a Teams theme name onto the `data-theme` token overrides (styles/tokens.css). */
export function applyTeamsThemeToDocument(theme: string): void {
  const root = document.documentElement;
  if (theme === 'dark') root.dataset.theme = 'teams-dark';
  else if (theme === 'contrast') root.dataset.theme = 'teams-contrast';
  else delete root.dataset.theme;
}

/**
 * Initializes Teams once and keeps the document theme in sync with the host.
 * Outside Teams this resolves to `false` and leaves the default light theme.
 */
export async function syncDocumentThemeWithTeams(): Promise<boolean> {
  const inTeams = await initializeTeams();
  if (!inTeams) return false;
  applyTeamsThemeToDocument(getTeamsTheme());
  onTeamsThemeChange(applyTeamsThemeToDocument);
  return true;
}
