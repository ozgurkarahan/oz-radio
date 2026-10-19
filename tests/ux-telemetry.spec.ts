import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEMO_DECK_EN, DEMO_QA_CONFIG, MEDIA, MOCKED_MEDIA_REASON, bootPayload, fulfillMedia, mockApi, mockBoot, mockedMediaUnavailable,
  routeExpiredMedia,
} from './support/mock-api';
import { demoHooks, mockDemoSocket, refuseDemoHandshake, type DemoSocketMock, type DemoSocketOptions } from './support/demo-ws-fixtures';
import { BOOT_TELEMETRY_IKEY, BOOT_TELEMETRY_INGESTION, normalizeBoot, type BootTelemetry } from '../demos/frontend/src/services/boot';
import { DEMO_CLOSE_CODES as CLOSE } from '../demos/frontend/src/services/demoProtocol';
import {
  DEMO_OUTCOMES, DEMO_STAGES, FIRST_VALUE_KINDS, MEDIA_KINDS, TELEMETRY_FIELDS, TELEMETRY_ROUTES, UTM_KEYS, ownScriptFile, routeTemplate,
  sanitizeProps, type TelemetryEvent,
} from '../demos/frontend/src/services/telemetryVitals';
import { OPT_OUT_KEY } from '../demos/frontend/src/services/telemetry';

/**
 * WU-J — cookieless telemetry, shipped dark. Everything is mocked: the boot block says whether telemetry is on
 * (`mockBoot`), `navigator.sendBeacon` is stubbed to capture what the browser would send, and the ingestion host is
 * answered with 204 should a request reach the network.
 *
 *  - off (no boot block, `enabled:false`, an invalid block): nothing is observed or sent, no listener, no chunk is downloaded;
 *  - on but the visitor says no (Global Privacy Control, Do Not Track, the opt-out key, unreadable storage): the same silence;
 *  - on: the six events carry allow-listed fields only, rounded, as templates and domains — never a question, an error
 *    message, a URL or an identifier; one in-memory page-load id; no cookie, no storage.
 *
 * `events()` re-validates every captured payload against an independent oracle (the shapes below), so a field that
 * escapes the allow-list, or a value that is not rounded or not clean, fails whichever test happened to send it.
 */
test.describe.configure({ timeout: 90_000 });

const INGESTION = 'https://ingest.oz-radio.test';
const ENDPOINT = `${INGESTION}/v2/track`;
const IKEY = '11111111-2222-4333-8444-555555555555';
const ON: BootTelemetry = { enabled: true, ingestion: INGESTION, ikey: IKEY, server_cold: false };
const VITALS_CHUNK = /\/src\/services\/telemetryVitals\.ts/;
const demoSource = { catalog: 'demo' as const, demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 };
const DECK_PATH = '/decks/deck-demo-en/present';
const SECRET = 'my-secret-question-about-jane.doe@example.com';

// ── Capture ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface BeaconCall { url: string; body: string; /** `performance.now()` when the page called sendBeacon. */ at: number }
interface Ev { name: TelemetryEvent; props: Record<string, string>; operationId: string; operationName: string }

/** The independent oracle: what a serialized value of each field must look like. */
const SERIALIZED: Record<string, (value: string) => boolean> = {
  ms: (v) => /^\d+$/.test(v) && Number(v) % 10 === 0,
  seconds: (v) => /^\d+$/.test(v),
  count: (v) => /^\d{1,2}$/.test(v),
  cls: (v) => /^\d+(\.\d{1,2})?$/.test(v),
  bool: (v) => v === 'true' || v === 'false',
  code: (v) => /^\d{1,4}$/.test(v),
  route: (v) => TELEMETRY_ROUTES.includes(v),
  domain: (v) => /^[a-z0-9.-]{4,100}$/.test(v) && v.includes('.') && !/^\d+(\.\d+){3}$/.test(v),
  campaign: (v) => /^[A-Za-z0-9._~+ -]{1,100}$/.test(v),
  errorName: (v) => /^[A-Za-z][A-Za-z0-9_$]{0,39}$/.test(v),
  frame: (v) => /^[A-Za-z0-9._-]{1,80}:\d{1,7}$/.test(v),
};

function parseCall(call: BeaconCall): Ev {
  expect(call.url).toBe(ENDPOINT);
  const items = JSON.parse(call.body);
  expect(items, 'one item per beacon').toHaveLength(1);
  const [envelope] = items;
  expect(Object.keys(envelope).sort()).toEqual(['data', 'iKey', 'name', 'tags', 'time']);
  expect(envelope.iKey).toBe(IKEY);
  expect(envelope.name).toBe(`Microsoft.ApplicationInsights.${IKEY.replace(/-/g, '')}.Event`);
  expect(envelope.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // Nothing that identifies a visitor, a device or a session: four constant or in-memory tags, no ai.user.* / ai.session.* / ai.device.*
  expect(Object.keys(envelope.tags).sort()).toEqual(['ai.cloud.role', 'ai.internal.sdkVersion', 'ai.operation.id', 'ai.operation.name']);
  expect(envelope.tags['ai.cloud.role']).toBe('oz-radio');
  expect(envelope.tags['ai.operation.id']).toMatch(/^[0-9a-f]{16}$/);
  expect(TELEMETRY_ROUTES).toContain(envelope.tags['ai.operation.name']);
  expect(envelope.data.baseType).toBe('EventData');
  expect(Object.keys(envelope.data.baseData).sort()).toEqual(['name', 'properties', 'ver']);
  const name = envelope.data.baseData.name as TelemetryEvent;
  const fields = TELEMETRY_FIELDS[name];
  expect(fields, `${name} is one of the six events`).toBeTruthy();
  const props = envelope.data.baseData.properties as Record<string, string>;
  expect(Object.keys(props).length, `${name} sends something`).toBeGreaterThan(0);
  for (const [key, value] of Object.entries(props)) {
    const shape = fields[key];
    expect(shape, `${name}.${key} is allow-listed`).toBeTruthy();
    expect(typeof value, `${name}.${key} is a string`).toBe('string');
    const ok = typeof shape === 'string' ? SERIALIZED[shape](value) : shape.includes(value);
    expect(ok, `${name}.${key}=${JSON.stringify(value)} has the shape ${JSON.stringify(shape)}`).toBe(true);
  }
  return { name, props, operationId: envelope.tags['ai.operation.id'], operationName: envelope.tags['ai.operation.name'] };
}

interface Watch {
  /** Every URL the page requested. */
  requests: string[];
  /** Every call of `navigator.sendBeacon`, whatever the destination. */
  calls(): Promise<BeaconCall[]>;
  /** The captured events, each one validated against the oracle. */
  events(): Promise<Ev[]>;
  named(name: TelemetryEvent): Promise<Ev[]>;
  /** The page is hidden (`pagehide`): pending events are flushed. */
  hide(): Promise<void>;
  /** Everything that was sent, as one string, for "never appears" assertions. */
  raw(): Promise<string>;
  /** Waits for the first event with this name. */
  next(name: TelemetryEvent, timeout?: number): Promise<Ev>;
}

/** Stubs `navigator.sendBeacon` (it records and succeeds) and answers the ingestion host with 204. Call before `goto`. */
async function watch(page: Page): Promise<Watch> {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route(`${INGESTION}/**`, (route) => route.fulfill({ status: 204, body: '' }));
  await page.addInitScript(() => {
    const w = window as unknown as { __beacons: { url: string; body: string; at: number }[] };
    w.__beacons = [];
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      w.__beacons.push({ url: String(url), body: typeof data === 'string' ? data : `<${typeof data}>`, at: performance.now() });
      return true;
    };
  });
  const calls = () => page.evaluate(() => (window as unknown as { __beacons?: BeaconCall[] }).__beacons ?? []);
  const events = async () => (await calls()).map(parseCall);
  const named = async (name: TelemetryEvent) => (await events()).filter((e) => e.name === name);
  return {
    requests,
    calls,
    events,
    named,
    hide: () => page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); }),
    raw: async () => (await calls()).map((c) => c.body).join('\n'),
    next: async (name, timeout = 20_000) => {
      await expect.poll(async () => (await named(name)).length, { timeout }).toBeGreaterThan(0);
      return (await named(name))[0];
    },
  };
}

