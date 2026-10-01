import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { Renderer } from './Renderer';
import type { Settings } from '../core/Settings';

/** Vignette + film grain + damage tint, applied in linear space before tone mapping. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uVignette: { value: 0.32 },
    uGrain: { value: 0.025 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain; uniform vec3 uTint;
    varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float v = 1.0 - dot(d, d) * uVignette * 2.6;
      c.rgb *= clamp(v, 0.0, 1.0) * uTint;
      c.rgb += (h(vUv * 917.0 + fract(uTime)) - 0.5) * uGrain * (0.4 + c.rgb);
      gl_FragColor = c;
    }`,
};

/**
 * High-preset post stack: HDR render → bloom (neon, headlights, sun) → grade → ACES output.
 * Medium/Low render straight to the canvas.
 */
export class PostFX {
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private grade: ShaderPass;
  enabled: boolean;

  constructor(private r: Renderer, settings: Settings) {
    const gl = r.gl;
    const size = gl.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: r.preset.antialias ? 4 : 0 });
    this.composer = new EffectComposer(gl, rt);
    this.composer.addPass(new RenderPass(r.scene, r.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 0.82);
    this.composer.addPass(this.bloom);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.enabled = settings.data.bloom;
    settings.onChange((s) => (this.enabled = s.bloom));
    r.onResize.push(() => this.resize());
    this.resize();
    r.postRender = (dt) => {
      if (!this.enabled) return false;
      (this.grade.uniforms.uTime as { value: number }).value += dt;
      // count every pass of the frame in renderer.info (debug overlay / perf stats)
      gl.info.autoReset = false;
      gl.info.reset();
      this.composer.render(dt);
      return true;
    };
  }

  private resize(): void {
    const gl = this.r.gl;
    const pr = gl.getPixelRatio();
    this.composer.setPixelRatio(pr);
    this.composer.setSize(innerWidth, innerHeight);
    this.bloom.resolution.set((innerWidth * pr) / 2, (innerHeight * pr) / 2);
  }

  /** Night makes neon pop; rain/day tone it down. */
  setNight(night: number): void {
    this.bloom.strength = 0.3 + night * 0.38;
    this.bloom.threshold = 0.9 - night * 0.12;
  }

  /** Red tint pulse when badly hurt (multiplies the image). */
  setHurt(amount: number): void {
    const t = (this.grade.uniforms.uTint as { value: THREE.Vector3 }).value;
    t.set(1, 1 - amount * 0.35, 1 - amount * 0.35);
  }
}
