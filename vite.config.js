import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const serviceWorkerTemplate = readFileSync(resolve(root, 'src/pwa/service-worker.js'), 'utf8');

function listPublicFiles(directory = publicDir) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...listPublicFiles(absolute));
    else {
      const path = relative(publicDir, absolute).split(sep).join('/');
      if (path !== 'sw.js') files.push(`./${path}`);
    }
  }
  return files;
}

function pwaReleasePlugin() {
  return {
    name: 'shahr-nur-offline-shell',
    apply: 'build',
    generateBundle(_options, bundle) {
      const paths = new Set(['./index.html']);
      for (const fileName of Object.keys(bundle)) {
        if (fileName !== 'sw.js' && !fileName.endsWith('.map')) paths.add(`./${fileName}`);
      }
      for (const fileName of listPublicFiles()) paths.add(fileName);
      const precache = [...paths].sort();
      const hash = createHash('sha256');
      for (const path of precache) {
        hash.update(path);
        if (path.startsWith('./') && path.slice(2).startsWith('assets/')) {
          const item = bundle[path.slice(2)];
          if (item) hash.update(item.type === 'chunk' ? item.code : Buffer.from(item.source));
        } else if (path.startsWith('./')) {
          const diskPath = resolve(publicDir, path.slice(2));
          try {
            hash.update(readFileSync(diskPath));
          } catch {
            const item = bundle[path.slice(2)];
            if (item) hash.update(item.type === 'chunk' ? item.code : Buffer.from(item.source));
          }
        }
      }
      const revision = hash.digest('hex').slice(0, 12);
      const worker = serviceWorkerTemplate
        .replace('__CACHE_VERSION__', revision)
        .replace('__PRECACHE_URLS__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: worker });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [pwaReleasePlugin()],
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
