import * as THREE from 'three';

export interface EmitOpts {
  x: number;
  y: number;
  z: number;
  vx?: number;
  vy?: number;
  vz?: number;
  life: number;
  size0: number;
  size1: number;
  color0: number;
  color1?: number;
  alpha0?: number;
  alpha1?: number;
  gravity?: number;
  drag?: number;
  spin?: number;
}

/**
 * CPU-simulated billboard particles rendered with one InstancedBufferGeometry draw call.
 * Use one instance for alpha-blended effects (smoke, dust) and one additive (fire, sparks).
 */
export class Particles {
  readonly mesh: THREE.Mesh;
  private max: number;
  private count = 0;
  private px: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private age: Float32Array;
  private size: Float32Array; // size0, size1
  private col: Float32Array; // r0 g0 b0 a0 r1 g1 b1 a1
  private phys: Float32Array; // gravity, drag, spin, rot
  private aOffset: THREE.InstancedBufferAttribute;
  private aColor: THREE.InstancedBufferAttribute;
  private aSize: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private c0 = new THREE.Color();
  private c1 = new THREE.Color();

  constructor(scene: THREE.Scene, max: number, additive: boolean, soft = true) {
    this.max = max;
    this.px = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.age = new Float32Array(max);
    this.size = new Float32Array(max * 2);
    this.col = new Float32Array(max * 8);
    this.phys = new Float32Array(max * 4);
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.attributes.position!);
    this.geo.setAttribute('uv', base.attributes.uv!);
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iOffset', this.aOffset);
    this.geo.setAttribute('iColor', this.aColor);
    this.geo.setAttribute('iSize', this.aSize);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]),
      defines: soft ? { SOFT: 1 } : {},
      vertexShader: `
        attribute vec3 iOffset; attribute vec4 iColor; attribute vec2 iSize;
        varying vec4 vColor; varying vec2 vUv;
        #include <fog_pars_vertex>
        void main() {
          vColor = iColor; vUv = uv;
          vec4 mvPosition = viewMatrix * vec4(iOffset, 1.0);
          float c = cos(iSize.y), s = sin(iSize.y);
          vec2 p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSize.x;
          mvPosition.xy += p;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `
        varying vec4 vColor; varying vec2 vUv;
        #include <fog_pars_fragment>
        void main() {
          vec2 d = vUv - 0.5;
          float r = dot(d, d) * 4.0;
          #ifdef SOFT
          float a = smoothstep(1.0, 0.0, r);
          a *= a;
          #else
          float a = step(r, 1.0);
          #endif
          if (a * vColor.a < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb, vColor.a * a);
          #include <fog_fragment>
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 11;
    scene.add(this.mesh);
  }

  setMax(n: number): void {
    this.max = Math.min(n, this.life.length);
    if (this.count > this.max) this.count = this.max;
  }

  emit(o: EmitOpts): void {
    let i: number;
    if (this.count < this.max) i = this.count++;
    else {
      // recycle the oldest-ish (random) particle
      i = Math.floor(Math.random() * this.count);
    }
    this.px[i * 3] = o.x; this.px[i * 3 + 1] = o.y; this.px[i * 3 + 2] = o.z;
    this.vel[i * 3] = o.vx ?? 0; this.vel[i * 3 + 1] = o.vy ?? 0; this.vel[i * 3 + 2] = o.vz ?? 0;
    this.life[i] = o.life;
    this.age[i] = 0;
    this.size[i * 2] = o.size0; this.size[i * 2 + 1] = o.size1;
    this.c0.setHex(o.color0);
    this.c1.setHex(o.color1 ?? o.color0);
    this.col.set([this.c0.r, this.c0.g, this.c0.b, o.alpha0 ?? 1, this.c1.r, this.c1.g, this.c1.b, o.alpha1 ?? 0], i * 8);
    this.phys[i * 4] = o.gravity ?? 0;
    this.phys[i * 4 + 1] = o.drag ?? 0;
    this.phys[i * 4 + 2] = o.spin ?? (Math.random() - 0.5) * 2;
    this.phys[i * 4 + 3] = Math.random() * 6.28;
  }

  update(dt: number): void {
    const off = this.aOffset.array as Float32Array;
    const col = this.aColor.array as Float32Array;
    const siz = this.aSize.array as Float32Array;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.age[i]! += dt;
      if (this.age[i]! >= this.life[i]!) {
        // swap-remove
        n--;
        this.copy(n, i);
        i--;
        continue;
      }
      const g = this.phys[i * 4]!, drag = this.phys[i * 4 + 1]!;
      const k = Math.max(0, 1 - drag * dt);
      this.vel[i * 3]! *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! * k - g * dt;
      this.vel[i * 3 + 2]! *= k;
      this.px[i * 3]! += this.vel[i * 3]! * dt;
      this.px[i * 3 + 1]! += this.vel[i * 3 + 1]! * dt;
      this.px[i * 3 + 2]! += this.vel[i * 3 + 2]! * dt;
      this.phys[i * 4 + 3]! += this.phys[i * 4 + 2]! * dt;
      const t = this.age[i]! / this.life[i]!;
      off[i * 3] = this.px[i * 3]!; off[i * 3 + 1] = this.px[i * 3 + 1]!; off[i * 3 + 2] = this.px[i * 3 + 2]!;
      const c = this.col;
      col[i * 4] = c[i * 8]! + (c[i * 8 + 4]! - c[i * 8]!) * t;
      col[i * 4 + 1] = c[i * 8 + 1]! + (c[i * 8 + 5]! - c[i * 8 + 1]!) * t;
      col[i * 4 + 2] = c[i * 8 + 2]! + (c[i * 8 + 6]! - c[i * 8 + 2]!) * t;
      col[i * 4 + 3] = c[i * 8 + 3]! + (c[i * 8 + 7]! - c[i * 8 + 3]!) * t;
      siz[i * 2] = this.size[i * 2]! + (this.size[i * 2 + 1]! - this.size[i * 2]!) * t;
      siz[i * 2 + 1] = this.phys[i * 4 + 3]!;
    }
    this.count = n;
    this.geo.instanceCount = n;
    if (n > 0) {
      this.aOffset.needsUpdate = true;
      this.aColor.needsUpdate = true;
      this.aSize.needsUpdate = true;
      this.aOffset.updateRanges.length = 0;
      this.aOffset.addUpdateRange(0, n * 3);
      this.aColor.updateRanges.length = 0;
      this.aColor.addUpdateRange(0, n * 4);
      this.aSize.updateRanges.length = 0;
      this.aSize.addUpdateRange(0, n * 2);
    }
  }

  private copy(from: number, to: number): void {
    if (from === to) return;
    this.px.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.vel.copyWithin(to * 3, from * 3, from * 3 + 3);
    this.life[to] = this.life[from]!;
    this.age[to] = this.age[from]!;
    this.size.copyWithin(to * 2, from * 2, from * 2 + 2);
    this.col.copyWithin(to * 8, from * 8, from * 8 + 8);
    this.phys.copyWithin(to * 4, from * 4, from * 4 + 4);
  }

  get active(): number {
    return this.count;
  }
}

