import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

/**
 * Build stamp.
 *
 * The version is read from package.json rather than duplicated in the source,
 * so `npm version` remains the single place it changes. It is injected as a
 * constant rather than imported: importing the JSON would pull the whole file
 * into the bundle, publishing the dependency list to anyone who opens it.
 *
 * The year is taken at build time, not from `new Date()` in the browser. A
 * copyright notice states when the work was published; rendering it from the
 * visitor's clock instead means a device with the wrong date silently prints
 * the wrong notice.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Build configuration.
 *
 * The overriding goal is a tiny first paint. The home page needs neither the
 * SFU client nor the E2EE worker, and `livekit-client` is by far the largest
 * dependency — so it is isolated in its own chunk that only downloads once the
 * user actually opens a meeting (see the lazy import in App.tsx).
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Substituted literally at build time, so both fold into string constants and
  // cost nothing at runtime. Declared for TypeScript in src/globals.d.ts.
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_YEAR__: JSON.stringify(String(new Date().getFullYear())),
  },

  build: {
    target: 'es2022',
    cssCodeSplit: true,
    // Source maps ship to the server for stack-trace symbolication but are not
    // referenced by the bundle, so browsers never fetch them.
    sourcemap: 'hidden',
    reportCompressedSize: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/livekit-client')) return 'livekit';
          if (id.includes('node_modules/react')) return 'react';
          return undefined;
        },
      },
    },
  },

  esbuild: {
    // Strip debugging aids from production output.
    drop: ['debugger'],
    pure: ['console.debug'],
    legalComments: 'none',
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Dev-only: lets the browser treat the API as same-origin, so the local
      // setup exercises the same CORS and CSP behaviour as production.
      '/api': { target: 'http://127.0.0.1:8080', changeOrigin: false },
    },
  },

  worker: { format: 'es' },
});
