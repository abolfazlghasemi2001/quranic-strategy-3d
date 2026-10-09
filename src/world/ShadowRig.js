/** Camera-frustum/caster-volume intersection, fixed extent buckets and light-space texel snapping. */
import * as THREE from 'three';
const EDGES = [[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]];
function clip(a, b, planes, outA, outB) {
  let enter = 0, exit = 1;
  for (const plane of planes) {
    const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
    if (da < 0 && db < 0) return false;
    if (da < 0) enter = Math.max(enter, da / (da - db));
    else if (db < 0) exit = Math.min(exit, da / (da - db));
    if (enter > exit) return false;
  }
  outA.copy(a).lerp(b, enter); outB.copy(a).lerp(b, exit); return true;
}
export class ShadowRig {
  constructor({ width, depth, settings = {} }) {
    this.settings = settings;
    const margin = settings.casterMargin || 0;
    this.bounds = new THREE.Box3(new THREE.Vector3(-margin, 0, -margin), new THREE.Vector3(width + margin, settings.maxCasterHeight || 12, depth + margin));
    const lo = this.bounds.min, hi = this.bounds.max;
    this.planes = [new THREE.Plane(new THREE.Vector3(1,0,0),-lo.x),new THREE.Plane(new THREE.Vector3(-1,0,0),hi.x),new THREE.Plane(new THREE.Vector3(0,1,0),-lo.y),new THREE.Plane(new THREE.Vector3(0,-1,0),hi.y),new THREE.Plane(new THREE.Vector3(0,0,1),-lo.z),new THREE.Plane(new THREE.Vector3(0,0,-1),hi.z)];
    this.world = Array.from({length:8}, (_, i) => new THREE.Vector3(i&1?hi.x:lo.x,i&2?hi.y:lo.y,i&4?hi.z:lo.z));
    this.view = Array.from({length:8}, () => new THREE.Vector3());
    this.frustum = new THREE.Frustum(); this.matrix = new THREE.Matrix4(); this.lightBox = new THREE.Box3();
    this.a = new THREE.Vector3(); this.b = new THREE.Vector3(); this.point = new THREE.Vector3();
    this.position = new THREE.Vector3(); this.target = new THREE.Vector3(); this.direction = new THREE.Vector3(); this.right = new THREE.Vector3();
  }
  _addPoint(point) { this.point.copy(point).applyMatrix4(this.lightView); this.lightBox.expandByPoint(this.point); }
  fit(camera, light, azimuth = 0) {
    camera.updateMatrixWorld(true); this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);
    for (let i=0;i<8;i++) this.view[i].set(i&1?1:-1,i&2?1:-1,i&4?1:-1).unproject(camera);
    light.getWorldPosition(this.position); light.target.getWorldPosition(this.target);
    const shadow = light.shadow, cam = shadow.camera;
    cam.position.copy(this.position); this.direction.copy(this.position).sub(this.target).normalize();
    this.right.set(Math.cos(azimuth), 0, -Math.sin(azimuth)); cam.up.copy(this.direction).cross(this.right).normalize();
    cam.lookAt(this.target); cam.updateMatrixWorld(true); this.lightBox.makeEmpty();
    this.lightView = cam.matrixWorldInverse;
    for (let i=0;i<8;i++) { if(this.frustum.containsPoint(this.world[i]))this._addPoint(this.world[i]); if(this.bounds.containsPoint(this.view[i]))this._addPoint(this.view[i]); }
    for (const [i,j] of EDGES) {
      if(clip(this.world[i],this.world[j],this.frustum.planes,this.a,this.b)){this._addPoint(this.a);this._addPoint(this.b);}
      if(clip(this.view[i],this.view[j],this.planes,this.a,this.b)){this._addPoint(this.a);this._addPoint(this.b);}
    }
    if(this.lightBox.isEmpty())return false;
    const p = this.settings.fitPadding || 3, q = this.settings.extentQuantum || 4;
    const lo=this.lightBox.min, hi=this.lightBox.max;
    const width=Math.max(q,Math.ceil((hi.x-lo.x+p*2)/q)*q),height=Math.max(q,Math.ceil((hi.y-lo.y+p*2)/q)*q);
    const tx=width/shadow.mapSize.x,ty=height/shadow.mapSize.y;
    const cx=Math.round((hi.x+lo.x)/2/tx)*tx,cy=Math.round((hi.y+lo.y)/2/ty)*ty;
    cam.left=cx-width/2;cam.right=cx+width/2;cam.bottom=cy-height/2;cam.top=cy+height/2;
    cam.near=Math.max(.1,-hi.z-p);cam.far=Math.max(cam.near+1,-lo.z+p);cam.updateProjectionMatrix();
    return true;
  }
}
