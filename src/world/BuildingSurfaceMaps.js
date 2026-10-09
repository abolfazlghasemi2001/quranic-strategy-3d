/** Procedural data maps derived from the existing geometric ornament canvases; no writing. */
import * as THREE from 'three';
export function applyBuildingSurfaceMaps(factory, { tier, anisotropy = 1, normalStrength = 0.42 }) {
  if (tier === 'low' || factory.tier === 'low' || factory.disposed || factory.surfaceMapsGenerated) return;
  factory.surfaceMapsGenerated = true;
  for (const [material, colorMap] of [[factory.materials.brick, factory.textures[0]], [factory.materials.tile, factory.textures[1]], [factory.materials.star, factory.textures[2]]]) {
    const source = colorMap.image, size = source.width;
    const pixels = source.getContext('2d').getImageData(0, 0, size, size).data;
    const height = (x, y) => { const i = (((y + size) % size) * size + (x + size) % size) * 4; return (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 765; };
    for (const kind of ['normal', 'roughness']) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
      const context = canvas.getContext('2d'), image = context.createImageData(size, size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (kind === 'normal') {
          const dx = (height(x-1,y)-height(x+1,y))*2, dy=(height(x,y-1)-height(x,y+1))*2, inv=1/Math.sqrt(dx*dx+dy*dy+1);
          image.data[i]=(dx*inv*.5+.5)*255;image.data[i+1]=(dy*inv*.5+.5)*255;image.data[i+2]=(inv*.5+.5)*255;
        } else image.data[i]=image.data[i+1]=image.data[i+2]=Math.round(200+height(x,y)*45);
        image.data[i+3]=255;
      }
      context.putImageData(image,0,0); const texture=new THREE.CanvasTexture(canvas);
      texture.colorSpace=THREE.NoColorSpace;texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.repeat.copy(colorMap.repeat);texture.anisotropy=anisotropy;texture.generateMipmaps=true;
      factory.textures.push(texture);
      if(kind==='normal'){material.normalMap=texture;material.normalScale.set(normalStrength,normalStrength);}else material.roughnessMap=texture;
    }
    colorMap.anisotropy=anisotropy;material.needsUpdate=true;
  }
}
