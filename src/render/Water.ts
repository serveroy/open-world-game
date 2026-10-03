import * as THREE from 'three';
import { WATER_Y, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../world/constants';

/** Wave height used by boat buoyancy (kept in sync with shader low-frequency swell). */
export function waveHeight(x: number, z: number, t: number): number {
  return Math.sin(x * 0.05 + t * 0.9) * 0.12 + Math.sin(z * 0.07 - t * 0.7) * 0.1 + Math.sin((x + z) * 0.11 + t * 1.3) * 0.05;
}

/**
 * Stylised ocean: follows the camera, depth-tinted using a baked depth texture
 * (turquoise shallows, foam at the shoreline), fresnel sky reflection, sun glint.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  readonly uniforms: Record<string, THREE.IUniform>;

  constructor(scene: THREE.Scene, depthSampler: (x: number, z: number) => number, size = 1800) {
    const W = 400, H = 300;
    const data = new Uint8Array(W * H);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const x = WORLD_MIN_X + ((i + 0.5) / W) * (WORLD_MAX_X - WORLD_MIN_X);
        const z = WORLD_MIN_Z + ((j + 0.5) / H) * (WORLD_MAX_Z - WORLD_MIN_Z);
        const d = WATER_Y - depthSampler(x, z);
        data[j * W + i] = Math.max(0, Math.min(255, Math.round((d / 16) * 255)));
      }
    const tex = new THREE.DataTexture(data, W, H, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;

    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Color(1, 1, 1) },
        uSky: { value: new THREE.Color(0x9cc4e4) },
        uDeep: { value: new THREE.Color(0x0a3a5a) },
        uShallow: { value: new THREE.Color(0x2ac0c0) },
        uNight: { value: 0 },
        uRain: { value: 0 },
        uDepth: { value: tex },
        uWorldMin: { value: new THREE.Vector2(WORLD_MIN_X, WORLD_MIN_Z) },
        uWorldSize: { value: new THREE.Vector2(WORLD_MAX_X - WORLD_MIN_X, WORLD_MAX_Z - WORLD_MIN_Z) },
      },
    ]);
    this.uniforms.uDepth!.value = tex;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      fog: true,
      vertexShader: `
        varying vec3 vW;
        #include <fog_pars_vertex>
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vW = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        uniform float uTime, uNight, uRain;
        uniform vec3 uSunDir, uSunColor, uSky, uDeep, uShallow;
        uniform sampler2D uDepth;
        uniform vec2 uWorldMin, uWorldSize;
        varying vec3 vW;
        #include <fog_pars_fragment>
        float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
        float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
        void main() {
          vec2 uv = (vW.xz - uWorldMin) / uWorldSize;
          float depth = texture2D(uDepth, uv).r * 16.0;
          if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) depth = 16.0;
          float t = uTime;
          vec2 p = vW.xz;
          // analytic wave normal (sum of directional sines) + noise ripples
          vec3 n = vec3(0.0, 1.0, 0.0);
          n.x += cos(p.x * 0.05 + t * 0.9) * 0.05 * 0.12 + cos((p.x + p.y) * 0.11 + t * 1.3) * 0.11 * 0.05;
          n.z += cos(p.y * 0.07 - t * 0.7) * 0.07 * 0.1;
          float r1 = n2(p * 0.35 + vec2(t * 0.6, t * 0.3));
          float r2 = n2(p * 0.9 - vec2(t * 0.4, -t * 0.7));
          float r3 = n2(p * 3.0 + vec2(t * 1.5));
          n.x += (r1 - 0.5) * 0.22 + (r2 - 0.5) * 0.12 + (r3 - 0.5) * 0.05 * (1.0 + uRain * 4.0);
          n.z += (r2 - 0.5) * 0.22 + (r1 - 0.5) * 0.12 + (r3 - 0.5) * 0.05 * (1.0 + uRain * 4.0);
          n = normalize(n);
          vec3 V = normalize(cameraPosition - vW);
          float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0) * 0.85 + 0.05;
          float shallow = 1.0 - smoothstep(0.3, 7.0, depth);
          vec3 base = mix(uDeep, uShallow, shallow * 0.85);
          base *= mix(1.0, 0.25, uNight);
          vec3 sky = uSky * mix(1.0, 0.6, uNight);
          vec3 col = mix(base, sky, fres);
          vec3 H = normalize(uSunDir + V);
          float spec = pow(max(dot(n, H), 0.0), 220.0) * 3.0 * (1.0 - uRain * 0.8);
          col += uSunColor * spec * max(uSunDir.y, 0.0) * 2.0;
          // shoreline foam bands
          float foamZone = 1.0 - smoothstep(0.0, 1.2, depth);
          float bands = smoothstep(0.55, 0.9, sin(depth * 9.0 - t * 2.2) * 0.5 + 0.5) * (1.0 - smoothstep(0.0, 0.9, depth));
          float foam = clamp(foamZone * 0.65 + bands * 0.6, 0.0, 1.0) * (0.6 + r1 * 0.5);
          col = mix(col, vec3(0.92, 0.96, 1.0) * mix(1.0, 0.35, uNight), foam);
          float alpha = mix(0.35, 0.94, smoothstep(0.0, 5.0, depth));
          alpha = max(alpha, foam * 0.9);
          gl_FragColor = vec4(col, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
    });
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = WATER_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
  }

  update(cam: THREE.Camera, time: number): void {
    // snap to grid to keep noise stable
    this.mesh.position.x = Math.round(cam.position.x / 50) * 50;
    this.mesh.position.z = Math.round(cam.position.z / 50) * 50;
    this.uniforms.uTime!.value = time;
  }
}