/** Telemetry is off, or the visitor said no: nothing was sent and nothing extra was downloaded or listened to. */
async function expectSilence(page: Page, w: Watch) {
  expect(await w.calls(), 'no sendBeacon call at all').toEqual([]);
  expect(w.requests.filter((u) => u.startsWith(INGESTION)), 'no request to the ingestion host').toEqual([]);
  expect(w.requests.filter((u) => VITALS_CHUNK.test(u)), 'the observers chunk is never downloaded').toEqual([]);
  await w.hide();
  await page.waitForTimeout(300);
  expect(await w.calls(), 'not even when the page is hidden').toEqual([]);
}

/** Home with a boot block, the Home route and the shell rendered. */
async function openHome(page: Page, path = '/', telemetry: BootTelemetry | 'absent' = ON, goto: Parameters<Page['goto']>[1] = {}) {
  const w = await watch(page);
  await mockApi(page, 'visitor');
  await mockBoot(page, telemetry === 'absent' ? 'absent' : { telemetry });
  await page.goto(path, goto);
  await expect(page.locator('#main h1').first()).toBeVisible();
  return w;
}

async function noCookiesOrStorage(page: Page) {
  expect(await page.context().cookies(), 'no cookie').toEqual([]);
  const storage = await page.evaluate(() => ({
    cookie: document.cookie,
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
  }));
  expect(storage.cookie).toBe('');
  for (const key of [...storage.local, ...storage.session]) expect(key, 'telemetry stores nothing').not.toMatch(/telemetry|analytics|insights|ai[._-]?(user|session)|oz_|beacon/i);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Part A — the contract, in Node
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('contract (node)', () => {
  test('the six events and their exact field lists', () => {
    expect(Object.keys(TELEMETRY_FIELDS)).toEqual(['oz_load', 'oz_vitals', 'oz_first_value', 'oz_demo', 'oz_media_error', 'oz_ui_error']);
    expect(Object.keys(TELEMETRY_FIELDS.oz_load)).toEqual([
      'route', 'referrer', ...UTM_KEYS, 'ttfb_ms', 'first_cta_ms', 'cta_changed', 'server_cold',
    ]);
    expect(Object.keys(TELEMETRY_FIELDS.oz_vitals)).toEqual(['lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms']);
    expect(Object.keys(TELEMETRY_FIELDS.oz_first_value)).toEqual(['kind', 'ms_from_nav', 'ms_from_tap', 'taps_since_load']);
    expect(Object.keys(TELEMETRY_FIELDS.oz_demo)).toEqual([
      'stage_reached', 'close_code', 'outcome', 'ice_gather_ms', 'ms_to_first_word', 'questions', 'idle_tail_s',
    ]);
    expect(Object.keys(TELEMETRY_FIELDS.oz_media_error)).toEqual(['kind', 'media_error_code', 'recovered', 'route']);
    expect(Object.keys(TELEMETRY_FIELDS.oz_ui_error)).toEqual(['error_name', 'frame', 'route']);
    expect([...DEMO_STAGES]).toEqual(['tap', 'ws_open', 'rtc_connected', 'first_word', 'complete']);
    expect([...DEMO_OUTCOMES]).toEqual(['cap', 'stop', 'error', 'busy', 'limit', 'blocked', 'network']);
    expect([...FIRST_VALUE_KINDS]).toEqual(['audio', 'video', 'avatar']);
    expect([...MEDIA_KINDS]).toEqual(['audio', 'video']);
  });

  test('no field accepts a sentence, an e-mail address, a URL, a path, markup or an object', () => {
    const probes: unknown[] = [
      'What is the revenue of ACME, Inc.? (my question)', 'jane.doe@example.com', 'https://example.com/private?token=1', '/decks/abc/present?x=1',
      'at Object.run (https://example.com/a.js:1:2)', '<img src=x onerror=alert(1)>', '{"message":"secret"}', 'a'.repeat(300),
      { message: 'secret' }, ['audio'], new Error('secret'), () => 'secret', Symbol('secret'),
    ];
    for (const [event, fields] of Object.entries(TELEMETRY_FIELDS)) {
      for (const key of Object.keys(fields)) {
        for (const probe of probes) {
          expect(sanitizeProps(event as TelemetryEvent, { [key]: probe }), `${event}.${key} accepted ${String(typeof probe)}`).toEqual({});
        }
      }
    }
  });

  test('sanitizeProps keeps allow-listed keys only, rounded and as clean strings', () => {
    expect(sanitizeProps('oz_load', {
      route: '/', referrer: 'www.example.com', ttfb_ms: 123.4, first_cta_ms: 1250, cta_changed: false, server_cold: true,
      utm_source: 'linkedin', message: 'free text', email: 'a@b.com', __proto__: { route: 'x' }, constructor: 'x',
    })).toEqual({
      route: '/', referrer: 'www.example.com', ttfb_ms: '120', first_cta_ms: '1250', cta_changed: 'false', server_cold: 'true', utm_source: 'linkedin',
    });
    expect(sanitizeProps('oz_vitals', { lcp_ms: 2304, cls: 0.054, inp_ms: 96.5, fcp_ms: 901, ttfb_ms: 55 })).toEqual({
      lcp_ms: '2300', cls: '0.05', inp_ms: '100', fcp_ms: '900', ttfb_ms: '60',
    });
    expect(sanitizeProps('oz_vitals', { cls: 0.056 }).cls).toBe('0.06');
    expect(sanitizeProps('oz_vitals', { cls: 0 }).cls).toBe('0');
    expect(sanitizeProps('oz_first_value', { kind: 'audio', ms_from_nav: 4321, ms_from_tap: 87, taps_since_load: 250 })).toEqual({
      kind: 'audio', ms_from_nav: '4320', ms_from_tap: '90', taps_since_load: '99',
    });
    expect(sanitizeProps('oz_demo', {
      stage_reached: 'first_word', close_code: 4408, outcome: 'cap', ice_gather_ms: 604, ms_to_first_word: 3849, questions: 2, idle_tail_s: 12.6,
    })).toEqual({
      stage_reached: 'first_word', close_code: '4408', outcome: 'cap', ice_gather_ms: '600', ms_to_first_word: '3850', questions: '2', idle_tail_s: '13',
    });
    expect(sanitizeProps('oz_media_error', { kind: 'video', media_error_code: 0, recovered: true, route: '/video/library' })).toEqual({
      kind: 'video', media_error_code: '0', recovered: 'true', route: '/video/library',
    });
    expect(sanitizeProps('oz_ui_error', { error_name: 'TypeError', frame: 'index-ab12.js:1', route: '/decks/:id/present' })).toEqual({
      error_name: 'TypeError', frame: 'index-ab12.js:1', route: '/decks/:id/present',
    });
    expect(sanitizeProps('oz_load', {})).toEqual({});
    expect(sanitizeProps('nope' as TelemetryEvent, { a: 1 })).toEqual({});
  });

  test('sanitizeProps drops everything that is not the right shape', () => {
    const drops: [TelemetryEvent, string, unknown][] = [
      // numbers
      ['oz_vitals', 'lcp_ms', Number.NaN], ['oz_vitals', 'lcp_ms', Number.POSITIVE_INFINITY], ['oz_vitals', 'lcp_ms', -1],
      ['oz_vitals', 'lcp_ms', 3_600_001], ['oz_vitals', 'lcp_ms', '1200'], ['oz_vitals', 'lcp_ms', true], ['oz_vitals', 'lcp_ms', { v: 1 }],
      ['oz_vitals', 'cls', 101], ['oz_vitals', 'cls', '0.1'], ['oz_demo', 'close_code', 12_345], ['oz_demo', 'close_code', 1006.5],
      ['oz_demo', 'close_code', -1], ['oz_demo', 'questions', 'two'], ['oz_demo', 'idle_tail_s', Number.NaN],
      // booleans
      ['oz_load', 'cta_changed', 'false'], ['oz_load', 'server_cold', 0], ['oz_media_error', 'recovered', 'true'],
      // closed vocabularies
      ['oz_first_value', 'kind', 'Audio'], ['oz_first_value', 'kind', 'audio '], ['oz_first_value', 'kind', 'podcast'],
      ['oz_demo', 'stage_reached', 'done'], ['oz_demo', 'outcome', 'timeout'], ['oz_media_error', 'kind', 'avatar'],
      // routes: only templates, never a raw path
      ['oz_load', 'route', '/decks/6f1d2c3e-1111-2222-3333-444455556666/present'], ['oz_load', 'route', '/decks/:deckId/present'],
      ['oz_media_error', 'route', '/podcast/library?episode=pod-2'], ['oz_ui_error', 'route', 'https://app.example.com/'],
      // referrer: a bare domain
      ['oz_load', 'referrer', 'https://www.linkedin.com/feed/'], ['oz_load', 'referrer', 'www.linkedin.com:8080'], ['oz_load', 'referrer', 'localhost'],
      ['oz_load', 'referrer', '192.168.0.12'], ['oz_load', 'referrer', 'user@example.com'], ['oz_load', 'referrer', 'EXAMPLE.com'],
      // campaign values: plain words only
      ['oz_load', 'utm_content', 'a@b.com'], ['oz_load', 'utm_term', 'x'.repeat(101)], ['oz_load', 'utm_source', 'line\nbreak'],
      ['oz_load', 'utm_campaign', '<script>'], ['oz_load', 'utm_medium', 'ünï'], ['oz_load', 'utm_source', ''],
      // error identity: a name and a file:line, never a message
      ['oz_ui_error', 'error_name', 'Error: boom'], ['oz_ui_error', 'error_name', 'a b'], ['oz_ui_error', 'error_name', '1Error'],
      ['oz_ui_error', 'error_name', 'x'.repeat(41)],
      ['oz_ui_error', 'frame', 'https://app.example.com/assets/a.js:1'], ['oz_ui_error', 'frame', 'a.js'], ['oz_ui_error', 'frame', 'a.js:1:2'],
      ['oz_ui_error', 'frame', '../a.js:1'], ['oz_ui_error', 'frame', 'a b.js:1'], ['oz_ui_error', 'frame', 'a.js:12345678'],
    ];
    for (const [event, key, value] of drops) {
      expect(sanitizeProps(event, { [key]: value }), `${event}.${key}=${String(value).slice(0, 30)}`).toEqual({});
    }
  });

  test('ownScriptFile: only a script file of the app itself (origin and path), never the page or another site', () => {
    const origin = 'https://app.example';
    const page = '/playlists/0f8e5c1a-2b3c-4d5e-8f90-123456789abc';
    expect(ownScriptFile(`${origin}/assets/index-ab12.js`, origin, page)).toBe('index-ab12.js');
    expect(ownScriptFile(`${origin}/assets/vendor-x9.mjs?v=1`, origin, page)).toBe('vendor-x9.mjs');
    expect(ownScriptFile(`${origin}/src/pages/PlaylistPlayerPage.tsx?t=1`, origin, page)).toBe('PlaylistPlayerPage.tsx');
    expect(ownScriptFile(`${origin}/node_modules/.vite/deps/react-dom_client.js?v=abc`, origin, page)).toBe('react-dom_client.js');
    for (const url of [
      `${origin}${page}`, `${origin}${page}?q=secret`,                        // the page itself: an inline script
      `${origin}/playlists/0f8e5c1a-2b3c-4d5e-8f90-123456789abc`,            // a page path, even when it is not the current one
      `${origin}/boom.js`, `${origin}/x/secret.js`, `${origin}/assets/`,     // not where the app's scripts live
      `${origin}/assets/a b.js`, `${origin}/assets/${'a'.repeat(81)}.js`, `${origin}/assets/data.json`,
      'https://evil.example/assets/index-ab12.js', 'chrome-extension://abc/assets/x.js', 'not a url', '',
    ]) {
      expect(ownScriptFile(url, origin, page), url).toBeNull();
    }
    expect(ownScriptFile(`${origin}/assets/index-ab12.js`, origin, '/assets/index-ab12.js')).toBeNull();
  });

  test('routeTemplate: every route of the app has a template, ids never survive, everything else is "other"', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'demos', 'frontend', 'src', 'main.tsx'), 'utf8');
    const paths = [...main.matchAll(/lazyRoute\('([^']+)'/g)].map((m) => m[1]);
    expect(paths.length, 'the routes of main.tsx were found').toBeGreaterThanOrEqual(10);
    for (const route of paths) {
      const concrete = route.replace(/:\w+/g, 'a1b2c3-secret');
      const template = routeTemplate(concrete);
      expect(template, route).toBe(route.replace(/:\w+/g, ':id'));
      expect(template).not.toContain('secret');
      expect(TELEMETRY_ROUTES).toContain(template);
    }
    expect(routeTemplate('/')).toBe('/');
    expect(routeTemplate('/index.html')).toBe('/');
    expect(routeTemplate('/decks/')).toBe('/decks');
    expect(routeTemplate('/decks/6f1d2c3e/present')).toBe('/decks/:id/present');
    expect(routeTemplate('/playlists/pl-1')).toBe('/playlists/:id');
    for (const other of ['/foo', '/admin', '/decks/a/b/present', '/decks/a/other', '/podcast/library/x', '/search/x', '//evil.example.com', '/decks//present', '/%2e%2e']) {
      expect(routeTemplate(other), other).toBe('other');
    }
  });

  test('the boot block parser: off unless enabled with a valid https ingestion origin and a GUID key', () => {
    const good = bootPayload({}, {});
    const parse = (telemetry: unknown) => normalizeBoot({ ...good, telemetry })?.telemetry;
    expect(parse(undefined)).toEqual({ enabled: false });
    expect(parse(null)).toEqual({ enabled: false });
    expect(parse({ enabled: false })).toEqual({ enabled: false });
    expect(parse({ enabled: false, ingestion: INGESTION, ikey: IKEY, server_cold: true }), 'off carries nothing else').toEqual({ enabled: false });
    expect(parse({ enabled: true, ingestion: INGESTION, ikey: IKEY })).toEqual({ enabled: true, ingestion: INGESTION, ikey: IKEY, server_cold: false });
    expect(parse({ enabled: true, ingestion: INGESTION, ikey: IKEY, server_cold: true })).toEqual({ enabled: true, ingestion: INGESTION, ikey: IKEY, server_cold: true });
    expect(parse({ enabled: true, ingestion: INGESTION, ikey: IKEY.toUpperCase(), server_cold: 'true' })).toMatchObject({ enabled: true, server_cold: false });
    expect(parse({ enabled: true, ingestion: INGESTION, ikey: IKEY, extra: '<script>' })).toEqual({ enabled: true, ingestion: INGESTION, ikey: IKEY, server_cold: false });
    const off = { enabled: false };
    for (const bad of [
      { enabled: 'true', ingestion: INGESTION, ikey: IKEY }, { enabled: 1, ingestion: INGESTION, ikey: IKEY },
      { enabled: true }, { enabled: true, ingestion: INGESTION }, { enabled: true, ikey: IKEY },
      { enabled: true, ingestion: 'http://ingest.oz-radio.test', ikey: IKEY },
      { enabled: true, ingestion: 'https://ingest.oz-radio.test/', ikey: IKEY },
      { enabled: true, ingestion: 'https://ingest.oz-radio.test/v2/track', ikey: IKEY },
      { enabled: true, ingestion: 'https://ingest.oz-radio.test:8443', ikey: IKEY },
      { enabled: true, ingestion: 'https://user:pw@ingest.oz-radio.test', ikey: IKEY },
      { enabled: true, ingestion: 'https://ingest.oz-radio.test?x=1', ikey: IKEY },
      { enabled: true, ingestion: 'https://Ingest.Oz-Radio.test', ikey: IKEY },
      { enabled: true, ingestion: 'https://203.0.113.7', ikey: IKEY }, { enabled: true, ingestion: 'https://localhost', ikey: IKEY },
      { enabled: true, ingestion: 'https://intranet', ikey: IKEY }, { enabled: true, ingestion: 'javascript:alert(1)', ikey: IKEY },
      { enabled: true, ingestion: 'https://</script>.example.com', ikey: IKEY },
      { enabled: true, ingestion: 42, ikey: IKEY }, { enabled: true, ingestion: INGESTION, ikey: 42 },
      { enabled: true, ingestion: INGESTION, ikey: 'not-a-guid' }, { enabled: true, ingestion: INGESTION, ikey: `{${IKEY}}` },
      { enabled: true, ingestion: INGESTION, ikey: `${IKEY}0` }, { enabled: true, ingestion: INGESTION, ikey: `${IKEY}</script>` },
    ]) {
      expect(parse(bad), JSON.stringify(bad)).toEqual(off);
    }
    // the patterns themselves
    expect(BOOT_TELEMETRY_INGESTION.test('https://swedencentral-0.in.applicationinsights.azure.com')).toBe(true);
    expect(BOOT_TELEMETRY_IKEY.test('9826f519-9441-42e8-8f60-17224f150fce')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Part B — off: nothing is observed, sent or downloaded
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('off by default', () => {
  test('no boot block: nothing is sent and the observers chunk is never requested', async ({ page }) => {
    const w = await openHome(page, '/', 'absent');
    await page.getByRole('link', { name: 'Listen to an episode' }).first().click();
    await expect(page).toHaveURL(/\/podcast\/library/);
    await expectSilence(page, w);
    await noCookiesOrStorage(page);
  });

  test('the boot block says enabled:false: the same silence', async ({ page }) => {
    const w = await openHome(page, '/', { enabled: false });
    await expectSilence(page, w);
  });

  test('a fail-closed boot block (ok:false) is off too', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor');
    await mockBoot(page, 'fallback');
    await page.goto('/');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await expectSilence(page, w);
  });

  for (const [name, bad] of [
    ['enabled without an endpoint or a key', { enabled: true }],
    ['an http endpoint', { enabled: true, ingestion: 'http://ingest.oz-radio.test', ikey: IKEY }],
    ['an endpoint with a path', { enabled: true, ingestion: `${INGESTION}/v2/track`, ikey: IKEY }],
    ['a key that is not a GUID', { enabled: true, ingestion: INGESTION, ikey: 'nope' }],
    ['"true" as a string', { enabled: 'true', ingestion: INGESTION, ikey: IKEY }],
  ] as [string, unknown][]) {
    test(`an invalid enabled block (${name}) reads as off`, async ({ page }) => {
      const w = await openHome(page, '/', bad as BootTelemetry);
      await expectSilence(page, w);
    });
  }

  test('off, the demo works as before and sends nothing (every demo path)', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor', demoSource);
    const mock = await mockDemoSocket(page, { slideCount: DEMO_DECK_EN.slide_count, sessionSeconds: 300, idleCloseMs: false, onOpen: { close: CLOSE.BUSY } });
    await mockBoot(page, { telemetry: { enabled: false } }, demoSource);
    await page.goto(DECK_PATH);
    await page.getByTestId('demo-start').click();
    await expect.poll(() => mock.connections).toBe(1);
    await expect(page.getByTestId('demo-outcome')).toBeVisible();
    await expectSilence(page, w);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Part C — on, but the visitor says no
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('the visitor says no', () => {
  test('Global Privacy Control', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true }));
    const w = await openHome(page);
    await expectSilence(page, w);
    await noCookiesOrStorage(page);
  });

  for (const value of ['1', 'yes']) {
    test(`Do Not Track (${value})`, async ({ page }) => {
      await page.addInitScript((v) => Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => v, configurable: true }), value);
      const w = await openHome(page);
      await expectSilence(page, w);
    });
  }

  test('Do Not Track on the window object (older browsers)', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'doNotTrack', { value: '1', configurable: true }));
    const w = await openHome(page);
    await expectSilence(page, w);
  });

  test('the opt-out key in localStorage', async ({ page }) => {
    await page.addInitScript((key) => localStorage.setItem(key, '1'), OPT_OUT_KEY);
    const w = await openHome(page);
    await expectSilence(page, w);
  });

  test('storage that cannot be read stays on the safe side: opted out', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
    });
    const w = await openHome(page);
    await expectSilence(page, w);
  });

  test('an opt-out made after the page loaded (another tab) stops what has not been sent yet', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await page.evaluate((key) => localStorage.setItem(key, '1'), OPT_OUT_KEY);
    await w.hide();
    await page.waitForTimeout(300);
    expect((await w.events()).map((e) => e.name), 'no oz_vitals after the opt-out').toEqual(['oz_load']);
  });

  test('Do Not Track "0", the opt-out key "0" and an unrelated key do not block telemetry', async ({ page }) => {
    await page.addInitScript((key) => {
      Object.defineProperty(Navigator.prototype, 'doNotTrack', { get: () => '0', configurable: true });
      localStorage.setItem(key, '0');
      localStorage.setItem('site-analytics', '1');
    }, OPT_OUT_KEY);
    const w = await openHome(page);
    await w.next('oz_load');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Part D — on: the six events
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('oz_load', () => {
  test('Home: route template, referrer domain, the UTM allow-list, ttfb, first call to action, cta_changed false, server_cold', async ({ page }) => {
    const w = await openHome(
      page,
      '/?utm_source=linkedin&utm_medium=social&utm_campaign=spring_2026&utm_content=jane.doe@example.com&utm_term=%3Cscript%3E&foo=bar&email=me@example.com&token=abc123',
      { ...ON, server_cold: true },
      { referer: 'https://www.linkedin.com/feed/update/urn:li:activity:7654321?trk=secret-tracking-id' },
    );
    const load = await w.next('oz_load');
    expect(load.props).toMatchObject({
      route: '/', referrer: 'www.linkedin.com', utm_source: 'linkedin', utm_medium: 'social', utm_campaign: 'spring_2026',
      cta_changed: 'false', server_cold: 'true',
    });
    expect(Number(load.props.ttfb_ms), 'time to first byte').toBeGreaterThan(0);
    expect(Number(load.props.first_cta_ms), 'the call to action is shown in its final form').toBeGreaterThan(0);
    // Other UTM keys and values with anything but plain words, other query keys and the referrer's path never leave
    expect(Object.keys(load.props).filter((k) => k.startsWith('utm_')).sort()).toEqual(['utm_campaign', 'utm_medium', 'utm_source']);
    const raw = await w.raw();
    for (const secret of ['jane.doe', 'example.com', '<script>', 'foo', 'token', 'abc123', 'secret-tracking-id', 'urn:li', '/feed', 'update']) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(w.requests.filter((u) => u.startsWith(INGESTION)), 'sendBeacon is the transport, not a request of the page').toEqual([]);
    expect((await w.named('oz_load')), 'once per page load').toHaveLength(1);
    await noCookiesOrStorage(page);
  });

  test('Home without a referrer, campaign or server cold start: only what is known', async ({ page }) => {
    const w = await openHome(page);
    const load = await w.next('oz_load');
    expect(Object.keys(load.props).sort()).toEqual(['cta_changed', 'first_cta_ms', 'route', 'server_cold', 'ttfb_ms']);
    expect(load.props.server_cold).toBe('false');
  });

  test('a same-site referrer is not a referrer', async ({ page }) => {
    const w = await openHome(page, '/', ON, { referer: 'http://127.0.0.1:5180/decks' });
    const load = await w.next('oz_load');
    expect(load.props.referrer).toBeUndefined();
  });

  test('other routes report their template at once and have no call-to-action fields', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor', demoSource);
    await mockBoot(page, { telemetry: ON }, demoSource);
    await page.goto('/decks/deck-demo-en/present');
    const load = await w.next('oz_load');
    expect(load.props.route).toBe('/decks/:id/present');
    expect(load.operationName).toBe('/decks/:id/present');
    expect(load.props.first_cta_ms).toBeUndefined();
    expect(load.props.cta_changed).toBeUndefined();
    expect(await w.raw()).not.toContain('deck-demo-en');
  });

  test('an unknown path is "other": the path never leaves', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor');
    await mockBoot(page, { telemetry: ON });
    await page.goto('/private/customer-name-secret-z42z?utm_source=x');
    const load = await w.next('oz_load');
    expect(load.props.route).toBe('other');
    expect(load.operationName).toBe('other');
    // `z42z`, not a bare number: digits occur by chance in the random page-load id, the timestamp and the timings.
    expect(await w.raw()).not.toMatch(/private|customer|secret|z42z/);
  });
});

