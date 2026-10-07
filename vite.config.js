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
