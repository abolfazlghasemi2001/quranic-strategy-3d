# Asset provenance / مجوز دارایی‌ها

Default buildings, terrain, sky, unit meshes, texture maps, particles and SVG icons are generated from project code. No image/model of prophets, imams or angels is introduced. Quran text is only rendered by the study UI.

| File | Source and exact version | License / attribution | SHA-256 |
|---|---|---|---|
| `public/fonts/Vazirmatn-Variable.woff2` | [Vazirmatn official repository](https://github.com/rastikerdar/vazirmatn), Git blob `a501289a85595158570b0c2badcb4608b042e748` (unmodified WOFF2 variable font) | SIL OFL 1.1; Copyright 2015 The Vazirmatn Project Authors; full license `public/fonts/OFL-Vazirmatn.txt` | `4e3fa217d38fdafc1fea4414ceb58ca5e662cf0ab5fa735a8c8c20e8b42cad92` |
| `public/fonts/AmiriQuran-Arabic.woff2` | `@fontsource/amiri-quran@5.3.0`, font metadata v19 / 2025-08-26; Google Fonts mirror of [Amiri](https://github.com/aliftype/amiri), unmodified Arabic WOFF2 subset | SIL OFL 1.1; Copyright 2010–2022 The Amiri Project Authors; full license `public/fonts/OFL-AmiriQuran.txt` | `35f4f02bbde81b20118a788f8b212bff385eb499df0746d277b5b478f32e733e` |
| Existing `public/assets/characters/**/*.glb` | Unchanged from the audited base; see `public/assets/characters/ATTRIBUTIONS.md` | Existing CC0 license `public/assets/characters/LICENSE.txt` | Existing files untouched |

Fonts and license texts are self-hosted and included in content-hashed PWA precache. No third-party font request is made at runtime. Procedural textures require no downloaded artwork. Font licensing/diacritic rendering is **not** religious review of Quran/translation; existing dataset reviewed flags and provenance remain unchanged, and qualified independent human review is still unproven.