/** Convenience effect presets on top of two particle systems. */
export class Effects {
  readonly smoke: Particles;
  readonly glow: Particles;
  readonly sharp: Particles;
  constructor(scene: THREE.Scene, max: number) {
    this.smoke = new Particles(scene, max, false, true);
    this.glow = new Particles(scene, Math.floor(max * 0.6), true, true);
    this.sharp = new Particles(scene, Math.floor(max * 0.4), false, false);
  }
  update(dt: number): void {
    this.smoke.update(dt);
    this.glow.update(dt);
    this.sharp.update(dt);
  }
  tireSmoke(x: number, y: number, z: number, amt = 1): void {
    this.smoke.emit({ x, y, z, vx: (Math.random() - 0.5) * 1.2, vy: 0.6 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 1.2, life: 1.4 + Math.random(), size0: 0.6, size1: 3.2 * amt, color0: 0xdcdcdc, alpha0: 0.35 * amt, alpha1: 0, drag: 1.2 });
  }
  engineSmoke(x: number, y: number, z: number, dark: number): void {
    const c = dark > 0.5 ? 0x2a2a2a : 0x8a8a8a;
    this.smoke.emit({ x, y, z, vx: (Math.random() - 0.5) * 0.6, vy: 1.6 + Math.random(), vz: (Math.random() - 0.5) * 0.6, life: 1.8 + Math.random(), size0: 0.5, size1: 2.6, color0: c, color1: 0x5a5a5a, alpha0: 0.5, alpha1: 0, drag: 0.6 });
  }
  fire(x: number, y: number, z: number, scale = 1): void {
    this.glow.emit({ x: x + (Math.random() - 0.5) * 0.6 * scale, y, z: z + (Math.random() - 0.5) * 0.6 * scale, vx: (Math.random() - 0.5) * 0.5, vy: 2 + Math.random() * 2, vz: (Math.random() - 0.5) * 0.5, life: 0.5 + Math.random() * 0.4, size0: 1.1 * scale, size1: 0.2, color0: 0xffc040, color1: 0xff3a10, alpha0: 0.9, alpha1: 0, drag: 0.5 });
    if (Math.random() < 0.35) this.smoke.emit({ x, y: y + 1, z, vx: (Math.random() - 0.5) * 0.6, vy: 2.5, vz: (Math.random() - 0.5) * 0.6, life: 2.5, size0: 1, size1: 4 * scale, color0: 0x1a1a1a, alpha0: 0.55, alpha1: 0, drag: 0.4 });
  }
  explosion(x: number, y: number, z: number, scale = 1): void {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2, s = 4 + Math.random() * 9;
      this.glow.emit({ x, y: y + 0.5, z, vx: Math.cos(a) * Math.cos(e) * s * scale, vy: Math.sin(e) * s * scale, vz: Math.sin(a) * Math.cos(e) * s * scale, life: 0.5 + Math.random() * 0.5, size0: 2.6 * scale, size1: 0.6, color0: 0xffe080, color1: 0xff3a00, alpha0: 1, alpha1: 0, drag: 3 });
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 4;
      this.smoke.emit({ x, y: y + 1, z, vx: Math.cos(a) * s, vy: 2 + Math.random() * 4, vz: Math.sin(a) * s, life: 3 + Math.random() * 2, size0: 2 * scale, size1: 7 * scale, color0: 0x2a2a2a, color1: 0x6a6a6a, alpha0: 0.7, alpha1: 0, drag: 1.2 });
    }
    for (let i = 0; i < 20; i++) this.spark(x, y + 0.5, z, 14);
  }
  spark(x: number, y: number, z: number, speed = 6, nx = 0, ny = 1, nz = 0): void {
    const vx = nx * speed * 0.5 + (Math.random() - 0.5) * speed, vy = ny * speed * 0.5 + Math.random() * speed * 0.6, vz = nz * speed * 0.5 + (Math.random() - 0.5) * speed;
    this.glow.emit({ x, y, z, vx, vy, vz, life: 0.25 + Math.random() * 0.3, size0: 0.12, size1: 0.04, color0: 0xffe8a0, color1: 0xff8020, alpha0: 1, alpha1: 0, gravity: 9.8 });
  }
  dust(x: number, y: number, z: number, color = 0xb8a080, size = 1): void {
    this.smoke.emit({ x, y, z, vx: (Math.random() - 0.5) * 1.5, vy: 0.4 + Math.random() * 0.6, vz: (Math.random() - 0.5) * 1.5, life: 1 + Math.random(), size0: 0.4 * size, size1: 2 * size, color0: color, alpha0: 0.4, alpha1: 0, drag: 1.5 });
  }
  splash(x: number, y: number, z: number, amt = 1): void {
    for (let i = 0; i < 6 * amt; i++) this.sharp.emit({ x, y, z, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 3, vz: (Math.random() - 0.5) * 3, life: 0.6 + Math.random() * 0.4, size0: 0.25, size1: 0.1, color0: 0xe8f4ff, alpha0: 0.85, alpha1: 0, gravity: 9.8 });
  }
  muzzle(x: number, y: number, z: number, big = false): void {
    this.glow.emit({ x, y, z, life: 0.06, size0: big ? 0.9 : 0.5, size1: big ? 0.5 : 0.3, color0: 0xfff0b0, color1: 0xffa040, alpha0: 1, alpha1: 0.3, spin: 0 });
  }
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: 'concrete' | 'metal' | 'flesh' | 'dirt' | 'water'): void {
    if (kind === 'metal') for (let i = 0; i < 5; i++) this.spark(x, y, z, 5, nx, ny, nz);
    else if (kind === 'flesh') for (let i = 0; i < 4; i++) this.sharp.emit({ x, y, z, vx: nx * 1.5 + (Math.random() - 0.5) * 2, vy: ny + Math.random() * 1.5, vz: nz * 1.5 + (Math.random() - 0.5) * 2, life: 0.35, size0: 0.12, size1: 0.05, color0: 0x7a0a0a, alpha0: 0.9, alpha1: 0, gravity: 9.8 });
    else if (kind === 'water') this.splash(x, y, z, 0.5);
    else {
      this.smoke.emit({ x, y, z, vx: nx * 1.5, vy: ny * 1.5 + 0.3, vz: nz * 1.5, life: 0.7, size0: 0.15, size1: 0.9, color0: kind === 'dirt' ? 0x8a7050 : 0xb0aca4, alpha0: 0.6, alpha1: 0, drag: 2 });
      for (let i = 0; i < 3; i++) this.sharp.emit({ x, y, z, vx: nx * 3 + (Math.random() - 0.5) * 3, vy: ny * 3 + Math.random() * 2, vz: nz * 3 + (Math.random() - 0.5) * 3, life: 0.4, size0: 0.06, size1: 0.04, color0: 0x5a5a5a, alpha0: 1, alpha1: 1, gravity: 12 });
    }
  }
}
