import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/** Longest eyebrow set as a tracked-caps label; a longer one is a sentence and keeps sentence case. */
const EYEBROW_LABEL_MAX_CHARS = 30;

function plainText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (React.isValidElement(node)) return plainText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Consistent page top: optional back link, eyebrow, serif H1, lead, right-aligned actions. */
export function PageHeader({ eyebrow, title, lead, actions, back, className, children }: {
  /** A short label ("Decks"). Text longer than 30 characters is rendered as a sentence, never as tracked caps. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  lead?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { to: string; label: string } | { onClick: () => void; label: string };
  className?: string;
  children?: React.ReactNode;
}) {
  const eyebrowIsSentence = plainText(eyebrow).trim().length > EYEBROW_LABEL_MAX_CHARS;
  return (
    <header className={['page-header', className].filter(Boolean).join(' ')}>
      <div className="page-header__text">
        {back && ('to' in back
          ? <Link className="back-link" to={back.to}><ArrowLeft aria-hidden />{back.label}</Link>
          : <button type="button" className="back-link" onClick={back.onClick}><ArrowLeft aria-hidden />{back.label}</button>)}
        {eyebrow && <div className={eyebrowIsSentence ? 'eyebrow eyebrow--sentence' : 'eyebrow'}>{eyebrow}</div>}
        <h1 className="page-header__title">{title}</h1>
        {lead && <p className="page-header__lead">{lead}</p>}
        {children}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </header>
  );
}

export function SectionHead({ title, aside, as: Tag = 'h2', className }: {
  title: React.ReactNode; aside?: React.ReactNode; as?: 'h2' | 'h3'; className?: string;
}) {
  return (
    <div className={['section-head', className].filter(Boolean).join(' ')}>
      <Tag>{title}</Tag>
      {aside && <span className="eyebrow">{aside}</span>}
    </div>
  );
}
