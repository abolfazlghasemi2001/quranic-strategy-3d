import * as THREE from 'three';
import { expect, it } from 'vitest';
import { ShadowRig } from '../src/world/ShadowRig.js';
import world from '../src/data/world.json';
const setup = () => {
 const camera=new THREE.PerspectiveCamera(48,412/915,.5,620); camera.position.set(70,60,95);camera.lookAt(40,0,40);camera.updateMatrixWorld(true);
 const light=new THREE.DirectionalLight();light.position.set(95,130,70);light.target.position.set(40,0,40);light.shadow.mapSize.set(1024,1024);
 const rig=new ShadowRig({width:80,depth:80,settings:world.lighting.sun.stableShadow});return {camera,light,rig};
};
it('fits the actual visible caster volume with quantized extents and texel-snapped centres', () => {
 const {camera,light,rig}=setup();expect(rig.fit(camera,light,1.2)).toBe(true);const c=light.shadow.camera;
 const width=c.right-c.left,height=c.top-c.bottom;expect(width%4).toBe(0);expect(height%4).toBe(0);
 expect((c.left+c.right)/2/(width/1024)).toBeCloseTo(Math.round((c.left+c.right)/2/(width/1024)),8);
 expect(c.far).toBeGreaterThan(c.near);expect(c.projectionMatrix.elements.every(Number.isFinite)).toBe(true);
});
it('holds its shadow projection during a sub-texel camera pan', () => {
 const {camera,light,rig}=setup();rig.fit(camera,light,1.2);const projection=light.shadow.camera.projectionMatrix.clone();
 camera.position.x+=0.00001;camera.updateMatrixWorld(true);rig.fit(camera,light,1.2);
 // Near/far may vary continuously, but XY extents / centres must remain fixed.
 for(const index of [0,5,12,13])expect(light.shadow.camera.projectionMatrix.elements[index]).toBe(projection.elements[index]);
});
it('has no singular shadow orientation at solar zenith', () => {
 const {camera,light,rig}=setup();light.position.set(40,130,40);expect(rig.fit(camera,light,1.2)).toBe(true);
 expect(light.shadow.camera.matrixWorld.elements.every(Number.isFinite)).toBe(true);
 expect(light.shadow.camera.up.length()).toBeCloseTo(1);
});
