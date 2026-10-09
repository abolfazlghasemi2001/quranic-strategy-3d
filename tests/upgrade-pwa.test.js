import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('does not replace an active offline release until the user accepts after saving', () => {
 const source=readFileSync(new URL('../src/pwa/service-worker.js',import.meta.url),'utf8');
 const install=source.split("self.addEventListener('install'")[1].split('self.addEventListener(')[0];
 expect(install).not.toContain('self.skipWaiting()');
 expect(source).toContain('SKIP_WAITING');
});
