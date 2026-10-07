import * as THREE from 'three';

const mat = (color, texture = null) => new THREE.MeshStandardMaterial({ color, map: texture, roughness: 0.78, metalness: 0.03 });

function canvasTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const c = canvas.getContext('2d');
  c.fillStyle = kind === 'tile' ? '#1b8891' : '#ba7847';
  c.fillRect(0, 0, 128, 128);
  if (kind === 'brick') {
    c.strokeStyle = 'rgba(74,35,22,.42)'; c.lineWidth = 3;
    for (let y = 0; y <= 128; y += 16) {
      c.beginPath(); c.moveTo(0, y); c.lineTo(128, y); c.stroke();
      for (let x = (y / 16) % 2 ? 0 : 16; x < 128; x += 32) {
        c.beginPath(); c.moveTo(x, y); c.lineTo(x, y + 16); c.stroke();
      }
    }
  } else {
    c.strokeStyle = 'rgba(230,245,220,.7)'; c.lineWidth = 2;
    for (let i = -128; i < 256; i += 16) {
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i - 128, 128); c.stroke();
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 128, 128); c.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const value = new THREE.Mesh(geometry, material);
  value.position.set(x, y, z);
  value.castShadow = value.receiveShadow = true;
  return value;
}

function arch(group, width, height, z, material) {
  const side = width * 0.18;
  group.add(mesh(new THREE.BoxGeometry(side, height, .35), material, -width / 2 + side / 2, height / 2, z));
  group.add(mesh(new THREE.BoxGeometry(side, height, .35), material, width / 2 - side / 2, height / 2, z));
  group.add(mesh(new THREE.TorusGeometry(width * .32, side * .5, 6, 18, Math.PI), material, 0, height, z));
}

export class BuildingFactory {
  constructor(tileSize) {
    this.tileSize = tileSize;
    this.textures = [canvasTexture('brick'), canvasTexture('tile')];
    this.materials = {
      brick: mat(0xffffff, this.textures[0]), tile: mat(0xffffff, this.textures[1]),
      plaster: mat(0xe9d2a4), wood: mat(0x694329), water: new THREE.MeshStandardMaterial({ color: 0x61d3dc, emissive: 0x17636b, emissiveIntensity: .45, roughness: .18 }),
      crop: mat(0xb5a83c), dark: mat(0x53392b), gold: mat(0xe7bd57),
    };
  }