test.describe('oz_vitals', () => {
  test('once, when the page is first hidden: allow-listed numbers, rounded', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    expect(w.requests.filter((u) => VITALS_CHUNK.test(u)), 'the observers are a separate chunk, downloaded once').toHaveLength(1);
    await expect.poll(async () => page.evaluate(() => performance.getEntriesByType('paint').length)).toBeGreaterThan(0);
    await w.hide();
    const vitals = await w.next('oz_vitals');
    expect(Object.keys(vitals.props).every((k) => ['lcp_ms', 'cls', 'inp_ms', 'fcp_ms', 'ttfb_ms'].includes(k))).toBe(true);
    expect(Object.keys(vitals.props).length).toBeGreaterThan(0);
    // a second hide (tab switch) is not a second report
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('pagehide'));
    });
    await page.waitForTimeout(300);
    expect(await w.named('oz_vitals')).toHaveLength(1);
  });

  test('visibilitychange to hidden reports too', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await w.next('oz_vitals');
  });
});

test.describe('oz_first_value', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('audio: the first audible sound, with the time from the tap and the number of taps — once', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await mockBoot(page, { telemetry: ON });
    await page.goto('/podcast/library');
    await page.getByTestId('library-item').filter({ hasText: 'Agents on air' }).getByRole('button', { name: 'Listen to Agents on air' }).click();
    const player = page.getByRole('dialog').getByTestId('radio-player');
    await expect(player).toHaveAttribute('data-state', 'playing');
    const first = await w.next('oz_first_value');
    expect(first.props.kind).toBe('audio');
    expect(Number(first.props.taps_since_load)).toBeGreaterThanOrEqual(1);
    expect(Number(first.props.ms_from_tap)).toBeGreaterThanOrEqual(0);
    expect(Number(first.props.ms_from_tap)).toBeLessThanOrEqual(Number(first.props.ms_from_nav));
    // pausing and playing again is not a new "first value"
    const audio = page.getByTestId('radio-audio');
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0.4);
    await player.getByTestId('radio-play').click();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
    await player.getByTestId('radio-play').click();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
    await page.waitForTimeout(300);
    expect(await w.named('oz_first_value')).toHaveLength(1);
    expect(await w.named('oz_media_error')).toHaveLength(0);
  });

  test('video: the first frame playing', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor');
    await page.route('**/media/vid-1.mp4', (route) => fulfillMedia(route, MEDIA.mp4));
    await mockBoot(page, { telemetry: ON });
    await page.goto('/video/library');
    await page.getByTestId('library-item').first().getByRole('button', { name: /^Play / }).click();
    await expect.poll(() => page.getByTestId('library-player').evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2 && v.currentTime > 0), { timeout: 30_000 }).toBe(true);
    const first = await w.next('oz_first_value');
    expect(first.props.kind).toBe('video');
    expect(Number(first.props.taps_since_load)).toBeGreaterThanOrEqual(1);
    expect(Number(first.props.ms_from_tap)).toBeGreaterThanOrEqual(0);
  });
});

