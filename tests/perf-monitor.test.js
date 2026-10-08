/**
 * Phase 9 — Vitest: PerfMonitor (Phase 9 optimization: ring buffer).
 *
 * The monitor used to allocate a `{ t, dt }` object per frame and `shift()`
 * the array every frame. The ring-buffer rewrite must keep the exact same
 * FPS math while allocating nothing per frame and staying bounded.
 */
import { describe, it, expect } from 'vitest';

import { PerfMonitor } from '../src/ui/PerfMonitor.js';

describe('PerfMonitor: rolling-window FPS math', () => {
  it('measures a constant frame rate correctly', () => {
    const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 });
    const frame = 1 / 60;
    let snapshot = null;
    for (let i = 0; i < 120; i += 1) snapshot = monitor.update(frame) ?? snapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot.fps).toBeCloseTo(60, 0);
    expect(snapshot.fpsMin).toBeCloseTo(60, 0);
    expect(snapshot.fpsMax).toBeCloseTo(60, 0);
  });

  it('reports null until the first sample interval elapses', () => {
    const monitor = new PerfMonitor({ sampleInterval: 0.25 });
    expect(monitor.update(1 / 60)).toBeNull();
    expect(monitor.update(1 / 60)).toBeNull();
  });

  it('keeps the window bounded (ring buffer never grows)', () => {
    const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 });
    for (let i = 0; i < 100000; i += 1) monitor.update(1 / 60);
    // 1.5 s at 60 fps ≈ 90 frames + headroom; the buffer must stay far below
    // the number of updates and never wrap mid-window.
    expect(monitor.frameCount).toBeLessThanOrEqual(monitor._capacity);
    expect(monitor.frameCount).toBeLessThan(1000);
    expect(monitor.frameCount).toBeGreaterThan(2);
    expect(monitor.fps).toBeCloseTo(60, 0);
  });

  it('tracks renderer stats and the resetEnvelope helper', () => {
    const monitor = new PerfMonitor({ sampleInterval: 0.1 });
    const stats = { drawCalls: 42, triangles: 1000, frameMs: 16.6, programs: 7, geometries: 30, textures: 12 };
    let snapshot = null;
    for (let i = 0; i < 30; i += 1) snapshot = monitor.update(0.05, stats) ?? snapshot;
    expect(snapshot.drawCalls).toBe(42);
    expect(snapshot.triangles).toBe(1000);
    expect(snapshot.textures).toBe(12);
    monitor.resetEnvelope();
    expect(monitor.fpsMin).toBe(Infinity);
    expect(monitor.fpsMax).toBe(0);
  });
});
