import * as THREE from 'three';
import type { QualityLevel, Settings } from '../core/Settings';

export interface QualityPreset {
  level: QualityLevel;
  maxPixelRatio: number;
  minPixelRatio: number;
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
  low: { level: 'low', maxPixelRatio: 1, minPixelRatio: 0.5, shadows: false, shadowMapSize: 512, bloom: false, antialias: false, viewRadiusChunks: 1, farPlane: 420, maxPeds: 14, maxTraffic: 8, maxParticles: 300, propDensity: 0.5 },
  med: { level: 'med', maxPixelRatio: 1.5, minPixelRatio: 0.6, shadows: true, shadowMapSize: 1024, bloom: false, antialias: false, viewRadiusChunks: 2, farPlane: 600, maxPeds: 26, maxTraffic: 14, maxParticles: 600, propDensity: 0.8 },
  high: { level: 'high', maxPixelRatio: 2, minPixelRatio: 0.75, shadows: true, shadowMapSize: 2048, bloom: true, antialias: true, viewRadiusChunks: 2, farPlane: 800, maxPeds: 36, maxTraffic: 18, maxParticles: 1000, propDensity: 1 },
};

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
  if (/Apple GPU/i.test(gpu) && cores >= 6) return 'med';
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
    const pr = Math.min(devicePixelRatio || 1, this.preset.maxPixelRatio) * this.scale;
    this.gl.setPixelRatio(Math.max(this.preset.minPixelRatio * 0.75, pr));
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
    const maxPr = Math.min(devicePixelRatio || 1, this.preset.maxPixelRatio);
    const minScale = this.preset.minPixelRatio / maxPr;
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
    this.gl.render(this.scene, this.camera);
  }
}
