'use strict';
// Minimal PNG writer (built-ins only) used to draw placeholder pictures for sample data.
const zlib = require('node:zlib');
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** pixels: Uint8Array RGB (w*h*3) → PNG buffer */
function encode(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A soft "building & sky" placeholder: gradient sky, ground band, a few window-like blocks. Deterministic per seed. */
function placeholder(w, h, seed = 1, palette = 0) {
  const P = [[[58, 123, 213], [232, 240, 250], [72, 96, 120]], [[38, 140, 120], [226, 244, 236], [70, 110, 95]], [[196, 120, 60], [252, 238, 224], [120, 88, 64]], [[120, 84, 190], [240, 234, 250], [88, 72, 120]], [[40, 100, 160], [225, 235, 245], [90, 104, 120]]][palette % 5];
  const [sky, light, wall] = P; const px = Buffer.alloc(w * h * 3);
  let s = seed >>> 0; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const horizon = Math.round(h * 0.68);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; let c;
    if (y < horizon) { const t = y / horizon; c = [sky[0] + (light[0] - sky[0]) * t, sky[1] + (light[1] - sky[1]) * t, sky[2] + (light[2] - sky[2]) * t]; }
    else { const t = (y - horizon) / (h - horizon); c = [110 + 40 * t, 150 + 30 * t, 90 + 30 * t]; }
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
  }
  // building silhouettes with windows
  const n = 2 + Math.floor(rnd() * 3); let x0 = Math.round(w * 0.08);
  for (let b = 0; b < n && x0 < w * 0.9; b++) {
    const bw = Math.round(w * (0.15 + rnd() * 0.22)), bh = Math.round(h * (0.25 + rnd() * 0.35)); const top = horizon - bh;
    for (let y = top; y < horizon + Math.round(h * 0.03); y++) for (let x = x0; x < Math.min(w, x0 + bw); x++) { const i = (y * w + x) * 3; px[i] = wall[0]; px[i + 1] = wall[1]; px[i + 2] = wall[2]; }
    for (let wy = top + 10; wy < horizon - 12; wy += 18) for (let wx = x0 + 8; wx < x0 + bw - 12; wx += 16) { const lit = rnd() > 0.35; for (let y = wy; y < wy + 9; y++) for (let x = wx; x < wx + 8; x++) { if (x >= w) continue; const i = (y * w + x) * 3; px[i] = lit ? 250 : 200; px[i + 1] = lit ? 236 : 215; px[i + 2] = lit ? 160 : 230; } }
    x0 += bw + Math.round(w * 0.03);
  }
  // a tree
  const tx = Math.round(w * 0.88), ty = horizon; for (let y = ty - 28; y < ty; y++) for (let x = tx - 14; x < tx + 14; x++) { if ((x - tx) ** 2 + (y - (ty - 20)) ** 2 < 14 * 14) { const i = (y * w + x) * 3; px[i] = 60; px[i + 1] = 130; px[i + 2] = 70; } }
  for (let y = ty - 6; y < ty + 8; y++) for (let x = tx - 2; x < tx + 2; x++) { const i = (y * w + x) * 3; px[i] = 90; px[i + 1] = 65; px[i + 2] = 40; }
  return encode(w, h, px);
}
module.exports = { encode, placeholder };