  create(def) {
    const g = new THREE.Group();
    g.name = `building:${def.id}`;
    const s = this.tileSize, w = def.size[0] * s * .86, d = def.size[1] * s * .86;
    const m = this.materials;
    const base = (h = 1.1, material = m.brick) => g.add(mesh(new THREE.BoxGeometry(w, h, d), material, 0, h / 2, 0));

    if (def.id === 'town-center') {
      base(2.3, m.plaster);
      g.add(mesh(new THREE.CylinderGeometry(w * .3, w * .38, 1.15, 8), m.brick, 0, 2.85, 0));
      g.add(mesh(new THREE.SphereGeometry(w * .32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), m.tile, 0, 3.45, 0));
      arch(g, w * .5, 1.45, d / 2 + .2, m.tile);
      g.add(mesh(new THREE.CylinderGeometry(.08, .08, .7, 8), m.gold, 0, 4.2, 0));
    } else if (def.id === 'farm') {
      base(.25, m.brick);
      for (let i = -2; i <= 2; i += 1) g.add(mesh(new THREE.BoxGeometry(w * .1, .42, d * .78), m.crop, i * w * .16, .45, 0));
      g.add(mesh(new THREE.CylinderGeometry(.55, .7, 1.4, 8), m.plaster, w * .3, .9, -d * .25));
      g.add(mesh(new THREE.ConeGeometry(.76, .65, 8), m.tile, w * .3, 1.9, -d * .25));
    } else if (def.id === 'light-spring') {
      base(.35, m.tile);
      g.add(mesh(new THREE.CylinderGeometry(w * .35, w * .4, .35, 16), m.water, 0, .48, 0));
      g.add(mesh(new THREE.CylinderGeometry(.2, .28, 1.25, 10), m.plaster, 0, 1.15, 0));
      const orb = mesh(new THREE.SphereGeometry(.38, 12, 8), m.water, 0, 1.95, 0); g.add(orb);
    } else if (def.id === 'warehouse') {
      base(1.7, m.brick);
      g.add(mesh(new THREE.CylinderGeometry(w * .5, w * .5, d, 12, 1, false, 0, Math.PI), m.plaster, 0, 1.7, -d / 2).rotateX(Math.PI / 2));
      arch(g, w * .48, 1.05, d / 2 + .2, m.dark);
    } else if (def.id === 'watchtower') {
      g.add(mesh(new THREE.CylinderGeometry(w * .28, w * .38, 3.6, 8), m.brick, 0, 1.8, 0));
      g.add(mesh(new THREE.CylinderGeometry(w * .43, w * .36, .55, 8), m.tile, 0, 3.75, 0));
      for (let i = 0; i < 8; i += 1) {
        const a = i * Math.PI / 4; g.add(mesh(new THREE.BoxGeometry(.34, .5, .34), m.brick, Math.sin(a) * w * .38, 4.2, Math.cos(a) * w * .38));
      }
    } else if (def.id === 'library') {
      base(1.35, m.plaster);
      // twin bookshelf walls
      for (const side of [-1, 1]) {
        g.add(mesh(new THREE.BoxGeometry(w * .12, 1.15, d * .8), m.wood, side * w * .34, 1.9, 0));
        for (let i = 0; i < 3; i += 1) g.add(mesh(new THREE.BoxGeometry(w * .14, .1, d * .72), m.dark, side * w * .34, 1.5 + i * .38, 0));
      }
      arch(g, w * .5, 1.4, d * .42, m.tile);
      g.add(mesh(new THREE.BoxGeometry(w * .96, .16, d * .96), m.tile, 0, 2.7, 0));
      g.add(mesh(new THREE.CylinderGeometry(.05, .05, .8, 6), m.gold, 0, 3.15, 0));
      g.add(mesh(new THREE.BoxGeometry(w * .5, .06, d * .3), m.crop, 0, 3.0, 0)); // open book
    } else {
      base(1.05, m.brick);
      g.add(mesh(new THREE.BoxGeometry(w * .92, .18, d * 1.04), m.tile, 0, 1.12, 0));
    }
    g.traverse((o) => { if (o.isMesh) o.userData.buildingRoot = g; });
    return g;
  }

  /**
   * Construction scaffold shown while a build/upgrade job is running.
   * Low-poly wooden frame + partial foundation — code only, no external assets.
   */
  createScaffold(def) {
    const g = new THREE.Group();
    g.name = `scaffold:${def.id}`;
    const s = this.tileSize, w = def.size[0] * s * .86, d = def.size[1] * s * .86;
    const m = this.materials;

    // half-built foundation
    g.add(mesh(new THREE.BoxGeometry(w, .5, d), m.brick, 0, .25, 0));
    // corner posts
    const px = w * .42, pz = d * .42, h = 1.9;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        g.add(mesh(new THREE.BoxGeometry(.14, h, .14), m.wood, sx * px, h / 2 + .4, sz * pz));
      }
    }
    // cross beams
    for (const sz of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(w * .94, .12, .12), m.wood, 0, h * .55 + .4, sz * pz));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.BoxGeometry(.12, .12, d * .94), m.wood, sx * px, h * .55 + .4, 0));
    g.add(mesh(new THREE.BoxGeometry(w * .94, .12, .12), m.wood, 0, h + .4, 0));
    // diagonal brace (visual "work in progress" cue)
    const brace = mesh(new THREE.BoxGeometry(.1, h * 1.1, .1), m.wood, 0, h * .55 + .4, pz);
    brace.rotation.z = Math.PI / 5;
    g.add(brace);
    // plank pile
    g.add(mesh(new THREE.BoxGeometry(w * .4, .12, d * .22), m.wood, w * .18, .6, -d * .28));

    g.traverse((o) => { if (o.isMesh) o.userData.buildingRoot = g; });
    return g;
  }

  dispose() {
    for (const t of this.textures) t.dispose();
    for (const m of Object.values(this.materials)) m.dispose();
  }
}
