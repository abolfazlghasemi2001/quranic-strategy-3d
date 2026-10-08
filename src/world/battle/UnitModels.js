/**
 * UnitModels — همهٔ مدل‌های میدان نبرد، ساخته‌شده با کد (بدون هیچ فایل دودویی).
 *
 * قواعد طراحی:
 *   • low-poly و انتزاعی؛ هیچ چهره، هیچ اندام انسانی و هیچ نشانهٔ مذهبی روی مدل‌ها نیست.
 *   • رنگ‌ها به‌صورت «رنگ رأس» (vertex color) پخته می‌شوند تا هر گونهٔ واحد فقط
 *     یک متریال و یک InstancedMesh داشته باشد (چند draw call برای صدها سرباز).
 *   • رنگ هر لشکر از دادهٔ scene می‌آید: مدافع روشن/فیروزه‌ای، مهاجم خاکی/کهربایی.
 *   • همهٔ هندسه‌ها کوچک‌اند: یک واحد ≈ چند صد مثلث؛ حذف‌شان با dispose انجام می‌شود.
 */
import * as THREE from 'three';

export const BATTLE_FACTION = Object.freeze({ DEFENDER: 0, RAIDER: 1 });

export const BATTLE_PALETTES = Object.freeze({
  defender: { body: 0x2f8f96, trim: 0xf4ecd8, accent: 0xe7bd57, dark: 0x1c5b63, glow: 0xa8f4e6 },
  raider: { body: 0x6d4b39, trim: 0x2e2521, accent: 0xd9822f, dark: 0x3a2921, glow: 0xffb761 },
});

/** رنگ هر رأس را روی هندسه می‌نویسد (متریال واحد با vertexColors). */
export function paint(geometry, color) {
  const value = new THREE.Color(color);
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = value.r;
    colors[i * 3 + 1] = value.g;
    colors[i * 3 + 2] = value.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/** ادغام هندسه‌های رنگ‌شده در یک بافر (position/normal/color) — ورودی‌ها مصرف می‌شوند. */
export function mergePainted(parts, name = 'merged') {
  const sources = parts.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  let count = 0;
  for (const source of sources) count += source.attributes.position.count;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  let offset = 0;
  for (const source of sources) {
    const n = source.attributes.position.count;
    position.set(source.attributes.position.array, offset * 3);
    if (source.attributes.normal) normal.set(source.attributes.normal.array, offset * 3);
    if (source.attributes.color) color.set(source.attributes.color.array, offset * 3);
    offset += n;
    source.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(position, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(color, 3));
  merged.name = name;
  return merged;
}

const at = (geometry, x, y, z, rotate = null) => {
  if (rotate) {
    if (rotate.x) geometry.rotateX(rotate.x);
    if (rotate.y) geometry.rotateY(rotate.y);
    if (rotate.z) geometry.rotateZ(rotate.z);
  }
  geometry.translate(x, y, z);
  return geometry;
};

/**
 * هندسهٔ هر گونهٔ واحد. واحدها رو به +Z ساخته می‌شوند؛ چرخش نهایی در شبیه‌ساز
 * نمایش داده می‌شود. هیچ جزئیات چهره‌ای وجود ندارد (قاعدهٔ محتوایی پروژه).
 */
export function createUnitGeometry(type, palette) {
  const parts = [];
  const body = (r, h, color, y = h / 2) => at(paint(new THREE.ConeGeometry(r, h, 7), color), 0, y, 0);
  const head = (r, color, y) => at(paint(new THREE.SphereGeometry(r, 8, 6), color), 0, y, 0);
  const crown = (r, h, color, y) => at(paint(new THREE.ConeGeometry(r, h, 7), color), 0, y, 0);

  if (type === 'guard') {
    parts.push(body(0.34, 1.0, palette.body));
    parts.push(head(0.19, palette.trim, 1.14));
    parts.push(crown(0.24, 0.3, palette.accent, 1.3));
    parts.push(at(paint(new THREE.BoxGeometry(0.1, 0.62, 0.5), palette.accent), -0.32, 0.55, 0.06)); // سپر
    parts.push(at(paint(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 6), palette.dark), 0.3, 0.85, 0.02, { z: 0.16 }));
    parts.push(at(paint(new THREE.ConeGeometry(0.075, 0.26, 6), palette.trim), 0.42, 1.58, 0.02));
  } else if (type === 'archer') {
    parts.push(body(0.27, 1.02, palette.body));
    parts.push(head(0.18, palette.trim, 1.12));
    parts.push(crown(0.26, 0.36, palette.dark, 1.28)); // کلاه‌خود بلند
    parts.push(at(paint(new THREE.TorusGeometry(0.3, 0.035, 5, 12, Math.PI), palette.accent), 0.3, 0.9, 0, { y: Math.PI / 2 })); // کمان
    parts.push(at(paint(new THREE.CylinderGeometry(0.07, 0.07, 0.52, 6), palette.dark), -0.2, 0.86, -0.2, { z: -0.3 })); // تیردان
  } else if (type === 'healer') {
    parts.push(body(0.3, 0.96, palette.trim));
    parts.push(head(0.18, palette.body, 1.08));
    parts.push(crown(0.22, 0.28, palette.accent, 1.24));
    parts.push(at(paint(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 5), palette.dark), -0.3, 0.8, 0, { z: -0.05 })); // نیزهٔ پرچم
    parts.push(at(paint(new THREE.BoxGeometry(0.36, 0.42, 0.03), palette.accent), -0.14, 1.35, 0)); // پرچم
    parts.push(at(paint(new THREE.SphereGeometry(0.16, 10, 8), palette.glow), 0.3, 1.0, 0.1)); // فانوس
    parts.push(at(paint(new THREE.CylinderGeometry(0.02, 0.02, 0.4, 5), palette.dark), 0.3, 0.78, 0.1));
  } else if (type === 'breaker') {
    parts.push(at(paint(new THREE.BoxGeometry(0.58, 0.88, 0.48), palette.body), 0, 0.44, 0));
    parts.push(at(paint(new THREE.BoxGeometry(0.74, 0.16, 0.54), palette.trim), 0, 0.96, 0));
    parts.push(head(0.19, palette.trim, 1.16));
    parts.push(crown(0.26, 0.3, palette.dark, 1.32));
    parts.push(at(paint(new THREE.CylinderGeometry(0.14, 0.14, 1.15, 8), palette.dark), 0, 0.62, 0.5, { x: Math.PI / 2 })); // دژکوب
    parts.push(at(paint(new THREE.BoxGeometry(0.07, 0.5, 0.07), palette.accent), -0.22, 0.62, 0.3, { x: 0.5 }));
    parts.push(at(paint(new THREE.BoxGeometry(0.07, 0.5, 0.07), palette.accent), 0.22, 0.62, 0.3, { x: 0.5 }));
  } else {
    parts.push(body(0.3, 1.0, palette.body));
    parts.push(head(0.18, palette.trim, 1.1));
  }
  return mergePainted(parts, `unit:${type}`);
}

