// Minimal QR code encoder (byte mode, error correction level M, versions 1–10) rendering to SVG.
// Used for authenticator (TOTP) enrollment so no third-party QR service ever sees the secret.
const EC_M = { 1: [1, 16, 10], 2: [1, 28, 16], 3: [1, 44, 26], 4: [2, 32, 18], 5: [2, 43, 24], 6: [4, 27, 16], 7: [4, 31, 18], 8: [2, 38, 22, 2, 39], 9: [3, 36, 22, 2, 37], 10: [4, 43, 26, 1, 44] };
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
function rsPoly(n) { let p = [1]; for (let i = 0; i < n; i++) { const q = new Array(p.length + 1).fill(0); for (let j = 0; j < p.length; j++) { q[j] ^= p[j]; q[j + 1] ^= mul(p[j], EXP[i]); } p = q; } return p; }
function rsEncode(data, n) { const gen = rsPoly(n); const res = new Array(n).fill(0); for (const d of data) { const f = d ^ res.shift(); res.push(0); if (f) for (let j = 0; j < n; j++) res[j] ^= mul(gen[j + 1], f); } return res; }

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const capacity = v => { const e = EC_M[v]; const total = e[0] * e[1] + (e[3] ? e[3] * e[4] : 0); return total - 2 - (v >= 10 ? 1 : 0); };
  while (version <= 10 && capacity(version) < bytes.length) version++;
  if (version > 10) throw new Error('Data too long for QR generator');
  const e = EC_M[version]; const blocks = []; const dataLen = e[0] * e[1] + (e[3] ? e[3] * e[4] : 0);
  const bits = []; const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  push(4, 4); push(bytes.length, version >= 10 ? 16 : 8); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataLen * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0xec; data.length < dataLen; p ^= 0xec ^ 0x11) data.push(p);
  let off = 0; const groups = [[e[0], e[1]], ...(e[3] ? [[e[3], e[4]]] : [])];
  for (const [cnt, len] of groups) for (let i = 0; i < cnt; i++) { const d = data.slice(off, off + len); off += len; blocks.push({ d, ec: rsEncode(d, e[2]) }); }
  const out = []; const maxD = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < e[2]; i++) for (const b of blocks) out.push(b.ec[i]);
  const size = version * 4 + 17; const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const set = (r, c, v) => { m[r][c] = v; };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue; set(rr, cc, (i >= 0 && i <= 6 && (j === 0 || j === 6)) || (j >= 0 && j <= 6 && (i === 0 || i === 6)) || (i >= 2 && i <= 4 && j >= 2 && j <= 4) ? 1 : 0); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }
  if (ALIGN[version]) for (const r of ALIGN[version]) for (const c of ALIGN[version]) { if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1 ? 1 : 0); }
  for (let i = 0; i < 8; i++) { if (m[8][i] === null) set(8, i, 0); if (m[i][8] === null) set(i, 8, 0); if (m[8][size - 1 - i] === null) set(8, size - 1 - i, 0); if (m[size - 1 - i][8] === null) set(size - 1 - i, 8, 0); }
  set(8, 8, 0); set(size - 8, 8, 1);
  if (version >= 7) { const vb = versionBits(version); for (let i = 0; i < 18; i++) { const b = (vb >> i) & 1; set(Math.floor(i / 3), size - 11 + (i % 3), b); set(size - 11 + (i % 3), Math.floor(i / 3), b); } }
  // place data
  let bi = 0; const total = out.length * 8; let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < size; k++) { const r = upward ? size - 1 - k : k; for (const c of [col, col - 1]) { if (m[r][c] !== null) continue; const bit = bi < total ? (out[bi >> 3] >> (7 - (bi & 7))) & 1 : 0; bi++; m[r][c] = bit; } }
    upward = !upward;
  }
  // choose best mask (simple penalty: prefer fewest long runs)
  const masks = [(r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => (r * c) % 2 + (r * c) % 3 === 0, (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0, (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0];
  const isFunc = (r, c) => (version >= 7 && ((r < 6 && c >= size - 11 && c <= size - 9) || (c < 6 && r >= size - 11 && r <= size - 9))) || (r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9) || r === 6 || c === 6 || (ALIGN[version] && ALIGN[version].some(ar => ALIGN[version].some(ac => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2 && !(ar === 6 && ac === 6) && !(ar === 6 && ac === size - 7) && !(ar === size - 7 && ac === 6))));
  let best = null, bestScore = Infinity;
  for (let mi = 0; mi < 8; mi++) {
    const mm = m.map((row, r) => row.map((v, c) => isFunc(r, c) ? v : v ^ (masks[mi](r, c) ? 1 : 0)));
    // format bits
    const fmtBits = formatBits(mi);
    for (let i = 0; i < 15; i++) { const b = (fmtBits >> (14 - i)) & 1; if (i < 6) mm[8][i] = b; else if (i < 8) mm[8][i + 1] = b; else if (i === 8) mm[7][8] = b; else mm[14 - i][8] = b; if (i < 8) mm[size - 1 - i][8] = b; else mm[8][size - 15 + i] = b; }
    mm[size - 8][8] = 1;
    let score = 0;
    for (let r = 0; r < size; r++) for (let c = 0, run = 1; c < size; c++) { if (c && mm[r][c] === mm[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; }
    for (let c = 0; c < size; c++) for (let r = 0, run = 1; r < size; r++) { if (r && mm[r][c] === mm[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; } else run = 1; }
    if (score < bestScore) { bestScore = score; best = mm; }
  }
  return best;
}
function versionBits(v) { let x = v << 12; const g = 0x1f25; for (let i = 17; i >= 12; i--) if ((x >> i) & 1) x ^= g << (i - 12); return (v << 12) | x; }
function formatBits(mask) { const data = (0b00 << 3) | mask; let v = data << 10; const g = 0b10100110111; for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= g << (i - 10); return ((data << 10) | v) ^ 0b101010000010010; }

export function qrSvg(text, { size = 200 } = {}) {
  const m = qrMatrix(text); const n = m.length; const scale = size / (n + 8);
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) path += `M${(c + 4) * scale} ${(r + 4) * scale}h${scale}v${scale}h-${scale}z`;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('width', size); svg.setAttribute('height', size); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'QR code');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect'); bg.setAttribute('width', size); bg.setAttribute('height', size); bg.setAttribute('fill', '#fff');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); p.setAttribute('fill', '#000');
  svg.append(bg, p); return svg;
}
