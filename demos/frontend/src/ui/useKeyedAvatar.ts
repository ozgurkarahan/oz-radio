import { useEffect, useState } from 'react';

/**
 * Client-side chroma key for avatar thumbnails.
 *
 * Avatar photos are delivered on a green screen. Each URL is processed once on
 * a canvas; the transparent result is cached as an object URL. If the image is
 * not green-screened, cannot be read (cross-origin taint / decode error) or the
 * browser lacks canvas support, callers fall back to the original image.
 */

export type KeyedStatus = 'pending' | 'keyed' | 'original' | 'none';

const MAX_ENTRIES = 32;
const MAX_SIDE = 640;
const resolved = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
/** URLs whose image failed to load at all — callers show a monogram instead. */
const failed = new Set<string>();

function remember(url: string, value: string | null) {
  resolved.set(url, value);
  while (resolved.size > MAX_ENTRIES) {
    const oldest = resolved.keys().next().value as string;
    const blobUrl = resolved.get(oldest);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    resolved.delete(oldest);
  }
}

function cornersAreGreen(data: Uint8ClampedArray, w: number, h: number): boolean {
  if (w < 16 || h < 16) return false;
  const patch = Math.max(2, Math.floor(Math.min(w, h) * 0.04));
  const corners: [number, number][] = [[0, 0], [w - patch, 0], [0, h - patch], [w - patch, h - patch]];
  let green = 0;
  for (const [cx, cy] of corners) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy; y < cy + patch; y++) {
      for (let x = cx; x < cx + patch; x++) {
        const i = (y * w + x) * 4;
        r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
    }
    if (g / n - Math.max(r / n, b / n) > 60) green++;
  }
  return green >= 3;
}

function keyPixels(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const rb = Math.max(r, b);
    const dom = g - rb;
    if (dom > 60) {
      data[i + 3] = 0;
    } else if (dom > 18) {
      data[i + 3] = Math.round((255 * (60 - dom)) / 42);
      data[i + 1] = rb + 6;
    } else if (dom > 0) {
      data[i + 1] = rb + Math.round(dom * 0.35); // despill green fringe
    }
  }
}

function process(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    try {
      if (new URL(url, window.location.href).origin !== window.location.origin) img.crossOrigin = 'anonymous';
    } catch { /* relative URL */ }
    img.decoding = 'async';
    img.onerror = () => { failed.add(url); resolve(null); };
    img.onload = () => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, w, h);
        const frame = ctx.getImageData(0, 0, w, h); // throws SecurityError when tainted
        if (!cornersAreGreen(frame.data, w, h)) return resolve(null);
        keyPixels(frame.data);
        ctx.putImageData(frame, 0, 0);
        canvas.toBlob((blob) => resolve(blob ? URL.createObjectURL(blob) : null), 'image/png');
      } catch {
        resolve(null);
      }
    };
    img.src = url;
  });
}

/**
 * The backend derives a display-size, already-keyed WebP for `/static/avatars/<id>.<ext>` as `<id>-disc.webp`
 * (~15 KB instead of ~250 KB). Using it skips the download of the original and the canvas read altogether.
 * Avatars it cannot be built for (green-screen photos, custom thumbnails) answer 404, or anything but image/webp
 * (a dev server's HTML fallback): those take the original + canvas key path.
 */
const DISC_SOURCE_RE = /^(\/static\/avatars\/[A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(?:png|jpe?g|webp)$/;

export function lightAvatarUrl(url: string): string | null {
  const m = DISC_SOURCE_RE.exec(url);
  return m && !m[1].endsWith('-disc') ? `${m[1]}-disc.webp` : null;
}

async function fetchLight(url: string): Promise<string | null> {
  const light = lightAvatarUrl(url);
  if (!light) return null;
  try {
    const res = await fetch(light);
    if (!res.ok || !/^image\/webp/i.test(res.headers.get('content-type') ?? '')) return null;
    return URL.createObjectURL(await res.blob());
  } catch {
    return null;
  }
}

export function keyAvatar(url: string): Promise<string | null> {
  if (resolved.has(url)) return Promise.resolve(resolved.get(url) ?? null);
  let p = inflight.get(url);
  if (!p) {
    p = fetchLight(url).then((light) => light ?? process(url)).then((out) => {
      remember(url, out);
      inflight.delete(url);
      return out;
    });
    inflight.set(url, p);
  }
  return p;
}

/** Returns the keyed (transparent) image URL when available, else the original. */
export function useKeyedAvatar(url: string | null | undefined): { src: string | null; status: KeyedStatus } {
  const initial = (): { src: string | null; status: KeyedStatus } => {
    if (!url || failed.has(url)) return { src: null, status: 'none' };
    if (resolved.has(url)) {
      const k = resolved.get(url);
      return k ? { src: k, status: 'keyed' } : { src: url, status: 'original' };
    }
    return { src: url, status: 'pending' };
  };
  const [state, setState] = useState(initial);

  useEffect(() => {
    setState(initial());
    if (!url || resolved.has(url)) return;
    let cancelled = false;
    keyAvatar(url).then((k) => {
      if (cancelled) return;
      if (k) setState({ src: k, status: 'keyed' });
      else if (failed.has(url)) setState({ src: null, status: 'none' });
      else setState({ src: url, status: 'original' });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return state;
}

