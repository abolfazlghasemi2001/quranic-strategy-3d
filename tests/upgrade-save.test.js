import { expect, it, vi } from 'vitest';
import { SaveSystem } from '../src/game/SaveSystem.js';
it('does not report a durable save when an IDB transaction failed', async () => {
 const saves=new SaveSystem({backend:'idb'});vi.spyOn(saves,'_idbPut').mockResolvedValue(false);
 await expect(saves.save({entities:[]},{requirePersistent:true})).rejects.toThrow('persistent-save-unavailable');
});
it('still permits memory fallback for ordinary play, but never for update/reload consent', async () => {
 const saves=new SaveSystem({backend:'memory'});await expect(saves.save({entities:[]})).resolves.toBeTypeOf('number');
 await expect(saves.save({entities:[]},{requirePersistent:true})).rejects.toThrow('persistent-save-unavailable');
});
