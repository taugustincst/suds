'use strict';
// Minimal PNG writer (built-ins only) used to draw placeholder pictures for sample data.
const zlib = require('node:zlib');
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
/** pixels: Uint8Array RGB (w*h*3) → PNG buffer. Every caller here draws a throwaway placeholder (region
 *  starter directories, sample data) meant to be replaced with a real photo, generated a hundred at a
 *  time, synchronously, inside one transaction — not final art worth spending CPU compressing hard. The
 *  default deflate level (6) was measurably the majority of the cost of loading an 81-provider starter
 *  directory; level 1 trades a few KB of output for several times the speed on exactly this kind of
 *  low-entropy, soon-to-be-discarded image. */
function encode(w, h, rgb, level = 1) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
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

// --- tiny 5x7 bitmap font (A-Z 0-9 and a few marks) so generated cards can carry a name ---
const FONT = {
  A: '01110,10001,10001,11111,10001,10001,10001', B: '11110,10001,10001,11110,10001,10001,11110', C: '01110,10001,10000,10000,10000,10001,01110',
  D: '11110,10001,10001,10001,10001,10001,11110', E: '11111,10000,10000,11110,10000,10000,11111', F: '11111,10000,10000,11110,10000,10000,10000',
  G: '01110,10001,10000,10111,10001,10001,01111', H: '10001,10001,10001,11111,10001,10001,10001', I: '11111,00100,00100,00100,00100,00100,11111',
  J: '00111,00010,00010,00010,00010,10010,01100', K: '10001,10010,10100,11000,10100,10010,10001', L: '10000,10000,10000,10000,10000,10000,11111',
  M: '10001,11011,10101,10101,10001,10001,10001', N: '10001,11001,10101,10011,10001,10001,10001', O: '01110,10001,10001,10001,10001,10001,01110',
  P: '11110,10001,10001,11110,10000,10000,10000', Q: '01110,10001,10001,10001,10101,10010,01101', R: '11110,10001,10001,11110,10100,10010,10001',
  S: '01111,10000,10000,01110,00001,00001,11110', T: '11111,00100,00100,00100,00100,00100,00100', U: '10001,10001,10001,10001,10001,10001,01110',
  V: '10001,10001,10001,10001,10001,01010,00100', W: '10001,10001,10001,10101,10101,11011,10001', X: '10001,10001,01010,00100,01010,10001,10001',
  Y: '10001,10001,01010,00100,00100,00100,00100', Z: '11111,00001,00010,00100,01000,10000,11111',
  0: '01110,10001,10011,10101,11001,10001,01110', 1: '00100,01100,00100,00100,00100,00100,01110', 2: '01110,10001,00001,00010,00100,01000,11111',
  3: '11111,00010,00100,00010,00001,10001,01110', 4: '00010,00110,01010,10010,11111,00010,00010', 5: '11111,10000,11110,00001,00001,10001,01110',
  6: '00110,01000,10000,11110,10001,10001,01110', 7: '11111,00001,00010,00100,01000,01000,01000', 8: '01110,10001,10001,01110,10001,10001,01110',
  9: '01110,10001,10001,01111,00001,00010,01100', '&': '01100,10010,10100,01000,10101,10010,01101', '-': '00000,00000,00000,11111,00000,00000,00000',
  '.': '00000,00000,00000,00000,00000,01100,01100', "'": '00100,00100,00000,00000,00000,00000,00000', ' ': '00000,00000,00000,00000,00000,00000,00000',
};
const textWidth = (str, scale) => Math.max(0, str.length * 6 - 1) * scale;
/** Draw str into an RGB buffer at (x, y). Unknown characters render as a space. */
function drawText(px, w, h, str, x, y, scale, color) {
  let cx = x;
  for (const ch of String(str).toUpperCase()) {
    const rows = (FONT[ch] || FONT[' ']).split(',');
    for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) {
      if (rows[ry][rx] !== '1') continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px_ = cx + rx * scale + sx, py = y + ry * scale + sy;
        if (px_ < 0 || py < 0 || px_ >= w || py >= h) continue;
        const i = (py * w + px_) * 3; px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2];
      }
    }
    cx += 6 * scale;
  }
}
const CARD_PALETTES = {
  detox_withdrawal_mgmt: [[176, 58, 46], [120, 40, 32]], residential: [[38, 100, 160], [24, 64, 104]], inpatient: [[38, 100, 160], [24, 64, 104]],
  partial_hospitalization: [[46, 110, 150], [28, 70, 98]], intensive_outpatient: [[46, 125, 140], [28, 82, 92]], outpatient: [[52, 132, 128], [32, 86, 84]],
  mat_otp: [[92, 62, 168], [58, 38, 112]], mat_obot: [[110, 72, 176], [70, 44, 116]], sober_living: [[52, 132, 92], [32, 86, 60]],
  housing: [[46, 120, 86], [28, 78, 56]], shelter: [[62, 110, 72], [38, 72, 48]], mental_health: [[70, 96, 176], [44, 62, 116]],
  primary_care: [[36, 128, 142], [22, 84, 94]], harm_reduction: [[198, 118, 44], [130, 76, 28]], syringe_services: [[198, 118, 44], [130, 76, 28]],
  naloxone: [[206, 96, 48], [136, 62, 30]], crisis_line: [[186, 54, 74], [124, 34, 48]], transportation: [[92, 106, 130], [58, 68, 86]],
  employment: [[120, 104, 48], [78, 68, 30]], legal: [[86, 92, 116], [54, 58, 76]], food: [[140, 110, 52], [92, 72, 34]],
  benefits: [[88, 100, 140], [56, 64, 92]], peer_support: [[150, 78, 132], [98, 50, 86]], recovery_community: [[132, 84, 150], [86, 54, 98]],
  family_support: [[160, 92, 110], [104, 58, 72]], pregnancy_parenting: [[168, 96, 128], [110, 62, 84]], veterans: [[70, 88, 118], [44, 56, 78]],
  other: [[74, 88, 104], [46, 56, 68]],
};
/** A calm, category-tinted cover card carrying the program's initials. Drawn locally: no network, no third-party image.
 *  Deliberately spare — the program name and category already appear as text on the card and profile beneath it. */
function initialsCard(name, category = 'other', w = 480, h = 270) {
  const [c1, c2] = CARD_PALETTES[category] || CARD_PALETTES.other;
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (y / h) * 0.7 + (x / w) * 0.3; const i = (y * w + x) * 3;
    px[i] = c1[0] + (c2[0] - c1[0]) * t; px[i + 1] = c1[1] + (c2[1] - c1[1]) * t; px[i + 2] = c1[2] + (c2[2] - c1[2]) * t;
  }
  const words = String(name || '?').split(/[^A-Za-z0-9]+/).filter(w2 => w2 && !['of', 'the', 'and', 'for', 'at', 'a'].includes(w2.toLowerCase()));
  const initials = words.slice(0, 3).map(w2 => w2[0]).join('').toUpperCase() || '?';
  const scale = Math.max(6, Math.round(h / (initials.length > 2 ? 26 : 20)));
  drawText(px, w, h, initials, Math.round((w - textWidth(initials, scale)) / 2), Math.round((h - 7 * scale) / 2) - Math.round(h * 0.04), scale, [255, 255, 255]);
  const cat = String(category).replace(/_/g, ' ').toUpperCase();
  const cs = Math.max(1, Math.round(h / 135));
  drawText(px, w, h, cat, Math.round((w - textWidth(cat, cs)) / 2), h - Math.round(h * 0.13), cs, [226, 234, 242]);
  return encode(w, h, px);
}
module.exports = { encode, placeholder, initialsCard, drawText };