test.describe('oz_media_error', () => {
  test.skip(mockedMediaUnavailable, MOCKED_MEDIA_REASON);

  test('an expired link that cannot be renewed: kind, error code, recovered false, the route — flushed when the page is hidden', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await routeExpiredMedia(page, '**/media/pod-2.mp3');
    await mockBoot(page, { telemetry: ON });
    await page.goto('/podcast/library');
    await page.getByTestId('library-item').filter({ hasText: 'Agents on air' }).getByRole('button', { name: 'Listen to Agents on air' }).click();
    await expect(page.getByRole('dialog').getByTestId('radio-player')).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
    await w.hide();
    const error = await w.next('oz_media_error');
    expect(error.props.kind).toBe('audio');
    expect(['2', '3', '4']).toContain(error.props.media_error_code);
    expect(error.props.recovered).toBe('false');
    expect(error.props.route).toBe('/podcast/library');
    expect(await w.named('oz_first_value'), 'no sound was ever heard').toHaveLength(0);
    expect(await w.raw()).not.toMatch(/AuthenticationFailed|pod-2|expired/i);
  });

  test('a link that is renewed: recovered true, reported as soon as it plays again', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await routeExpiredMedia(page, '**/media/pod-2.mp3', { times: 1 });
    await mockBoot(page, { telemetry: ON });
    await page.goto('/podcast/library');
    await page.getByTestId('library-item').filter({ hasText: 'Agents on air' }).getByRole('button', { name: 'Listen to Agents on air' }).click();
    await expect(page.getByRole('dialog').getByTestId('radio-player')).toHaveAttribute('data-state', 'playing', { timeout: 30_000 });
    const error = await w.next('oz_media_error');
    expect(error.props.recovered).toBe('true');
    expect(error.props.kind).toBe('audio');
    expect(['2', '3', '4']).toContain(error.props.media_error_code);
    expect((await w.next('oz_first_value')).props.kind).toBe('audio');
  });

  test('a stall of more than 8 s while playing is reported with code 0, and recovered false when it does not end', async ({ page }) => {
    await page.clock.install();
    const w = await watch(page);
    await mockApi(page, 'visitor', { podcastV2: true });
    await mockBoot(page, { telemetry: ON });
    await page.goto('/podcast/library');
    await page.getByTestId('library-item').filter({ hasText: 'Agents on air' }).getByRole('button', { name: 'Listen to Agents on air' }).click();
    const player = page.getByRole('dialog').getByTestId('radio-player');
    await expect(player).toHaveAttribute('data-state', 'playing');
    // The element reports buffering that never ends.
    await page.evaluate(() => {
      const audio = document.querySelector('[data-testid="radio-audio"]') as HTMLAudioElement;
      Object.defineProperty(audio, 'readyState', { configurable: true, get: () => 1 });
      audio.dispatchEvent(new Event('waiting'));
    });
    await page.clock.runFor(7000);
    expect(await w.named('oz_media_error'), 'not yet: 8 s').toHaveLength(0);
    await page.clock.runFor(1500); // the stall is now an incident
    await page.clock.runFor(10_500); // and it did not recover
    const stall = await w.next('oz_media_error');
    expect(stall.props).toMatchObject({ kind: 'audio', media_error_code: '0', recovered: 'false', route: '/podcast/library' });
  });
});

