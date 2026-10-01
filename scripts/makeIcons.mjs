// Generates PWA PNG icons procedurally (no external assets). Run: node scripts/makeIcons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a + (b - a) * t;
// Sunset gradient, sun disc, sea stripes, palm-ish silhouette bar → "CC" feel without text.
function pixel(u, v) {
  let r = mix(255, 120, v), g = mix(90, 20, v), b = mix(60, 90, v);
  const dx = u - 0.5, dy = v - 0.48;
  const d = Math.hypot(dx, dy);
  if (d < 0.22) { r = 255; g = mix(220, 120, (dy + 0.22) / 0.44); b = 80; if (v > 0.42 && Math.floor(v * 40) % 3 === 0) { r = 200; g = 40; b = 80; } }
  if (v > 0.66) { const w = Math.sin(u * 40 + v * 90) * 0.5 + 0.5; r = mix(20, 40, w); g = mix(30, 70, w); b = mix(80, 140, w); }
  if (v > 0.6 && v < 0.67 && (u < 0.18 || u > 0.7)) { r = 25; g = 10; b = 30; }
  // rounded mask
  const m = 0.18, cx = Math.min(Math.max(u, m), 1 - m), cy = Math.min(Math.max(v, m), 1 - m);
  const a = Math.hypot(u - cx, v - cy) > m ? 0 : 255;
  return [Math.round(r), Math.round(g), Math.round(b), a];
}
writeFileSync('public/icon-192.png', png(192, pixel));
writeFileSync('public/icon-512.png', png(512, pixel));
console.log('icons written');
