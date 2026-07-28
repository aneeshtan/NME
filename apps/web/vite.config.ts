import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import tailwindcss from '@tailwindcss/vite';

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
