'use strict';
// Best-effort text extraction from an uploaded policy/contract, with Node built-ins only, so the library
// can be searched by what a document says and not just what it was titled. Plain text is taken as is; a
// PDF's content streams are inflated (zlib) and the string operands of its text operators pulled out; a
// .docx is a zip whose word/document.xml is inflated and stripped of tags. Anything else (a scan, an
// image, an old .doc) yields nothing, and a document that yields nothing is still findable by title.
//
// This runs inline in the upload request against attacker-chosen bytes, so everything here is linear in
// the input and bounded: no regex over the file, every inflate capped, and scanning stops once enough text
// has been collected.
const zlib = require('node:zlib');

const MAX_TEXT = 200 * 1024;          // what is kept for search
const MAX_SCAN = 8 * 1024 * 1024;     // bytes of decoded content looked at in total
const MAX_INFLATE = 4 * MAX_TEXT;     // a stream that inflates past this is a bomb, not a policy

function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT); }

const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
// One pass over a decoded content stream: collect every (literal) and <hex> string operand. Whether it is
// followed by Tj/TJ/' /" is not checked -- for search, a few font names picked up along the way are
// harmless, and a hand-written scanner cannot be made to backtrack.
function pdfStrings(src, out, budget) {
  let i = 0; const n = src.length; let taken = 0;
  while (i < n && taken < budget.left) {
    const c = src.charCodeAt(i);
    if (c === 40) { // (
      let depth = 1; let s = ''; i++;
      while (i < n && depth > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const nx = src[i + 1] || '';
          if (nx >= '0' && nx <= '7') { let oct = ''; let j = i + 1; while (j < n && j < i + 4 && src[j] >= '0' && src[j] <= '7') oct += src[j++]; s += String.fromCharCode(parseInt(oct, 8)); i = j; continue; }
          s += ESC[nx] || nx; i += 2; continue;
        }
        if (ch === '(') depth++; else if (ch === ')') { depth--; if (!depth) { i++; break; } }
        s += ch; i++;
      }
      if (s) { out.push(s); taken += s.length; }
      continue;
    }
    if (c === 60 && src[i + 1] !== '<') { // <hex>  (not a << dictionary)
      let j = i + 1; let hex = '';
      while (j < n && src[j] !== '>') { const h = src[j]; if (/[0-9A-Fa-f]/.test(h)) hex += h; else if (!/\s/.test(h)) break; j++; }
      if (src[j] === '>' && hex.length) { let s = ''; for (let k = 0; k + 1 < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16)); out.push(s); taken += s.length; i = j + 1; continue; }
      i++; continue;
    }
    i++;
  }
  budget.left -= taken;
}

function pdfText(buf) {
  const src = buf.toString('latin1');
  const out = []; const budget = { left: MAX_SCAN };
  let from = 0; let streams = 0;
  // A real policy has a few hundred content streams at most; a file with tens of thousands is not one.
  while (budget.left > 0 && streams++ < 3000) {
    const s = src.indexOf('stream', from); if (s < 0) break;
    let start = s + 6; if (src[start] === '\r') start++; if (src[start] === '\n') start++;
    const end = src.indexOf('endstream', start); if (end < 0) break;
    const raw = buf.subarray(start, end);
    let text;
    try { text = zlib.inflateSync(raw, { maxOutputLength: MAX_INFLATE }).toString('latin1'); }
    catch { text = raw.length <= MAX_INFLATE ? raw.toString('latin1') : ''; }
    pdfStrings(text, out, budget);
    from = end + 9;
  }
  return out.join(' ');
}

// Minimal zip reader: walk local file headers, inflate the one entry we want. Sizes for entries written
// with a data descriptor come from the central directory, read once.
function zipEntry(buf, wanted) {
  let central = null;
  const cdSizes = () => {
    if (central) return central;
    central = new Map();
    let c = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    while (c >= 0 && c + 46 <= buf.length && buf.readUInt32LE(c) === 0x02014b50) {
      const cn = buf.readUInt16LE(c + 28), cx = buf.readUInt16LE(c + 30), cc = buf.readUInt16LE(c + 32);
      central.set(buf.toString('utf8', c + 46, c + 46 + cn), buf.readUInt32LE(c + 20));
      c += 46 + cn + cx + cc;
    }
    return central;
  };
  let off = 0; let entries = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50 && entries++ < 10000) {
    const method = buf.readUInt16LE(off + 8), flags = buf.readUInt16LE(off + 6);
    let csize = buf.readUInt32LE(off + 18); const nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
    const name = buf.toString('utf8', off + 30, off + 30 + nlen);
    const dataStart = off + 30 + nlen + xlen;
    if (flags & 8) { const sz = cdSizes().get(name); if (sz === undefined) return null; csize = sz; }
    if (name === wanted) {
      const data = buf.subarray(dataStart, dataStart + csize);
      try { return method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: MAX_INFLATE }) : method === 0 && data.length <= MAX_INFLATE ? data : null; }
      catch { return null; }
    }
    off = dataStart + csize;
    if (flags & 8) off += 16;
  }
  return null;
}

function docxText(buf) {
  const xml = zipEntry(buf, 'word/document.xml'); if (!xml) return '';
  return xml.toString('utf8').replace(/<\/w:p>/g, '\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function extractText(buf, type) {
  try {
    if (type === 'text/plain') return clean(buf.toString('utf8', 0, MAX_SCAN));
    if (type === 'application/pdf') return clean(pdfText(buf));
    if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return clean(docxText(buf));
  } catch { /* an unreadable file is still a valid upload; it just is not searchable by content */ }
  return '';
}

module.exports = { extractText };
