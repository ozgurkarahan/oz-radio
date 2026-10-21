import React from 'react';
import { useKeyedAvatar } from './useKeyedAvatar';

export interface HostLike {
  display_name?: string | null;
  thumbnail_url?: string | null;
}

/**
 * Circular avatar portrait. Green-screen thumbnails are keyed client-side so
 * the face sits on the disc colour; other images are cropped to cover; avatars
 * without a thumbnail show a serif monogram.
 */
export function HostDisc({ host, size = 104, speaking = false, ring = false, tone = 'sage', className, label, ...rest }: {
  host?: HostLike | null;
  size?: number;
  speaking?: boolean;
  /** Dashed rotating outer ring (hero use). */
  ring?: boolean;
  tone?: 'sage' | 'sand';
  /** Accessible name; defaults to the host's display name. Pass "" for decorative use. */
  label?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const { src, status } = useKeyedAvatar(host?.thumbnail_url || null);
  const name = host?.display_name?.trim() || '';
  const alt = label ?? name;
  return (
    <span
      className={['host-disc', speaking && 'host-disc--speaking', tone === 'sand' && 'host-disc--sand', className].filter(Boolean).join(' ')}
      style={{ '--disc': `${size}px` } as React.CSSProperties}
      data-avatar-status={status}
      role={alt ? 'img' : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      {...rest}
    >
      {ring && <span className="host-disc__ring" aria-hidden />}
      <span className="host-disc__face">
        {src && status !== 'pending' ? (
          <img src={src} alt="" decoding="async" className={status === 'original' ? 'is-cover' : undefined} draggable={false} />
        ) : status === 'none' ? (
          <span className="host-disc__monogram" aria-hidden>{(name[0] ?? '?').toUpperCase()}</span>
        ) : null}
      </span>
    </span>
  );
}

/** Small overlapping host discs, e.g. the two podcast hosts in a list row. */
export function HostsMini({ hosts, label }: { hosts: (HostLike | null | undefined)[]; label?: string }) {
  const list = hosts.filter(Boolean) as HostLike[];
  if (list.length === 0) return null;
  return (
    <span className="hosts-mini" role="img" aria-label={label ?? list.map((h) => h.display_name).filter(Boolean).join(' and ')}>
      {list.map((h, i) => <HostDisc key={i} host={h} size={32} label="" />)}
    </span>
  );
}
