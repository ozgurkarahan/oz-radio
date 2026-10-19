import React from 'react';
import { Link } from 'react-router-dom';
import { Headphones, Play, RotateCcw, TriangleAlert } from 'lucide-react';
import { pickDemoDeck, readBoot } from '../services/boot';
import { demoDeckPath } from '../services/demoProtocol';
import { buttonClass } from '../ui';

interface State { error: Error | null }

type Scope = 'inline' | 'page' | 'app';

interface Props {
  children: React.ReactNode;
  /** A new key clears a caught error (a route change, a new episode). */
  resetKey?: string;
  /**
   * `page`: the routed content (the masthead stays; the panel offers Reload and the public ways in).
   * `app`: everything, including providers, masthead and mini-player (plain anchors, no router needed).
   * `inline` (default): a widget such as the player — the compact panel with Reload only.
   */
  scope?: Scope;
}

/** A lazily loaded page whose script could not be fetched (offline, or a deploy removed the old file). */
const CHUNK_LOAD_ERROR = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i;

/** Where "Start the live demo" leads from a dead end: the visitor's live-demo deck when the boot block names one, else the decks. */
export function liveDemoHref(): string {
  const deck = pickDemoDeck(readBoot());
  return deck ? demoDeckPath(deck.deck_id) : '/decks';
}

const reload = () => window.location.reload();

/** Last-resort guard so an unexpected render error never blanks the whole app. */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  private heading = React.createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  componentDidMount() {
    if (this.state.error) this.heading.current?.focus();
  }

  componentDidUpdate(prev: Props, prevState: State) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    } else if (this.state.error && !prevState.error) {
      this.heading.current?.focus();
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const scope = this.props.scope ?? 'inline';
    if (scope === 'app') return <AppCrash heading={this.heading} />;
    if (scope === 'page') return <PageCrash error={error} heading={this.heading} />;
    return (
      <div role="alert" className="crash">
        <div className="empty">
          <span className="empty__icon"><TriangleAlert aria-hidden /></span>
          <h2 className="empty__title">Something went wrong on this page</h2>
          <p className="empty__text">Try reloading, or pick another section from the navigation bar.</p>
          <button type="button" className="btn btn--primary" onClick={reload}>
            <RotateCcw aria-hidden /> Reload
          </button>
        </div>
      </div>
    );
  }
}

/** A page crashed: say so, keep the rest of the app usable, offer a reload and the public ways in. */
function PageCrash({ error, heading }: { error: unknown; heading: React.RefObject<HTMLHeadingElement | null> }) {
  const download = CHUNK_LOAD_ERROR.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));
  return (
    <div role="alert" className="crash" data-testid="route-crash">
      <div className="empty">
        <span className="empty__icon"><TriangleAlert aria-hidden /></span>
        <h1 ref={heading} tabIndex={-1} className="empty__title crash__title">Something went wrong on this page</h1>
        <p className="empty__text">
          {download && 'This page could not be downloaded. Check your connection, then reload. '}
          The rest of Oz Radio still works. Reload this page, or pick another way in:
        </p>
        <div className="next-steps next-steps--center">
          <button type="button" className={buttonClass({ variant: 'primary' })} onClick={reload}>
            <RotateCcw aria-hidden /> Reload
          </button>
          <Link className={buttonClass({})} to="/">Home</Link>
          <Link className={buttonClass({})} to="/podcast/library"><Headphones aria-hidden /> Listen to an episode</Link>
          <Link className={buttonClass({})} to={liveDemoHref()}><Play aria-hidden /> Start the live demo</Link>
        </div>
      </div>
    </div>
  );
}

/** Something outside the page boundary crashed (a provider, the masthead, the mini-player): brand, message, ways out. */
function AppCrash({ heading }: { heading: React.RefObject<HTMLHeadingElement | null> }) {
  return (
    <div role="alert" className="crash crash--app" data-testid="app-crash">
      <p className="crash__brand">Oz <em>Radio</em></p>
      <h1 ref={heading} tabIndex={-1} className="empty__title crash__title">Something went wrong</h1>
      <p className="empty__text">Oz Radio ran into a problem it could not recover from. Reloading usually fixes it.</p>
      <div className="next-steps next-steps--center">
        <button type="button" className={buttonClass({ variant: 'primary' })} onClick={reload}>
          <RotateCcw aria-hidden /> Reload
        </button>
        <a className={buttonClass({})} href="/">Home</a>
      </div>
    </div>
  );
}
