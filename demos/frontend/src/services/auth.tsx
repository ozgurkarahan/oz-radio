// Auth state for the hybrid exposure model.
// Anonymous visitors can browse published content; only allowlisted
// ("admin") users can run uploads, live avatar, renders, chat, etc.
import React, { createContext, useContext, useEffect, useState } from 'react';

export type AuthMode = 'easyauth' | 'disabled';

export interface AuthState {
  authenticated: boolean;
  is_admin: boolean;
  name: string | null;
  auth_mode: AuthMode;
  loading: boolean;
}

const LOADING_STATE: AuthState = {
  authenticated: false,
  is_admin: false,
  name: null,
  auth_mode: 'easyauth',
  loading: true,
};

const AuthContext = createContext<AuthState>(LOADING_STATE);

let mePromise: Promise<AuthState> | null = null;

async function fetchMe(): Promise<AuthState> {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return {
      authenticated: !!d?.authenticated,
      is_admin: !!d?.is_admin,
      name: typeof d?.name === 'string' && d.name ? d.name : null,
      auth_mode: d?.auth_mode === 'disabled' ? 'disabled' : 'easyauth',
      loading: false,
    };
  } catch (e) {
    // Default deny: if identity can't be determined, treat as anonymous.
    console.warn('[auth] /api/me failed — treating visitor as anonymous', e);
    return { ...LOADING_STATE, loading: false };
  }
}

/** Fetches `/api/me` once per page load (shared across all consumers). */
export function loadAuth(): Promise<AuthState> {
  if (!mePromise) mePromise = fetchMe();
  return mePromise;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(LOADING_STATE);
  useEffect(() => {
    let cancelled = false;
    loadAuth().then((s) => { if (!cancelled) setState(s); });
    return () => { cancelled = true; };
  }, []);
  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/** Easy Auth's Microsoft sign-in (a full page load, not a route), then back to `next`. */
export function microsoftSignInUrl(next: string): string {
  return `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(next)}`;
}

export function signInUrl(): string {
  return microsoftSignInUrl(`${window.location.pathname}${window.location.search}`);
}

export const SIGN_OUT_URL = '/.auth/logout?post_logout_redirect_uri=/';

export function signIn(): void {
  window.location.href = signInUrl();
}

// ---- The "Owner sign-in" explainer (/sign-in) ------------------------------------------------
// Visitors cannot sign in (the Entra app is single-tenant), so "Owner sign-in" opens an in-app page first; only its
// "Continue to Microsoft sign-in" leaves for Easy Auth. `next` is where the visitor was.

/** The in-app route of the explainer (a lazy route, main.tsx). */
export const SIGN_IN_PATH = '/sign-in';

const NEXT_MAX_LENGTH = 2048;
// A browser drops tabs and line breaks inside a URL and reads "\" as "/": "/<tab>/host" and "/\host" would both mean "//host".
const NEXT_FORBIDDEN = /[\s\\\u0000-\u001f\u007f-\u009f]/;

/** The path of an in-app target the way the router matches it: decoded, no trailing slash, any case. */
function routePath(target: string): string {
  const raw = target.split(/[?#]/, 1)[0];
  let path = raw;
  try { path = decodeURIComponent(raw); } catch { /* a malformed escape: compare it as it is */ }
  return path.replace(/\/+$/, '').toLowerCase() || '/';
}

/**
 * The only form of `next` the client will ever follow: one in-app path that starts with a single "/" ("/decks?x=1").
 * Anything else — "//host", "/\host", "https://…", "javascript:", whitespace or control characters, more than 2048
 * characters, the sign-in page itself — becomes "/". Easy Auth refuses external redirects as well; this keeps the client
 * from ever building one.
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== 'string' || next.length > NEXT_MAX_LENGTH) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || NEXT_FORBIDDEN.test(next)) return '/';
  if (routePath(next) === SIGN_IN_PATH) return '/';
  try {
    // Whatever the URL parser makes of it must still be this origin.
    if (new URL(next, 'https://oz-radio.invalid').origin !== 'https://oz-radio.invalid') return '/';
  } catch {
    return '/';
  }
  return next;
}

/** `/sign-in?next=<where the visitor is>`. On the explainer itself the `next` it already has is kept, never nested. */
export function ownerSignInPath(here: { pathname: string; search: string }): string {
  const next = routePath(here.pathname) === SIGN_IN_PATH
    ? safeNextPath(new URLSearchParams(here.search).get('next'))
    : safeNextPath(`${here.pathname}${here.search}`);
  return `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}`;
}

// ---- Global 401/403 handling ----------------------------------------------
export interface AuthErrorDetail {
  status: 401 | 403;
  url: string;
}

export const AUTH_ERROR_EVENT = 'app:auth-error';

export function emitAuthError(status: 401 | 403, url = ''): void {
  window.dispatchEvent(new CustomEvent<AuthErrorDetail>(AUTH_ERROR_EVENT, { detail: { status, url } }));
}

let interceptorInstalled = false;

/**
 * Wraps `window.fetch` so any 401/403 from `/api/*` raises a global
 * notification (rendered by <AuthToast/>). Responses are passed through
 * untouched so callers keep their own error handling.
 */
export function installAuthErrorInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined' || !window.fetch) return;
  interceptorInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await original(input, init);
    if (res.status === 401 || res.status === 403) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      let path = url;
      try { path = new URL(url, window.location.origin).pathname; } catch { /* keep raw */ }
      if (path.startsWith('/api/') && path !== '/api/me') {
        emitAuthError(res.status as 401 | 403, path);
      }
    }
    return res;
  };
}
