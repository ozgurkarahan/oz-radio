import { test, expect, devices } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Cold-path measurement (opt-in, never runs by default).
 *
 * Starts from the portfolio link a real visitor clicks and records, from the click on:
 *   C1.1  the first paint that shows Oz Radio branding (the shell, or the redirect page's own message) — limit 1 s;
 *   C1.2  the first actionable hero CTA (visible, enabled, hit-testable, still for two polls)        — limit 10 s;
 * plus viewport screenshots (a full-page capture would drop touch emulation) and a JSON result.
 *
 * It NEVER warms anything up: the first request of the run is the entry URL, and a retry would be a warm run, so
 * retries are off. Run it against a replica verified to be scaled to zero (the coordinator's Wave 3 gate):
 *   OZ_RADIO_COLD_PATH=1 npx playwright test tests/cold-path.spec.ts --project=chromium --retries=0
 * Environment:
 *   OZ_RADIO_ENTRY_URL        entry link (default https://ozgurkarahan.com/oz-radio/)
 *   OZ_RADIO_COLD_PATH_OUT    output folder (default test-results/cold-path)
 *   OZ_RADIO_CTA_SELECTOR     CSS selector of the hero CTA (default: the Home hero CTA group)
 *   OZ_RADIO_COLD_PATH_CAP_MS give up waiting for the CTA after this long (default 120000)
 *
 * Guardrails (same as the UX evidence runs): Global Privacy Control is on, so the owner's analytics stay clean; the live
 * demo socket (/ws/voice*, which spends the daily quota) is answered locally and closed; no HAR and no trace are recorded
 * (media routes carry SAS tokens); only origin + path of a URL is ever written, never a query string.
 */

const ENABLED = process.env.OZ_RADIO_COLD_PATH === '1';
const ENTRY_URL = process.env.OZ_RADIO_ENTRY_URL ?? 'https://ozgurkarahan.com/oz-radio/';
const OUT_DIR = path.resolve(process.env.OZ_RADIO_COLD_PATH_OUT ?? 'test-results/cold-path');
const CTA_SELECTOR = process.env.OZ_RADIO_CTA_SELECTOR
  ?? '[data-testid="home-try-live-demo"], .home-hero__ctas a[href], .home-hero__ctas button';
const CAP_MS = Number(process.env.OZ_RADIO_COLD_PATH_CAP_MS ?? 120_000);
const LIMITS = { brandedPaintMs: 1000, actionableCtaMs: 10_000 };
const DEMO_SOCKET = /\/ws\/voice/;

/** Navigator.globalPrivacyControl = true and the portfolio's own analytics opt-out (copied from the shared safe-browse helper). */
const GPC_INIT = `(() => {
  try { Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }); } catch (e) {}
  try { localStorage.setItem('site-analytics-opt-out', '1'); } catch (e) {}
})();`;

type ColdEvent = { type: string; t: number; url: string; [key: string]: unknown };

/** origin + pathname only: never a query string or a fragment (they can carry SAS tokens). */
const stripUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    return url.origin + url.pathname;
  } catch {
    return raw.replace(/[?#].*$/, '');
  }
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

// No trace, video or automatic screenshot: media routes carry SAS tokens (these options must be set at file level).
test.use({ trace: 'off', video: 'off', screenshot: 'off' });

/** Runs in every top-level document of the visit (the portfolio redirect page, then the app) and reports to Node. */
function instrument(cfg: { ctaSelector: string }) {
  if (window.top !== window) return;
  const w = window as unknown as { __ozColdReport?: (event: unknown) => void };
  const now = () => performance.timeOrigin + performance.now();
  const queue: unknown[] = [];
  const flush = () => {
    if (typeof w.__ozColdReport !== 'function') { setTimeout(flush, 25); return; }
    while (queue.length) {
      try { w.__ozColdReport(queue.shift()); } catch { /* the page is going away */ }
    }
  };
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    queue.push({ type, t: now(), url: location.origin + location.pathname, ...data });
    flush();
  };
  const bodyText = () => (document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) : '');
  const observe = (type: string, onEntry: (entry: PerformanceEntry & Record<string, unknown>) => void) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach((entry) => onEntry(entry as PerformanceEntry & Record<string, unknown>)))
        .observe({ type, buffered: true });
    } catch { /* an engine without this entry type */ }
  };

  emit('doc', { readyState: document.readyState });
  observe('paint', (e) => emit('paint', { name: e.name, start: e.startTime, text: bodyText() }));
  observe('largest-contentful-paint', (e) => emit('lcp', { start: e.startTime, size: e.size }));
  observe('layout-shift', (e) => emit('ls', { value: e.value, hadRecentInput: e.hadRecentInput }));
  addEventListener('DOMContentLoaded', () => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    emit('nav', nav ? { responseStart: nav.responseStart, domContentLoaded: nav.domContentLoadedEventEnd, transferSize: nav.transferSize } : {});
  });

  // First branded paint: the text "Oz Radio" is rendered, then two animation frames later it has been painted.
  let branded = false;
  const checkBranded = () => {
    if (branded || !document.body || !/Oz Radio/i.test(document.body.innerText)) return;
    branded = true;
    emit('branded-text', { text: bodyText() });
    requestAnimationFrame(() => requestAnimationFrame(() => emit('branded-painted', { text: bodyText() })));
  };
  const brandedTimer = setInterval(() => { checkBranded(); if (branded) clearInterval(brandedTimer); }, 50);

  // First actionable CTA: visible, enabled, not behind another element, not inside a busy skeleton, unmoved for two polls.
  let previous: number[] | null = null;
  const ctaTimer = setInterval(() => {
    const el = document.querySelector<HTMLElement>(cfg.ctaSelector);
    if (!el) { previous = null; return; }
    const r = el.getBoundingClientRect();
    const inView = r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
    let visible = true;
    try { visible = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { /* an older engine */ }
    const enabled = !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && !el.closest('[aria-busy="true"]');
    let onTop = false;
    if (inView) {
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      onTop = !!hit && (hit === el || el.contains(hit));
    }
    const rect = [r.left, r.top, r.width, r.height].map(Math.round);
    const still = !!previous && previous.every((v, i) => Math.abs(v - rect[i]) <= 1);
    previous = rect;
    if (inView && visible && enabled && onTop && still) {
      clearInterval(ctaTimer);
      emit('cta-actionable', { label: (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 90), href: el.getAttribute('href'), testid: el.getAttribute('data-testid'), rect });
    }
  }, 100);
}

