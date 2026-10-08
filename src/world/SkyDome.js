/**
 * SkyDome — code generated gradient sky with a sun glow.
 * A single back side sphere that follows the camera position, so the sky is
 * effectively infinite without touching the far plane.
 */
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  varying vec3 vSkyDirection;

  void main() {
    vSkyDirection = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uBelow;
  uniform vec3 uGlow;
  uniform vec3 uSunDirection;
  uniform float uGradientPower;
  uniform float uGlowFalloff;
  uniform float uGlowStrength;

  varying vec3 vSkyDirection;

  vec3 blendedSky( vec3 direction ) {
    float height = direction.y * 0.5 + 0.5;

    // above the horizon: warm haze -> blue sky
    vec3 color = mix( uHorizon, uZenith, pow( clamp( height, 0.0, 1.0 ), uGradientPower ) );
    float haze = pow( 1.0 - abs( direction.y ), 6.0 ) * 0.22;
    color = mix( color, uHorizon, haze );

    // below the horizon (visible past the island edge): distant land haze
    float below = clamp( -direction.y, 0.0, 1.0 );
    color = mix( color, uBelow, smoothstep( 0.0, 0.22, below ) );

    float sun = pow( max( dot( direction, normalize( uSunDirection ) ), 0.0 ), uGlowFalloff );
    color += uGlow * sun * uGlowStrength;
    return color;
  }

  void main() {
    gl_FragColor = vec4( blendedSky( normalize( vSkyDirection ) ), 1.0 );

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class SkyDome {
  constructor({ config }) {
    const sky = config.world.sky;
    const sun = config.sunDirection;

    this.uniforms = {
      uZenith: { value: new THREE.Color(sky.zenith) },
      uHorizon: { value: new THREE.Color(sky.horizon) },
      uBelow: { value: new THREE.Color(sky.below ?? sky.horizon) },
      uGlow: { value: new THREE.Color(sky.glow) },
      uSunDirection: { value: new THREE.Vector3(sun.x, sun.y, sun.z).normalize() },
      uGradientPower: { value: sky.gradientPower ?? 0.62 },
      uGlowFalloff: { value: sky.glowFalloff ?? 7 },
      uGlowStrength: { value: sky.glowStrength ?? 0.85 },
    };

    this.geometry = new THREE.SphereGeometry(1, 32, 16);
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'sky-dome';
    this.mesh.scale.setScalar(sky.radius ?? 600);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = true;
  }

  update(_dt, engine) {
    // Keep the dome centred on the camera: the sky never gets "closer".
    this.mesh.position.copy(engine.camera.position);
  }

  setLighting({ sunDirection, zenith, horizon, below, glow, glowStrength } = {}) {
    if (sunDirection) this.uniforms.uSunDirection.value.set(sunDirection.x, sunDirection.y, sunDirection.z).normalize();
    if (zenith) this.uniforms.uZenith.value.copy(zenith);
    if (horizon) this.uniforms.uHorizon.value.copy(horizon);
    if (below) this.uniforms.uBelow.value.copy(below);
    if (glow) this.uniforms.uGlow.value.copy(glow);
    if (Number.isFinite(glowStrength)) this.uniforms.uGlowStrength.value = glowStrength;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
  }
}