/** متریال مشترک واحدها (یک بار ساخته و همه‌جا استفاده می‌شود). */
export function createUnitMaterial() {
  return new THREE.MeshLambertMaterial({ vertexColors: true });
}

/** هندسهٔ تیر/گلولهٔ نوری (برای پروازهای کوتاه دیداری). */
export function createProjectileGeometry(kind) {
  if (kind === 'light-bolt') return paint(new THREE.SphereGeometry(0.13, 8, 6), 0xfff0c2);
  if (kind === 'light-ring') return paint(new THREE.TorusGeometry(0.22, 0.05, 5, 12), 0xffe6a8);
  return mergePainted([
    at(paint(new THREE.BoxGeometry(0.05, 0.05, 0.62), 0xf3ead4), 0, 0, 0),
    at(paint(new THREE.ConeGeometry(0.07, 0.16, 5), 0xe7bd57), 0, 0, 0.36, { x: Math.PI / 2 }),
  ], `projectile:${kind}`);
}

/** نوار جان: مستطیل ۱×۰٫۱۶ با لنگر در لبهٔ چپ (x از ۰ تا ۱). */
export function createBarGeometry(height = 0.16) {
  const geometry = new THREE.PlaneGeometry(1, height);
  geometry.translate(0.5, 0, 0);
  return geometry;
}

/** بافتِ ذره‌ها: گرادیان شعاعی نرم (گرد و خاک و جرقه) — با کد کشیده می‌شود. */
export function createParticleTexture(kind) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d');
  const gradient = c.createRadialGradient(32, 32, 2, 32, 32, 31);
  if (kind === 'spark') {
    gradient.addColorStop(0, 'rgba(255,255,235,0.95)');
    gradient.addColorStop(0.35, 'rgba(255,206,120,0.7)');
    gradient.addColorStop(1, 'rgba(255,160,60,0)');
  } else {
    gradient.addColorStop(0, 'rgba(240,236,224,0.75)');
    gradient.addColorStop(0.5, 'rgba(214,204,180,0.42)');
    gradient.addColorStop(1, 'rgba(200,190,168,0)');
  }
  c.fillStyle = gradient;
  c.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** حلقهٔ استقرار (نمایش نقطهٔ فرود نیرو روی زمین). */
export function createDeployRing(inner = 0.7, outer = 1.0, color = 0x8ff0e0) {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 20),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  group.add(ring);
  const spoke = new THREE.Mesh(
    new THREE.PlaneGeometry(outer * 1.5, 0.12),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }),
  );
  spoke.rotation.x = -Math.PI / 2;
  group.add(spoke);
  return group;
}
