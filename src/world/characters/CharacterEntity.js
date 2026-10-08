/** A single pooled rig instance. Geometry/material/texture ownership stays in CharacterSystem. */
import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';

export class CharacterEntity {
  constructor({ key, profile, faction, model, onAnimationChange = null }) {
    this.key = String(key);
    this.profile = profile;
    this.model = model;
    this.modelId = model.id;
    this.faction = faction;
    this.onAnimationChange = onAnimationChange;
    this.root = new THREE.Group();
    this.root.name = `character:${this.key}`;
    this.root.visible = false;
    this.root.userData.characterId = profile.id;
    this.root.userData.faction = faction;

    this.ready = false;
    this.visual = null;
    this.mixer = null;
    this.clips = new Map();
    this.actions = new Map();
    this.currentAction = null;
    this.currentAnimation = null;
    this.baseAnimation = 'idle';
    this.transientRemaining = 0;
    this.reducedMotion = false;
    this.meshCount = 0;
    this.triangles = 0;
  }

  attach(asset, materialVariants, { castShadow = true } = {}) {
    if (this.ready || !asset?.scene) return this.ready;
    const modelRoot = cloneSkeleton(asset.scene);
    const seen = new Set();
    let meshCount = 0;
    let triangles = 0;
    modelRoot.traverse((node) => {
      if (!node.isMesh) return;
      meshCount += Array.isArray(node.material) ? node.material.length : 1;
      node.castShadow = Boolean(castShadow);
      node.receiveShadow = false;
      node.frustumCulled = true;
      if (Array.isArray(node.material)) {
        node.material = node.material.map((material) => materialVariants.get(material) || material);
      } else {
        node.material = materialVariants.get(node.material) || node.material;
      }
      const geometry = node.geometry;
      if (geometry && !seen.has(geometry)) {
        seen.add(geometry);
        triangles += Math.floor((geometry.index?.count ?? geometry.attributes?.position?.count ?? 0) / 3);
      }
    });

    modelRoot.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(modelRoot);
    const size = new THREE.Vector3();
    bounds.getSize(size);
    const height = Math.max(0.01, size.y);
    const scale = this.model.targetHeight / height;
    const fit = new THREE.Group();
    fit.name = `character-fit:${this.profile.id}`;
    fit.scale.setScalar(scale);
    fit.position.y = -bounds.min.y * scale;
    fit.add(modelRoot);
    this.root.add(fit);

    this.visual = modelRoot;
    this.mixer = new THREE.AnimationMixer(modelRoot);
    this.clips.clear();
    for (const clip of asset.animations || []) this.clips.set(clip.name, clip);
    this.meshCount = meshCount;
    this.triangles = triangles;
    this.ready = true;
    this.setAnimation('idle', { fade: 0 });
    this.mixer.update(0);
    return true;
  }

  setTransform({ x = 0, y = 0, z = 0, rotation = 0, scale = 1 } = {}) {
    this.root.position.set(x, y, z);
    this.root.rotation.set(0, rotation, 0);
    this.root.scale.setScalar(Math.max(0, scale));
  }

  setVisible(visible) {
    this.root.visible = Boolean(visible && this.ready);
  }

  setAnimation(key, { fade = 0.16, loop = true } = {}) {
    if (!this.ready) return false;
    const requested = this.reducedMotion && key !== 'death' ? 'idle' : key;
    this.baseAnimation = requested;
    if (this.transientRemaining > 0 && requested !== 'death') return true;
    if (requested === 'death') this.transientRemaining = 0;
    return this._activate(requested, { fade, loop });
  }

  playTransient(key, seconds = 0.32) {
    if (!this.ready || this.reducedMotion || key === 'death') return false;
    const played = this._activate(key, { fade: 0.06, loop: false });
    if (played) this.transientRemaining = Math.max(0.05, Number(seconds) || 0.32);
    return played;
  }

  _activate(key, { fade = 0.16, loop = true } = {}) {
    const clipName = this.model.animations[key] || this.model.animations.idle;
    const clip = this.clips.get(clipName);
    if (!clip) return false;
    if (this.currentAnimation === key && this.currentAction?.isRunning()) return true;

    const next = this.mixer.clipAction(clip);
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.setEffectiveTimeScale(1);
    next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    next.play();

    const previous = this.currentAction;
    if (previous && previous !== next && fade > 0) previous.crossFadeTo(next, fade, true);
    else if (previous && previous !== next) previous.stop();

    this.currentAction = next;
    this.currentAnimation = key;
    try { this.onAnimationChange?.({ key, clip: clipName }); } catch { /* presentation observer only */ }
    return true;
  }

  updateAnimation(dt) {
    if (!this.ready || this.reducedMotion || !this.mixer || !(dt > 0)) return;
    if (this.transientRemaining > 0) {
      this.transientRemaining = Math.max(0, this.transientRemaining - dt);
      if (this.transientRemaining === 0 && this.baseAnimation !== this.currentAnimation) {
        this._activate(this.baseAnimation, { fade: 0.12, loop: true });
      }
    }
    this.mixer.update(dt);
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
    if (this.reducedMotion && this.ready) {
      this.transientRemaining = 0;
      this.setAnimation('idle', { fade: 0 });
      this.mixer?.update(0);
    }
  }

  resetForPool() {
    this.root.visible = false;
    this.root.position.set(0, 0, 0);
    this.root.rotation.set(0, 0, 0);
    this.root.scale.setScalar(1);
    this.transientRemaining = 0;
    this.baseAnimation = 'idle';
    this.currentAnimation = null;
    this.currentAction = null;
    this.mixer?.stopAllAction();
  }

  dispose() {
    this.resetForPool();
    this.mixer?.stopAllAction();
    this.root.removeFromParent();
    this.root.clear();
    this.clips.clear();
    this.actions.clear();
    this.mixer = null;
    this.visual = null;
    this.ready = false;
  }
}