test.describe('oz_ui_error', () => {
  /** A script of this site's own: same origin and a built-chunk path, so its frame counts as ours. */
  async function serveScript(page: Page, file: string, body: string) {
    await page.route(`**/assets/${file}`, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body }));
  }
  const inject = (page: Page, file: string) => page.evaluate((src) => {
    const script = document.createElement('script');
    script.src = src;
    document.head.appendChild(script);
  }, `/assets/${file}`);

  test('a render crash caught by the route boundary: the error name, a file:line and the route — never the message', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'admin', demoSource);
    await mockBoot(page, { telemetry: ON }, demoSource);
    await page.route('**/api/playlists/pl-1', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playlist_id: 'pl-1', title: { text: 'unexpected-shape-secret' }, description: '', steps: [] }),
    }));
    await page.goto('/playlists/pl-1');
    await expect(page.getByTestId('route-crash')).toBeVisible();
    const error = await w.next('oz_ui_error');
    expect(error.props.error_name).toMatch(/^(Error|[A-Z][A-Za-z]*Error)$/); // what React or the page threw: only its name is sent
    expect(error.props.frame).toMatch(/^[\w.-]+:\d+$/);
    expect(error.props.route).toBe('/playlists/:id');
    const raw = await w.raw();
    expect(raw).not.toMatch(/unexpected-shape-secret|Objects are not valid|React child|object with keys|pl-1/);
  });

  test('an uncaught exception of the site\'s own code: name and file:line, not the message', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await serveScript(page, 'boom.js', 'setTimeout(function () { throw new TypeError("secret message about jane.doe@example.com"); }, 0);');
    await inject(page, 'boom.js');
    const error = await w.next('oz_ui_error');
    expect(error.props).toEqual({ error_name: 'TypeError', frame: 'boom.js:1', route: '/' });
    expect(await w.raw()).not.toMatch(/secret|jane|example/);
  });

  test('an unhandled rejection with an Error: its name and top frame', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await serveScript(page, 'reject.js', 'setTimeout(function () { Promise.reject(new RangeError("secret rejection text")); }, 0);');
    await inject(page, 'reject.js');
    const error = await w.next('oz_ui_error');
    expect(error.props).toEqual({ error_name: 'RangeError', frame: 'reject.js:1', route: '/' });
    expect(await w.raw()).not.toContain('secret');
  });

  test('errors of other origins, strings and extensions are not reported', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await page.evaluate(() => {
      setTimeout(() => { throw new Error('thrown from the test harness: not the site'); }, 0);
      setTimeout(() => { Promise.reject('a rejected string with secret text'); }, 0);
      setTimeout(() => { Promise.reject({ message: 'secret object' }); }, 0);
    });
    await page.waitForTimeout(500);
    expect((await w.events()).map((e) => e.name)).toEqual(['oz_load']);
  });

  test('an error of the page itself (an inline script) is not reported: the page path can carry an id', async ({ page }) => {
    const w = await watch(page);
    await mockApi(page, 'visitor');
    await mockBoot(page, { telemetry: ON });
    const id = '0f8e5c1a-2b3c-4d5e-8f90-123456789abc';
    await page.goto(`/playlists/${id}`);
    await w.next('oz_load');
    // What an inline script of the page (or one an extension injects) reports: the page's own URL as its file.
    await page.evaluate(() => {
      const thrown = new TypeError('inline');
      thrown.stack = `TypeError: inline\n    at ${location.href}:2:5`;
      window.dispatchEvent(new ErrorEvent('error', { error: thrown, filename: location.href, lineno: 2, colno: 5 }));
      const rejected = new RangeError('inline rejection');
      rejected.stack = `RangeError: inline rejection\n    at ${location.href}:3:1`;
      void Promise.reject(rejected);
    });
    await page.waitForTimeout(500);
    expect(await w.named('oz_ui_error')).toEqual([]);
    expect(await w.raw()).not.toContain(id);
  });

  test('the same error is reported once, and a page load reports at most five different ones', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    const names = ['AError', 'BError', 'CError', 'DError', 'EError', 'FError', 'GError'];
    await serveScript(page, 'many.js', `
      var names = ${JSON.stringify(names)};
      setTimeout(function () { for (var i = 0; i < names.length; i++) { for (var again = 0; again < 3; again++) {
        (function (n) { var e = new Error("m"); e.name = n; Promise.reject(e); })(names[i]);
      } } }, 0);
    `);
    await inject(page, 'many.js');
    await expect.poll(async () => (await w.named('oz_ui_error')).length).toBe(5);
    await page.waitForTimeout(400);
    const seen = (await w.named('oz_ui_error')).map((e) => e.props.error_name);
    expect(seen).toEqual(names.slice(0, 5));
  });
});

