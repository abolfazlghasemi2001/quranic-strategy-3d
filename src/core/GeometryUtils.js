/**
 * Geometry helpers. Every mesh in the game is built from code — no binary model files.
 * All helpers are pure geometry math, usable from Node (no DOM, no WebGL required).
 */
import * as THREE from 'three';
import { hash3i } from './RNG.js';

/**
 * Axis aligned ground quad (XZ plane) with UVs expressed in world units,
 * so tiled textures keep a constant scale no matter how big the quad is.
 */
export function createGroundQuad({ x0, z0, x1, z1, y = 0, uvScale = 8, name = 'ground-quad' }) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array([
    x0, y, z0,
    x1, y, z0,
    x1, y, z1,
    x0, y, z1,
  ]);
  const u = (value) => value / uvScale;
  const uvs = new Float32Array([
    u(x0), u(z0),
    u(x1), u(z0),
    u(x1), u(z1),
    u(x0), u(z1),
  ]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setIndex([0, 2, 1, 0, 3, 2]);
  geometry.name = name;
  return geometry;
}

/**
 * Merge geometries into one buffer (position/normal/uv).
 * Contract: the inputs are *consumed* — they are disposed at the end, so callers
 * must not keep references to them.
 */
export function mergeGeometries(geometries, { name = 'merged' } = {}) {
  const inputs = geometries.filter(Boolean);
  const sources = inputs.map((g) => (g.index ? g.toNonIndexed() : g.clone()));
  let vertexCount = 0;
  for (const geometry of sources) vertexCount += geometry.attributes.position.count;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);

  let offset = 0;
  for (const geometry of sources) {
    const count = geometry.attributes.position.count;
    position.set(geometry.attributes.position.array, offset * 3);
    if (geometry.attributes.normal) normal.set(geometry.attributes.normal.array, offset * 3);
    if (geometry.attributes.uv) uv.set(geometry.attributes.uv.array, offset * 2);
    offset += count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.name = name;

  for (const geometry of sources) geometry.dispose();
  for (const geometry of inputs) geometry.dispose();
  return merged;
}

/**
 * Deterministic low-poly "rock" jitter.
 * Vertices are displaced by a hash of their (rounded) position, so duplicated
 * vertices of the same corner always move together and faces never tear.
 */
export function jitterPositions(geometry, { amount = 0.12, seed = 0, round = 100 } = {}) {
  const position = geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const kx = Math.round(x * round);
    const ky = Math.round(y * round);
    const kz = Math.round(z * round);
    const nx = (hash3i(kx, ky, (kz ^ seed) >>> 0) / 4294967295) * 2 - 1;
    const ny = (hash3i(kx + 7, ky - 3, (kz ^ (seed + 131)) >>> 0) / 4294967295) * 2 - 1;
    const nz = (hash3i(kx - 11, ky + 5, (kz ^ (seed + 977)) >>> 0) / 4294967295) * 2 - 1;
    position.setXYZ(i, x + nx * amount, y + ny * amount * 0.75, z + nz * amount);
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Chunky low-poly rock sitting on the ground plane (origin at its base). */
export function createRockGeometry({ radius = 0.55, detail = 1, squash = 0.78, seed = 0, amount = 0.16 } = {}) {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  jitterPositions(geometry, { amount: amount * radius * 2.2, seed, round: 100 });
  geometry.scale(1, squash, 1);
  geometry.translate(0, radius * squash * 0.72, 0);
  geometry.computeVertexNormals();
  geometry.name = 'rock';
  return geometry;
}

/** Small bush: squashed jittered icosahedron. */
export function createShrubGeometry({ radius = 0.42, squash = 0.72, seed = 0 } = {}) {
  const geometry = new THREE.IcosahedronGeometry(radius, 0);
  jitterPositions(geometry, { amount: radius * 0.35, seed, round: 100 });
  geometry.scale(1.12, squash, 1.12);
  geometry.translate(0, radius * squash * 0.7, 0);
  geometry.computeVertexNormals();
  geometry.name = 'shrub';
  return geometry;
}

/**
 * Tree parts, both with origin at the ground so a single instance matrix drives
 * the trunk and the foliage (2 draw calls for the whole forest).
 */
export function createTreeGeometries({ trunkHeight = 1.05, levels = 3, segments = 7, seed = 0 } = {}) {
  const trunk = new THREE.CylinderGeometry(0.11, 0.19, trunkHeight, 6, 1, true);
  trunk.translate(0, trunkHeight * 0.5, 0);
  trunk.name = 'tree-trunk';

  const cones = [];
  for (let i = 0; i < levels; i += 1) {
    const t = i / Math.max(1, levels - 1 || 1);
    const radius = 0.66 - t * 0.34;
    const height = 0.92 - t * 0.22;
    const y = trunkHeight + i * 0.52 + height * 0.42;
    const cone = new THREE.ConeGeometry(radius, height, segments, 1, true);
    cone.translate(0, y, 0);
    cones.push(cone);
  }

  const foliage = mergeGeometries(cones, { name: 'tree-foliage' });

  // Gentle per-vertex wobble keeps the silhouette organic but still low-poly.
  jitterPositions(trunk, { amount: 0.012, seed: seed + 11, round: 500 });
  jitterPositions(foliage, { amount: 0.035, seed: seed + 29, round: 200 });

  return { trunk, foliage };
}

/** Thin ring used as a tap marker on the ground. */
export function createMarkerGeometry({ innerRadius = 0.55, outerRadius = 0.85, segments = 36 } = {}) {
  const geometry = new THREE.RingGeometry(innerRadius, outerRadius, segments, 1);
  geometry.rotateX(-Math.PI / 2);
  geometry.name = 'tap-marker';
  return geometry;
}
