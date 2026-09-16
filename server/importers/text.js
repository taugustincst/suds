'use strict';
// Shared text utilities for importers: HTML → text, quoted-printable, date sniffing, client hints.
const zlib = require('node:zlib');

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : m; }
    return map[e] ?? m;
  });
}

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|tr|blockquote|pre)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<\/td>/gi, '\t');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return m ? htmlToText(m[1]).trim() : '';
}

function quotedPrintableDecode(s) {
  return Buffer.from(String(s).replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'binary').toString('utf8');
}

// MIME multipart (MHT/MHTML) → array of {contentType, location, body(Buffer|string)}
function parseMime(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw);
  const headerEnd = text.search(/\r?\n\r?\n/);
  const headers = text.slice(0, headerEnd);
  const bm = /boundary="?([^"\r\n;]+)"?/i.exec(headers);
  if (!bm) {
    return [{ contentType: (/content-type:\s*([^;\r\n]+)/i.exec(headers) || [, 'text/html'])[1].trim(), body: decodePart(headers, text.slice(headerEnd).trim()) }];
  }
  const parts = text.split(new RegExp('--' + bm[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:--)?\\r?\\n'));
  const out = [];
  for (const p of parts.slice(1)) {
    const he = p.search(/\r?\n\r?\n/); if (he < 0) continue;
    const h = p.slice(0, he); const b = p.slice(he).replace(/^\r?\n\r?\n/, '');
    const ct = (/content-type:\s*([^;\r\n]+)/i.exec(h) || [, ''])[1].trim().toLowerCase();
    const loc = (/content-location:\s*([^\r\n]+)/i.exec(h) || [, ''])[1].trim();
    if (!ct) continue;
    out.push({ contentType: ct, location: loc, body: decodePart(h, b) });
  }
  return out;
}
function decodePart(headers, body) {
  const enc = (/content-transfer-encoding:\s*([^\r\n]+)/i.exec(headers) || [, '7bit'])[1].trim().toLowerCase();
  if (enc === 'quoted-printable') return quotedPrintableDecode(body);
  if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  return Buffer.from(body, 'latin1').toString('utf8');
}

// Minimal ZIP reader (stored + deflate) — enough for .docx / .onepkg-less exports. Returns Map<name, Buffer>.
function unzip(buf) {
  const files = new Map();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a ZIP archive');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28), elen = buf.readUInt16LE(off + 30), clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    const lnlen = buf.readUInt16LE(lho + 26), lelen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lnlen + lelen;
    const data = buf.subarray(dataStart, dataStart + csize);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data));
    off += 46 + nlen + elen + clen;
  }
  return files;
}

function docxToText(buf) {
  const files = unzip(buf);
  const xml = files.get('word/document.xml');
  if (!xml) throw new Error('Not a DOCX file (word/document.xml missing)');
  let s = xml.toString('utf8');
  s = s.replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>|<w:cr\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  return decodeEntities(s).replace(/\n{3,}/g, '\n\n').trim();
}

// Find a date in text (ISO, US, or "Month D, YYYY"); returns ISO string or null
function sniffDate(text) {
  const s = String(text || '');
  let m = /(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(s);
  if (m) { const d = new Date(m[1] + (m[2] ? 'T' + m[2] : 'T12:00:00')); if (!isNaN(d)) return d.toISOString(); }
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b(?:,?\s+(\d{1,2}:\d{2}\s*(?:AM|PM)?))?/i.exec(s);
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; const d = new Date(`${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T12:00:00`); if (!isNaN(d)) return d.toISOString(); }
  m = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(s);
  if (m) { const d = new Date(`${m[1].slice(0, 3)} ${m[2]}, ${m[3]} 12:00:00`); if (!isNaN(d)) return d.toISOString(); }
  return null;
}

// Extract client hints from text: "Client: Doe, Jane", "Re: Jane Doe", client codes like C26-0012
function sniffClientHints(text) {
  const s = String(text || '');
  const hints = { codes: [], names: [] };
  for (const m of s.matchAll(/\b(C\d{2}-\d{4})\b/gi)) hints.codes.push(m[1].toUpperCase());
  const kw = /\b(?:(?:client|participant|pt|patient|re|name|regarding)\s*[:\-]\s*|(?:with|for|regarding)\s+)/gi;
  const nameRe = /^([A-Z][a-zA-Z'\-]+(?:,\s*|\s+)[A-Z][a-zA-Z'\-]+)/;
  for (const m of s.matchAll(kw)) { const nm = nameRe.exec(s.slice(m.index + m[0].length)); if (nm) hints.names.push(nm[1].trim()); }
  hints.codes = [...new Set(hints.codes)]; hints.names = [...new Set(hints.names)].slice(0, 5);
  return hints;
}

module.exports = { htmlToText, extractTitle, quotedPrintableDecode, parseMime, unzip, docxToText, sniffDate, sniffClientHints, decodeEntities };