// ── oz_demo ───────────────────────────────────────────────────────────────────────────────────────────────────

const slimDeck = (slides: number) => ({
  ...DEMO_DECK_EN,
  id: DEMO_DECK_EN.deck_id,
  filename: DEMO_DECK_EN.title,
  slide_count: slides,
  slides: Array.from({ length: slides }, (_, i) => ({ index: i, title: `Slide ${i + 1}`, image_url: '', text: `Text of slide ${i + 1}` })),
});

interface DemoRun { mock: DemoSocketMock; w: Watch }

async function openDemo(page: Page, o: { slides?: number; socket?: DemoSocketOptions; refuse?: boolean } = {}): Promise<DemoRun> {
  const slides = o.slides ?? DEMO_DECK_EN.slide_count;
  const w = await watch(page);
  await mockApi(page, 'visitor', demoSource);
  if (slides !== DEMO_DECK_EN.slide_count) await page.route('**/api/decks/deck-demo-en', (route) => route.fulfill({ json: slimDeck(slides) }));
  if (o.refuse) await refuseDemoHandshake(page);
  const mock = await mockDemoSocket(page, { slideCount: slides, sessionSeconds: 300, idleCloseMs: false, ...o.socket });
  await mockBoot(page, { telemetry: ON }, demoSource);
  await page.goto(DECK_PATH);
  await expect(page.getByTestId('demo-start')).toBeVisible({ timeout: 30_000 });
  return { mock, w };
}

