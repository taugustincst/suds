'use strict';
// Renders the SUDS app icon to PNG at several sizes using only zlib (no image libraries).
const fs = require('node:fs'); const zlib = require('node:zlib'); const path = require('node:path');
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; for (let x = 0; x < size; x++) { const [r, g, b, a] = pixel(x, y); const o = y * (size * 4 + 1) + 1 + x * 4; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
// Icon: rounded blue square, white path, green + yellow dots (matches favicon.svg), with 4x supersampling
function icon(size, { maskable = false } = {}) {
  const S = 4;
  const sample = (px, py) => {
    const u = px / size * 32, v = py / size * 32; // favicon coordinate space 0..32
    const pad = maskable ? 0 : 0; const rr = maskable ? 0 : 7;
    const inside = (() => { if (maskable) return true; const x = Math.min(u - rr, Math.max(0, u - (32 - rr))), y = Math.min(v - rr, Math.max(0, v - (32 - rr))); const dx = u < rr ? rr - u : u > 32 - rr ? u - (32 - rr) : 0, dy = v < rr ? rr - v : v > 32 - rr ? v - (32 - rr) : 0; return dx * dx + dy * dy <= rr * rr; })();
    if (!inside) return [0, 0, 0, 0];
    const sc = maskable ? 0.8 : 1, cx = 16, cy = 16; const ux = (u - cx) / sc + cx, uy = (v - cy) / sc + cy;
    // curve: cubic bezier from (9,20) c(9,17)(11,15)(14,15) then (18,15) c(21,15)(23,13)(23,10)
    const dist = (x, y) => { let best = 1e9; for (let t = 0; t <= 1; t += 0.02) { const bz = (p0, p1, p2, p3) => (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3; for (const [P0, P1, P2, P3] of [[[9, 20], [9, 17], [11, 15], [14, 15]], [[18, 15], [21, 15], [23, 13], [23, 10]]]) { const bx = bz(P0[0], P1[0], P2[0], P3[0]), by = bz(P0[1], P1[1], P2[1], P3[1]); best = Math.min(best, Math.hypot(x - bx, y - by)); } const lx = 14 + t * 4, ly = 15; best = Math.min(best, Math.hypot(x - lx, y - ly)); } return best; };
    if (Math.hypot(ux - 9, uy - 21) <= 3) return [0x8f, 0xd3, 0xa6, 255];
    if (Math.hypot(ux - 23, uy - 10) <= 3) return [0xff, 0xd1, 0x66, 255];
    if (dist(ux, uy) <= 1.5) return [255, 255, 255, 255];
    return [0x1f, 0x5f, 0x8b, 255];
  };
  return png(size, (x, y) => { const acc = [0, 0, 0, 0]; for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) { const p = sample(x + (i + 0.5) / S, y + (j + 0.5) / S); for (let k = 0; k < 4; k++) acc[k] += p[k]; } return acc.map(v => Math.round(v / (S * S))); });
}
const out = path.join(__dirname, '..', 'public', 'icons'); fs.mkdirSync(out, { recursive: true });
for (const s of [180, 192, 512]) fs.writeFileSync(path.join(out, `icon-${s}.png`), icon(s));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, { maskable: true }));
console.log('icons written to public/icons');
