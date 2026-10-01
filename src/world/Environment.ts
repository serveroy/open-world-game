import * as THREE from 'three';
import { Sky } from '../render/Sky';
import type { Water } from '../render/Water';
import { worldUniforms } from '../render/WorldMaterial';
import { GameClock, WeatherSystem, type WeatherKind } from './TimeOfDay';
import { clamp01, lerp, smoothstep } from '../core/math';

const _sun = { x: 0, y: 1, z: 0 };
const _ca = new THREE.Color();
const _cb = new THREE.Color();

function mixHex(a: number, b: number, t: number, out: THREE.Color): THREE.Color {
  _ca.setHex(a);
  _cb.setHex(b);
  return out.copy(_ca).lerp(_cb, clamp01(t));
}

/**
 * Day/night lighting, sky, fog, weather particles (rain / sand). Drives world uniforms.
 */
export class Environment {
  readonly clock: GameClock;
  readonly weather: WeatherSystem;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly sky: Sky;
  readonly fog: THREE.Fog;
  private rain: THREE.LineSegments;
  private sand: THREE.Points;
  private rainU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmt: { value: 0 }, uColor: { value: new THREE.Color(0xaabbcc) } };
  private sandU = { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uAmt: { value: 0 } };
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  night = 0;
  /** Desert factor of the focus point (0 city … 1 deep desert). */
  desert = 0;
  private skyZenith = new THREE.Color();
  private skyHorizon = new THREE.Color();
  private sunColor = new THREE.Color();
  private shadowsOn: boolean;
  lightning = 0;
  private lightningTimer = 8;
  onThunder: ((intensity: number) => void) | null = null;

  constructor(scene: THREE.Scene, private camera: THREE.PerspectiveCamera, shadows: boolean, shadowSize: number, clouds: boolean, private water: Water | null, dayLength: number) {
    this.clock = new GameClock(dayLength);
    this.weather = new WeatherSystem();
    this.shadowsOn = shadows;
    this.sky = new Sky(scene, clouds);
    this.fog = new THREE.Fog(0xa8d0f0, 120, 600);
    scene.fog = this.fog;
    scene.background = null;
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x8a7a68, 1);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff4e0, 2.6);
    this.sun.castShadow = shadows;
    this.sun.shadow.mapSize.set(shadowSize, shadowSize);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    const sc = this.sun.shadow.camera;
    const ext = shadowSize >= 2048 ? 70 : 50;
    sc.left = sc.bottom = -ext;
    sc.right = sc.top = ext;
    sc.near = 1;
    sc.far = 400;
    scene.add(this.sun, this.sun.target);

    // rain: line streaks wrapped around the camera in the vertex shader
    const N = 2400;
    const rp = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) {
      const x = Math.random() * 60 - 30, y = Math.random() * 30, z = Math.random() * 60 - 30;
      rp.set([x, y, z, x + 0.05, y - 0.7, z + 0.02], i * 6);
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(rp, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.ShaderMaterial({
      uniforms: this.rainU,
      transparent: true,
      depthWrite: false,
      vertexShader: `uniform float uTime; uniform vec3 uCam; varying float vA;
        void main() {
          vec3 p = position;
          p.y = mod(p.y - uTime * 22.0, 30.0);
          p.x = mod(p.x - uCam.x, 60.0) - 30.0 + uCam.x;
          p.z = mod(p.z - uCam.z, 60.0) - 30.0 + uCam.z;
          p.y += uCam.y - 12.0;
          vA = 1.0;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform float uAmt; uniform vec3 uColor; void main() { gl_FragColor = vec4(uColor, 0.35 * uAmt); }`,
    }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    const S = 1800;
    const sp = new Float32Array(S * 3);
    for (let i = 0; i < S; i++) sp.set([Math.random() * 80 - 40, Math.random() * 16, Math.random() * 80 - 40], i * 3);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    this.sand = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.sandU,
      transparent: true,
      depthWrite: false,
      vertexShader: `uniform float uTime; uniform vec3 uCam;
        void main() {
          vec3 p = position;
          p.x = mod(p.x + uTime * 14.0 - uCam.x, 80.0) - 40.0 + uCam.x;
          p.z = mod(p.z + sin(uTime + p.y) * 2.0 - uCam.z, 80.0) - 40.0 + uCam.z;
          p.y += uCam.y - 4.0 + sin(uTime * 2.0 + p.x) * 0.5;
          vec4 mv = viewMatrix * vec4(p, 1.0);
          gl_PointSize = clamp(220.0 / -mv.z, 1.0, 8.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform float uAmt; void main() { vec2 c = gl_PointCoord - 0.5; if (dot(c,c) > 0.25) discard; gl_FragColor = vec4(0.85, 0.65, 0.4, 0.5 * uAmt); }`,
    }));
    this.sand.frustumCulled = false;
    this.sand.visible = false;
    scene.add(this.sand);
  }

  setShadows(on: boolean): void {
    this.shadowsOn = on;
    this.sun.castShadow = on;
  }

  setWeather(k: WeatherKind, immediate = false): void {
    this.weather.set(k, immediate);
  }

  update(realDt: number, focus: THREE.Vector3, renderer: THREE.WebGLRenderer): void {
    const before = this.clock.totalHours;
    this.clock.advance(realDt);
    this.weather.update(this.clock.totalHours - before, realDt);
    const wp = this.weather.params;
    this.desert = smoothstep(320, 520, focus.x);
    const sand = wp.sand * this.desert;
    // rain is lighter in the desert
    const rain = wp.rain * (1 - this.desert * 0.7);

    this.clock.sunDir(_sun);
    this.sunDir.set(_sun.x, _sun.y, _sun.z);
    const el = _sun.y;
    this.night = this.clock.nightFactor();
    const n = this.night;
    const golden = 1 - smoothstep(0.05, 0.32, el);

    // sky colours
    mixHex(0x2a6ac8, 0x3a5aa0, golden, this.skyZenith);
    mixHex(0xa8d0f0, 0xf0a070, golden * (el > -0.05 ? 1 : 0.5), this.skyHorizon);
    if (n > 0) {
      this.skyZenith.lerp(_ca.setHex(0x040814), n);
      this.skyHorizon.lerp(_ca.setHex(0x141c30), n);
    }
    // weather greys out the sky
    const grey = wp.cloud * 0.55 + rain * 0.35;
    this.skyZenith.lerp(_ca.setHex(n > 0.5 ? 0x0a0c12 : 0x5a6470), grey);
    this.skyHorizon.lerp(_ca.setHex(n > 0.5 ? 0x14161c : 0x8a929a), grey);
    if (sand > 0) {
      this.skyZenith.lerp(_ca.setHex(0xa07850), sand * 0.85);
      this.skyHorizon.lerp(_ca.setHex(0xc89868), sand * 0.95);
    }
    // lightning flash
    if (wp.rain > 0.85) {
      this.lightningTimer -= realDt;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 6 + Math.random() * 14;
        this.lightning = 1;
        this.onThunder?.(0.6 + Math.random() * 0.4);
      }
    }
    if (this.lightning > 0) {
      this.lightning = Math.max(0, this.lightning - realDt * 3.5);
      const f = this.lightning * (Math.random() > 0.3 ? 1 : 0.4);
      this.skyHorizon.lerp(_ca.setHex(0xd8e0ff), f * 0.7);
      this.skyZenith.lerp(_ca.setHex(0xb0b8e0), f * 0.6);
    }

    const u = this.sky.uniforms;
    u.uZenith.value.copy(this.skyZenith);
    u.uHorizon.value.copy(this.skyHorizon);
    u.uGround.value.copy(this.skyHorizon).multiplyScalar(0.6);
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.set(-this.sunDir.x, -this.sunDir.y, -this.sunDir.z * 0.6 + 0.2).normalize();
    u.uNight.value = n;
    u.uCloud.value = wp.cloud;
    u.uTime.value += realDt;
    u.uHazeAmt.value = sand * 0.8;
    u.uHaze.value.setHex(0xc89868);

    // sun / moon light
    mixHex(0xfff2dc, 0xff9a50, golden, this.sunColor);
    u.uSunColor.value.copy(this.sunColor);
    const sunUp = smoothstep(-0.06, 0.12, el);
    const dayI = (2.3 + (1 - golden) * 0.5) * sunUp * wp.sunMul;
    const moonI = 0.5 * n * (1 - wp.cloud * 0.5);
    if (sunUp > 0.02) {
      this.sun.color.copy(this.sunColor);
      this.sun.intensity = dayI + this.lightning * 2;
      this.sun.position.set(focus.x + this.sunDir.x * 150, focus.y + Math.max(this.sunDir.y, 0.08) * 150, focus.z + this.sunDir.z * 150);
    } else {
      const md = u.uMoonDir.value as THREE.Vector3;
      this.sun.color.setHex(0x8aa0d8);
      this.sun.intensity = moonI + this.lightning * 2.5;
      this.sun.position.set(focus.x + md.x * 150, focus.y + Math.max(md.y, 0.2) * 150, focus.z + md.z * 150);
    }
    this.sun.target.position.copy(focus);
    this.sun.castShadow = this.shadowsOn && (sunUp > 0.05 || n > 0.7) && wp.cloud < 0.95;
    this.hemi.color.copy(this.skyZenith).lerp(_ca.setHex(0xffffff), 0.35);
    if (n > 0) this.hemi.color.lerp(_ca.setHex(0x5a70b0), n);
    this.hemi.groundColor.setHex(0x7a6a58).lerp(_ca.setHex(0x2a2430), n);
    this.hemi.intensity = lerp(1.45, 0.85, n) * (1 - wp.cloud * 0.15) + this.lightning;

    // fog
    const far = this.camera.far;
    this.fog.color.copy(this.skyHorizon);
    let fogNear = far * 0.25, fogFar = far * 0.98;
    fogNear *= wp.fogMul;
    fogFar *= lerp(1, wp.fogMul, 0.8);
    if (sand > 0) {
      fogNear = lerp(fogNear, 4, sand);
      fogFar = lerp(fogFar, 85, sand);
      this.fog.color.lerp(_ca.setHex(0xb88a58), sand);
    }
    this.fog.near = fogNear;
    this.fog.far = Math.max(fogNear + 20, fogFar);
    renderer.toneMappingExposure = lerp(1.0, 1.25, n);

    // world shader uniforms
    worldUniforms.uNight.value = smoothstep(0.15, 0.85, n) + (wp.cloud > 0.85 ? 0.15 : 0);
    worldUniforms.uTime.value += realDt;
    worldUniforms.uWet.value += ((rain > 0.2 ? 1 : 0) - worldUniforms.uWet.value) * Math.min(1, realDt * 0.08);
    worldUniforms.uSand.value = sand;

    // particles
    this.rainU.uTime.value += realDt;
    this.rainU.uCam.value.copy(this.camera.position);
    this.rainU.uAmt.value = rain;
    this.rainU.uColor.value.setHex(n > 0.5 ? 0x6a7a8a : 0xb8c8d8);
    this.rain.visible = rain > 0.03;
    this.sandU.uTime.value += realDt;
    this.sandU.uCam.value.copy(this.camera.position);
    this.sandU.uAmt.value = sand;
    this.sand.visible = sand > 0.03;

    // water
    if (this.water) {
      const wu = this.water.uniforms;
      (wu.uSunDir!.value as THREE.Vector3).copy(sunUp > 0.02 ? this.sunDir : (u.uMoonDir.value as THREE.Vector3));
      (wu.uSunColor!.value as THREE.Color).copy(sunUp > 0.02 ? this.sunColor : _ca.setHex(0x8aa0d8));
      (wu.uSky!.value as THREE.Color).copy(this.skyHorizon).lerp(this.skyZenith, 0.3);
      wu.uNight!.value = n;
      wu.uRain!.value = rain;
    }
    this.sky.follow(this.camera);
  }

  get rainAmount(): number {
    return this.weather.params.rain * (1 - this.desert * 0.7);
  }
  get sandAmount(): number {
    return this.weather.params.sand * this.desert;
  }
  get skyHorizonColor(): THREE.Color {
    return this.skyHorizon;
  }
}
