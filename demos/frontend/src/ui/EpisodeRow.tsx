import React from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { Chip } from './primitives';
import { langAttr, levelLabel, type AudienceLevelValue } from './format';

/**
 * One row of an editorial "episode" list (decks, videos, podcasts, playlists).
 * The title is the primary action and stretches over the whole row; controls in
 * `actions` / `extra` stay independently clickable above it.
 *
 * `level` renders the audience-level chip as the first item of the meta line (nothing for null or an
 * unknown value); `lang` (BCP-47, e.g. "fr-FR") sets the `lang` attribute of the title element.
 * A row without these two props renders exactly as before.
 *
 * Extra props (e.g. `data-testid`) are applied to the <li>.
 */
export function EpisodeRow({
  num, title, to, onOpen, openLabel, meta, kind, kindLead, hosts, duration, actions, extra, titleProps, className, level, lang, ...rest
}: {
  num?: React.ReactNode;
  title: React.ReactNode;
  /** Router destination for the title… */
  to?: string;
  /** …or a click handler (used when no route exists, e.g. opening a player). */
  onOpen?: () => void;
  /** Accessible label for the title action when the title alone is ambiguous. */
  openLabel?: string;
  meta?: React.ReactNode[];
  kind?: { icon: LucideIcon; label: string; tone?: 'clay' | 'ink' };
  /**
   * Mixed lists (Home): the format leads the row as a badge above the title, on every viewport, instead of
   * the desktop-only column. The row then has one cell fewer: its grid template must drop the kind column.
   */
  kindLead?: boolean;
  hosts?: React.ReactNode;
  duration?: React.ReactNode;
  actions?: React.ReactNode;
  extra?: React.ReactNode;
  titleProps?: Record<string, unknown>;
  /** Audience level of the item (`audience_level` of the public DTOs): rendered as a chip before the other meta. */
  level?: AudienceLevelValue | null;
  /** Language of the title (BCP-47, e.g. "fr-FR" → `lang="fr"`); omitted when unknown. */
  lang?: string;
} & Omit<React.LiHTMLAttributes<HTMLLIElement>, 'title'>) {
  const KindIcon = kind?.icon;
  const levelText = levelLabel(level);
  const titleLang = langAttr(lang);
  const titleNode = to ? (
    <Link className="episode-row__title" to={to} aria-label={openLabel} lang={titleLang} {...titleProps}>{title}</Link>
  ) : onOpen ? (
    <button type="button" className="episode-row__title" onClick={onOpen} aria-label={openLabel} lang={titleLang} {...titleProps}>{title}</button>
  ) : (
    <span className="episode-row__title" lang={titleLang} {...titleProps}>{title}</span>
  );
  const kindNode = (
    <span className={['episode-row__kind', kindLead && 'episode-row__kind--lead'].filter(Boolean).join(' ')} data-tone={kind?.tone}>
      {KindIcon && <KindIcon aria-hidden />}{kind?.label}
    </span>
  );
  return (
    <li className={['episode-row', className].filter(Boolean).join(' ')} {...rest}>
      <span className="episode-row__num" aria-hidden>{num}</span>
      <div className="episode-row__body">
        {kindLead && kind && kindNode}
        {titleNode}
        {(levelText !== '' || (meta && meta.length > 0)) && (
          <div className="episode-row__meta">
            {levelText !== '' && (
              <Chip className="episode-row__level" data-testid="episode-level" data-level={level}>{levelText}</Chip>
            )}
            {(meta ?? []).filter(Boolean).map((m, i) => <span key={i}>{m}</span>)}
          </div>
        )}
        {extra && <div className="episode-row__extra">{extra}</div>}
      </div>
      {!kindLead && kindNode}
      <span className="episode-row__hosts">{hosts}</span>
      <span className="episode-row__dur">{duration}</span>
      <div className="episode-row__actions">{actions}</div>
    </li>
  );
}

export function EpisodeList({ children, label, className }: { children: React.ReactNode; label?: string; className?: string }) {
  return <ol className={['episode-list', className].filter(Boolean).join(' ')} aria-label={label}>{children}</ol>;
}
