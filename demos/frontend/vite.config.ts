import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** The latin subsets the first view needs: body text (Hanken Grotesk) and the display titles (Newsreader, roman). */
const CRITICAL_FONTS = [
  /^assets\/hanken-grotesk-latin-wght-normal-[\w-]+\.woff2$/,
  /^assets\/newsreader-latin-opsz-normal-[\w-]+\.woff2$/,
];

/**
 * Preloads the critical fonts with their hashed build names, so they download in parallel with the bundle instead of after
 * the first render (which is what makes the late swap). Build only: the dev server serves the unhashed files and skips it.
 */
function preloadCriticalFonts(): Plugin {
  let base = '/';
  return {
    name: 'oz-preload-critical-fonts',
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        if (!ctx.bundle) return undefined;
        return Object.keys(ctx.bundle)
          .filter((file) => CRITICAL_FONTS.some((pattern) => pattern.test(file)))
          .sort()
          .map((file) => ({
            tag: 'link',
            // Font preloads need `crossorigin` even on the same origin, or the font request does not reuse them.
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: true, href: `${base}${file}` },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadCriticalFonts()],
  server: {
    port: 5173,
    // Test servers shared by parallel Playwright runs set OZ_VITE_HMR=off, so an edit never reloads a page under test.
    ...(process.env.OZ_VITE_HMR === 'off' ? { hmr: false, ws: false as const } : {}),
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      '/ws': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
