/**
 * Terrain — the ground mesh, the terrain blend mask and the buildable grid overlay.
 *
 * The whole ground (grass + roads + soil patches + the sandy apron around the
 * island) is ONE mesh and ONE material: three tiled textures are blended with a
 * baked mask texture. That keeps the ground at a single draw call and avoids the
 * z-fighting that stacked decal planes would cause.
 */
import * as THREE from 'three';
import { createGroundQuad } from '../core/GeometryUtils.js';
import { createGroundTexture } from '../core/Textures.js';
import { valueNoise2D } from '../core/Noise.js';
import { Rng } from '../core/RNG.js';
import { clamp01 } from '../core/MathUtils.js';

const MASK_BANDS = 8;
const MASK_BAND_STEP = 0.42; // world units per feather band

export class Terrain {
  constructor({ config, map }) {
    this.config = config;
    this.map = map;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    this.gridVisible = true;

    const margin = config.terrain.margin;
    this.extent = {
      minX: -margin,
      minZ: -margin,
      maxX: config.worldWidth + margin,
      maxZ: config.worldDepth + margin,
    };
    this.extent.width = this.extent.maxX - this.extent.minX;
    this.extent.depth = this.extent.maxZ - this.extent.minZ;

    /** @type {THREE.Texture[]} */
    this.textures = [];
    this._disposables = [];
  }

  build() {
    const textures = this.config.terrain.textures;

    this.grassTexture = this._track(createGroundTexture('grass', this.config, (this.config.seed ^ 0x51ed) >>> 0));
    this.dirtTexture = this._track(createGroundTexture('dirt', this.config, (this.config.seed ^ 0x2f1a) >>> 0));
    this.sandTexture = this._track(createGroundTexture('sand', this.config, (this.config.seed ^ 0x77c3) >>> 0));
    this.maskTexture = this._track(this._createMaskTexture());

    const geometry = this._track(
      createGroundQuad({
        x0: this.extent.minX,
        z0: this.extent.minZ,
        x1: this.extent.maxX,
        z1: this.extent.maxZ,
        y: 0,
        uvScale: textures.grassRepeatUnits,
        name: 'ground',
      }),
    );

    const material = this._track(
      new THREE.MeshStandardMaterial({
        map: this.grassTexture,
        color: 0xffffff,
        roughness: 0.97,
        metalness: 0,
        dithering: true,
      }),
    );
    material.name = 'ground-material';
    this._applyGroundShader(material);

    this.groundMesh = new THREE.Mesh(geometry, material);
    this.groundMesh.name = 'ground';
    this.groundMesh.receiveShadow = true;
    this.groundMesh.matrixAutoUpdate = false;
    this.groundMesh.updateMatrix();
    this.group.add(this.groundMesh);

    this._buildGrid();
    return this.group;
  }

  /* ---------------------------------------------------------- ground mask */

