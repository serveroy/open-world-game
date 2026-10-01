import * as THREE from 'three';
import type { QualityLevel, Settings } from '../core/Settings';

export interface QualityPreset {
  level: QualityLevel;
  maxPixelRatio: number;
  minPixelRatio: number;
  /** Desired render-target height in device pixels (sharpness on small, dense phone screens). */
  targetHeight: number;
  /** Dynamic resolution never drops the render height below this. */
  minHeight: number;
  /** Hard cap on rendered pixels (fill-rate budget). */
  maxPixels: number;
  shadows: boolean;
  shadowMapSize: number;
  bloom: boolean;
  antialias: boolean;
  viewRadiusChunks: number;
  farPlane: number;
  maxPeds: number;
  maxTraffic: number;
  maxParticles: number;
  propDensity: number;
}

export const PRESETS: Record<QualityLevel, QualityPreset> = {
  low: { level: 'low', maxPixelRatio: 2, minPixelRatio: 0.5, targetHeight: 600, minHeight: 400, maxPixels: 0.65e6, shadows: false, shadowMapSize: 512, bloom: false, antialias: false, viewRadiusChunks: 1, farPlane: 420, maxPeds: 14, maxTraffic: 8, maxParticles: 300, propDensity: 0.5 },
  med: { level: 'med', maxPixelRatio: 2.5, minPixelRatio: 0.6, targetHeight: 780, minHeight: 480, maxPixels: 1.1e6, shadows: true, shadowMapSize: 1024, bloom: false, antialias: true, viewRadiusChunks: 2, farPlane: 600, maxPeds: 26, maxTraffic: 14, maxParticles: 600, propDensity: 0.8 },
  high: { level: 'high', maxPixelRatio: 3, minPixelRatio: 0.75, targetHeight: 1080, minHeight: 620, maxPixels: 2.4e6, shadows: true, shadowMapSize: 2048, bloom: true, antialias: true, viewRadiusChunks: 2, farPlane: 800, maxPeds: 36, maxTraffic: 18, maxParticles: 1000, propDensity: 1 },
};

/**
 * Device pixel ratio to render at. Phones in landscape have very few CSS pixels vertically but
 * 2–3× density, so we aim for a target render height instead of a fixed ratio, capped by DPR,
 * the preset and a pixel budget. `scale` (0..1) is the dynamic-resolution factor.
 */
export function renderPixelRatio(dpr: number, cssW: number, cssH: number, p: Pick<QualityPreset, 'maxPixelRatio' | 'targetHeight' | 'minHeight' | 'maxPixels'>, scale = 1): { pr: number; min: number; max: number } {
  const d = Math.max(1, dpr || 1);
  const h = Math.max(1, cssH), w = Math.max(1, cssW);
  const budget = Math.sqrt(p.maxPixels / (w * h));
  const max = Math.max(0.5, Math.min(d, p.maxPixelRatio, Math.max(1, p.targetHeight / h), Math.max(0.75, budget)));
  const min = Math.min(max, Math.max(0.5, p.minHeight / h));
  const pr = Math.min(max, Math.max(min, max * scale));
  return { pr, min, max };
}

/** Guess a sensible preset from device hints (first run, `quality: auto`). */
export function detectQuality(): QualityLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const mem = nav.deviceMemory ?? 4;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent) || matchMedia('(pointer: coarse)').matches;
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    /* ignore */
  }
  if (/SwiftShader|llvmpipe|Software/i.test(gpu)) return 'low';
  if (!mobile) return cores >= 6 ? 'high' : 'med';
  if (/Apple GPU/i.test(gpu)) return 'med';
  if (/Adreno \(TM\) (7|8)\d\d|Mali-G7\d|Mali-G[0-9]{3}|Immortalis/i.test(gpu) && mem >= 6) return 'med';
  return 'low';
}

/**
 * Owns the WebGL renderer, main camera and scene; handles resizing, quality presets
 * and dynamic resolution scaling driven by measured frame time.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  preset: QualityPreset;
  private scale = 1;
  private frameAvg = 16.7;
  private adjustTimer = 0;
  /** Optional post-processing hook (set by PostFX). */
  postRender: ((dt: number) => boolean) | null = null;
  onResize: ((w: number, h: number) => void)[] = [];

  constructor(container: HTMLElement, private settings: Settings, level: QualityLevel) {
    this.preset = PRESETS[level];
    this.gl = new THREE.WebGLRenderer({
      antialias: this.preset.antialias,
      powerPreference: 'high-performance',
      stencil: false,
      alpha: false,
    });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.0;
    this.gl.shadowMap.enabled = this.preset.shadows && settings.data.shadows;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    this.gl.domElement.className = 'game-canvas';
    container.appendChild(this.gl.domElement);
    this.camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.2, this.preset.farPlane);
    this.scene.add(this.camera);
    this.resize();
    addEventListener('resize', () => this.resize());
    let vd = settings.data.viewDistance;
    settings.onChange((s) => {
      if (s.viewDistance !== vd) {
        vd = s.viewDistance;
        this.resize();
      }
    });
    screen.orientation?.addEventListener?.('change', () => setTimeout(() => this.resize(), 120));
  }

  get pixelRatio(): number {
    return this.gl.getPixelRatio();
  }

  setQuality(level: QualityLevel): void {
    this.preset = PRESETS[level];
    this.gl.shadowMap.enabled = this.preset.shadows && this.settings.data.shadows;
    this.camera.far = this.preset.farPlane * this.settings.data.viewDistance;
    this.camera.updateProjectionMatrix();
    this.scale = 1;
    this.resize();
  }

  resize(): void {
    const w = innerWidth, h = innerHeight;
    const { pr } = renderPixelRatio(devicePixelRatio, w, h, this.preset, this.scale);
    this.gl.setPixelRatio(pr);
    this.gl.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.far = this.preset.farPlane * this.settings.data.viewDistance;
    this.camera.updateProjectionMatrix();
    for (const f of this.onResize) f(w, h);
  }

  /** Feed frame time (ms); adjusts resolution scale to hold target FPS. */
  trackFrame(ms: number): void {
    this.frameAvg += (ms - this.frameAvg) * 0.05;
    if (!this.settings.data.dynamicResolution) return;
    this.adjustTimer += ms;
    if (this.adjustTimer < 1000) return;
    this.adjustTimer = 0;
    const target = this.settings.data.fpsCap === 30 ? 33.4 : 16.9;
    const r = renderPixelRatio(devicePixelRatio, innerWidth, innerHeight, this.preset, 1);
    const minScale = r.min / r.max;
    let next = this.scale;
    if (this.frameAvg > target * 1.18) next = Math.max(minScale, this.scale - 0.1);
    else if (this.frameAvg < target * 0.85) next = Math.min(1, this.scale + 0.05);
    if (Math.abs(next - this.scale) > 0.001) {
      this.scale = next;
      this.resize();
    }
  }

  get resolutionScale(): number {
    return this.scale;
  }
  get avgFrameMs(): number {
    return this.frameAvg;
  }

  render(dt: number): void {
    if (this.postRender && this.postRender(dt)) return;
    this.gl.info.autoReset = true;
    this.gl.render(this.scene, this.camera);
  }
}
