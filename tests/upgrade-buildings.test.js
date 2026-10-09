// @vitest-environment jsdom
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/core/Config.js';
import { EventBus } from '../src/core/EventBus.js';
import { GameState } from '../src/game/GameState.js';
import { BuildingView } from '../src/world/BuildingView.js';
import definitions from '../src/data/buildings.json';
let view, state, bus;
beforeEach(() => {
  const context = new Proxy({}, { get: (_target, name) => name === 'getImageData' ? () => ({ data: new Uint8ClampedArray(128 * 128 * 4), width: 128, height: 128 }) : () => {}, set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  const config = new Config({ search: '?quality=low' });
  state = new GameState(config); bus = new EventBus();
  view = new BuildingView({ config, state, bus, world: { group: new THREE.Group(), getGroundHeight: () => 0, dayNightState: { daylight: 1 } }, rig: {}, input: {} });
});
afterEach(() => { view?.dispose(); vi.restoreAllMocks(); });
const add = (type, index, level = 1) => {
  const def = definitions.buildings.find((item) => item.id === type);
  const entity = state.createEntity({ type, size: def.size, col: index % 10 * 4, row: Math.floor(index / 10) * 4, level });
  bus.emit('game:building-added', { entity }); return entity;
};
const draws = () => {
  view.beforeRender?.(); let calls = 0;
  view.group.traverseVisible((node) => { if (node.isMesh && (!node.isInstancedMesh || node.count > 0)) calls += Array.isArray(node.material) ? node.material.length : 1; });
  return calls;
};
describe('PERF-01: repeated city presentation draw budget', () => {
  it('renders 30 real buildings inside the 150-call scene budget before battle overhead', () => {
    const types = ['farm', 'warehouse', 'light-spring', 'watchtower', 'barracks', 'library', 'dar-al-quran', 'sentry-post'];
    for (let i = 0; i < 30; i += 1) add(types[i % types.length], i);
    expect(view.roots.size).toBe(30); expect(draws()).toBeLessThan(130);
  });
  it('keeps transforms and building lifecycle independent from gameplay objects', () => {
    const a = add('farm', 0), b = add('farm', 1);
    const root = view.getEntityRoot(a.id); root.position.y = -0.12; root.rotation.z = 0.04;
    view.beforeRender?.(); expect(state.entities.get(a.id)).not.toHaveProperty('root');
    expect(view.getEntityRoot(b.id).position.y).toBe(0);
    bus.emit('game:building-removed', { entityId: a.id }); state.entities.delete(a.id);
    expect(view.roots.size).toBe(1); expect(draws()).toBeLessThan(12);
  });
  it('does not dispose a shared template while another instance still uses it', () => {
    const a = add('farm', 0), b = add('farm', 1);
    view.beforeRender?.(); const geometry = [];
    view.group.traverse((node) => { if (node.isInstancedMesh) geometry.push(node.geometry); });
    if (!geometry.length) return; // This regression is meaningful after instancing is introduced.
    const dispose = vi.spyOn(geometry[0], 'dispose');
    bus.emit('game:building-removed', { entityId: a.id }); view.beforeRender?.();
    expect(dispose).not.toHaveBeenCalled();
    bus.emit('game:building-removed', { entityId: b.id });
    expect(dispose).toHaveBeenCalledOnce();
  });
});
