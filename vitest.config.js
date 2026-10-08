import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = dirname(fileURLToPath(import.meta.url));

/**
 * Phase 9 — واحد (Vitest).
 * منطق economy و شبیه‌ساز نبرد کاملاً خالص (pure) است (بدون DOM/WebGL)،
 * پس environment پیش‌فرض node کافی است. داده‌های JSON مستقیماً با import
 * خوانده می‌شوند (افزونهٔ JSONِ Vite).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(root, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // The sim is fixed-timestep; tests never sleep on wall-clock time.
    testTimeout: 20000,
    hookTimeout: 20000,
    // Deterministic reporting: no file parallelism surprises in CI logs.
    reporters: ['default'],
  },
});
