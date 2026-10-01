import * as THREE from 'three';

/** Gradient sky dome with sun disc/halo, moon, stars and soft procedural clouds. */
export class Sky {
  readonly mesh: THREE.Mesh;
  readonly uniforms = {
    uZenith: { value: new THREE.Color(0x2a6ac8) },
    uHorizon: { value: new THREE.Color(0xa8d0f0) },
    uGround: { value: new THREE.Color(0x6a7a8a) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xffffff) },
    uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
    uNight: { value: 0 },
    uCloud: { value: 0.3 },
    uTime: { value: 0 },
    uHaze: { value: new THREE.Color(0xffffff) },
    uHazeAmt: { value: 0 },
  };

  constructor(scene: THREE.Scene, clouds: boolean) {
    const geo = new THREE.SphereGeometry(1, 32, 16);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      defines: clouds ? { CLOUDS: 1 } : {},
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = position;
          vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position = p.xyww;
        }`,
      fragmentShader: `
        uniform vec3 uZenith, uHorizon, uGround, uSunColor, uHaze;
        uniform vec3 uSunDir, uMoonDir;
        uniform float uNight, uCloud, uTime, uHazeAmt;
        varying vec3 vDir;
        float h21(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
        float n2(vec2 p) { vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
        void main() {
          vec3 d = normalize(vDir);
          float y = d.y;
          vec3 col = y > 0.0 ? mix(uHorizon, uZenith, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-y * 4.0, 0.0, 1.0));
          float sd = max(dot(d, uSunDir), 0.0);
          col += uSunColor * (pow(sd, 900.0) * 18.0 + pow(sd, 12.0) * 0.35 + pow(sd, 3.0) * 0.12) * (1.0 - uNight * 0.9);
          // moon
          float md = max(dot(d, uMoonDir), 0.0);
          col += vec3(0.85, 0.9, 1.0) * (smoothstep(0.9994, 0.9997, md) * 1.2 + pow(md, 60.0) * 0.12) * uNight;
          // stars
          if (uNight > 0.01 && y > 0.0) {
            vec2 sp = d.xz / (y + 0.35) * 160.0;
            float s = h21(floor(sp));
            float tw = 0.6 + 0.4 * sin(uTime * 3.0 + s * 50.0);
            col += vec3(step(0.996, s) * tw * smoothstep(0.0, 0.25, y)) * uNight * (1.0 - uCloud);
          }
          #ifdef CLOUDS
          if (y > 0.0) {
            vec2 cp = d.xz / (y + 0.12) * 1.6 + vec2(uTime * 0.004, uTime * 0.002);
            float c = n2(cp) * 0.55 + n2(cp * 2.3) * 0.3 + n2(cp * 5.1) * 0.15;
            c = smoothstep(1.0 - uCloud * 0.85 - 0.1, 1.05, c) * smoothstep(0.0, 0.18, y);
            vec3 cc = mix(vec3(1.0), uSunColor, 0.35) * (0.55 + 0.45 * (1.0 - uNight));
            cc = mix(cc, uHorizon * 0.8, 0.25) * (1.0 - uNight * 0.75);
            col = mix(col, cc, c * 0.85);
          }
          #endif
          col = mix(col, uHaze, uHazeAmt * (1.0 - clamp(y * 1.5, 0.0, 1.0) * 0.4));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(500);
    scene.add(this.mesh);
  }

  follow(cam: THREE.Camera): void {
    this.mesh.position.copy(cam.position);
  }
}