test.describe('cold path (opt-in)', () => {
  test.skip(!ENABLED, 'Opt-in: set OZ_RADIO_COLD_PATH=1 and run it against a replica verified to be scaled to zero.');
  // A retry would be a warm run: never retry.
  test.describe.configure({ retries: 0 });

  test('first branded paint (C1.1) and first actionable CTA (C1.2) from the portfolio link, on a phone', async ({ browser }, testInfo) => {
    test.setTimeout(CAP_MS + 120_000);
    const { defaultBrowserType: _browser, ...pixel7 } = devices['Pixel 7'];
    const context = await browser.newContext({ ...pixel7 });
    const events: ColdEvent[] = [];
    const ledger: string[] = [];
    const notes: string[] = [];
    const shots: Record<string, string> = {};
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      await context.addInitScript(GPC_INIT);
      await context.routeWebSocket(DEMO_SOCKET, (socket) => socket.close({ code: 4000, reason: 'blocked by the cold-path guard' }));
      await context.exposeBinding('__ozColdReport', (_source, event: ColdEvent) => { events.push(event); });
      await context.addInitScript(instrument, { ctaSelector: CTA_SELECTOR });
      const page = await context.newPage();
      const started = Date.now();
      page.on('requestfinished', (request) => {
        ledger.push(JSON.stringify({ t: Date.now() - started, method: request.method(), type: request.resourceType(), url: stripUrl(request.url()) }));
      });
      page.on('requestfailed', (request) => {
        ledger.push(JSON.stringify({ t: Date.now() - started, method: request.method(), type: request.resourceType(), url: stripUrl(request.url()), failed: request.failure()?.errorText ?? 'failed' }));
      });

      const shoot = async (label: string) => {
        if (shots[label]) return;
        const file = path.join(OUT_DIR, `cold-path-${label}.png`);
        try {
          await page.screenshot({ path: file, fullPage: false, timeout: 15_000 });
          shots[label] = path.basename(file);
        } catch (error) {
          notes.push(`screenshot ${label}: ${String(error).split('\n')[0]}`);
        }
      };

      // The click: nothing runs before this line, so the replica has not been touched by this spec.
      const navigation = page.goto(ENTRY_URL, { waitUntil: 'commit', timeout: CAP_MS }).catch((error) => { notes.push(`goto: ${String(error).split('\n')[0]}`); });
      let nextTick = 5000;
      while (Date.now() - started < CAP_MS) {
        if (events.some((e) => e.type === 'branded-painted')) await shoot('1-branded');
        if (events.some((e) => e.type === 'cta-actionable')) break;
        if (Date.now() - started >= nextTick) {
          await shoot(`waiting-${Math.round((Date.now() - started) / 1000)}s`);
          nextTick += 5000;
        }
        await sleep(100);
      }
      await shoot('2-actionable');
      // Let late layout shifts (a web font arriving) land before counting them.
      await sleep(3000);
      await shoot('3-settled');
      await navigation;

      const byTime = (a: ColdEvent, b: ColdEvent) => a.t - b.t;
      const firstBranded = events.filter((e) => e.type === 'branded-painted').sort(byTime)[0];
      const cta = events.filter((e) => e.type === 'cta-actionable').sort(byTime)[0];
      const ms = (event?: ColdEvent) => (event ? Math.round(event.t - started) : null);
      const brandedPaintMs = ms(firstBranded);
      const actionableCtaMs = ms(cta);
      const appOrigin = cta ? new URL(cta.url).origin : null;
      const appEvents = events.filter((e) => appOrigin !== null && new URL(e.url).origin === appOrigin);
      const appDoc = appEvents.filter((e) => e.type === 'doc').sort(byTime)[0];
      const appNav = appEvents.filter((e) => e.type === 'nav').sort(byTime)[0];
      const shifts = appEvents.filter((e) => e.type === 'ls' && !e.hadRecentInput);
      const lcp = appEvents.filter((e) => e.type === 'lcp').sort(byTime).pop();
      const result = {
        spec: 'tests/cold-path.spec.ts',
        measuredAt: new Date(started).toISOString(),
        entryUrl: stripUrl(ENTRY_URL),
        profile: 'Pixel 7 (Chromium emulation), no network throttling',
        guards: { globalPrivacyControl: true, demoSockets: 'answered locally and closed (4000)', warmUp: 'none', retries: 0 },
        limits: LIMITS,
        brandedPaintMs,
        actionableCtaMs,
        c11Pass: brandedPaintMs !== null && brandedPaintMs <= LIMITS.brandedPaintMs,
        c12Pass: actionableCtaMs !== null && actionableCtaMs <= LIMITS.actionableCtaMs,
        firstBrandedText: firstBranded?.text ?? null,
        actionableCta: cta ? { label: cta.label, href: cta.href, testid: cta.testid } : null,
        appDocumentStartMs: ms(appDoc),
        appServerWaitMs: appNav && appDoc ? Math.round(appDoc.t - started + Number(appNav.responseStart)) : null,
        appLcpMs: lcp ? Math.round(Number(lcp.start)) : null,
        appCls: Number(shifts.reduce((sum, e) => sum + Number(e.value), 0).toFixed(4)),
        documents: events.filter((e) => e.type === 'doc').sort(byTime).map((e) => ({ url: e.url, startMs: ms(e) })),
        screenshots: shots,
        notes,
        events: events.sort(byTime).slice(0, 400).map((e) => ({ ...e, t: Math.round(e.t - started) })),
      };
      fs.writeFileSync(path.join(OUT_DIR, 'cold-path.json'), `${JSON.stringify(result, null, 2)}\n`);
      fs.writeFileSync(path.join(OUT_DIR, 'cold-path-requests.jsonl'), `${ledger.join('\n')}\n`);
      await testInfo.attach('cold-path.json', { path: path.join(OUT_DIR, 'cold-path.json'), contentType: 'application/json' });
      testInfo.annotations.push({
        type: 'cold-path',
        description: `branded paint ${brandedPaintMs ?? 'never'} ms (limit ${LIMITS.brandedPaintMs}), actionable CTA ${actionableCtaMs ?? 'never'} ms (limit ${LIMITS.actionableCtaMs})`,
      });

      expect.soft(brandedPaintMs, 'C1.1: no branded paint was seen').not.toBeNull();
      expect.soft(brandedPaintMs ?? Number.POSITIVE_INFINITY, 'C1.1 branded paint ≤ 1 s after the click').toBeLessThanOrEqual(LIMITS.brandedPaintMs);
      expect.soft(actionableCtaMs, 'C1.2: the hero CTA never became actionable').not.toBeNull();
      expect.soft(actionableCtaMs ?? Number.POSITIVE_INFINITY, 'C1.2 actionable CTA ≤ 10 s after the click').toBeLessThanOrEqual(LIMITS.actionableCtaMs);
    } finally {
      await context.close();
    }
  });
});
