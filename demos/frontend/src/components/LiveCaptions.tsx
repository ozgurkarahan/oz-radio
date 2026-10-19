import React from 'react';
import type { CaptionView } from '../services/demoCaptions';

interface Props {
  /** What the avatar has said so far (paced to its audio); null when nothing is being said. */
  view: CaptionView | null;
  /** The sentence that just finished, for the screen-reader announcement. */
  announcement: string;
  /** Language of the deck: the captions and the announcement follow it. */
  lang?: string;
  /** Stop showing the captions (the answer is already written out next to them). */
  suppressed?: boolean;
}

/**
 * Captions of what the live avatar says. The box is plain text — not a live region, so a screen reader never reads it
 * word by word. A separate visually hidden polite region announces whole sentences, once each, as they finish.
 */
export default function LiveCaptions({ view, announcement, lang, suppressed = false }: Props) {
  const text = !suppressed && view ? view.text : '';
  return (
    <div className="live-captions" role="group" aria-label="Live captions" data-testid="live-captions" lang={lang}>
      <p
        className="live-captions__text"
        data-testid="live-captions-text"
        data-kind={view?.kind}
        data-complete={view?.complete ? 'true' : undefined}
        data-slide={view?.slide ?? undefined}
      >
        {text}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="live-captions-announce">{announcement}</p>
    </div>
  );
}
