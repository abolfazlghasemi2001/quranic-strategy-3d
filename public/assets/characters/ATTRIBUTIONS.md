# Character asset attributions

## License check and provenance

| Field | Record |
| --- | --- |
| Creator | Kay Lousberg / KayKit |
| Pack | **KayKit : Adventurers Character Pack (1.0)** |
| Official pack page | <https://kaylousberg.com/game-assets/characters-adventurers> |
| Source repository | <https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0> |
| License | **CC0 1.0 Universal** — confirmed in the pack's `LICENSE.txt` on 2026-10-08; the license permits personal, educational, and commercial use. The original notice asks for optional credit. A copy of the pack notice is in `LICENSE.txt`. |
| Date retrieved and reviewed | 2026-10-08 |
| Changes | Kept the source character geometry, rig and selected animation clips; removed unused animation/accessor data; downsampled each embedded 1024×1024 PNG atlas to 512×512 and repacked the self-contained GLB. No character was redrawn or reskinned. No runtime per-character texture or material is created; loaded geometry and atlas data are shared, with at most one cached faction material variant per model. |
| Project use | Fictional generic city citizens and battle units in the 3D presentation layer. Asset names are mapped to project roles in `src/data/characters.json`. These are not depictions of prophets, imams, angels, or any other sacred figure. No game-specific Clash of Clans artwork, animation, UI, icon, name, audio, or unit design was used. |

## Files included

| Project file | Source file in the pack | Project role(s) |
| --- | --- | --- |
| `builders/builder.glb` | `Barbarian.glb` | Builder profile; reused as the fictional heavy-work/breaker gameplay unit |
| `farmers/farmer.glb` | `Rogue.glb` | Farmer profile |
| `guards/guard.glb` | `Knight.glb` | Guard gameplay unit |
| `archers/archer.glb` | `Rogue_Hooded.glb` | Archer gameplay unit; also reused for the scout profile |
| `scholars/scholar.glb` | `Mage.glb` | Scholar profile; reused for the non-religious support/healer gameplay unit |

The base GLBs contain a skinned humanoid rig and real animation clips. Each optimized file retains: `Idle`, `Walking_A`, `Running_A`, `1H_Melee_Attack_Slice_Horizontal`, `1H_Ranged_Shooting`, `Hit_A`, `Death_A`, `Cheer`, `Interact`, and `PickUp`. Gameplay role bindings and animation mapping are data-driven; reusing one source model for an alias does not duplicate its binary file.

## Usage and asset failure behavior

Models are loaded asynchronously by `src/world/characters/CharacterAssetLoader.js`, cached by model ID, and disposed by `CharacterSystem`. A load/parse failure is logged for developers and falls back to the existing low-poly instanced battle representation; it never blocks the game or displays a technical error to the player. The offline service worker precaches the optimized GLBs.
