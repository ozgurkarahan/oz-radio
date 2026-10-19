import React, { useEffect, useId, useRef } from 'react';
import { useNavigationType, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Headphones } from 'lucide-react';
import { DemoActionLink, useDemoEntry } from '../components/AuthGate';
import { SIGN_OUT_URL, microsoftSignInUrl, safeNextPath, useAuth } from '../services/auth';
import { ButtonLink, PageHeader, buttonClass } from '../ui';

const LEAD_VISITOR = 'Signing in is only for the site owner and the people they have invited; everything public on Oz Radio works without an account.';
const LEAD_SIGNED_IN = "You're signed in.";
const LEAD_NOT_ENABLED = "You're signed in, but your account isn't enabled for this demo.";
const LEAD_NO_SIGN_IN = "Sign-in isn't used in this environment.";

/**
 * The page "Owner sign-in" opens (`/sign-in?next=<where the visitor was>`). Visitors cannot sign in — the Entra app is
 * single-tenant, and Microsoft's error page for an account outside it offers nothing but the browser's Back — so the public
 * actions come first and only the owner's own "Continue to Microsoft sign-in" leaves for Easy Auth.
 */
export default function SignInPage() {
  const auth = useAuth();
  const entry = useDemoEntry();
  const [params] = useSearchParams();
  const navigationType = useNavigationType();
  const root = useRef<HTMLDivElement>(null);
  const ownerTitleId = useId();
  // The one form of `next` this page ever follows (never an external address, never this page).
  const next = safeNextPath(params.get('next'));

  // Reached by a click inside the app: the heading takes focus, as on the 404 page, so the next Tab starts here and a screen
  // reader announces the page. A first load or Back/Forward is left to the route's own focus handling.
  useEffect(() => {
    if (navigationType === 'POP') return;
    const heading = root.current?.querySelector('h1');
    if (!heading) return;
    heading.tabIndex = -1;
    heading.focus();
  }, []);

  const noSignIn = !auth.loading && auth.auth_mode === 'disabled';
  const notEnabled = auth.authenticated && !auth.is_admin;
  const lead = noSignIn ? LEAD_NO_SIGN_IN : auth.is_admin ? LEAD_SIGNED_IN : notEnabled ? LEAD_NOT_ENABLED : LEAD_VISITOR;

  return (
    <div ref={root} className="container page sign-in" data-testid="sign-in-page">
      <PageHeader title="Owner sign-in" lead={lead} />
      <div className="sign-in__body">
        {noSignIn || auth.is_admin ? (
          <div className="sign-in__actions">
            <ButtonLink to={next} icon={ArrowLeft} data-testid="sign-in-back">Back to where you were</ButtonLink>
          </div>
        ) : (
          <>
            <div
              className="sign-in__public"
              role="group"
              aria-label="Try Oz Radio without signing in"
              aria-busy={entry.kind === 'pending' || undefined}
            >
              <div className="sign-in__actions">
                <DemoActionLink
                  entry={entry}
                  className="sign-in__demo"
                  testIdLive="sign-in-demo-action"
                  testIdRecorded="sign-in-demo-action"
                />
                <ButtonLink to="/podcast/library" icon={Headphones} data-testid="sign-in-listen-action">Listen to an episode</ButtonLink>
              </div>
              <ButtonLink to={next} variant="link" icon={ArrowLeft} className="sign-in__back" data-testid="sign-in-back">
                Back to where you were
              </ButtonLink>
            </div>
            <section className="sign-in__owner" aria-labelledby={ownerTitleId}>
              <h2 id={ownerTitleId} className="eyebrow">For the site owner</h2>
              {notEnabled ? (
                <>
                  <p className="small muted">To use another account, sign out first.</p>
                  <a href={SIGN_OUT_URL} className={buttonClass({})} data-testid="sign-in-sign-out">Sign out</a>
                </>
              ) : (
                <>
                  <a href={microsoftSignInUrl(next)} className={buttonClass({})} data-testid="sign-in-continue">
                    Continue to Microsoft sign-in
                    <ArrowRight aria-hidden />
                  </a>
                  <p className="small muted sign-in__note">
                    If your Microsoft account isn't invited, Microsoft shows an error page. Use your browser's Back button to return here.
                  </p>
                </>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
