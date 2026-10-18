import { defineConfig, devices } from '@playwright/test';

/**
 * Read environment variables from file.
 * https://github.com/motdotla/dotenv
 */
// import dotenv from 'dotenv';
// import path from 'path';
// dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * The phone listening suites (persistent player, mini-player, Now Playing sheet, resume,
 * auto-next, listen-first rows, phone platform, accessibility, ?debug=player) that the
 * mobile-* projects run on emulated phones.
 */
const PHONE_LISTENING_SPECS = [
  '**/playback-*.spec.ts',
  '**/mobile-*.spec.ts',
  '**/listen-first.spec.ts',
  '**/player-debug.spec.ts',
];

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './tests',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    // Local dev UI (run-local.ps1 → Vite on :5173, backend with AUTH_MODE=disabled).
    baseURL: process.env.AI_PRESENTER_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },

    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },

    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },

    /*
     * Phones (npm run test:mobile): the phone listening specs on an emulated iPhone (WebKit,
     * Safari's engine) and Android phone (Chromium) — mobile user agent, device pixel ratio,
     * meta viewport, touch and (hover: none) / (pointer: coarse).
     * Emulation does NOT reproduce iOS autoplay rules (the one-tap user-activation budget),
     * the lock screen / Control Center / Android media notification, background audio with
     * the screen off, AirPods or call interruptions, or Safari's dynamic toolbars: real
     * devices do (device script with ?debug=player).
     * A spec's own test.use({ viewport, isMobile, hasTouch }) still wins over the device's
     * (e.g. the desktop checks in mobile-platform.spec.ts); engine-specific checks skip
     * themselves per browser with a reason (e.g. CDP safe-area emulation is Chromium only).
     * On Windows, Playwright's WebKit decodes media with Media Foundation, which downloads media
     * URLs itself, outside page.route(): the mocked /media fixtures cannot play there (README › Testing).
     */
    {
      name: 'mobile-webkit',
      testMatch: PHONE_LISTENING_SPECS,
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'mobile-chromium',
      // + the read-only production smoke (npm run test:prod-smoke), skipped unless OZ_RADIO_PROD_SMOKE=1.
      testMatch: [...PHONE_LISTENING_SPECS, '**/prod-smoke.spec.ts'],
      use: { ...devices['Pixel 7'] },
    },

    /* Test against branded browsers. */
    // {
    //   name: 'Microsoft Edge',
    //   use: { ...devices['Desktop Edge'], channel: 'msedge' },
    // },
    // {
    //   name: 'Google Chrome',
    //   use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    // },
  ],

  /* Run your local dev server before starting the tests */
  // webServer: {
  //   command: 'npm run start',
  //   url: 'http://localhost:3000',
  //   reuseExistingServer: !process.env.CI,
  // },
});
