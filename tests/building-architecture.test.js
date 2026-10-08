import { describe, expect, it, vi } from 'vitest';
import { Config } from '../src/core/Config.js';
import { EventBus, EVENTS } from '../src/core/EventBus.js';
import { Game } from '../src/game/Game.js';
import { BuildingSystem } from '../src/game/BuildingSystem.js';
import { WorldInputAdapter } from '../src/world/WorldInputAdapter.js';

function makeGame() {
  const config = new Config({ search: '?quality=low', env: { cores: 2, memory: 2, coarsePointer: true } });
  const bus = new EventBus();
  const game = new Game({ config, bus });
  game.bootstrap();
  return { config, bus, game };
}

describe('game/world presentation boundary', () => {
  it('maps screen taps in the world adapter and sends only a plain world intent to gameplay', () => {
    const { bus, game } = makeGame();
    const input = { onTap: null };
    const world = {
      isInsideMap: vi.fn((x, z) => x >= 0 && z >= 0),
      getCellAt: vi.fn(() => ({ col: 3, row: 4 })),
    };
    const rig = { screenToGround: vi.fn(() => ({ x: 3.5, z: 4.5 })) };
    const adapter = new WorldInputAdapter({ config: game.config, world, rig, input, bus });

    input.onTap({ clientX: 100, clientY: 200, pointerType: 'touch' });
    expect(rig.screenToGround).toHaveBeenCalledOnce();
    expect(game.state.lastTap).toMatchObject({ x: 3.5, z: 4.5, cell: { col: 3, row: 4 }, inside: true });
    expect(game.state.tapCount).toBe(1);
    expect(world.getCellAt).toHaveBeenCalledWith(3.5, 4.5);

    adapter.dispose();
    game.dispose();
  });

  it('keeps renderer roots out of gameplay entities and signals view updates through events', () => {
    const { config, bus, game } = makeGame();
    const buildings = new BuildingSystem({
      config,
      bus,
      state: game.state,
      economy: game.economy,
      queue: game.queue,
      game,
    });
    const added = vi.fn();
    const updated = vi.fn();
    bus.on(EVENTS.BUILDING_ADDED, added);
    bus.on(EVENTS.BUILDING_UPDATED, updated);

    expect(buildings.startPlacement('farm')).toBe(true);
    buildings.onPlacementPointer({ col: 0, row: 0 });
    expect(buildings.confirmPlacement()).toBe(true);
    const entity = [...game.state.entities.values()].find((item) => item.type === 'farm');
    expect(entity).toBeTruthy();
    expect(Object.hasOwn(entity, 'root')).toBe(false);
    expect(added).toHaveBeenCalledWith({ entity });

    buildings.onJobFinished({ job: { kind: 'build' }, entity });
    expect(updated).toHaveBeenCalledWith({ entity, jobKind: 'build' });
    buildings.dispose();
    game.dispose();
  });
});
