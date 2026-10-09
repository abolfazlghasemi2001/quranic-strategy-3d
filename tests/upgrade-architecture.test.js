import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith('.js') ? [join(dir, entry.name)] : []);
it('keeps every game module free from direct DOM/Three.js access', () => {
  const forbidden = files('src/game').filter((path) => /\b(?:window|document|navigator)\s*[?.]\s*|from\s*['"]three/.test(readFileSync(path, 'utf8')));
  expect(forbidden).toEqual([]);
});
it('keeps battle stepping independent of ambient random numbers and clocks', () => {
  for (const path of ['BattleSim', 'BattleScenario', 'BattleRecorder', 'Unit', 'AStar']) {
    expect(readFileSync(`src/game/battle/${path}.js`, 'utf8')).not.toMatch(/\b(?:Math\.random|Date\.now|performance\.now)\s*\(/);
  }
});
