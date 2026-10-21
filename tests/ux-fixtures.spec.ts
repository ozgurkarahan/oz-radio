import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  DEMO_QA_CONFIG, DEMO_DECK_EN, DEMO_DECK_FR, PUBLIC_SLIDE_TEXT_MAX, VTT_BODY, VIDEO_DEMO_EN, VIDEO_DEMO_FR,
  bootPayload, bootScriptTag, escapeBootJson, injectBootIntoHtml, liveDemoDecks, mockApi, mockBoot, rawBootScriptTag, readBootText,
  routeExpiredMedia,
} from './support/mock-api';
import {
  DEMO_SCRIPTED_CLOSES, GENERIC_PROXY_ERROR, SERVER_QA_ERRORS, demoHooks, demoProbe, expectedIdleCloseMs, mockDemoSocket,
  refuseDemoHandshake,
} from './support/demo-ws-fixtures';
import {
  BOOT_ELEMENT_ID, BOOT_FAIL_CLOSED, BOOT_MARKER, BOOT_MAX_LIVE_DECKS, BOOT_TELEMETRY_IKEY, BOOT_TELEMETRY_INGESTION, BOOT_VERSION,
  fetchBootFallback, normalizeBoot, parseBoot, pickDemoDeck,
} from '../demos/frontend/src/services/boot';
import {
  DEMO_ACTIVITY_MIN_INTERVAL_SECONDS, DEMO_AZURE_EVENTS, DEMO_AUDIO_TAIL_GRACE_SECONDS, DEMO_CAPTION_KINDS, DEMO_CLOSE_CODES,
  DEMO_CLOSE_REASONS, DEMO_FALLBACK_LINKS,
  DEMO_FIRST_AUDIO_LATENCY_SECONDS, DEMO_IDLE_ANNOUNCE_MIN_DELTA_SECONDS, DEMO_IDLE_CHECK_INTERVAL_SECONDS, DEMO_IDLE_CLOSE_SECONDS,
  DEMO_MAX_TEXT_QUESTION_CHARS, DEMO_MSG,
  DEMO_NARRATION_CHARS_PER_SECOND, DEMO_OUTCOME_COPY, DEMO_PROTOCOL_VERSION, DEMO_QA_LIMIT_MESSAGES, DEMO_SERVICE_ERROR_DETAIL,
  DEMO_SWITCHED_OFF_DETAIL, DEMO_TEXT_TOO_LONG_MESSAGE, DEMO_TIMING, DEMO_WS_PATH, demoDeckPath, findRecording, outcomeFor, recordingPath,
} from '../demos/frontend/src/services/demoProtocol';
import {
  LIBRARY_UNAVAILABLE_DETAIL, classifyLoadError, isFrench, langAttr, levelLabel, loadErrorMessage, normalizeTitle, primaryLanguage,
  recordingTitle,
} from '../demos/frontend/src/ui/format';
import {
  deckNeedsNotesTranslation, isAdminSlide, mergeDeckTranslations, presenterSlides, type DeckDetail, type PublicSlideInfo,
} from '../demos/frontend/src/services/decksApi';

/**
 * Smoke test of the shared fixtures and contract helpers (WU-F0, contracts v1). Fast, mocked, no backend.
 * Part A is plain Node (the pure helpers and the TS ↔ Python contract sync). Part B drives a page through
 * `mockBoot`, `mockDemoSocket`, `refuseDemoHandshake`, `demoProbe` and the `mockApi` toggles.
 * Only WU-F0 edits this file and tests/support/*.
 */