async function tapStart(page: Page, mock: DemoSocketMock) {
  await page.getByTestId('demo-start').click();
  await expect.poll(() => mock.connections).toBe(1);
}

async function connect(page: Page, mock: DemoSocketMock) {
  await tapStart(page, mock);
  await demoHooks.connected(page);
}

async function endTurns(page: Page, mock: DemoSocketMock, count: number, from = 1) {
  for (let i = from; i < from + count; i += 1) {
    await expect.poll(() => mock.items.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(i);
    await demoHooks.finishTurn(page, mock.items[i - 1]);
  }
}

test.describe('oz_demo', () => {
  test('busy (1013) after the socket opened: stage, close code and outcome — and nothing that was never reached', async ({ page }) => {
    const { mock, w } = await openDemo(page, { socket: { onOpen: { close: CLOSE.BUSY } } });
    await tapStart(page, mock);
    await expect(page.getByTestId('demo-outcome')).toBeVisible();
    const demo = await w.next('oz_demo');
    expect(demo.props).toEqual({ stage_reached: 'ws_open', close_code: '1013', outcome: 'busy', questions: '0' });
    expect(await w.named('oz_first_value')).toHaveLength(0);
  });

  test('every close code maps to the outcome of the contract', async ({ page }) => {
    const table: [number, string][] = [
      [CLOSE.DAILY_QUOTA, 'limit'], [CLOSE.STORE_OUTAGE, 'error'], [CLOSE.SESSION_ERROR, 'error'], [CLOSE.TIME_CAP, 'cap'], [CLOSE.FINISHED, 'stop'], [CLOSE.IDLE, 'stop'],
    ];
    for (const [code, outcome] of table) {
      const context = page.context();
      const p = await context.newPage();
      const { mock, w } = await openDemo(p, { socket: { onOpen: { close: code } } });
      await tapStart(p, mock);
      const demo = await w.next('oz_demo');
      expect(demo.props, `close ${code}`).toMatchObject({ close_code: String(code), outcome, stage_reached: 'ws_open' });
      await p.close();
    }
  });

  test('the socket never opens (a blocked network): stage "tap", close code 1006, outcome blocked', async ({ page }) => {
    const { mock, w } = await openDemo(page, { refuse: true });
    await page.getByTestId('demo-start').click();
    await expect(page.getByTestId('demo-outcome')).toBeVisible({ timeout: 20_000 });
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'tap', close_code: '1006', outcome: 'blocked' });
    expect(mock.connections).toBe(0);
    expect(await w.named('oz_demo')).toHaveLength(1);
  });

  test('a whole demo with a typed question and "Finish demo": the stages, the time to the first word, the question count — never the question', async ({ page }) => {
    const { mock, w } = await openDemo(page, { slides: 1, socket: { qaDelaysMs: { transcript: 100, answer: 100 } } });
    await connect(page, mock);
    await endTurns(page, mock, 1);
    await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('demo-ask').click();
    await page.getByTestId('qa-text-input').fill(SECRET);
    await page.getByTestId('qa-text-submit').click();
    const ask = await mock.waitForSent('qa.ask_text');
    expect(ask.text).toBe(SECRET);
    await expect(page.getByTestId('qa-answer')).toBeVisible();
    await endTurns(page, mock, 1, 2);
    await mock.waitForSent('qa.resume');
    await page.waitForTimeout(1200); // an idle tail the event can measure
    await page.getByTestId('demo-finish').click();
    await expect(page.getByTestId('demo-outcome')).toBeVisible();
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'complete', close_code: '4001', outcome: 'stop', questions: '1' });
    expect(Number(demo.props.ms_to_first_word)).toBeGreaterThan(0);
    expect(Number(demo.props.idle_tail_s)).toBeGreaterThanOrEqual(1);
    expect(demo.props.ice_gather_ms, 'no ICE servers in this mock').toBeUndefined();
    const first = await w.next('oz_first_value');
    expect(first.props.kind).toBe('avatar');
    expect(first.props.taps_since_load, 'the Start tap is the only tap before the first word').toBe('1');
    expect(Number(first.props.ms_from_tap)).toBeGreaterThan(0);
    // The question, the answer and the deck's words appear nowhere in what was sent.
    const raw = await w.raw();
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('jane.doe');
    expect(raw).not.toContain(mock.options.answer ?? 'The deck says growth');
    expect(raw).not.toMatch(/Welcome to this short live demo|deck-demo-en|Slide 1|qa\.ask_text/);
    expect(await w.named('oz_demo')).toHaveLength(1);
    await noCookiesOrStorage(page);
  });

  test('the visitor does nothing after the narration: 4002 is a stop, and the idle tail is measured', async ({ page }) => {
    const { mock, w } = await openDemo(page, { slides: 1, socket: { idleCloseMs: 8000 } });
    await connect(page, mock);
    await endTurns(page, mock, 1);
    await expect(page.getByTestId('demo-narration-done')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('demo-outcome')).toBeVisible({ timeout: 40_000 });
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'complete', close_code: '4002', outcome: 'stop', questions: '0' });
    expect(Number(demo.props.idle_tail_s), 'seconds between the end of the narration and the close').toBeGreaterThanOrEqual(4);
  });

  test('Stop mid-session is an attempt that ended: outcome stop, no close code, the stage reached', async ({ page }) => {
    const { mock, w } = await openDemo(page, { slides: 2 });
    await connect(page, mock);
    await endTurns(page, mock, 1);
    await page.getByTestId('demo-stop').click();
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'first_word', outcome: 'stop', questions: '0' });
    expect(demo.props.close_code).toBeUndefined();
    expect(Number(demo.props.ms_to_first_word)).toBeGreaterThan(0);
    // Start again: a new attempt, a new event
    await page.getByTestId('demo-start').click();
    await expect.poll(() => mock.connections).toBe(2);
    await page.getByTestId('demo-stop').click();
    await expect.poll(async () => (await w.named('oz_demo')).length).toBe(2);
  });

  test('leaving the page during a live demo reports it as stopped (and a hidden tab does not)', async ({ page }) => {
    const { mock, w } = await openDemo(page, { slides: 2 });
    await tapStart(page, mock);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    expect(await w.named('oz_demo'), 'a hidden tab is not the end of a demo').toHaveLength(0);
    await w.hide();
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'ws_open', outcome: 'stop' });
    expect(demo.props.close_code).toBeUndefined();
  });

  test('the time the ICE gathering took is reported when the offer goes out', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { RTCPeerConnection: unknown };
      class FakePC {
        onicecandidate: ((e: unknown) => void) | null = null;
        onicegatheringstatechange: (() => void) | null = null;
        onconnectionstatechange: (() => void) | null = null;
        oniceconnectionstatechange: (() => void) | null = null;
        ondatachannel: unknown = null;
        ontrack: unknown = null;
        iceGatheringState = 'new';
        connectionState = 'new';
        signalingState = 'stable';
        localDescription: { type: string; sdp: string } | null = null;
        addTransceiver() { /* recv-only */ }
        createDataChannel() { return {}; }
        async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' }; }
        async setLocalDescription(description: { type: string; sdp: string }) {
          this.localDescription = description;
          this.iceGatheringState = 'gathering';
          setTimeout(() => this.onicecandidate?.({ candidate: { candidate: 'candidate:1 1 udp 41820159 10.0.0.1 3478 typ relay raddr 0.0.0.0 rport 0', type: 'relay', protocol: 'udp', relayProtocol: 'udp', url: 'turn:turn.example:3478?transport=udp' } }), 200);
          setTimeout(() => { this.iceGatheringState = 'complete'; this.onicecandidate?.({ candidate: null }); this.onicegatheringstatechange?.(); }, 700);
        }
        async setRemoteDescription() { /* never reached */ }
        close() { this.connectionState = 'closed'; }
      }
      w.RTCPeerConnection = FakePC;
    });
    const { mock, w } = await openDemo(page, { socket: { onOpen: 'ice' } });
    await tapStart(page, mock);
    await mock.waitForSent('session.avatar.connect');
    await page.getByTestId('demo-stop').click();
    const demo = await w.next('oz_demo');
    expect(demo.props).toMatchObject({ stage_reached: 'ws_open', outcome: 'stop' });
    expect(Number(demo.props.ice_gather_ms), 'ms from the peer connection to the offer').toBeGreaterThanOrEqual(600);
    expect(Number(demo.props.ice_gather_ms)).toBeLessThanOrEqual(3000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
// Part E — one id per page load, nothing stored, failures ignored
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
test.describe('identity and transport', () => {
  test('one random id links the events of a page load, a new load has another, nothing is stored', async ({ page }) => {
    const w = await openHome(page);
    await w.next('oz_load');
    await page.waitForTimeout(400);
    await w.hide();
    await w.next('oz_vitals');
    const first = await w.events();
    expect(new Set(first.map((e) => e.operationId)).size, 'one id per page load').toBe(1);
    await noCookiesOrStorage(page);
    await page.reload();
    await expect(page.locator('#main h1').first()).toBeVisible();
    await w.next('oz_load');
    const second = await w.events();
    expect(second.map((e) => e.operationId)[0], 'the id is never stored, so a reload has a new one').not.toBe(first[0].operationId);
    await noCookiesOrStorage(page);
  });

  test('when sendBeacon refuses, a credential-less keepalive POST with a plain-text body is used', async ({ page }) => {
    const posts: { body: string | null; type: string | undefined; cookie: string | undefined; referer: string | undefined }[] = [];
    await page.addInitScript(() => { navigator.sendBeacon = () => false; });
    await page.route(`${INGESTION}/**`, (route) => {
      const request = route.request();
      posts.push({ body: request.postData(), type: request.headers()['content-type'], cookie: request.headers()['cookie'], referer: request.headers()['referer'] });
      return route.fulfill({ status: 204, body: '' });
    });
    await mockApi(page, 'visitor');
    await mockBoot(page, { telemetry: ON });
    await page.goto('/');
    await expect.poll(() => posts.length).toBeGreaterThan(0);
    expect(posts[0].type).toMatch(/^text\/plain/);
    expect(posts[0].cookie).toBeUndefined();
    expect(posts[0].referer, 'no referrer to the ingestion host').toBeUndefined();
    expect(parseCall({ url: ENDPOINT, body: posts[0].body ?? '', at: 0 }).name).toBe('oz_load');
  });

  test('analytics failures are ignored: sendBeacon throwing and a failing network change nothing for the visitor', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.addInitScript(() => { navigator.sendBeacon = () => { throw new Error('beacon blocked'); }; });
    await page.route(`${INGESTION}/**`, (route) => route.abort('connectionrefused'));
    await mockApi(page, 'visitor');
    await mockBoot(page, { telemetry: ON });
    await page.goto('/');
    await expect(page.locator('#main h1').first()).toBeVisible();
    await page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
    await expect(page.getByTestId('route-crash')).toHaveCount(0);
    await expect(page.getByTestId('app-crash')).toHaveCount(0);
  });

  test('the beacon endpoint is the validated ingestion origin plus /v2/track, whatever the page URL', async ({ page }) => {
    const w = await openHome(page, '/?x=https://evil.example.net/v2/track');
    await w.next('oz_load');
    for (const call of await w.calls()) expect(call.url).toBe(ENDPOINT);
  });

  test('the observers chunk cannot be downloaded: nothing is sent, nothing breaks', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.route(VITALS_CHUNK, (route) => route.abort('connectionreset'));
    const w = await openHome(page);
    await page.waitForTimeout(800);
    await w.hide();
    expect(await w.calls()).toEqual([]);
    expect(errors).toEqual([]);
    await expect(page.getByTestId('route-crash')).toHaveCount(0);
    await expect(page.getByTestId('app-crash')).toHaveCount(0);
  });

  test('calls made while the chunk downloads wait, and keep the time they were made', async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route(VITALS_CHUNK, async (route) => { await held; await route.fallback(); });
    const w = await openHome(page);
    // The call to action is on screen while the chunk is still held back; only then does the chunk arrive.
    await expect(page.locator('[data-testid="home-try-live-demo"], [data-testid="home-watch-recorded-demo"]')).toBeVisible();
    await page.waitForTimeout(1500);
    expect(await w.calls(), 'nothing is sent before the engine runs').toEqual([]);
    release();
    const load = await w.next('oz_load', 30_000);
    const [call] = await w.calls();
    expect(Number(load.props.first_cta_ms)).toBeGreaterThan(0);
    expect(Number(load.props.first_cta_ms) + 1000, 'first_cta_ms is the time the call was made, not the time of the replay').toBeLessThan(call.at);
  });
});
