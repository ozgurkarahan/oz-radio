import { test, expect, type Page } from '@playwright/test';
import { mockApi, type Role } from './support/mock-api';

/**
 * Phone platform basics (iPhone Safari, Android Chrome): edge-to-edge viewport,
 * no sideways scrolling at phone widths, no iOS focus-zoom on form controls,
 * and safe-area insets around the notch, the home indicator and the mini-player.
 *
 * Emulation notes:
 * - `hasTouch` makes `(pointer: coarse)` match (Chromium and WebKit), so the
 *   touch-only 16px rule is asserted on computed styles.
 * - With `isMobile`, Chromium widens `window.innerWidth` to the content width
 *   when a page overflows, so `scrollWidth <= innerWidth` alone cannot catch
 *   overflow: the layout width (`clientWidth`) is the reference.
 * - Safe-area insets are emulated through the DevTools protocol
 *   (`Emulation.setSafeAreaInsetsOverride`, Chromium only). Real iOS Safari
 *   behaviour still needs a device.
 */

const PHONE = { width: 390, height: 844 };
const SMALL_PHONE = { width: 320, height: 568 };
const ROUTES = ['/', '/podcast/library', '/decks', '/video/library', '/search'];
const MASTHEAD_H = 72;
const SP_5 = 24;
const SP_7 = 48;
const MINI_PLAYER_H = 64;

test.use({ viewport: PHONE, isMobile: true, hasTouch: true });
test.skip(({ browserName }) => browserName === 'firefox', 'Firefox has no isMobile emulation');

