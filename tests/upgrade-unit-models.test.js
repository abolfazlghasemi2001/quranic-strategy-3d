import * as THREE from 'three';
import { expect, it, vi } from 'vitest';
import { createUnitGeometry, BATTLE_PALETTES, paint, mergePainted } from '../src/world/battle/UnitModels.js';
import units from '../src/data/units.json';
it('consumes indexed source geometry when merging painted parts', () => {
 const original=paint(new THREE.BoxGeometry(),0xffffff),dispose=vi.spyOn(original,'dispose');const merged=mergePainted([original]);
 expect(dispose).toHaveBeenCalledOnce();merged.dispose();
});
it.each(units.units)('has a faceless multipart $id silhouette inside its JSON triangle cap', (unit) => {
 const geometry=createUnitGeometry(unit.id,BATTLE_PALETTES.defender);
 expect(geometry.attributes.position.count/3).toBeGreaterThanOrEqual(300);
 expect(geometry.attributes.position.count/3).toBeLessThanOrEqual(unit.render?.maxTriangles || 800);
 expect(geometry.attributes.color.count).toBe(geometry.attributes.position.count);geometry.dispose();
});
