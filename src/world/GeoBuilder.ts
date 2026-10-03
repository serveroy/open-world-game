import * as THREE from 'three';

/**
 * Accumulates non-indexed triangles with world-material attributes:
 * position, normal, color, uvm (wall metres), wparams (style, floorH, seed, emissive).
 */
export class GeoBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  uvm: number[] = [];
  wp: number[] = [];
  private c = new THREE.Color();
  private w: [number, number, number, number] = [0, 0, 0, 0];
  private r = 1;
  private g = 1;
  private b = 1;

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  color(hex: number, mul = 1): this {
    this.c.setHex(hex);
    this.r = this.c.r * mul;
    this.g = this.c.g * mul;
    this.b = this.c.b * mul;
    return this;
  }
  colorRGB(r: number, g: number, b: number): this {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }
  params(style = 0, floorH = 3, seed = 0, emissive = 0): this {
    this.w = [style, floorH, seed % 997, emissive];
    return this;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): void {
    this.pos.push(x, y, z);
    this.nrm.push(nx, ny, nz);
    this.col.push(this.r, this.g, this.b);
    this.uvm.push(u, v);
    this.wp.push(this.w[0], this.w[1], this.w[2], this.w[3]);
  }

  /** Quad from 4 corners (counter-clockwise when viewed from the front). */
  quad(
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    uvs?: [number, number, number, number, number, number, number, number],
  ): void {
    // normal from (b-a) x (d-a)
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = dx - ax, vy = dy - ay, vz = dz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const t = uvs ?? [0, 0, 0, 0, 0, 0, 0, 0];
    this.vert(ax, ay, az, nx, ny, nz, t[0], t[1]);
    this.vert(bx, by, bz, nx, ny, nz, t[2], t[3]);
    this.vert(cx, cy, cz, nx, ny, nz, t[4], t[5]);
    this.vert(ax, ay, az, nx, ny, nz, t[0], t[1]);
    this.vert(cx, cy, cz, nx, ny, nz, t[4], t[5]);
    this.vert(dx, dy, dz, nx, ny, nz, t[6], t[7]);
  }

  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    this.vert(ax, ay, az, nx, ny, nz, 0, 0);
    this.vert(bx, by, bz, nx, ny, nz, 0, 0);
    this.vert(cx, cy, cz, nx, ny, nz, 0, 0);
  }

  /** Horizontal rectangle at height y (facing up). */
  flat(x0: number, z0: number, x1: number, z1: number, y: number): void {
    this.quad(x0, y, z1, x1, y, z1, x1, y, z0, x0, y, z0);
  }

  /**
   * Axis-aligned box. Walls get metre UVs (for windows) when `walls` style is set via params();
   * `roofHex` colours the top face (style 0) if given; bottom omitted.
   */
  box(cx: number, y0: number, cz: number, hx: number, h: number, hz: number, roofHex?: number, wallUV = true): void {
    const x0 = cx - hx, x1 = cx + hx, z0 = cz - hz, z1 = cz + hz, y1 = y0 + h;
    const W = hx * 2, D = hz * 2;
    const uv = (w: number): [number, number, number, number, number, number, number, number] =>
      wallUV ? [0, 0, w, 0, w, h, 0, h] : [0, 0, 0, 0, 0, 0, 0, 0];
    // south (+z)
    this.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, uv(W));
    // north (-z)
    this.quad(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, uv(W));
    // east (+x)
    this.quad(x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1, uv(D));
    // west (-x)
    this.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, uv(D));
    // top
    const saved = this.w;
    const sr = this.r, sg = this.g, sb = this.b;
    if (roofHex !== undefined) {
      this.color(roofHex);
      this.w = [0, 0, 0, saved[3] > 0 && roofHex === undefined ? saved[3] : 0];
    }
    this.flat(x0, z0, x1, z1, y1);
    this.w = saved;
    this.r = sr; this.g = sg; this.b = sb;
  }

  /** Rotated box around Y (no window UVs). */
  boxYaw(cx: number, y0: number, cz: number, hx: number, h: number, hz: number, yaw: number): void {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const p = (lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    const [ax, az] = p(-hx, hz), [bx, bz] = p(hx, hz), [qx, qz] = p(hx, -hz), [dx, dz] = p(-hx, -hz);
    const y1 = y0 + h;
    this.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
    this.quad(bx, y0, bz, qx, y0, qz, qx, y1, qz, bx, y1, bz);
    this.quad(qx, y0, qz, dx, y0, dz, dx, y1, dz, qx, y1, qz);
    this.quad(dx, y0, dz, ax, y0, az, ax, y1, az, dx, y1, dz);
    this.quad(ax, y1, az, bx, y1, bz, qx, y1, qz, dx, y1, dz);
  }

  /** Gable roof on a box footprint, ridge along the longer axis. */
  gable(cx: number, y0: number, cz: number, hx: number, hz: number, rise: number, overhang = 0.4): void {
    const ox = hx + overhang, oz = hz + overhang;
    if (hx >= hz) {
      const y1 = y0 + rise;
      this.quad(cx - ox, y0, cz + oz, cx + ox, y0, cz + oz, cx + ox, y1, cz, cx - ox, y1, cz);
      this.quad(cx + ox, y0, cz - oz, cx - ox, y0, cz - oz, cx - ox, y1, cz, cx + ox, y1, cz);
      this.tri(cx + hx, y0, cz + hz, cx + hx, y0, cz - hz, cx + hx, y1, cz);
      this.tri(cx - hx, y0, cz - hz, cx - hx, y0, cz + hz, cx - hx, y1, cz);
    } else {
      const y1 = y0 + rise;
      this.quad(cx + ox, y0, cz + oz, cx + ox, y0, cz - oz, cx, y1, cz - oz, cx, y1, cz + oz);
      this.quad(cx - ox, y0, cz - oz, cx - ox, y0, cz + oz, cx, y1, cz + oz, cx, y1, cz - oz);
      this.tri(cx - hx, y0, cz + hz, cx + hx, y0, cz + hz, cx, y1, cz + hz);
      this.tri(cx + hx, y0, cz - hz, cx - hx, y0, cz - hz, cx, y1, cz - hz);
    }
  }

  /** Strip quad between two points with width, following heights h0/h1. */
  strip(ax: number, az: number, bx: number, bz: number, w: number, ya: number, yb: number): void {
    const dx = bx - ax, dz = bz - az;
    const l = Math.hypot(dx, dz) || 1;
    const px = (-dz / l) * w * 0.5, pz = (dx / l) * w * 0.5;
    // ensure upward-facing winding
    this.quad(ax - px, ya, az - pz, bx - px, yb, bz - pz, bx + px, yb, bz + pz, ax + px, ya, az + pz);
    // fix orientation if normal points down
    const n = this.nrm.length;
    if (this.nrm[n - 2]! < 0) {
      for (let i = n - 18; i < n; i += 3) {
        this.nrm[i] = -this.nrm[i]!;
        this.nrm[i + 1] = -this.nrm[i + 1]!;
        this.nrm[i + 2] = -this.nrm[i + 2]!;
      }
      // swap winding of the 2 triangles (vertices 1<->2 and 4<->5)
      const swap = (i: number, j: number): void => {
        for (let k = 0; k < 3; k++) {
          const t = this.pos[i * 3 + k]!;
          this.pos[i * 3 + k] = this.pos[j * 3 + k]!;
          this.pos[j * 3 + k] = t;
        }
      };
      const base = this.pos.length / 3 - 6;
      swap(base + 1, base + 2);
      swap(base + 4, base + 5);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uvm', new THREE.Float32BufferAttribute(this.uvm, 2));
    g.setAttribute('wparams', new THREE.Float32BufferAttribute(this.wp, 4));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