async function open(page: Page, role: Role, path: string) {
  await mockApi(page, role);
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/** Resolves a design token (e.g. `var(--fs-body)`) to the pixels it computes to as a font size. */
async function tokenPx(page: Page, value: string) {
  return page.evaluate((v) => {
    const probe = document.createElement('span');
    probe.style.fontSize = v;
    document.body.append(probe);
    const px = parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  }, value);
}

async function fontPx(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

/** Rendered font size of every visible form control on the page. */
async function controlFontSizes(page: Page) {
  const controls = page.locator('.field__control:visible');
  await expect(controls.first()).toBeVisible();
  return controls.evaluateAll((els) => els.map((el) => ({
    control: `${el.tagName.toLowerCase()} "${(el as HTMLInputElement).labels?.[0]?.textContent?.trim()
      || el.getAttribute('placeholder') || el.getAttribute('data-testid') || ''}"`,
    px: parseFloat(getComputedStyle(el).fontSize),
  })));
}

test('viewport meta is edge-to-edge and keeps pinch-zoom', async ({ page }) => {
  await open(page, 'visitor', '/');
  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content).toContain('width=device-width');
  expect(content).toContain('viewport-fit=cover');
  expect(content).not.toMatch(/maximum-scale|user-scalable\s*=\s*(no|0)/);
});

for (const size of [PHONE, SMALL_PHONE]) {
  test.describe(`no horizontal overflow at ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });
    for (const path of ROUTES) {
      test(path, async ({ page }) => {
        await open(page, 'visitor', path);
        const m = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          innerWidth: window.innerWidth,
        }));
        expect(m.clientWidth, 'layout viewport is the device width').toBe(size.width);
        expect(m.scrollWidth, 'page is wider than the screen').toBeLessThanOrEqual(m.clientWidth);
        expect(m.innerWidth, 'page was zoomed out to fit wider content').toBe(size.width);
      });
    }
  });
}

test.describe('touch screens get 16px form controls (no iOS focus zoom)', () => {
  for (const path of ['/search', '/decks/deck-plain/present', '/podcast']) {
    test(`admin ${path}`, async ({ page }) => {
      await open(page, 'admin', path);
      expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'coarse pointer emulated').toBe(true);
      for (const { control, px } of await controlFontSizes(page)) {
        expect(px, control).toBeGreaterThanOrEqual(16);
      }
    });
  }
});

test.describe('desktop (fine pointer) keeps the compact control sizes', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('regular and small fields follow the type tokens', async ({ page }) => {
    await open(page, 'admin', '/podcast');
    expect(await page.evaluate(() => matchMedia('(pointer: fine)').matches)).toBe(true);
    await expect(page.getByLabel('Style', { exact: true })).toBeVisible();
    expect(await page.getByLabel('Style', { exact: true }).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)))
      .toBe(await tokenPx(page, 'var(--fs-body)'));

    await open(page, 'admin', '/decks/deck-plain/present');
    await expect(page.locator('.presenter-settings .field__control').first()).toBeVisible();
    expect(await fontPx(page, '.presenter-settings .field--sm .field__control')).toBe(await tokenPx(page, 'var(--fs-sm)'));
  });
});

test.describe('Teams themes', () => {
  for (const theme of ['teams-dark', 'teams-contrast']) {
    test(`${theme}: masthead strip, touch controls and width follow the theme`, async ({ page }) => {
      await open(page, 'admin', '/search');
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      const colours = await page.evaluate(() => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--c-canvas)';
        document.body.append(probe);
        const bg = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return { bg, masthead: getComputedStyle(document.querySelector('.masthead')!).backgroundColor };
      });
      expect(colours.masthead).toBe(colours.bg);
      expect(await fontPx(page, '[data-testid="search-input"]')).toBeGreaterThanOrEqual(16);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
    });
  }
});

test.describe('safe-area insets (emulated notch and home indicator)', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Safe-area emulation uses the Chromium DevTools protocol');
  // Geometry is read with boundingBox(): skip the menu sheet's slide-in animation.
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  async function setInsets(page: Page, insets: { top: number; right: number; bottom: number; left: number }) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  }

  async function showToast(page: Page) {
    await page.evaluate(() => window.dispatchEvent(
      new CustomEvent('app:auth-error', { detail: { status: 403, url: '/api/decks/upload' } }),
    ));
    const toast = page.getByTestId('auth-toast');
    await expect(toast).toBeVisible();
    return (await toast.boundingBox())!;
  }

  async function openSheet(page: Page) {
    await page.getByRole('button', { name: 'Open menu' }).click();
    const sheet = page.locator('#site-sheet');
    await expect(sheet).toHaveAttribute('data-open', 'true');
    return sheet;
  }

  /** A generic dialog with content taller than any phone. */
  async function injectModal(page: Page) {
    await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.className = 'modal';
      modal.dataset.testid = 'probe-modal';
      modal.innerHTML = '<div class="modal__panel"><div style="height: 2000px"></div></div>';
      document.body.append(modal);
    });
    return page.getByTestId('probe-modal');
  }

  test('without insets the layout is unchanged', async ({ page }) => {
    await open(page, 'visitor', '/');
    const gutter = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.paddingLeft = 'var(--gutter)';
      document.body.append(probe);
      const px = getComputedStyle(probe).paddingLeft;
      probe.remove();
      return px;
    });
    await expect(page.locator('.masthead')).toHaveCSS('padding-top', '0px');
    await expect(page.locator('.masthead__inner')).toHaveCSS('padding-left', gutter);
    await expect(page.locator('.container.page').first()).toHaveCSS('padding-right', gutter);

    const toast = await showToast(page);
    expect(PHONE.width - (toast.x + toast.width)).toBeCloseTo(SP_5, 0);
    expect(PHONE.height - (toast.y + toast.height)).toBeCloseTo(SP_5, 0);

    const sheet = await openSheet(page);
    await expect(sheet).toHaveCSS('top', `${MASTHEAD_H}px`);
    await expect(sheet).toHaveCSS('padding-bottom', `${SP_7}px`);
    await page.getByRole('button', { name: 'Close menu' }).click();

    const modal = await injectModal(page);
    for (const side of ['top', 'right', 'bottom', 'left']) await expect(modal).toHaveCSS(`padding-${side}`, `${SP_5}px`);
    expect((await modal.locator('.modal__panel').boundingBox())!.height).toBeCloseTo(PHONE.height * 0.92, 0);
  });

  test('portrait: masthead, menu sheet, toasts and dialogs clear the status bar, home indicator and mini-player', async ({ page }) => {
    await open(page, 'visitor', '/');
    await setInsets(page, { top: 47, right: 0, bottom: 34, left: 0 });
    // A visible mini-player publishes its height on <html> (!important: wins over the player's own updates).
    await page.addStyleTag({ content: `html { --mini-player-h: ${MINI_PLAYER_H}px !important; }` });

    await expect(page.locator('.masthead')).toHaveCSS('padding-top', '47px');
    expect((await page.locator('.masthead__inner').boundingBox())!.y).toBeCloseTo(47, 0);

    const toast = await showToast(page);
    expect(PHONE.height - (toast.y + toast.height)).toBeCloseTo(SP_5 + MINI_PLAYER_H + 34, 0);

    const sheet = await openSheet(page);
    await expect(sheet).toHaveCSS('top', `${MASTHEAD_H + 47}px`);
    await expect(sheet).toHaveCSS('padding-bottom', `${SP_7 + MINI_PLAYER_H + 34}px`);
    await expect(sheet).toHaveCSS('scroll-padding-bottom', `${MINI_PLAYER_H + 34}px`);
    await sheet.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const last = (await sheet.locator('.sheet__link').last().boundingBox())!;
    expect(last.y + last.height).toBeLessThanOrEqual(PHONE.height - MINI_PLAYER_H - 34);
    await page.getByRole('button', { name: 'Close menu' }).click();

    const modal = await injectModal(page);
    await expect(modal).toHaveCSS('padding-top', '47px');
    await expect(modal).toHaveCSS('padding-bottom', '34px');
    const panel = (await modal.locator('.modal__panel').boundingBox())!;
    expect(panel.y).toBeGreaterThanOrEqual(47 - 0.5);
    expect(panel.y + panel.height).toBeLessThanOrEqual(PHONE.height - 34 + 0.5);
  });

  test('landscape: content, menu sheet, toasts and dialogs clear the notch', async ({ page }) => {
    const LANDSCAPE = { width: 844, height: 390 };
    await page.setViewportSize(LANDSCAPE);
    await open(page, 'visitor', '/');
    await setInsets(page, { top: 0, right: 59, bottom: 21, left: 59 });

    // 5vw gutter (42px) is narrower than the 59px notch inset.
    for (const selector of ['.masthead__inner', '.container.page']) {
      await expect(page.locator(selector).first()).toHaveCSS('padding-left', '59px');
      await expect(page.locator(selector).first()).toHaveCSS('padding-right', '59px');
    }

    const toast = await showToast(page);
    expect(LANDSCAPE.width - (toast.x + toast.width)).toBeCloseTo(59, 0);
    expect(LANDSCAPE.height - (toast.y + toast.height)).toBeCloseTo(SP_5 + 21, 0);
    await page.getByTestId('auth-toast').getByRole('button', { name: 'Dismiss' }).click();

    const sheet = await openSheet(page);
    await expect(sheet).toHaveCSS('padding-left', '59px');
    await expect(sheet).toHaveCSS('padding-right', '59px');
    await page.getByRole('button', { name: 'Close menu' }).click();

    // Padded by max(--sp-5, inset); on a short screen the panel shrinks to that padding instead of 92dvh.
    const modal = await injectModal(page);
    await expect(modal).toHaveCSS('padding-top', `${SP_5}px`);
    await expect(modal).toHaveCSS('padding-right', '59px');
    await expect(modal).toHaveCSS('padding-bottom', `${SP_5}px`);
    await expect(modal).toHaveCSS('padding-left', '59px');
    const panel = (await modal.locator('.modal__panel').boundingBox())!;
    expect(panel.x).toBeCloseTo(59, 0);
    expect(panel.y).toBeGreaterThanOrEqual(SP_5 - 0.5);
    expect(panel.y + panel.height).toBeLessThanOrEqual(LANDSCAPE.height - SP_5 + 0.5);
  });
});
