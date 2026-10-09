import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';

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
      mkdirSync(resolve(root, '.tmp'), { recursive: true });
      writeFileSync(resolve(root, '.tmp/bundle-modules.json'), JSON.stringify(Object.values(bundle).filter((item) => item.type === 'chunk').map((item) => ({ name: item.name, file: item.fileName, isEntry: item.isEntry, imports: item.imports, modules: Object.entries(item.modules).map(([id, meta]) => ({ path: relative(root, id), bytes: meta.renderedLength })).sort((a, b) => b.bytes - a.bytes) })), null, 2));
      const paths = new Set(['./index.html']);
      for (const fileName of Object.keys(bundle)) {
        if (fileName !== 'sw.js' && !fileName.endsWith('.map') && !fileName.startsWith('.vite/') && !fileName.endsWith('.br')) paths.add(`./${fileName}`);
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

function quranCompression() {
  const raw = readFileSync(resolve(publicDir, 'quran/quran.json'));
  const compressed = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } });
  const tag = `"${createHash('sha256').update(raw).digest('hex')}"`;
  const serve = (req, res, next) => {
    if (req.method !== 'GET' || !new URL(req.url, 'http://localhost').pathname.endsWith('/quran/quran.json') || !/\bbr\b/.test(req.headers['accept-encoding'] || '')) return next();
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('ETag', tag); res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === tag) { res.statusCode = 304; res.end(); return; }
    res.setHeader('Content-Encoding', 'br'); res.setHeader('Content-Length', compressed.length); res.end(compressed);
  };
  return { name: 'quran-brotli', configureServer(server) { server.middlewares.use(serve); }, configurePreviewServer(server) { server.middlewares.use(serve); }, generateBundle() { this.emitFile({ type: 'asset', fileName: 'quran/quran.json.br', source: compressed }); } };
}

function bootstrapStrings() {
  const id = '\0bootstrap-persian-strings';
  return {
    name: 'bootstrap-persian-strings', enforce: 'pre',
    resolveId(source, importer) {
      if (source.endsWith('/data/strings.fa.json') && importer?.replace(/\\/g, '/').endsWith('/src/core/ConfigRuntime.js')) return id;
    },
    load(moduleId) {
      if (moduleId !== id) return;
      const full = JSON.parse(readFileSync(resolve(root, 'src/data/strings.fa.json'), 'utf8'));
      const boot = Object.fromEntries(['app', 'loading', 'errors', 'hud', 'economy', 'defense', 'a11y', 'security'].map((key) => [key, full[key]]));
      for (const [section, keys] of Object.entries({ army: ['panel', 'garrisonTitle', 'capacity'], battle: ['button', 'title'], social: ['button', 'title', 'pending', 'rolledBack'], campaign: ['button', 'panelTitle', 'job', 'jobHint', 'active', 'open', 'pausedShort'], quran: ['title'] })) boot[section] = Object.fromEntries(keys.map((key) => [key, full[section][key]]));
      return `export default ${JSON.stringify(boot)};`;
    },
  };
}

function compactShaderSources() {
  return {
    name: 'compact-glsl-sources', apply: 'build', enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('.glsl.js')) return null;
      return code.replace(/(export default\s*(?:\/\*[\s\S]*?\*\/\s*)?)`([\s\S]*)`;/, (_all, prefix, shader) => {
        const compact = shader.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '').split('\n').map((line) => { const clean = line.replace(/[ \t]+/g, ' ').trim(); return clean.startsWith('#') ? clean : clean.replace(/ *([,;()[\]{}]) */g, '$1'); }).filter(Boolean).join('\n');
        return `${prefix}\`\n${compact}\n\`;`;
      });
    },
  };
}

function applicationCsp() {
  const social = JSON.parse(readFileSync(resolve(root, 'src/data/social.json'), 'utf8'));
  const origins = (social.client?.allowedOrigins || []).flatMap((value) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return [];
      if (url.protocol === 'http:') url.protocol = 'ws:';
      if (url.protocol === 'https:') url.protocol = 'wss:';
      return [url.origin];
    } catch { return []; }
  });
  return { name: 'application-csp', transformIndexHtml: (html) => html.replace('__CSP_SOCIAL__', origins.join(' ')) };
}

export default defineConfig({
  base: './',
  // Source-level split keeps skinning/animation loaders out of the city-only graph.
  resolve: { alias: [{ find: /^three$/, replacement: resolve(root, 'node_modules/three/src/Three.js') }] },
  plugins: [quranCompression(), bootstrapStrings(), compactShaderSources(), applicationCsp(), pwaReleasePlugin()],
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
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    minify: 'terser',
    terserOptions: { compress: { passes: 3 }, mangle: true, format: { comments: false } },
    manifest: true,
    target: 'es2020',
    rollupOptions: { output: { onlyExplicitManualChunks: true, manualChunks(id) {
      if (id.includes('/node_modules/three/')) {
        if (id.includes('/examples/') || /\/(?:animation|audio)\/|\/objects\/(?:SkinnedMesh|Bone|Skeleton)\.js|\/math\/interpolants\//.test(id)) return 'battle';
        return 'three';
      }
      if (/\/(?:world\/(?:battle|characters)\/|ui\/(?:BattlePanel|BarracksPanel|features\/BattleFeature)\.js|game\/battle\/(?:BattleSystem|BattleSim|BattleRecorder|BattleScenario|AStar|BattleGrid|MinHeap)\.js)/.test(id)) return 'battle';
      if (id.endsWith('/ui/QuranPanel.js') || id.endsWith('/data/quran-sample.json')) return 'quran';
      if (!id.endsWith('.css') && /\/(?:game\/quran\/(?!LearningState\.js|VerseIds\.js)|ui\/quran\/|ui\/features\/StudyFeature\.js)/.test(id)) return 'quran';
    } } },
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  esbuild: {
    legalComments: 'none',
  },
});