const REPO = path.join(__dirname, '..');
const read = (...parts: string[]) => fs.readFileSync(path.join(REPO, ...parts), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Part A — pure helpers (Node)
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
test.describe('contract helpers (node)', () => {
  test('normalizeTitle: quotes, NFKC, whitespace and case', () => {
    expect(normalizeTitle('L\u2019IA en trois  minutes · Démo en direct')).toBe(normalizeTitle("l'ia EN trois minutes · démo en direct"));
    expect(normalizeTitle('\uFF21\uFF29\u00A0in\u3000three minutes')).toBe('ai in three minutes');
    expect(normalizeTitle('  Straße  ')).toBe(normalizeTitle('STRASSE'));
    expect(normalizeTitle('Cafe\u0301')).toBe(normalizeTitle('Café'));
    expect(normalizeTitle('say \u201Chi\u201D')).toBe('say "hi"');
    expect(normalizeTitle('zero\u200Bwidth')).toBe('zerowidth');
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(42)).toBe('');
  });

  test('recordingTitle: a recording never claims to be live', () => {
    expect(recordingTitle('AI in three minutes · Live demo')).toBe('AI in three minutes · Demo recording');
    expect(recordingTitle('L\u2019IA en trois minutes · Démo en direct')).toBe('L\u2019IA en trois minutes · Démo enregistrée');
    expect(recordingTitle('Live demo tips')).toBe('Live demo tips');
    expect(recordingTitle('ai-enablement')).toBe('AI enablement');
    expect(recordingTitle(null)).toBe('Untitled');
  });

  test('level and language helpers', () => {
    expect([levelLabel('beginner'), levelLabel('practitioner'), levelLabel('expert')]).toEqual(['Beginner', 'Practitioner', 'Expert']);
    expect([levelLabel(null), levelLabel(undefined), levelLabel('guru'), levelLabel('toString')]).toEqual(['', '', '', '']);
    expect([primaryLanguage('fr-FR'), primaryLanguage('pt_BR'), primaryLanguage('EN'), primaryLanguage(''), primaryLanguage(7)])
      .toEqual(['fr', 'pt', 'en', null, null]);
    expect([isFrench('fr-CA'), isFrench('fr'), isFrench('en-US'), isFrench(undefined)]).toEqual([true, true, false, false]);
    expect([langAttr('fr-FR'), langAttr('en-US'), langAttr(null), langAttr('x')]).toEqual(['fr', 'en', undefined, undefined]);
  });

  test('load errors are classified and never echoed', () => {
    const cases: [unknown, string][] = [
      [new TypeError('Failed to fetch'), 'offline'],
      [new TypeError('Load failed'), 'offline'],
      [new TypeError('NetworkError when attempting to fetch resource.'), 'offline'],
      [new Error(LIBRARY_UNAVAILABLE_DETAIL), 'unavailable'],
      [new Error('Library storage not available'), 'unavailable'],
      [new Error('Storage unavailable'), 'unavailable'],
      [new Error('upstream connect error or disconnect/reset before headers. reset reason: connection failure'), 'unavailable'],
      [new Error('HTTP 503'), 'unavailable'],
      [new Error('Library item not found'), 'not-found'],
      [new Error('Deck not found'), 'not-found'],
      [new Error('boom'), 'unknown'],
    ];
    for (const [err, kind] of cases) {
      expect(classifyLoadError(err), String(err)).toBe(kind);
      const message = loadErrorMessage(err, 'the episodes');
      expect(message).not.toMatch(/fetch|upstream|HTTP|boom|Library storage/i);
    }
    expect(loadErrorMessage(new Error(LIBRARY_UNAVAILABLE_DETAIL), 'the episodes')).toBe("We couldn't load the episodes right now. Please try again in a moment.");
  });

  test('findRecording: the same-deck recording map', () => {
    const deckFr = { deck_id: 'deck-fr', title: 'L\u2019IA en trois minutes · Démo en direct', language: 'fr-FR' };
    const deckEn = { deck_id: 'deck-en', title: 'AI in three minutes · Live demo', language: 'en-US' };
    const video = (job_id: string, title: string, language: string, extra: Record<string, unknown> = {}) => ({
      job_id, title, language, created_at: '2026-10-18T10:00:00Z', duration_sec: 192, ...extra,
    });
    const podcast = (job_id: string, title: string, language: string, extra: Record<string, unknown> = {}) => ({
      job_id, title, language, created_at: '2026-10-18T11:00:00Z', duration_sec: 40, audio_duration_sec: 30, format: 'video' as const, has_video: true, ...extra,
    });

    // by normalized title (straight vs typographic apostrophe), language first, video before podcast
    const hit = findRecording(deckFr, [video('sv-en', deckEn.title, 'en-US'), video('sv-fr', "L'IA en trois minutes · Démo en direct", 'fr-FR')], [podcast('job-fr', deckFr.title, 'fr-FR')]);
    expect(hit).toMatchObject({ kind: 'video', id: 'sv-fr', matchedBy: 'title', sameLanguage: true, to: '/video/library?video=sv-fr' });
    expect(hit?.label).toBe("Watch L'IA en trois minutes · Démo enregistrée · Français · 3:12"); // a recording never reads "live"
    expect(findRecording(deckEn, [video('sv-en', deckEn.title, 'en-US')], [])?.label).toBe('Watch AI in three minutes · Demo recording · English · 3:12');

    // source_deck_id beats the title, per medium
    const byId = findRecording(deckEn, [video('sv-a', deckEn.title, 'en-US'), video('sv-b', 'Anything', 'en-US', { source_deck_id: 'deck-en' })], []);
    expect(byId).toMatchObject({ id: 'sv-b', matchedBy: 'source_deck_id' });

    // the deck's language outranks the medium: a same-language podcast beats a cross-language video
    expect(findRecording(deckFr, [video('sv-x', 'Autre', 'en-US', { source_deck_id: 'deck-fr' })], [podcast('job-fr', deckFr.title, 'fr-FR')]))
      .toMatchObject({ kind: 'podcast', id: 'job-fr', to: '/podcast/library?episode=job-fr&mode=watch' });
    // …and without anything in its language, the cross-language id match is still the same deck
    expect(findRecording(deckFr, [video('sv-x', 'Autre', 'en-US', { source_deck_id: 'deck-fr' })], [])).toMatchObject({ id: 'sv-x', sameLanguage: false });

    // an audio-only podcast is the last resort and reads "Listen to"
    const audio = findRecording(deckFr, [], [podcast('job-a', deckFr.title, 'fr-FR', { format: 'audio', has_video: false, audio_duration_sec: 61 })]);
    expect(audio).toMatchObject({ watchable: false, durationSec: 61, to: '/podcast/library?episode=job-a&mode=listen' });
    expect(audio?.label).toBe("Listen to L\u2019IA en trois minutes · Démo enregistrée · Français · 1:01");
    expect(findRecording(deckFr, [], [podcast('job-a', deckFr.title, 'fr-FR', { format: 'audio', has_video: false }), podcast('job-v', deckFr.title, 'fr-FR')])?.id).toBe('job-v');

    // newest wins, then job id
    expect(findRecording(deckEn, [video('sv-1', deckEn.title, 'en-US', { created_at: '2026-10-01T00:00:00Z' }), video('sv-2', deckEn.title, 'en-US', { created_at: '2026-10-02T00:00:00Z' })], [])?.id).toBe('sv-2');
    expect(findRecording(deckEn, [video('sv-b', deckEn.title, 'en-US'), video('sv-a', deckEn.title, 'en-US')], [])?.id).toBe('sv-a');

    // nothing → null (the caller shows DEMO_FALLBACK_LINKS); an empty title never matches
    expect(findRecording(deckEn, [video('sv-z', 'Unrelated', 'en-US')], [])).toBeNull();
    expect(findRecording({ deck_id: 'd', title: '   ', language: 'en-US' }, [video('sv-z', '', 'en-US')], [])).toBeNull();
    expect(DEMO_FALLBACK_LINKS.map((l) => l.to)).toEqual(['/podcast/library', '/video/library']);
    expect(recordingPath('podcast', 'job-1')).toBe('/podcast/library?episode=job-1&mode=watch');
    expect(demoDeckPath('deck-live')).toBe('/decks/deck-live/present');
  });

  test('outcomeFor: every close code reaches a visitor outcome', () => {
    const o = (code: number, opened = true, ctx = {}) => outcomeFor(code, opened, ctx);
    expect(o(DEMO_CLOSE_CODES.FINISHED)).toMatchObject({ kind: 'finished', title: 'Thanks for trying the live demo', retry: 'none', role: 'status' });
    expect(o(DEMO_CLOSE_CODES.IDLE)).toMatchObject({ kind: 'idle', title: 'Your live session has ended', retry: 'none' });
    expect(o(DEMO_CLOSE_CODES.TIME_CAP)).toMatchObject({ kind: 'cap', title: 'Your live session has ended', retry: 'none' });
    expect(o(DEMO_CLOSE_CODES.BUSY)).toMatchObject({ kind: 'busy', title: 'Another visitor is using the avatar', retry: 'later', retryLabel: 'Try again in a minute', role: 'alert' });
    expect(o(DEMO_CLOSE_CODES.DAILY_QUOTA)).toMatchObject({ kind: 'quota', title: "Today's live allowance has been reached", retry: 'none' });
    expect(o(DEMO_CLOSE_CODES.STORE_OUTAGE)).toMatchObject({ kind: 'outage', title: 'Live demo temporarily unavailable', retry: 'none', role: 'alert' });
    for (const code of [DEMO_CLOSE_CODES.SESSION_ERROR, DEMO_CLOSE_CODES.RESTART, DEMO_CLOSE_CODES.GOING_AWAY]) {
      expect(o(code), String(code)).toMatchObject({ kind: 'outage', title: 'Live demo temporarily unavailable', retry: 'later' });
    }
    expect(o(DEMO_CLOSE_CODES.NORMAL)).toMatchObject({ kind: 'ended', title: 'Your live session has ended' });
    expect(o(DEMO_CLOSE_CODES.NORMAL, true, { sawServiceError: true })).toMatchObject({ kind: 'outage' });
    // an `error` event from the avatar service before the close: an outage that says so (no raw text, no "Azure")
    for (const code of [1000, 1001, 1005, 1006, 1011, 1012, 1015, 4999]) {
      expect(o(code, true, { sawServiceError: true }), String(code)).toMatchObject({
        kind: 'outage', title: 'Live demo temporarily unavailable', detail: DEMO_SERVICE_ERROR_DETAIL, retry: 'later', retryLabel: 'Try again', role: 'alert',
      });
    }
    expect(DEMO_SERVICE_ERROR_DETAIL).not.toMatch(/azure|voice live|api/i);
    // closes with a meaning of their own win over a service error that was reported earlier
    const own: [number, string][] = [[4001, 'finished'], [4002, 'idle'], [4408, 'cap'], [4429, 'quota'], [1013, 'busy'], [4503, 'outage'], [4403, 'outage']];
    for (const [code, kind] of own) {
      const outcome = o(code, true, { sawServiceError: true });
      expect(outcome.kind, String(code)).toBe(kind);
      expect(outcome.detail, String(code)).toBe(o(code, true).detail); // unchanged copy
    }
    expect(o(DEMO_CLOSE_CODES.SESSION_ERROR).detail).toBe(DEMO_OUTCOME_COPY.outage.detail); // no service error: the standard line
    // 1006: never opened → connect; opened → interrupted
    expect(o(DEMO_CLOSE_CODES.ABNORMAL, false)).toMatchObject({ kind: 'connect', title: "Couldn't connect to the live avatar", retry: 'now', opened: false });
    expect(o(DEMO_CLOSE_CODES.ABNORMAL, true)).toMatchObject({ kind: 'interrupted', retry: 'now' });
    expect(o(DEMO_CLOSE_CODES.NO_STATUS, false)).toMatchObject({ kind: 'connect' });
    // the config re-fetch refines an ambiguous 1006
    expect(o(DEMO_CLOSE_CODES.ABNORMAL, false, { configEnabled: false })).toMatchObject({ kind: 'outage', retry: 'none', detail: DEMO_SWITCHED_OFF_DETAIL });
    expect(o(DEMO_CLOSE_CODES.ABNORMAL, false, { configEnabled: true })).toMatchObject({ kind: 'connect' });
    expect(o(DEMO_CLOSE_CODES.REFUSED, false)).toMatchObject({ kind: 'outage', retry: 'none' });
    // unknown codes degrade, never throw
    expect(o(4999, true)).toMatchObject({ kind: 'ended' });
    expect(o(1015, true)).toMatchObject({ kind: 'interrupted' });
    expect(Object.keys(DEMO_OUTCOME_COPY).sort()).toEqual(['busy', 'cap', 'connect', 'ended', 'finished', 'idle', 'interrupted', 'outage', 'quota']);
  });

  test('pickDemoDeck: the first browser language with a deck decides', () => {
    const decks = liveDemoDecks('demo');
    expect(decks.map((d) => d.deck_id)).toEqual([DEMO_DECK_EN.deck_id, DEMO_DECK_FR.deck_id]);
    const boot = { live_demo_decks: decks };
    expect(pickDemoDeck(boot, ['fr-FR', 'fr'])?.deck_id).toBe('deck-demo-fr');
    expect(pickDemoDeck(boot, ['en-US', 'fr-CA'])?.deck_id).toBe('deck-demo-en');
    expect(pickDemoDeck(boot, ['de-DE', 'fr-FR', 'en'])?.deck_id).toBe('deck-demo-fr');
    expect(pickDemoDeck(boot, ['en-US'])?.deck_id).toBe('deck-demo-en');
    expect(pickDemoDeck(boot, ['de-DE'])?.deck_id).toBe('deck-demo-en');
    expect(pickDemoDeck(boot, [])?.deck_id).toBe('deck-demo-en');
    expect(pickDemoDeck({ live_demo_decks: [DEMO_DECK_FR].map((d) => ({ deck_id: d.deck_id, language: d.language, title: d.title })) }, ['en-US'])?.deck_id).toBe('deck-demo-fr');
    expect(pickDemoDeck({ live_demo_decks: [] }, ['fr'])).toBeNull();
    expect(pickDemoDeck(null, ['fr'])).toBeNull();
  });

  test('parseBoot validates defensively', () => {
    const good = bootPayload({}, { catalog: 'demo', demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300, demoRemainingToday: 17 });
    const parsed = parseBoot(JSON.stringify(good));
    expect(parsed).toMatchObject({ v: 1, ok: true, demo: { enabled: true, session_seconds: 300, qa: { enabled: true, max_questions: 2 }, remaining_today: 17 } });
    expect(parsed?.live_demo_decks).toHaveLength(2);
    // ok:false, wrong version, malformed pieces → null
    expect(parseBoot(JSON.stringify(BOOT_FAIL_CLOSED))).toBeNull();
    expect(parseBoot(JSON.stringify({ ...good, v: 2 }))).toBeNull();
    expect(parseBoot(JSON.stringify({ ...good, demo: { ...good.demo, enabled: 'yes' } }))).toBeNull();
    expect(parseBoot(JSON.stringify({ ...good, demo: { ...good.demo, session_seconds: 'x' } }))).toBeNull();
    expect(parseBoot(JSON.stringify({ ...good, demo: { ...good.demo, qa: null } }))).toBeNull();
    for (const bad of ['', '   ', '{oops', 'null', '[]', '42', undefined, null]) expect(parseBoot(bad as string | null | undefined), String(bad)).toBeNull();
    // bad deck entries are dropped, the rest survives; the list is capped
    const messy = normalizeBoot({
      ...good,
      live_demo_decks: [{ deck_id: 'a' }, { deck_id: '' }, { deck_id: 'has space' }, { title: 'x' }, 7, null, { deck_id: 'b', language: 3, title: 4 }],
    });
    expect(messy?.live_demo_decks).toEqual([{ deck_id: 'a', language: 'en-US', title: '' }, { deck_id: 'b', language: 'en-US', title: '' }]);
    const many = normalizeBoot({ ...good, live_demo_decks: Array.from({ length: 50 }, (_, i) => ({ deck_id: `d${i}`, language: 'en-US', title: 't' })) });
    expect(many?.live_demo_decks).toHaveLength(BOOT_MAX_LIVE_DECKS);
    // remaining_today and max_questions tolerate junk
    expect(normalizeBoot({ ...good, demo: { ...good.demo, remaining_today: 'n/a', qa: { enabled: false } } })?.demo).toMatchObject({ remaining_today: null, qa: { enabled: false, max_questions: 0 } });
    expect(normalizeBoot({ ...good, telemetry: { enabled: 'true' } })?.telemetry.enabled).toBe(false);
  });

  test('escapeBootJson and injectBootIntoHtml', () => {
    const nasty = bootPayload({ live_demo_decks: [{ deck_id: 'd', language: 'en-US', title: '</script><script>alert(1)</script> & \u2028 \u2029 $& $1' }] });
    const tag = bootScriptTag(nasty);
    const body = tag.slice(tag.indexOf('>') + 1, tag.lastIndexOf('</script>'));
    expect(body).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(body)).toEqual(nasty);
    expect(escapeBootJson('<>&')).toBe('\\u003c\\u003e\\u0026');

    const html = `<html><head><title>t</title>${BOOT_MARKER}</head><body></body></html>`;
    const at = injectBootIntoHtml(html, tag);
    expect(at.markerSeen).toBe(true);
    expect(at.markerCount).toBe(1);
    expect(at.html).toBe(`<html><head><title>t</title>${tag}</head><body></body></html>`); // `$&` in the payload stays literal
    // no block: the document is served as it is (the marker stays a harmless comment)
    expect(injectBootIntoHtml(html, null)).toEqual({ html, markerSeen: true, markerCount: 1 });
    // the marker is the ONLY insertion point: a document without it is served unchanged, like the server does
    const bare = '<html><head><title>t</title></head><body></body></html>';
    expect(injectBootIntoHtml(bare, tag)).toEqual({ html: bare, markerSeen: false, markerCount: 0 });
    expect(injectBootIntoHtml(bare, null)).toEqual({ html: bare, markerSeen: false, markerCount: 0 });
    expect(injectBootIntoHtml('', tag)).toEqual({ html: '', markerSeen: false, markerCount: 0 });
    // only the first marker is replaced; the count tells a test the page carries more than one
    const twice = `<head>${BOOT_MARKER}</head><body>${BOOT_MARKER}</body>`;
    expect(injectBootIntoHtml(twice, tag)).toEqual({ html: `<head>${tag}</head><body>${BOOT_MARKER}</body>`, markerSeen: true, markerCount: 2 });
    expect(rawBootScriptTag('{oops')).toBe(`<script type="application/json" id="${BOOT_ELEMENT_ID}">{oops</script>`);
  });

  test('deck types: a public slide has no body or notes; presenterSlides gives the presenter empty strings', () => {
    const pub: PublicSlideInfo = { index: 0, title: 'Public', image_url: '', text: 'Visible text' };
    const admin = { index: 1, title: 'Admin', body: 'B', notes: 'N', translated_notes: { 'fr-FR': 'N-fr' } };
    expect([isAdminSlide(pub), isAdminSlide(admin)]).toEqual([false, true]);
    const slides = presenterSlides([pub, admin]);
    expect(slides[0]).toEqual({ index: 0, title: 'Public', body: '', notes: '', image_url: '', text: 'Visible text' });
    expect(slides[1]).toBe(admin); // an admin slide passes through untouched
    expect(presenterSlides(null)).toEqual([]);
    expect(Object.keys(presenterSlides([{ index: 2, title: 'x', image_url: 'u' }])[0]).sort()).toEqual(['body', 'image_url', 'index', 'notes', 'title']); // no `text` key when there is none
    // translation helpers only look at admin slides
    const deck: DeckDetail = { deck_id: 'd', id: 'd', title: 't', slide_count: 2, language: 'en-US', uploaded_at: '', tags: [], slides: [pub, admin] };
    expect(deckNeedsNotesTranslation(deck, 'de-DE')).toBe(true);
    expect(deckNeedsNotesTranslation(deck, 'fr-FR')).toBe(false); // already translated
    expect(deckNeedsNotesTranslation({ ...deck, slides: [pub] }, 'de-DE')).toBe(false); // a visitor deck never needs it
    const merged = mergeDeckTranslations(deck, 'de-DE', { 0: 'ignored', 1: 'N-de' });
    expect(merged.slides[0]).toBe(pub);
    expect(merged.slides[1]).toEqual({ ...admin, translated_notes: { 'fr-FR': 'N-fr', 'de-DE': 'N-de' } });
    // `filename` is optional (the public payload carries the display title)
    const visitor: DeckDetail = { deck_id: 'd', id: 'd', title: 'Display title', slide_count: 0, language: 'en-US', uploaded_at: '', tags: [], slides: [] };
    expect(visitor.filename).toBeUndefined();
  });

  test('fetchBootFallback builds the block the server would have sent, bounded in time', async () => {
    const reply = (map: Record<string, () => Promise<Response>>) => ((url: string) => {
      const handler = map[url];
      return handler ? handler() : Promise.reject(new Error(`unexpected ${url}`));
    }) as unknown as typeof fetch;
    const ok = (body: unknown) => () => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
    const decks = [
      { deck_id: 'deck-demo-en', title: 'AI in three minutes · Live demo', language: 'en-US', published: true, live_demo: true },
      { deck_id: 'deck-demo-fr', title: 'L\u2019IA', language: 'fr-FR', published: true, live_demo: true },
      { deck_id: 'deck-plain', title: 'plain', language: 'en-US', published: true, live_demo: false },
    ];
    const block = await fetchBootFallback({
      fetchImpl: reply({
        '/api/demo/config': ok({ enabled: true, session_seconds: 300, qa: { enabled: true, max_questions: 2, max_audio_seconds: 15 }, remaining_today: 9 }),
        '/api/decks': ok(decks),
      }),
    });
    expect(block).toMatchObject({ ok: true, demo: { enabled: true, session_seconds: 300, qa: { enabled: true, max_questions: 2 }, remaining_today: 9 } });
    expect(block?.live_demo_decks.map((d) => d.deck_id)).toEqual(['deck-demo-en', 'deck-demo-fr']);
    // demo off: decks are not needed, even when they fail
    const off = await fetchBootFallback({
      fetchImpl: reply({ '/api/demo/config': ok({ enabled: false, session_seconds: 180 }), '/api/decks': () => Promise.reject(new TypeError('Failed to fetch')) }),
    });
    expect(off).toMatchObject({ ok: true, demo: { enabled: false }, live_demo_decks: [] });
    // demo on but the deck list fails, or the config fails → null ("demo unavailable")
    expect(await fetchBootFallback({ fetchImpl: reply({ '/api/demo/config': ok({ enabled: true, session_seconds: 300 }), '/api/decks': () => Promise.reject(new Error('x')) }) })).toBeNull();
    expect(await fetchBootFallback({ fetchImpl: reply({ '/api/demo/config': () => Promise.resolve(new Response('{}', { status: 503 })), '/api/decks': ok([]) }) })).toBeNull();
    // a hung API is cut at the timeout
    const hung = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    const started = Date.now();
    expect(await fetchBootFallback({ fetchImpl: hung, timeoutMs: 150 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('TS and Python contracts agree (demoProtocol.ts / boot.ts ↔ services/demo_protocol.py)', () => {
    const py = read('demos', 'backend', 'services', 'demo_protocol.py');
    const num = (name: string) => {
      const m = new RegExp(`^${name}\\s*=\\s*(\\d+)\\b`, 'm').exec(py);
      if (!m) throw new Error(`${name} not found in demo_protocol.py`);
      return Number(m[1]);
    };
    const str = (name: string) => {
      const m = new RegExp(`^${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm').exec(py);
      if (!m) throw new Error(`${name} not found in demo_protocol.py`);
      return m[1];
    };
    expect(num('PROTOCOL_VERSION')).toBe(DEMO_PROTOCOL_VERSION);
    expect(str('WS_PATH')).toBe(DEMO_WS_PATH);
    expect(num('IDLE_CLOSE_SECONDS')).toBe(DEMO_IDLE_CLOSE_SECONDS);
    expect(num('AUDIO_TAIL_GRACE_SECONDS')).toBe(DEMO_AUDIO_TAIL_GRACE_SECONDS);
    expect(num('IDLE_CHECK_INTERVAL_SECONDS')).toBe(DEMO_IDLE_CHECK_INTERVAL_SECONDS);
    expect(Number(/^FIRST_AUDIO_LATENCY_SECONDS\s*=\s*([0-9.]+)/m.exec(py)?.[1])).toBe(DEMO_FIRST_AUDIO_LATENCY_SECONDS);
    expect(num('NARRATION_CHARS_PER_SECOND')).toBe(DEMO_NARRATION_CHARS_PER_SECOND);
    expect(num('QA_RESERVE_TIMEOUT_SECONDS') * 1000).toBe(DEMO_TIMING.qaReserveTimeoutMs);
    // the client's typed-question ack timeout outlasts the server's bounded reservation (+ the 1 s `qa.accepted` budget)
    expect(DEMO_TIMING.askTextAckTimeoutMs).toBeGreaterThan(DEMO_TIMING.qaReserveTimeoutMs + 1000);
    // v1.3 `demo.activity` / `demo.idle`: the server's rate limit and announcement step, and the client's throttle, which is
    // longer than the rate limit so that every activity the client sends is honoured
    expect(num('ACTIVITY_MIN_INTERVAL_SECONDS')).toBe(DEMO_ACTIVITY_MIN_INTERVAL_SECONDS);
    expect(num('IDLE_ANNOUNCE_MIN_DELTA_SECONDS')).toBe(DEMO_IDLE_ANNOUNCE_MIN_DELTA_SECONDS);
    expect(DEMO_TIMING.activityIntervalMs).toBe(10_000);
    expect(DEMO_TIMING.activityIntervalMs).toBeGreaterThan(num('ACTIVITY_MIN_INTERVAL_SECONDS') * 1000);
    expect(DEMO_MSG.ACTIVITY).toBe('demo.activity');
    expect(DEMO_MSG.IDLE).toBe('demo.idle');
    expect(num('MAX_TEXT_QUESTION_CHARS')).toBe(DEMO_MAX_TEXT_QUESTION_CHARS);
    expect(str('TEXT_TOO_LONG_MESSAGE')).toBe(DEMO_TEXT_TOO_LONG_MESSAGE);
    expect(str('SERVICE_ERROR_DETAIL')).toBe(DEMO_SERVICE_ERROR_DETAIL);
    expect(/^MAX_CLIENT_MESSAGE_BYTES\s*=\s*32 \* 1024/m.test(py)).toBe(true);

    for (const [name, code] of Object.entries(DEMO_CLOSE_CODES)) expect(num(`CLOSE_${name}`), `CLOSE_${name}`).toBe(code);
    const reasonsBlock = py.slice(py.indexOf('CLOSE_REASONS = {'), py.indexOf('}', py.indexOf('CLOSE_REASONS = {')));
    const pyReasons = Object.fromEntries([...reasonsBlock.matchAll(/(\d{4}):\s*"([^"]*)"/g)].map((m) => [Number(m[1]), m[2]]));
    expect(pyReasons).toEqual(DEMO_CLOSE_REASONS);
    expect(py).toMatch(/RESERVED_CLOSE_CODES = \(4000,\)/);
    // an application close frame the code already sends must carry the contract's reason (pre-accept refusals may
    // use other words: 1011 "Service not configured", the 4403 family)
    const app = read('demos', 'backend', 'app.py');
    const literal = new Map<number, Set<string>>();
    for (const m of app.matchAll(/ws\.close\(code=(\d+), reason="([^"]+)"\)/g)) {
      const code = Number(m[1]);
      literal.set(code, (literal.get(code) ?? new Set<string>()).add(m[2]));
    }
    for (const [code, reasons] of literal) {
      if (code === DEMO_CLOSE_CODES.REFUSED || !(code in DEMO_CLOSE_REASONS)) continue;
      expect([...reasons], `app.py reasons of ${code}`).toContain(DEMO_CLOSE_REASONS[code]);
    }
    // the quota refusals map to a close code
    const security = read('demos', 'backend', 'security.py');
    for (const reason of ['global', 'minutes', 'ip', 'busy', 'unavailable']) {
      expect(security, `DemoQuota reason ${reason}`).toContain(`"${reason}"`);
      expect(py).toContain(`"${reason}": CLOSE_`);
    }

    for (const [key, value] of Object.entries(DEMO_MSG)) expect(str(`MSG_${key}`), `MSG_${key}`).toBe(value);
    for (const [key, value] of Object.entries(DEMO_AZURE_EVENTS)) expect(str(`AZURE_${key}`), `AZURE_${key}`).toBe(value);
    expect(py).toContain(`CAPTION_KINDS = (${DEMO_CAPTION_KINDS.map((k) => `"${k}"`).join(', ')})`);
    const limitBlock = py.slice(py.indexOf('QA_LIMIT_MESSAGES = {'), py.indexOf('}', py.indexOf('QA_LIMIT_MESSAGES = {')));
    const pyLimits = Object.fromEntries([...limitBlock.matchAll(/"([a-z]+)":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1], m[2]]));
    expect(pyLimits).toEqual(DEMO_QA_LIMIT_MESSAGES);
    expect(pyLimits.session).toBe(read('demos', 'backend', 'services', 'voice_questions.py').match(/"limit":\s*"([^"]+)"/)?.[1]); // the existing text stays the session one

    expect(num('BOOT_VERSION')).toBe(BOOT_VERSION);
    expect(str('BOOT_ELEMENT_ID')).toBe(BOOT_ELEMENT_ID);
    expect(str('BOOT_MARKER')).toBe(BOOT_MARKER);
    expect(num('BOOT_MAX_LIVE_DECKS')).toBe(BOOT_MAX_LIVE_DECKS);
    expect(py).toContain(`"session_seconds": ${BOOT_FAIL_CLOSED.demo.session_seconds},`);
    // telemetry part of the boot block (WU-J): off is `{enabled:false}` and nothing else, on both sides; the two validation
    // patterns are the exact twins of each other (a `/` is escaped in a RegExp source, not in the Python text)
    expect(BOOT_FAIL_CLOSED.telemetry).toEqual({ enabled: false });
    expect(py).toContain('"telemetry": {"enabled": False},');
    const pyPattern = (name: string) => new RegExp(`^${name}\\s*=\\s*\\(?\\s*r"([^"]*)"`, 'm').exec(py)?.[1];
    const plain = (re: RegExp) => re.source.replace(/\\\//g, '/');
    expect(pyPattern('BOOT_TELEMETRY_IKEY_PATTERN'), 'BOOT_TELEMETRY_IKEY_PATTERN').toBe(plain(BOOT_TELEMETRY_IKEY));
    expect(BOOT_TELEMETRY_IKEY.flags).toBe('i');
    expect(pyPattern('BOOT_TELEMETRY_INGESTION_PATTERN'), 'BOOT_TELEMETRY_INGESTION_PATTERN').toBe(plain(BOOT_TELEMETRY_INGESTION));
    expect(num('BOOT_TELEMETRY_SERVER_COLD_SECONDS')).toBe(60);
    expect(str('LIBRARY_UNAVAILABLE_DETAIL')).toBe(LIBRARY_UNAVAILABLE_DETAIL);
    expect(num('PUBLIC_SLIDE_TEXT_MAX_CHARS')).toBe(PUBLIC_SLIDE_TEXT_MAX);

    // mirrored limits of the code the contract builds on
    const questions = read('demos', 'backend', 'services', 'voice_questions.py');
    expect(Number(/^MAX_TEXT_QUESTION_CHARS = (\d+)/m.exec(questions)?.[1])).toBe(DEMO_MAX_TEXT_QUESTION_CHARS);
    const errorCodes = [...questions.slice(questions.indexOf('ERROR_MESSAGES'), questions.indexOf('}', questions.indexOf('ERROR_MESSAGES'))).matchAll(/"([a-z_]+)":/g)].map((m) => m[1]);
    for (const code of errorCodes) expect(py, `QA_ERROR_CODES has ${code}`).toContain(`"${code}"`);
    const proxy = read('demos', 'backend', 'services', 'voice_proxy.py');
    expect(/^DEMO_MAX_CLIENT_MESSAGE_BYTES = 32 \* 1024/m.test(proxy)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Part B — fixtures against a page
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Runs `fetch` in the page and returns status, content type and body text (or `network` when it rejects). */
async function pageFetch(page: Page, url: string) {
  return page.evaluate(async (u) => {
    try {
      const r = await fetch(u);
      return { status: r.status, type: r.headers.get('content-type') ?? '', cache: r.headers.get('cache-control') ?? '', text: await r.text() };
    } catch (e) {
      return { status: 0, type: 'network', cache: '', text: String(e) };
    }
  }, url);
}

const pageJson = async (page: Page, url: string) => {
  const r = await pageFetch(page, url);
  return { ...r, json: r.status === 200 ? JSON.parse(r.text) : null };
};

/** A same-origin document that loads no app code: enough for fetches and WebSockets, and fast. */
const blank = (page: Page) => page.goto('/favicon.svg');

/**
 * Navigates to a served document and returns once its <head> is parsed. The app's own scripts are not awaited (a cold
 * Vite compiles them on first use, which can take longer than a test): these tests only read the document.
 */
const gotoDocument = async (page: Page, url: string) => {
  await page.goto(url, { waitUntil: 'commit' });
  await page.locator('#root').waitFor({ state: 'attached' });
};

const readBootIn = (page: Page) => page.evaluate(async () => {
  const modPath = '/src/services/boot.ts';
  const mod = await import(/* @vite-ignore */ modPath);
  return mod.readBoot();
});

test.describe('mockBoot', () => {
  test('injects the block the server would send; readBoot() parses it in the page', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const source = { catalog: 'demo' as const, demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300, demoRemainingToday: 12 };
    await mockApi(page, 'visitor', source);
    const boot = await mockBoot(page, {}, source);
    await gotoDocument(page, '/');
    const text = await readBootText(page);
    expect(text).not.toBeNull();
    expect(JSON.parse(text!)).toEqual(bootPayload({}, source));
    expect(boot.documents).toBeGreaterThan(0);
    expect(boot).toMatchObject({ markerSeen: true, markerCount: 1 });
    const parsed = await readBootIn(page);
    expect(parsed).toMatchObject({ v: 1, ok: true, demo: { enabled: true, session_seconds: 300, remaining_today: 12 } });
    expect(parsed.live_demo_decks.map((d: { deck_id: string }) => d.deck_id)).toEqual(['deck-demo-en', 'deck-demo-fr']);
    expect(await page.locator(`#${BOOT_ELEMENT_ID}`).count()).toBe(1);
    expect(errors).toEqual([]);
  });

  test('the dev-served index.html carries exactly one <!--OZ_BOOT--> marker — on /, on a client route and on /index.html', async ({ request }) => {
    for (const url of ['/', '/index.html', '/decks/deck-live/present']) {
      const html = await (await request.get(url)).text();
      expect(html.split(BOOT_MARKER).length - 1, url).toBe(1);
      expect(html, url).not.toContain(`id="${BOOT_ELEMENT_ID}"`); // nothing is injected without mockBoot
    }
  });

  test('an explicit /index.html is rewritten like any client route', async ({ page }) => {
    await mockApi(page, 'visitor');
    const boot = await mockBoot(page, { demo: { remaining_today: 7 } });
    await gotoDocument(page, '/index.html');
    expect(JSON.parse((await readBootText(page))!).demo.remaining_today).toBe(7);
    expect(boot).toMatchObject({ markerSeen: true, markerCount: 1 });
  });

  test('a document without the marker is served unchanged: no element is invented (like the server)', async ({ page }) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>No marker</title></head><body><div id="root">plain</div></body></html>');
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const { port } = server.address() as AddressInfo;
      const boot = await mockBoot(page, {});
      await page.goto(`http://127.0.0.1:${port}/`);
      expect(boot).toMatchObject({ documents: 1, markerSeen: false, markerCount: 0, lastTag: null });
      expect(await readBootText(page)).toBeNull();
      expect(await page.locator('#root').textContent()).toBe('plain');
      expect(await page.content()).not.toContain(BOOT_ELEMENT_ID);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  test("a deck title cannot break out of the element (</script>, &, U+2028)", async ({ page }) => {
    const title = '</script><script>window.__pwned = 1</script> & \u2028 end';
    await mockApi(page, 'visitor');
    await mockBoot(page, { live_demo_decks: [{ deck_id: 'deck-x', language: 'en-US', title }] });
    await gotoDocument(page, '/');
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(JSON.parse((await readBootText(page))!).live_demo_decks[0].title).toBe(title);
  });

  test("'absent', 'fallback' and a malformed body all read as null", async ({ page }) => {
    await mockApi(page, 'visitor');
    // handlers stack: the last mockBoot wins for the next navigation
    const absent = await mockBoot(page, 'absent');
    await gotoDocument(page, '/');
    expect(await readBootText(page)).toBeNull();
    expect(await readBootIn(page)).toBeNull();
    expect(absent).toMatchObject({ markerSeen: true, markerCount: 1, lastTag: null }); // served unchanged: the marker stays a comment

    await mockBoot(page, 'fallback');
    await gotoDocument(page, '/');
    expect(JSON.parse((await readBootText(page))!)).toMatchObject({ ok: false, demo: { enabled: false }, live_demo_decks: [] });
    expect(await readBootIn(page)).toBeNull();

    await mockBoot(page, { raw: '{oops' });
    await gotoDocument(page, '/');
    expect(await readBootText(page)).toBe('{oops');
    expect(await readBootIn(page)).toBeNull();
  });
});

test.describe('mockDemoSocket', () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page, 'visitor');
  });

  for (const { code, reason } of DEMO_SCRIPTED_CLOSES) {
    test(`close ${code} reaches the page's onclose`, async ({ page }) => {
      const mock = await mockDemoSocket(page, { onOpen: { close: code, reason, afterMs: 60 } });
      await blank(page);
      const probe = demoProbe(page);
      await probe.open();
      expect(await probe.waitForClose()).toEqual({ code, reason, wasClean: true, opened: true });
      expect(mock.connections).toBe(1);
      expect(mock.closes).toEqual([{ code, reason }]);
      expect(mock.urls[0]).toContain('deck_id=deck-live');
    });
  }

  test('1006: the handshake is refused (onopen never fires), in either order with the socket mock', async ({ page }) => {
    await refuseDemoHandshake(page, { afterMs: 50 });
    const mock = await mockDemoSocket(page, {});
    await blank(page);
    const first = demoProbe(page);
    await first.open();
    expect(await first.waitForClose()).toMatchObject({ code: 1006, opened: false });
    expect(mock.connections).toBe(0);

    const other = await page.context().newPage();
    await mockApi(other, 'visitor');
    const otherMock = await mockDemoSocket(other, {});
    await refuseDemoHandshake(other, { afterMs: 50 });
    await blank(other);
    const second = demoProbe(other);
    await second.open();
    expect(await second.waitForClose()).toMatchObject({ code: 1006, opened: false });
    expect(otherMock.connections).toBe(0);
  });

  test('protocol v2: started, captions, word timestamps, narration complete, idle close', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 2, idleCloseMs: 1500 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    const started = await probe.waitForMessage('demo.started');
    expect(started).toMatchObject({
      protocol: 2, session_seconds: 300, slide_count: 2, idle_close_seconds: 30, narration_chars: expect.any(Array),
    });
    expect((await probe.messages()).map((m) => m.type).slice(0, 2)).toEqual(['demo.started', 'proxy.connected']);

    await probe.send({ type: 'demo.speak', slide: 0, request_id: 'r1' });
    expect(await probe.waitForMessage('demo.speaking')).toMatchObject({ slide: 0, request_id: 'r1', remaining: 3 });
    await probe.waitForMessage('response.done');
    const messages = await probe.messages();
    const turn = mock.turns[0];
    const captions = messages.filter((m) => m.type === 'demo.caption');
    expect(captions.every((c) => c.kind === 'narration' && c.slide === 0 && c.response_id === turn.responseId)).toBe(true);
    const deltas = captions.filter((c) => !c.final).map((c) => c.text).join('');
    const final = captions.filter((c) => c.final);
    expect(final).toHaveLength(1);
    expect(final[0].text).toBe(turn.text);
    expect(deltas).toBe(turn.text); // appending the deltas reproduces the spoken text
    expect(messages.filter((m) => m.type === 'response.audio_transcript.delta')).toHaveLength(turn.words.length);
    const stamps = messages.filter((m) => m.type === 'response.audio_timestamp.delta');
    expect(stamps.map((m) => m.text)).toEqual(turn.words.map((w) => w.text));
    expect(stamps[1].audio_offset_ms).toBeGreaterThan(stamps[0].audio_offset_ms);
    // the order a client can rely on: response.created … transcript.done … caption(final) … response.done
    const order = messages.map((m) => m.type);
    expect(order.indexOf('response.created')).toBeLessThan(order.indexOf('response.audio_transcript.delta'));
    expect(order.indexOf('response.audio_transcript.done')).toBeLessThan(order.indexOf('response.done'));
    expect(order).not.toContain('demo.narration_complete'); // slide 0 of 2

    await probe.send({ type: 'demo.speak', slide: 1 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    // scaled by 1500 / 40 000: the estimated audio comes on top of the (scaled) 10 s + 30 s window, unless the generation took longer
    expect(complete).toMatchObject({ slides_spoken: 2, slide_count: 2 });
    expect(complete.idle_close_ms).toBeGreaterThanOrEqual(1500);
    expect(await probe.waitForClose()).toMatchObject({ code: 4002, reason: DEMO_CLOSE_REASONS[4002] });
    const emittedAt = mock.log.find((e) => e.dir === 'out' && e.type === 'demo.narration_complete')!.t;
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    expect(closedAt - emittedAt).toBeGreaterThanOrEqual(complete.idle_close_ms - 10); // never before the deadline
    expect(closedAt - emittedAt).toBeLessThan(complete.idle_close_ms + 800);          // …and on the first check after it
  });

  test('idle close: idle_close_ms = (1.5 s + D) from response.created, then 10 s of audio tail + 30 s idle (reported unscaled)', async ({ page }) => {
    // the first slide is short, so the second response's audio is the one that ends last
    const mock = await mockDemoSocket(page, { slideCount: 2, narrations: ['Hello.', 'A model predicts the next word, again and again.'], idleCloseMs: false }); // real durations; never closes
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.done');
    await probe.send({ type: 'demo.speak', slide: 1 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    const at = (type: string, n = 1) => mock.log.filter((e) => e.dir === 'out' && e.type === type)[n - 1].t;
    const elapsed = at('demo.narration_complete') - at('response.created', 2);
    const expected = expectedIdleCloseMs(mock.turns[1].endMs, undefined, elapsed);
    expect(Math.abs(complete.idle_close_ms - expected)).toBeLessThanOrEqual(25);
    // 40 s + 1.5 s + D, minus the (short) generation time
    expect(complete.idle_close_ms).toBeGreaterThan((DEMO_IDLE_CLOSE_SECONDS + DEMO_AUDIO_TAIL_GRACE_SECONDS + DEMO_FIRST_AUDIO_LATENCY_SECONDS) * 1000);
    expect(mock.closes).toEqual([]);
  });

  test('protocol v2: demo.finish closes with 4001 at once, whatever the session is doing', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: false, responseMs: 1500 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.created'); // a response is in flight
    await probe.send({ type: 'demo.finish' });
    expect(await probe.waitForClose()).toMatchObject({ code: 4001, reason: 'Demo finished', opened: true });
    expect(mock.closes).toEqual([{ code: 4001, reason: 'Demo finished' }]);
  });

  test('idle close: a rejected or dropped message never moves the deadline and never holds the slot', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 4000 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    await page.waitForTimeout(2800); // the original deadline is ≥ 4 s after the narration completed
    await probe.send({ type: 'demo.speak', slide: 99 });   // invalid slide: dropped silently
    await probe.send({ type: 'nope.unknown' });            // unknown type: dropped
    for (const forced of ['speak_limit', 'rate_limited', 'empty_slide'] as const) {
      mock.options.speak = forced;                         // notices
      await probe.send({ type: 'demo.speak', slide: 0 });
    }
    await probe.send({ type: 'qa.ask_text', request_id: 'bad id!', slide: 0, text: 'x' }); // qa.error bad_state, request_id null
    await probe.send({ type: 'qa.commit', request_id: 'no-question' });                     // no active question: bad_state
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    const startedAt = mock.log.find((e) => e.dir === 'out' && e.type === 'demo.narration_complete')!.t;
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    expect(mock.log.filter((e) => e.dir === 'in' && e.t > startedAt)).toHaveLength(7); // all of them reached the server in time
    expect((await probe.messages()).filter((m) => m.type === 'qa.error').map((m) => [m.request_id, m.code])).toEqual([[null, 'bad_state'], ['no-question', 'bad_state']]);
    expect(closedAt - startedAt).toBeGreaterThanOrEqual(complete.idle_close_ms - 10);
    // a moved deadline would have come ≥ 3 s after these messages, i.e. ≥ 5.8 s after the narration completed
    expect(closedAt - startedAt).toBeLessThan(complete.idle_close_ms + 1000);
  });

  test('idle close: an empty last slide completes the narration right after its notice', async ({ page }) => {
    const longNarration = Array.from({ length: 60 }, () => 'word').join(' '); // D ≈ 21 s: still being spoken at the notice
    const mock = await mockDemoSocket(page, { slideCount: 2, narrations: [longNarration, ''], idleCloseMs: false });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.done');
    await probe.send({ type: 'demo.speak', slide: 1, request_id: 'r-empty' });
    const complete = await probe.waitForMessage('demo.narration_complete');
    const messages = await probe.messages();
    const types = messages.map((m) => m.type);
    expect(types.indexOf('demo.notice')).toBeLessThan(types.indexOf('demo.narration_complete'));
    expect(messages.find((m) => m.type === 'demo.notice')).toMatchObject({ code: 'empty_slide', slide: 1, request_id: 'r-empty' });
    expect(complete).toMatchObject({ slides_spoken: 1, slide_count: 2 });
    // slide 0's audio is still playing: the deadline starts at its estimated end (1.5 s + D), not at the notice
    expect(complete.idle_close_ms).toBeGreaterThan(50_000);
    expect(complete.idle_close_ms).toBeLessThanOrEqual(expectedIdleCloseMs(mock.turns[0].endMs));
  });

  test('idle close: a question being answered holds the slot; the answer moves the deadline to its own end + the window', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 3000, qaDelaysMs: { transcript: 150, answer: 3700 } });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    await probe.send({ type: 'qa.ask_text', request_id: 'q1', slide: 0, text: 'Why?' });
    await probe.waitForMessage('qa.accepted');
    await probe.waitForMessage('qa.answer', { timeout: 10_000 }); // ~3.7 s after the narration completed: past the original deadline (≤ 3.5 s)
    expect(mock.closes).toEqual([]);                              // it was processing: nothing closed the session
    const at = (type: string) => mock.log.find((e) => e.dir === 'out' && e.type === type)!.t;
    expect(at('qa.answer') - at('demo.narration_complete')).toBeGreaterThan(complete.idle_close_ms);
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    const answerDoneAt = mock.log.filter((e) => e.dir === 'out' && e.type === 'response.done').pop()!.t;
    expect(closedAt - answerDoneAt).toBeGreaterThanOrEqual(3000 - 10); // the answer's turn: its anchor + the (scaled) 10 s + 30 s
  });

  test('idle close: listening holds the slot until the question is cancelled; a terminal question event moves the deadline to now + 30 s', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 3000 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete'); // deadline ≥ 3 s later
    await probe.send({ type: 'qa.begin', request_id: 'v1', slide: 0, mode: 'after_slide' });
    await probe.waitForMessage('qa.ready');
    await page.waitForTimeout(complete.idle_close_ms + 500);
    expect(mock.closes).toEqual([]); // listening: the visitor is about to speak
    await probe.send({ type: 'qa.cancel', request_id: 'v1' });
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    const cancelledAt = mock.log.find((e) => e.dir === 'in' && e.type === 'qa.cancel')!.t;
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    expect(closedAt - cancelledAt).toBeGreaterThanOrEqual(2250 - 10); // now + the scaled 30 s (3000 × 30 / 40)
    expect(closedAt - cancelledAt).toBeLessThan(2250 + 800);
  });

  test('idle close: a refused question (a terminal question event) pushes the deadline to now + 30 s', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 4000 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete'); // deadline ≥ 4 s later
    await page.waitForTimeout(2200);
    await probe.send({ type: 'qa.ask_text', request_id: 't1', slide: 0, text: 'x'.repeat(DEMO_MAX_TEXT_QUESTION_CHARS + 1) });
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 't1', code: 'too_long' });
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    const errorAt = mock.log.find((e) => e.dir === 'out' && e.type === 'qa.error')!.t;
    const completeAt = mock.log.find((e) => e.dir === 'out' && e.type === 'demo.narration_complete')!.t;
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    expect(closedAt - errorAt).toBeGreaterThanOrEqual(3000 - 10);          // now + the scaled 30 s (4000 × 30 / 40)
    expect(closedAt - completeAt).toBeGreaterThan(complete.idle_close_ms); // later than the original deadline
  });

  test('idle close: a response in flight holds the slot; its completion moves the deadline', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 3000 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete'); // deadline ≥ 3 s later
    mock.options.responseMs = 3700;                                         // the next response takes a while to generate
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.done', { n: 2, timeout: 10_000 }); // ≈ 3.7 s later: past the original deadline (≤ 3.5 s)
    expect(mock.closes).toEqual([]);
    const at = (type: string, n = 1) => mock.log.filter((e) => e.dir === 'out' && e.type === type)[n - 1].t;
    expect(at('response.done', 2) - at('demo.narration_complete')).toBeGreaterThan(complete.idle_close_ms);
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    expect(mock.log.find((e) => e.dir === 'close')!.t - at('response.done', 2)).toBeGreaterThanOrEqual(3000 - 10); // done + the scaled 40 s
  });

  test('v1.3 demo.activity: ignored before narration_complete; after it the deadline moves to now + 30 s, announced as demo.idle (never a reply), at most once per 5 s', async ({ page }) => {
    // idleCloseMs 8000 scales every idle duration by 0.2: the 30 s window is 6 s, the 1 s announcement step 200 ms, the 5 s rate limit 1 s
    const mock = await mockDemoSocket(page, { slideCount: 2, idleCloseMs: 8000 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.activity' });                 // before the narration is complete: ignored
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.done');
    await probe.send({ type: 'demo.activity' });                 // slide 0 of 2: the narration is still not complete
    await probe.send({ type: 'demo.speak', slide: 1 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    expect(complete.idle_close_ms).toBeGreaterThanOrEqual(8000);
    await page.waitForTimeout(600);
    expect((await probe.messages()).map((m) => m.type), 'nothing moved the deadline').not.toContain('demo.idle');

    await page.waitForTimeout(3000);                             // the original deadline is ≥ 8 s after the narration completed
    await probe.send({ type: 'demo.activity' });                 // honoured: now + 6 s, later than the original deadline
    const first = await probe.waitForMessage('demo.idle');
    expect(first.idle_close_ms).toBeGreaterThan(5500);
    expect(first.idle_close_ms).toBeLessThanOrEqual(6000);
    await page.waitForTimeout(400);
    await probe.send({ type: 'demo.activity' });                 // 0.5 s after the honoured one: rate-limited, ignored
    await page.waitForTimeout(800);
    expect((await probe.messages()).filter((m) => m.type === 'demo.idle'), 'an ignored activity moves nothing').toHaveLength(1);
    await probe.send({ type: 'demo.activity' });                 // 1.4 s after it: honoured again
    const second = await probe.waitForMessage('demo.idle', { n: 2 });
    expect(second.idle_close_ms).toBeGreaterThan(5500);
    expect(second.idle_close_ms).toBeLessThanOrEqual(6000);
    const messages = await probe.messages();
    expect(messages.map((m) => m.type)).not.toContain('demo.activity');                       // never echoed or answered
    expect(messages.filter((m) => m.type === 'qa.error' || m.type === 'demo.notice')).toEqual([]);
    expect(mock.ofType('demo.activity')).toHaveLength(5);        // every frame was recorded
  });

  test('v1.3 demo.activity: ignored when no question can be asked (the typed question is disabled)', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, idleCloseMs: 4000, qaAskText: 'disabled' });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    const complete = await probe.waitForMessage('demo.narration_complete');
    await page.waitForTimeout(complete.idle_close_ms - 1500);
    await probe.send({ type: 'demo.activity' });                 // no question can be asked: no extension, no announcement
    expect(await probe.waitForClose(10_000)).toMatchObject({ code: 4002 });
    const completeAt = mock.log.find((e) => e.dir === 'out' && e.type === 'demo.narration_complete')!.t;
    const closedAt = mock.log.find((e) => e.dir === 'close')!.t;
    expect(closedAt - completeAt).toBeLessThan(complete.idle_close_ms + 800);   // the original deadline, not now + 3 s
    expect((await probe.messages()).map((m) => m.type)).not.toContain('demo.idle');
  });

  test('v1.3 demo.idle: the helper pushes it to the page', async ({ page }) => {
    const mock = await mockDemoSocket(page, { idleCloseMs: false });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    mock.idle(123_456);
    expect(await probe.waitForMessage('demo.idle')).toEqual({ type: 'demo.idle', idle_close_ms: 123_456 });
  });

  test('response.cancel: the response in flight ends with response.done "cancelled", with no further and no final caption', async ({ page }) => {
    const mock = await mockDemoSocket(page, { slideCount: 1, responseMs: 1500, idleCloseMs: false });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('demo.caption'); // the first word has been spoken
    await probe.send({ type: 'response.cancel' });
    const done = await probe.waitForMessage('response.done');
    expect(done.response).toEqual({ id: mock.turns[0].responseId, status: 'cancelled' });
    expect(mock.turns[0].status).toBe('cancelled');
    await page.waitForTimeout(600); // the generation would have run for another second
    const messages = await probe.messages();
    const doneAt = messages.findIndex((m) => m.type === 'response.done');
    expect(messages.slice(doneAt + 1)).toEqual([]);                                       // nothing after it: no more deltas or captions
    expect(messages.filter((m) => m.type === 'demo.caption' && m.final)).toEqual([]);      // never a final caption for a cancelled turn
    expect(messages.map((m) => m.type)).not.toContain('response.audio_transcript.done');
    expect(messages.map((m) => m.type)).not.toContain('demo.narration_complete');          // only a completed response completes the narration
    // nothing in flight: a second cancel is ignored
    await probe.send({ type: 'response.cancel' });
    await page.waitForTimeout(150);
    expect(await probe.messages()).toHaveLength(messages.length);
    // speaking the slide again completes the narration
    mock.options.responseMs = 0;
    await probe.send({ type: 'demo.speak', slide: 0 });
    expect(await probe.waitForMessage('demo.narration_complete')).toMatchObject({ slides_spoken: 1, slide_count: 1 });
    expect(mock.turns.map((t) => t.status)).toEqual(['cancelled', 'completed']);
  });

  test('qa.ask_text: accepted → transcript → answer (+ answer captions), quota and errors', async ({ page }) => {
    // slow enough answers that "while q-2 is being answered" holds whatever the machine does between two test steps
    const mock = await mockDemoSocket(page, { remainingQuestions: 2, idleCloseMs: false, qaDelaysMs: { transcript: 40, answer: 1500 } });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'qa.ask_text', request_id: 'q-1', slide: 1, text: '  What is an agent?  ' });
    const accepted = await probe.waitForMessage('qa.accepted');
    expect(accepted).toMatchObject({ request_id: 'q-1', remaining_questions: 1, remaining_ms: expect.any(Number) });
    await probe.waitForMessage('qa.answer');
    await probe.waitForMessage('response.done');
    const messages = await probe.messages();
    const types = messages.map((m) => m.type);
    expect(types.indexOf('qa.accepted')).toBeLessThan(types.indexOf('qa.transcript'));
    expect(types.indexOf('qa.transcript')).toBeLessThan(types.indexOf('qa.answer'));
    expect(messages.find((m) => m.type === 'qa.transcript')).toMatchObject({ request_id: 'q-1', text: 'What is an agent?' }); // trimmed echo
    const answer = messages.find((m) => m.type === 'qa.answer');
    expect(answer).toMatchObject({ request_id: 'q-1', grounded: true, source_slides: [0] });
    expect(messages.find((m) => m.type === 'demo.caption' && m.final)).toMatchObject({ kind: 'answer', slide: null, text: answer.text });
    expect(messages.some((m) => m.type === 'qa.ready')).toBe(false); // no spoken invite on the text path
    expect(mock.turns.map((t) => t.kind)).toEqual(['answer']);

    await probe.send({ type: 'qa.ask_text', request_id: 'q-2', slide: 1, text: 'And a model?' }); // q-1 is `answered`: an implicit resume
    expect(await probe.waitForMessage('qa.accepted', { n: 2 })).toMatchObject({ request_id: 'q-2', remaining_questions: 0 });
    // while q-2 is being answered another question is not valid right now: the state check comes before the limits
    await probe.send({ type: 'qa.ask_text', request_id: 'q-2b', slide: 1, text: 'Too early?' });
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 'q-2b', code: 'bad_state' });
    await probe.waitForMessage('qa.answer', { n: 2 });
    await probe.send({ type: 'qa.ask_text', request_id: 'q-3', slide: 1, text: 'One more?' });
    expect(await probe.waitForMessage('qa.error', { n: 2 })).toMatchObject({ request_id: 'q-3', code: 'limit', scope: 'session', message: SERVER_QA_ERRORS.limit });
    await probe.send({ type: 'qa.ask_text', request_id: 'q-4', slide: 1, text: 'x'.repeat(DEMO_MAX_TEXT_QUESTION_CHARS + 1) });
    expect(await probe.waitForMessage('qa.error', { n: 3 })).toMatchObject({ request_id: 'q-4', code: 'too_long', message: DEMO_TEXT_TOO_LONG_MESSAGE });
    await probe.send({ type: 'qa.ask_text', request_id: 'bad id!', slide: 1, text: 'hello' });
    expect(await probe.waitForMessage('qa.error', { n: 4 })).toMatchObject({ request_id: null, code: 'bad_state' });
    await probe.send({ type: 'qa.ask_text', request_id: 'q-5', slide: 1, text: '   ' });
    expect(await probe.waitForMessage('qa.error', { n: 5 })).toMatchObject({ request_id: 'q-5', code: 'no_speech' });
    expect(mock.ofType('qa.ask_text')).toHaveLength(7);
  });

  test('qa.ask_text: time_low, scripted refusals and a silent server', async ({ page }) => {
    const mock = await mockDemoSocket(page, { remainingMs: 20_000, idleCloseMs: false });
    await blank(page);
    const probe = demoProbe(page);
    const ask = async () => {
      await probe.open();
      await probe.waitForMessage('demo.started');
      await probe.send({ type: 'qa.ask_text', request_id: 'q-1', slide: 0, text: 'Anything?' });
    };
    await ask();
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 'q-1', code: 'time_low', message: SERVER_QA_ERRORS.time_low });

    mock.options.remainingMs = undefined; // the options are live: the next connection starts with the full session
    mock.options.qaAskText = 'daily';
    await ask();
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 'q-1', code: 'limit', scope: 'daily', message: DEMO_QA_LIMIT_MESSAGES.daily });
    mock.options.qaAskText = 'quota-store';
    await ask();
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 'q-1', code: 'limit', scope: 'unavailable', message: DEMO_QA_LIMIT_MESSAGES.unavailable });
    mock.options.qaAskText = 'disabled';
    await ask();
    expect(await probe.waitForMessage('qa.error')).toMatchObject({ request_id: 'q-1', code: 'disabled' });

    mock.options.qaAskText = 'silent';
    await ask();
    await page.waitForTimeout(300);
    expect((await probe.messages()).some((m) => m.type.startsWith('qa.'))).toBe(false);
    expect(mock.connections).toBe(5);
  });

  test('qa.begin (voice): the per-session, daily and quota-store limits carry their scope', async ({ page }) => {
    const mock = await mockDemoSocket(page, { idleCloseMs: false });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    const scopes = ['session', 'daily', 'unavailable'] as const;
    const modes = { session: 'limit', daily: 'daily', unavailable: 'quota-store' } as const;
    for (const [i, scope] of scopes.entries()) {
      mock.options.qaBegin = modes[scope];
      await probe.send({ type: 'qa.begin', request_id: `v-${i}`, slide: 0, mode: 'after_slide' });
      expect(await probe.waitForMessage('qa.error', { n: i + 1 })).toMatchObject({
        request_id: `v-${i}`, code: 'limit', scope, message: DEMO_QA_LIMIT_MESSAGES[scope],
      });
    }
  });

  test('protocol v1 (an old server): no v2 fields, captions, narration_complete, qa.ask_text, demo.activity or demo.finish', async ({ page }) => {
    const mock = await mockDemoSocket(page, { protocol: 1, slideCount: 1, idleCloseMs: 300 });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    const started = await probe.waitForMessage('demo.started');
    expect(started.protocol).toBeUndefined();
    expect(started.slide_count).toBeUndefined();
    expect(started.idle_close_seconds).toBeUndefined();
    await probe.send({ type: 'demo.speak', slide: 0 });
    await probe.waitForMessage('response.done');
    await probe.send({ type: 'qa.ask_text', request_id: 'q-1', slide: 0, text: 'Hello?' });
    await probe.send({ type: 'demo.activity' });
    await probe.send({ type: 'demo.finish' });
    await page.waitForTimeout(500); // longer than idleCloseMs: nothing closes a v1 session
    const types = (await probe.messages()).map((m) => m.type);
    expect(types).toContain('response.audio_transcript.done');
    for (const missing of ['demo.caption', 'demo.narration_complete', 'demo.idle', 'qa.accepted', 'qa.error']) expect(types).not.toContain(missing);
    expect(mock.closes).toEqual([]);
    expect(mock.ofType('qa.ask_text')).toHaveLength(1); // the client sent it; the old server dropped it
    expect(mock.ofType('demo.activity')).toHaveLength(1);
  });

  test('error event, silent server, no ICE servers, ICE servers, notices and scripted mid-session closes', async ({ page }) => {
    // The avatar service refused the connection: demo.started (sent right after accept), then the generic error — no
    // proxy.connected — then 1011, like the target server.
    const mock = await mockDemoSocket(page, { onOpen: { error: GENERIC_PROXY_ERROR } });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    expect(await probe.waitForMessage('error')).toEqual({ type: 'error', error: { message: GENERIC_PROXY_ERROR } });
    expect(await probe.waitForClose()).toMatchObject({ code: 1011, reason: 'Demo session error', opened: true });
    expect((await probe.messages()).map((m) => m.type)).toEqual(['demo.started', 'error']);
    expect(mock.closes.map((c) => c.code)).toEqual([1011]);

    // an Azure error on a connected session, closed the way today's server does (a bare 1000)
    mock.options.onOpen = { error: 'Rate limit exceeded', connected: true, closeCode: 1000 };
    await probe.open();
    expect(await probe.waitForClose()).toMatchObject({ code: 1000, opened: true });
    expect((await probe.messages()).map((m) => m.type)).toEqual(['demo.started', 'proxy.connected', 'error']);

    mock.options.onOpen = 'silent'; // the options are live: each connection reads them when it opens
    await probe.open();
    await probe.waitForMessage('demo.started');
    await page.waitForTimeout(250);
    expect((await probe.messages()).map((m) => m.type)).toEqual(['demo.started']); // the Azure connection hangs: nothing else

    mock.options.onOpen = 'no-ice';
    await probe.open();
    const bare = await probe.waitForMessage('session.updated');
    expect(bare.session.avatar.ice_servers).toBeUndefined(); // connected, but the avatar never gets a media path
    expect((await probe.messages()).map((m) => m.type).slice(0, 3)).toEqual(['demo.started', 'proxy.connected', 'session.updated']);

    mock.options.onOpen = 'ice';
    await probe.open();
    const updated = await probe.waitForMessage('session.updated');
    expect(updated.session.avatar.ice_servers[0].urls[0]).toMatch(/^turn:127\.0\.0\.1:/);

    mock.options.onOpen = 'session';
    mock.options.speak = 'speak_limit';
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0, request_id: 'r9' });
    expect(await probe.waitForMessage('demo.notice')).toMatchObject({ code: 'speak_limit', slide: 0, request_id: 'r9' });

    mock.options.speak = 'speak';
    mock.options.closeAt = { code: 1011, on: 'first-speak' };
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });
    expect(await probe.waitForClose()).toMatchObject({ code: 1011, reason: 'Demo session error' });

    mock.options.closeAt = { code: 4408, on: 150 };
    await probe.open();
    expect(await probe.waitForClose()).toMatchObject({ code: 4408, reason: 'Demo time limit reached' });
  });

  test('silent: demo.started then nothing — and demo.finish is still honoured (4001) before proxy.connected', async ({ page }) => {
    const mock = await mockDemoSocket(page, { onOpen: 'silent' });
    await blank(page);
    const probe = demoProbe(page);
    await probe.open();
    await probe.waitForMessage('demo.started');
    await probe.send({ type: 'demo.speak', slide: 0 });                                          // nobody reads these yet
    await probe.send({ type: 'qa.ask_text', request_id: 'q1', slide: 0, text: 'Hello?' });
    await page.waitForTimeout(300);
    expect((await probe.messages()).map((m) => m.type)).toEqual(['demo.started']);
    await probe.send({ type: 'demo.finish' });
    expect(await probe.waitForClose()).toMatchObject({ code: 4001, reason: 'Demo finished', opened: true });
    expect(mock.ofType('demo.speak')).toHaveLength(1);                                          // it arrived and was ignored
    expect((await probe.messages()).map((m) => m.type)).toEqual(['demo.started']);
    expect(mock.closes).toEqual([{ code: 4001, reason: 'Demo finished' }]);
  });

  test('the demo page speaks protocol v2 with the fixtures (UI smoke: one Start tap presents the first slide)', async ({ page }) => {
    test.setTimeout(75_000); // loads the whole app: a cold Vite compiles it on first use
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockApi(page, 'visitor', { demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300 });
    const mock = await mockDemoSocket(page, { slideCount: 3, idleCloseMs: false });
    await page.goto('/decks/deck-live/present', { waitUntil: 'domcontentloaded' });
    const start = page.getByTestId('demo-start');
    await expect(start).toBeVisible({ timeout: 30_000 });
    await start.click();
    await expect.poll(() => mock.connections).toBe(1);
    await demoHooks.connected(page);
    // One Start tap = connect + present every slide: the first narration is requested without another tap.
    await mock.waitForSent('demo.speak');
    expect(mock.ofType('demo.speak')[0].slide).toBe(0);
    await expect.poll(() => mock.items.length).toBe(1);
    await demoHooks.finishLastTurn(page, mock);
    expect(errors).toEqual([]);
  });

  test('refusing the handshake leaves the demo page usable (outcome card + one retry)', async ({ page }) => {
    test.setTimeout(75_000); // loads the whole app: a cold Vite compiles it on first use
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await refuseDemoHandshake(page, { afterMs: 80 });
    await page.goto('/decks/deck-live/present', { waitUntil: 'domcontentloaded' });
    const start = page.getByTestId('demo-start');
    await expect(start).toBeVisible({ timeout: 30_000 });
    await start.click();
    await expect(page.getByTestId('demo-outcome')).toHaveAttribute('data-outcome', /^(connect|outage)$/, { timeout: 10_000 });
    // The card's own retry replaces the dock's Start, so only one retry action is offered.
    await expect(page.getByTestId('demo-outcome-retry')).toBeVisible({ timeout: 10_000 });
    await expect(start).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test.describe('mockApi additions', () => {
  test('public DTO fields: level, source deck, captions URL, slide text', async ({ page }) => {
    await mockApi(page, 'visitor', { podcastV2: true });
    await blank(page);
    const podcasts = (await pageJson(page, '/api/podcast/library')).json as Record<string, any>[];
    const byId = Object.fromEntries(podcasts.map((p) => [p.job_id, p]));
    expect(byId['pod-3']).toMatchObject({ audience_level: 'beginner', source_deck_id: null, captions_vtt_url: null, language: 'fr-FR' });
    expect(byId['pod-2']).toMatchObject({ audience_level: null, source_deck_id: null, captions_vtt_url: '/api/podcast/library/pod-2/captions.vtt' });
    const detail = (await pageJson(page, '/api/podcast/library/pod-2')).json;
    expect(detail.captions_vtt_url).toBe('/api/podcast/library/pod-2/captions.vtt');
    expect(detail).not.toHaveProperty('srt_url', '/media/pod-2.srt'); // the public DTO still hides the SRT

    const videos = (await pageJson(page, '/api/video/library')).json as Record<string, any>[];
    expect(videos[0]).toMatchObject({
      job_id: 'vid-1', audience_level: 'practitioner', source_deck_id: null, captions_vtt_url: '/api/video/library/vid-1/captions.vtt',
    });
    expect((await pageJson(page, '/api/video/library/vid-1')).json.video_url).toBe('/media/vid-1.mp4');

    const decks = (await pageJson(page, '/api/decks')).json as Record<string, any>[];
    expect(decks.map((d) => [d.deck_id, d.audience_level])).toEqual([['deck-live', 'beginner'], ['deck-plain', null]]);
    const deck = (await pageJson(page, '/api/decks/deck-live')).json;
    expect(deck.slides[0]).toEqual({ index: 0, title: 'Slide title 1', image_url: '', text: 'Body 1' });
    for (const s of deck.slides) {
      expect(Object.keys(s).sort()).toEqual(['image_url', 'index', 'text', 'title']); // never body / notes / translated_notes
      expect(s.text.length).toBeLessThanOrEqual(PUBLIC_SLIDE_TEXT_MAX);
    }
    // the public `filename` carries the display TITLE, never the uploaded file name; admins keep the file name
    expect(deck.filename).toBe('ai-fundamentals');
    expect(deck.title).toBe('ai-fundamentals');
    const asAdmin = await page.context().newPage();
    await mockApi(asAdmin, 'admin');
    await blank(asAdmin);
    const full = (await pageJson(asAdmin, '/api/decks/deck-live')).json;
    expect(full.filename).toBe('ai-fundamentals.pptx');
    expect(Object.keys(full.slides[0]).sort()).toEqual(['body', 'index', 'notes', 'title', 'translated_notes']); // admin payload unchanged: no `text`
  });

  test('captions.vtt is same-origin WebVTT for published items that have captions', async ({ page }) => {
    await mockApi(page, 'visitor', { podcastV2: true });
    await gotoDocument(page, '/');
    const video = await pageFetch(page, '/api/video/library/vid-1/captions.vtt');
    expect(video).toMatchObject({ status: 200, type: 'text/vtt; charset=utf-8', cache: 'public, max-age=600', text: VTT_BODY });
    expect(video.text.startsWith('WEBVTT\n\n')).toBe(true);
    expect((await pageFetch(page, '/api/podcast/library/pod-2/captions.vtt')).status).toBe(200);
    for (const missing of ['/api/podcast/library/pod-3/captions.vtt', '/api/podcast/library/pod-9/captions.vtt', '/api/video/library/vid-9/captions.vtt']) {
      expect((await pageFetch(page, missing)).status, missing).toBe(404);
    }
    // a <track> can load it (same origin, no CORS)
    const trackState = await page.evaluate(async () => {
      const video = document.createElement('video');
      const track = document.createElement('track');
      track.kind = 'captions';
      track.srclang = 'en';
      track.src = '/api/video/library/vid-1/captions.vtt';
      video.appendChild(track);
      document.body.appendChild(video);
      track.track.mode = 'hidden';
      for (let i = 0; i < 50 && !track.track.cues?.length; i += 1) await new Promise((r) => setTimeout(r, 50));
      return { cues: track.track.cues?.length ?? 0 };
    });
    expect(trackState.cues).toBe(2);
  });

  test('list failures: 503 (friendly detail), network, proxy 503, per list, and a retry that succeeds', async ({ page }) => {
    const api = await mockApi(page, 'visitor', { podcastV2: true, libraryFailure: 503 });
    await blank(page);
    for (const url of ['/api/decks', '/api/podcast/library', '/api/video/library']) {
      const r = await pageFetch(page, url);
      expect(r.status, url).toBe(503);
      expect(JSON.parse(r.text)).toEqual({ detail: LIBRARY_UNAVAILABLE_DETAIL });
    }
    api.failures.podcast = 'network';
    expect((await pageFetch(page, '/api/podcast/library')).type).toBe('network');
    api.failures.podcast = 'proxy-503';
    const proxy = await pageFetch(page, '/api/podcast/library');
    expect(proxy).toMatchObject({ status: 503, type: 'text/plain' });
    expect(proxy.text).toMatch(/^upstream connect error/);
    api.failures.podcast = null;
    expect((await pageFetch(page, '/api/podcast/library')).status).toBe(200); // "Try again" works
    expect((await pageFetch(page, '/api/decks')).status).toBe(503); // the others keep failing
    api.failures.decks = null;
    api.failures.video = null;
    expect((await pageFetch(page, '/api/decks')).status).toBe(200);

    const perList = await page.context().newPage();
    await mockApi(perList, 'visitor', { libraryFailure: { video: 'network' } });
    await blank(perList);
    expect((await pageFetch(perList, '/api/video/library')).type).toBe('network');
    expect((await pageFetch(perList, '/api/decks')).status).toBe(200);
  });

  test('detail failures and delays', async ({ page }) => {
    const api = await mockApi(page, 'visitor', { podcastV2: true, detailFailure: { podcast: 404, deck: 503 }, delayMs: { decks: 250 } });
    await blank(page);
    expect(await pageJson(page, '/api/podcast/library/pod-2')).toMatchObject({ status: 404 });
    expect((await pageFetch(page, '/api/podcast/library/pod-2/captions.vtt')).status).toBe(404);
    expect(JSON.parse((await pageFetch(page, '/api/decks/deck-live')).text)).toEqual({ detail: LIBRARY_UNAVAILABLE_DETAIL });
    expect((await pageFetch(page, '/api/video/library/vid-1')).status).toBe(200);
    const t0 = Date.now();
    await pageFetch(page, '/api/decks');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(240);
    api.delays.decks = 0;
    api.detailFailures.podcast = null;
    expect((await pageFetch(page, '/api/podcast/library/pod-2')).status).toBe(200);
  });

  test('/api/me: visitor, admin, and a signed-in guest who is not on the allow-list (T1-12)', async ({ page }) => {
    const api = await mockApi(page, 'visitor', { me: { authenticated: true, name: 'Guest Visitor' } });
    await blank(page);
    expect((await pageJson(page, '/api/me')).json).toEqual({ authenticated: true, is_admin: false, name: 'Guest Visitor', auth_mode: 'easyauth' });
    api.me.authenticated = false;
    api.me.name = null;
    expect((await pageJson(page, '/api/me')).json).toMatchObject({ authenticated: false, is_admin: false, name: null });

    const other = await page.context().newPage();
    await mockApi(other, 'admin');
    await blank(other);
    expect((await pageJson(other, '/api/me')).json).toEqual({ authenticated: true, is_admin: true, name: 'Admin User', auth_mode: 'easyauth' });
  });

  test('/api/demo/config options: enabled, remaining_today, failure', async ({ page }) => {
    const api = await mockApi(page, 'visitor', { demoQa: DEMO_QA_CONFIG, demoSessionSeconds: 300, demoRemainingToday: 17 });
    await blank(page);
    expect((await pageJson(page, '/api/demo/config')).json).toEqual({ enabled: true, session_seconds: 300, qa: DEMO_QA_CONFIG, remaining_today: 17 });
    api.demo.remainingToday = 0;
    expect((await pageJson(page, '/api/demo/config')).json.remaining_today).toBe(0);
    api.demo.enabled = false;
    const off = (await pageJson(page, '/api/demo/config')).json;
    expect(off).toMatchObject({ enabled: false, qa: { enabled: false } });
    expect(off).not.toHaveProperty('remaining_today');
    api.demo.failure = 503;
    expect((await pageFetch(page, '/api/demo/config')).status).toBe(503);

    const legacy = await page.context().newPage();
    await mockApi(legacy, 'visitor');
    await blank(legacy);
    expect((await pageJson(legacy, '/api/demo/config')).json).toEqual({ enabled: true, session_seconds: 180 }); // unchanged default
  });

  test('demo catalog: bilingual live decks with same-title recordings, found by findRecording', async ({ page }) => {
    await mockApi(page, 'visitor', { catalog: 'demo' });
    await blank(page);
    const decks = (await pageJson(page, '/api/decks')).json as { deck_id: string; title: string; language: string; live_demo: boolean }[];
    const videos = (await pageJson(page, '/api/video/library')).json;
    const podcasts = (await pageJson(page, '/api/podcast/library')).json;
    const live = decks.filter((d) => d.live_demo);
    expect(live.map((d) => d.deck_id)).toEqual(['deck-demo-en', 'deck-demo-fr']);
    expect(findRecording(live[0], videos, podcasts)).toMatchObject({ kind: 'video', id: VIDEO_DEMO_EN.job_id, sameLanguage: true });
    expect(findRecording(live[1], videos, podcasts)).toMatchObject({ kind: 'video', id: VIDEO_DEMO_FR.job_id, sameLanguage: true });
    // without the French video, the French podcast of the same title is next
    expect(findRecording(live[1], videos.filter((v: { job_id: string }) => v.job_id !== VIDEO_DEMO_FR.job_id), podcasts)).toMatchObject({ kind: 'podcast', id: 'pod-demo-fr' });
    // levels on the series, the deck detail in French
    const levels = podcasts.filter((p: { audience_level: string | null }) => p.audience_level).map((p: { job_id: string; audience_level: string }) => [p.job_id, p.audience_level]);
    expect(levels).toEqual(expect.arrayContaining([['pod-lvl-1', 'beginner'], ['pod-lvl-2', 'practitioner'], ['pod-lvl-3', 'expert']]));
    const fr = (await pageJson(page, '/api/decks/deck-demo-fr')).json;
    expect(fr).toMatchObject({ language: 'fr-FR', slides: expect.any(Array) });
    expect(fr.slides).toHaveLength(5);
    expect(fr.slides[0].text).toContain('démo en direct');
    // the default catalog is untouched when the option is absent
    const plain = await page.context().newPage();
    await mockApi(plain, 'visitor');
    await blank(plain);
    expect(((await pageJson(plain, '/api/decks')).json as { deck_id: string }[]).map((d) => d.deck_id)).toEqual(['deck-live', 'deck-plain']);
    expect(((await pageJson(plain, '/api/video/library')).json as unknown[]).length).toBe(1);
  });

  test('routeExpiredMedia answers 403 for the first requests only', async ({ page }) => {
    await mockApi(page, 'visitor', { podcastV2: true });
    await routeExpiredMedia(page, '**/media/pod-3.wav', { times: 1 });
    await blank(page);
    expect((await pageFetch(page, '/media/pod-3.wav')).status).toBe(403);
    expect((await pageFetch(page, '/media/pod-3.wav')).status).toBe(200);
  });

  test('mockBoot and mockApi compose in either order (the document is the only thing rewritten)', async ({ page }) => {
    test.setTimeout(60_000); // loads the whole app: a cold Vite compiles it on first use
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await mockBoot(page, { demo: { remaining_today: 3 } });
    const api = await mockApi(page, 'visitor');
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    expect(JSON.parse((await readBootText(page))!).demo.remaining_today).toBe(3);
    expect((await pageFetch(page, '/api/decks')).status).toBe(200);
    expect(api.failures).toEqual({});
    expect(errors).toEqual([]);
  });
});
