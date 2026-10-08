import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    // Bind on all interfaces so the sandbox preview proxy can reach the dev server,
    // and accept the proxied host name (otherwise Vite blocks it).
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    // Phase 8: proxy the jamaat WebSocket through the same origin so the
    // browser client just connects to /social-ws (works behind previews, too).
    proxy: {
      '/social-ws': {
        target: 'ws://127.0.0.1:8081',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  esbuild: {
    legalComments: 'none',
  },
});
