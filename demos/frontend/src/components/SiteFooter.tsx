import { matchPath, useLocation } from 'react-router-dom';

/** The presenter screens keep the whole viewport for the slide and the avatar: no footer there. */
const PRESENTER_PATHS = ['/live', '/decks/:deckId/present', '/playlists/:playlistId'];

/** Where Oz Radio sits in the owner's work: the first of the five building blocks (01 · Voice) on ozgurkarahan.com. */
export const SITE_VOICE_URL = 'https://ozgurkarahan.com/#voice';

/** Five-bar "you are here" marker of the site: bar `layer` is brand, the others are line. Decorative. */
export function LayerMarker({ layer }: { layer: 1 | 2 | 3 | 4 | 5 }) {
  return (
    <span className="layer-marker" data-layer={layer} aria-hidden="true">
      <i /><i /><i /><i /><i />
    </span>
  );
}

/** The site kicker "01 · Voice", linking back to that building block on ozgurkarahan.com. */
export function VoiceKicker({ className }: { className?: string }) {
  return (
    <a className={['layer-kicker', className].filter(Boolean).join(' ')} href={SITE_VOICE_URL}>
      <LayerMarker layer={1} />
      01 · Voice
      <span className="sr-only">, the first of five building blocks for enterprise agents, on ozgurkarahan.com</span>
    </a>
  );
}

/** Slim footer: what the project is, and the way back to the owner's site. */
export default function SiteFooter() {
  const { pathname } = useLocation();
  if (PRESENTER_PATHS.some((path) => matchPath({ path, end: true }, pathname))) return null;
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <p className="site-footer__note">Oz Radio is a personal open-source sample, not a Microsoft product.</p>
        <a className="site-footer__link" href={SITE_VOICE_URL}>
          ozgurkarahan.com<span aria-hidden="true"> ↗</span>
        </a>
      </div>
    </footer>
  );
}
