/** Apply a tiny vertex sway to foliage materials without adding a draw call. */
export function applyWindShader(material, { strength = 0.1, heightStart = 0.2, heightSpan = 1.5 } = {}) {
  if (!material || material.userData?.shahrWindApplied) return material;

  material.userData.shahrWindApplied = true;
  material.userData.shahrWindUniforms = null;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = { value: 0 };
    shader.uniforms.uWindStrength = { value: strength };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uWindTime;\nuniform float uWindStrength;',
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
          #ifdef USE_INSTANCING
            float shahrWindSeed = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.053;
          #else
            float shahrWindSeed = position.x * 0.071 + position.z * 0.053;
          #endif
          float shahrWindHeight = clamp((position.y - ${Number(heightStart).toFixed(4)}) / ${Math.max(0.01, Number(heightSpan)).toFixed(4)}, 0.0, 1.0);
          float shahrWindWave = sin(uWindTime * 0.85 + shahrWindSeed + position.y * 0.7);
          transformed.x += shahrWindWave * shahrWindHeight * uWindStrength;
          transformed.z += cos(uWindTime * 0.63 + shahrWindSeed * 1.3) * shahrWindHeight * uWindStrength * 0.28;`,
      );
    material.userData.shahrWindUniforms = shader.uniforms;
  };
  material.customProgramCacheKey = () => `shahr-nur-wind-v1-${strength}-${heightStart}-${heightSpan}`;
  material.needsUpdate = true;
  return material;
}

export function setWindTime(material, time) {
  const uniforms = material?.userData?.shahrWindUniforms;
  if (uniforms?.uWindTime) uniforms.uWindTime.value = Number(time) || 0;
}
