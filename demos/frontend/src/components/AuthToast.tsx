import React, { useEffect, useRef, useState } from 'react';
import { Lock, ShieldAlert, X } from 'lucide-react';
import { AUTH_ERROR_EVENT, type AuthErrorDetail, signIn, useAuth } from '../services/auth';
import { NOT_ENABLED_MESSAGE, OwnerSignInLink } from './AuthGate';
import { buttonClass } from '../ui';

/** Global banner for 401/403 responses from the API (see installAuthErrorInterceptor). */
export default function AuthToast() {
  const auth = useAuth();
  const [toast, setToast] = useState<AuthErrorDetail | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onErr = (e: Event) => {
      const detail = (e as CustomEvent<AuthErrorDetail>).detail;
      if (!detail) return;
      setToast(detail);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setToast(null), 7000);
    };
    window.addEventListener(AUTH_ERROR_EVENT, onErr);
    return () => {
      window.removeEventListener(AUTH_ERROR_EVENT, onErr);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  if (!toast) return null;
  const needsSignIn = toast.status === 401 && !auth.authenticated;
  const Icon = needsSignIn ? Lock : ShieldAlert;
  return (
    <div role="alert" data-testid="auth-toast" className="toast">
      <Icon aria-hidden style={{ width: 18, height: 18, flex: 'none' }} />
      <span style={{ flex: 1 }}>
        {needsSignIn
          ? 'Sign-in required — this action is only available to the site owner and invited users.'
          : toast.status === 401
            ? 'Your session has expired. Please sign in again.'
            : NOT_ENABLED_MESSAGE}
      </span>
      {/* Visitors cannot sign in, so they get the "Owner sign-in" text link, never a filled button. */}
      {needsSignIn && auth.auth_mode !== 'disabled' && <OwnerSignInLink className="gate-notice__signin" />}
      {!needsSignIn && toast.status === 401 && auth.auth_mode !== 'disabled' && (
        <button type="button" onClick={signIn} className={buttonClass({ size: 'sm', variant: 'primary' })}>
          Sign in
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => setToast(null)} className={buttonClass({ size: 'sm', variant: 'ghost', iconOnly: true })}>
        <X aria-hidden />
      </button>
    </div>
  );
}