  /**
   * Bakes the map layout into an RGBA canvas used as a blend mask:
   *   R = grass coverage (1 grass, 0 sand apron)
   *   G = dirt coverage  (roads + soil patches)
   *   B = dryness variation for the grass tint
   */
  _createMaskTexture() {
    const size = this.config.quality.maskSize || 1024;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const { minX, minZ, width, depth } = this.extent;
    const toPx = (x) => ((x - minX) / width) * size;
    const toPy = (z) => ((z - minZ) / depth) * size;

    ctx.clearRect(0, 0, size, size);

    // --- 1) grass island with a soft, slightly irregular coastline ---------
    const wobbleSeed = (this.config.seed ^ 0x1234) >>> 0;
    for (let band = MASK_BANDS - 1; band >= 0; band -= 1) {
      const grow = band * MASK_BAND_STEP;
      const value = Math.round(255 * (1 - band / MASK_BANDS));
      ctx.fillStyle = `rgb(${value}, 0, 0)`;
      this._traceIslandPath(ctx, { toPx, toPy, grow, wobbleSeed });
      ctx.fill();
    }

    // --- 2) roads (feathered, pure dirt) -----------------------------------
    const pathRects = this.map.pathRects;
    for (let band = 3; band >= 0; band -= 1) {
      const grow = band * 0.45;
      const green = Math.round(255 * (1 - band / 4.4));
      ctx.fillStyle = `rgb(255, ${green}, 0)`;
      for (const rect of pathRects) {
        const x = toPx(rect.minX - grow);
        const y = toPy(rect.minZ - grow);
        const w = toPx(rect.maxX + grow) - x;
        const h = toPy(rect.maxZ + grow) - y;
        ctx.fillRect(x, y, w, h);
      }
    }

    // --- 3) soil patches (organic blobs, partial dirt coverage) ------------
    const blobRng = new Rng((this.config.seed ^ 0xbeef) >>> 0);
    for (const patch of this.map.soilPatches) {
      const rings = [
        { radius: 1.35, value: 60 },
        { radius: 1.1, value: 130 },
        { radius: 0.85, value: 195 },
        { radius: 0.6, value: 235 },
      ];
      for (const ring of rings) {
        ctx.fillStyle = `rgb(255, ${ring.value}, 0)`;
        ctx.beginPath();
        const steps = 26;
        for (let i = 0; i <= steps; i += 1) {
          const angle = (i / steps) * Math.PI * 2;
          const noise = valueNoise2D(Math.cos(angle) * 3 + patch.seed, Math.sin(angle) * 3 - patch.seed, patch.seed) - 0.5;
          const radius = patch.radius * ring.radius * (1 + noise * 0.35);
          const x = toPx(patch.x + Math.cos(angle) * radius);
          const y = toPy(patch.z + Math.sin(angle) * radius);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fill();
      }
      // a few pebbles of bare dirt inside the patch for a less regular shape
      for (let i = 0; i < patch.blobs; i += 1) {
        const angle = blobRng.range(0, Math.PI * 2);
        const distance = blobRng.range(0.55, 1.15) * patch.radius;
        const radius = patch.radius * blobRng.range(0.16, 0.34);
        const cx = patch.x + Math.cos(angle) * distance;
        const cz = patch.z + Math.sin(angle) * distance;
        ctx.fillStyle = `rgb(255, ${Math.round(blobRng.range(150, 245))}, 0)`;
        ctx.beginPath();
        ctx.ellipse(toPx(cx), toPy(cz), toPx(cx + radius) - toPx(cx), toPy(cz + radius) - toPy(cz), blobRng.range(0, Math.PI), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // --- 4) per pixel dryness in the blue channel --------------------------
    const image = ctx.getImageData(0, 0, size, size);
    const data = image.data;
    const noiseSeed = (this.config.seed ^ 0x51a7) >>> 0;
    for (let py = 0; py < size; py += 1) {
      const worldZ = minZ + (py / size) * depth;
      for (let px = 0; px < size; px += 1) {
        const index = (py * size + px) * 4;
        if (data[index] === 0) continue; // apron: no dryness variation
        const worldX = minX + (px / size) * width;
        const dryness = clamp01(
          0.5 +
            0.5 * valueNoise2D(worldX * 0.035, worldZ * 0.035, noiseSeed) * 0.7 +
            0.5 * valueNoise2D(worldX * 0.11, worldZ * 0.11, noiseSeed + 977) * 0.3,
        );
        data[index + 2] = Math.round(dryness * 210);
      }
    }
    ctx.putImageData(image, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.name = 'ground-mask';
    texture.flipY = false; // keep world Z -> canvas Y (no vertical flip)
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 1;
    texture.needsUpdate = true;

    // The canvas is kept (the texture uploads it lazily); do not resize it here.
    return texture;
  }

  /** Trace the island outline with a deterministic wobble, optionally grown by `grow` world units. */
  _traceIslandPath(ctx, { toPx, toPy, grow, wobbleSeed }) {
    const step = Math.max(1.5, this.config.worldWidth / 26);
    const points = [];
    const edge = (x, z, nx, nz) => {
      const noise = valueNoise2D(x * 0.07, z * 0.07, wobbleSeed) - 0.5 + (valueNoise2D(x * 0.21, z * 0.21, wobbleSeed + 31) - 0.5) * 0.4;
      const offset = grow + noise * 2.1;
      points.push([x + nx * offset, z + nz * offset]);
    };

    for (let x = 0; x <= this.config.worldWidth; x += step) edge(x, 0, 0, -1);
    for (let z = 0; z <= this.config.worldDepth; z += step) edge(this.config.worldWidth, z, 1, 0);
    for (let x = this.config.worldWidth; x >= 0; x -= step) edge(x, this.config.worldDepth, 0, 1);
    for (let z = this.config.worldDepth; z >= 0; z -= step) edge(0, z, -1, 0);

    ctx.beginPath();
    points.forEach(([x, z], index) => {
      const px = toPx(x);
      const py = toPy(z);
      if (index === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
  }

  /* --------------------------------------------------------- ground shader */

  _applyGroundShader(material) {
    const textures = this.config.terrain.textures;
    const blend = Boolean(this.config.quality.groundDetailBlend);
    const grassRepeat = textures.grassRepeatUnits;
    const { minX, minZ, width, depth } = this.extent;

    const uniforms = {
      uDirtMap: { value: this.dirtTexture },
      uSandMap: { value: this.sandTexture },
      uMaskMap: { value: this.maskTexture },
      uDirtUv: { value: new THREE.Vector2(grassRepeat / textures.dirtRepeatUnits, grassRepeat / textures.dirtRepeatUnits) },
      uSandUv: { value: new THREE.Vector2(grassRepeat / textures.sandRepeatUnits, grassRepeat / textures.sandRepeatUnits) },
      uMaskUv: { value: new THREE.Vector4(grassRepeat / width, grassRepeat / depth, -minX / width, -minZ / depth) },
      uDirtTint: { value: new THREE.Color(textures.dirt.base) },
    };
    this.groundUniforms = uniforms;

    const declarations = `
      uniform sampler2D uMaskMap;
      uniform vec4 uMaskUv;
      ${blend ? 'uniform sampler2D uDirtMap;\nuniform sampler2D uSandMap;\nuniform vec2 uDirtUv;\nuniform vec2 uSandUv;' : 'uniform vec3 uDirtTint;'}
    `;

    const body = blend
      ? `
        vec4 grassTexel = texture2D( map, vMapUv );
        vec4 maskTexel = texture2D( uMaskMap, vMapUv * uMaskUv.xy + uMaskUv.zw );
        vec4 dirtTexel = texture2D( uDirtMap, vMapUv * uDirtUv );
        vec4 sandTexel = texture2D( uSandMap, vMapUv * uSandUv );
        vec3 groundColor = mix( sandTexel.rgb, grassTexel.rgb, maskTexel.r );
        groundColor = mix( groundColor, dirtTexel.rgb, maskTexel.g );
        groundColor *= mix( vec3( 1.0 ), vec3( 1.06, 1.0, 0.86 ), maskTexel.b );
        diffuseColor.rgb *= groundColor;
      `
      : `
        vec4 grassTexel = texture2D( map, vMapUv );
        vec4 maskTexel = texture2D( uMaskMap, vMapUv * uMaskUv.xy + uMaskUv.zw );
        float coverage = maskTexel.r;
        vec3 groundColor = mix( uDirtTint * 0.85, grassTexel.rgb, coverage );
        groundColor = mix( groundColor, uDirtTint, maskTexel.g * 0.9 );
        groundColor *= mix( vec3( 1.0 ), vec3( 1.06, 1.0, 0.86 ), maskTexel.b );
        diffuseColor.rgb *= groundColor * ( 0.35 + 0.65 * max( coverage, 0.35 ) );
      `;

    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${declarations}`)
        .replace('#include <map_fragment>', body);
    };
    material.customProgramCacheKey = () => (blend ? 'ground-blend-v1' : 'ground-tint-v1');
    material.needsUpdate = true;
  }

  /* ------------------------------------------------------------ grid lines */

  _buildGrid() {
    const { tileSize } = this.config;
    const cols = this.config.cols;
    const rows = this.config.rows;
    const y = 0.06;
    const colors = this.config.terrain.colors;

    const lines = [];
    for (let col = 0; col <= cols; col += 1) {
      const x = col * tileSize;
      lines.push(x, y, 0, x, y, rows * tileSize);
    }
    for (let row = 0; row <= rows; row += 1) {
      const z = row * tileSize;
      lines.push(0, y, z, cols * tileSize, y, z);
    }

    const lineGeometry = this._track(new THREE.BufferGeometry());
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    const lineMaterial = this._track(
      new THREE.LineBasicMaterial({
        color: new THREE.Color(colors.gridLine),
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
      }),
    );
    this.gridLines = new THREE.LineSegments(lineGeometry, lineMaterial);
    this.gridLines.name = 'grid-lines';
    this.gridLines.renderOrder = 2;
    this.group.add(this.gridLines);

    const border = [
      0, y, 0, cols * tileSize, y, 0,
      cols * tileSize, y, 0, cols * tileSize, y, rows * tileSize,
      cols * tileSize, y, rows * tileSize, 0, y, rows * tileSize,
      0, y, rows * tileSize, 0, y, 0,
    ];
    const borderGeometry = this._track(new THREE.BufferGeometry());
    borderGeometry.setAttribute('position', new THREE.Float32BufferAttribute(border, 3));
    const borderMaterial = this._track(
      new THREE.LineBasicMaterial({
        color: new THREE.Color(colors.gridBorder),
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      }),
    );
    this.gridBorder = new THREE.LineSegments(borderGeometry, borderMaterial);
    this.gridBorder.name = 'grid-border';
    this.gridBorder.renderOrder = 3;
    this.group.add(this.gridBorder);

    this.setGridVisible(this.gridVisible);
  }

  setGridVisible(visible) {
    this.gridVisible = Boolean(visible);
    if (this.gridLines) this.gridLines.visible = this.gridVisible;
    if (this.gridBorder) this.gridBorder.visible = this.gridVisible;
  }

  /** Called after a WebGL context loss: textures are re-uploaded on next frame. */
  markTexturesForUpload() {
    for (const texture of this.textures) texture.needsUpdate = true;
  }

  _track(resource) {
    if (resource && resource.isTexture) this.textures.push(resource);
    this._disposables.push(resource);
    return resource;
  }

  dispose() {
    for (const resource of this._disposables) {
      if (resource && typeof resource.dispose === 'function') resource.dispose();
    }
    this._disposables.length = 0;
    this.textures.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
