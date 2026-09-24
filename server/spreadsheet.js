'use strict';
// Excel (.xlsx) and CSV reading/writing with Node built-ins only (works in the browser kernel too).
const zlib = require('node:zlib');
const { unzip, decodeEntities } = require('./importers/text');

// ---------- CSV ----------
function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => String(v).trim() !== ''));
}
// A text cell that begins with =, +, -, @, a tab or a carriage return is read by Excel and LibreOffice as
// a formula, so a "summary" of `=HYPERLINK(...)` or `=cmd|' /C calc'!A0` runs on the analyst's machine.
// Such text goes out prefixed with a single quote (the spreadsheet convention for "this is text") and
// quoted; numbers are written as numbers, which cannot be formulas. Headers get the same treatment.
const FORMULA_START = /^[=+\-@\t\r]/;
function toCsv(rows, columns) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    let t = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (FORMULA_START.test(t)) return '"\'' + t.replace(/"/g, '""') + '"';
    return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return '﻿' + [columns.map(c => esc(c.label || c.key || c)).join(','), ...rows.map(r => columns.map(c => esc(r[c.key || c])).join(','))].join('\r\n');
}

// ---------- ZIP writer (deflate) ----------
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function zipEntry(name, content, comp, off, local, central) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const n = Buffer.from(name); const crc = crc32(data);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
  local.push(lh, n, comp);
  const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
  central.push(ch, n);
  return off + 30 + n.length + comp.length;
}
function zipEnd(entries, local, central, off) {
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, eocd]);
}

// setImmediate is Node-only: the browser kernel (local mode, the static build) bundles this file too.
const defer = globalThis.setImmediate ? (f) => setImmediate(f) : (f) => setTimeout(f, 0);

/** Compress off the event loop, one entry at a time, for archives big enough to be felt. */
async function zipAsync(entries) {
  const local = [], central = []; let off = 0;
  // The browser kernel's zlib shim has no callback form; compress synchronously there, a yield apart.
  const deflate = (buf) => (typeof zlib.deflateRaw === 'function'
    ? new Promise((resolve, reject) => zlib.deflateRaw(buf, (err, out) => (err ? reject(err) : resolve(out))))
    : new Promise((resolve) => defer(resolve)).then(() => zlib.deflateRawSync(buf)));
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    off = zipEntry(name, data, await deflate(data), off, local, central);
  }
  return zipEnd(entries, local, central, off);
}

function zip(entries) {
  const local = [], central = []; let off = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const comp = zlib.deflateRawSync(data); const n = Buffer.from(name); const crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    local.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, n); off += 30 + n.length + comp.length;
  }
  return zipEnd(entries, local, central, off);
}

// ---------- XLSX writer ----------
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
function colRef(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
/** sheets: [{ name, columns: [{key,label}], rows: [{...}] }] → Buffer (.xlsx) */
/** The XML for one worksheet. Lifted out of writeWorkbook so a large export can build them one at a time. */
function writeSheetXml(sh) {
  const cols = sh.columns.map(c => (typeof c === 'string' ? { key: c, label: c } : c));
  const cell = (r, i, v) => {
    const ref = colRef(i) + r;
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    // A date or timestamp becomes a real Excel date (serial number + date style) rather than text, so the
    // column sorts and filters as dates without anyone converting it by hand first.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) { const t = Date.parse(v + 'T00:00:00Z'); if (Number.isFinite(t)) return `<c r="${ref}" s="2"><v>${(t - EXCEL_EPOCH) / 86400000}</v></c>`; }
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) { const t = Date.parse(v); if (Number.isFinite(t)) return `<c r="${ref}" s="3"><v>${(t - EXCEL_EPOCH) / 86400000}</v></c>`; }
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(typeof v === 'object' ? JSON.stringify(v) : v)}</t></is></c>`;
  };
  const header = `<row r="1">${cols.map((c, i) => `<c r="${colRef(i)}1" t="inlineStr" s="1"><is><t>${xmlEsc(c.label)}</t></is></c>`).join('')}</row>`;
  const body = sh.rows.map((row, ri) => `<row r="${ri + 2}">${cols.map((c, i) => cell(ri + 2, i, row[c.key])).join('')}</row>`).join('');
  const widths = `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, c.width || String(c.label).length + 4))}" customWidth="1"/>`).join('')}</cols>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${widths}<sheetData>${header}${body}</sheetData><autoFilter ref="A1:${colRef(cols.length - 1)}${sh.rows.length + 1}"/></worksheet>`;
}

/** Every file in the .xlsx container, keyed by path. */
function writeWorkbookParts(sheets) {
  const files = [];
  const safeName = (n, i) => (String(n).replace(/[\\/*?:\[\]]/g, ' ').slice(0, 31) || `Sheet${i + 1}`);
  files.push(['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`]);
  files.push(['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`]);
  files.push(['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`]);
  files.push(['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`]);
  files.push(['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`]);
  sheets.forEach((s, i) => files.push([`xl/worksheets/sheet${i + 1}.xml`, writeSheetXml(s)]));
  return new Map(files);
}

/** sheets: [{ name, columns: [{key,label}], rows: [{...}] }] -> Buffer (.xlsx) */
function writeWorkbook(sheets) { return zip([...writeWorkbookParts(sheets).entries()]); }

/**
 * Same output as writeWorkbook, but each worksheet — which is where the seconds go on a large export —
 * is rendered with a yield in between. Building a year of every table synchronously froze every other
 * request in the process while one person exported.
 */
async function writeWorkbookAsync(sheets) {
  const breathe = () => new Promise((resolve) => defer(resolve));
  const parts = writeWorkbookParts(sheets.map(s => ({ name: s.name, columns: s.columns, rows: [] })));
  for (let i = 0; i < sheets.length; i++) {
    parts.set(`xl/worksheets/sheet${i + 1}.xml`, writeSheetXml(sheets[i]));
    await breathe();
  }
  const out = await zipAsync([...parts.entries()]);
  return out;
}

// ---------- XLSX reader (first sheet or all sheets → arrays of arrays) ----------
function readWorkbook(buf) {
  const files = unzip(buf);
  const get = (n) => { const f = files.get(n); return f ? f.toString('utf8') : null; };
  const wb = get('xl/workbook.xml'); if (!wb) throw new Error('Not an Excel (.xlsx) file');
  const rels = get('xl/_rels/workbook.xml.rels') || '';
  const relMap = {}; for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) { const id = /Id="([^"]+)"/.exec(m[0])?.[1]; const t = /Target="([^"]+)"/.exec(m[0])?.[1]; if (id && t) relMap[id] = t.replace(/^\/?xl\//, '').replace(/^\//, ''); }
  const shared = []; const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(decodeEntities([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeEntities(/name="([^"]*)"/.exec(m[0])?.[1] || ''); const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const target = relMap[rid] || `worksheets/sheet${sheets.length + 1}.xml`;
    const xml = get('xl/' + target) || get(target); if (!xml) continue;
    const rows = [];
    for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1]; const inner = cm[2] || '';
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)?.[1]; const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const idx = ref ? colIndex(ref) : row.length;
        let v = null;
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (type === 's') v = shared[Number(vm?.[1])] ?? '';
        else if (type === 'inlineStr') v = decodeEntities([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
        else if (type === 'b') v = vm?.[1] === '1';
        else if (vm) { const n = Number(vm[1]); v = Number.isFinite(n) ? n : decodeEntities(vm[1]); }
        while (row.length < idx) row.push(null);
        row[idx] = v;
      }
      if (row.some(x => x !== null && x !== '')) rows.push(row);
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// Excel serial date → YYYY-MM-DD (dates come through as numbers)
function excelDate(n) { if (typeof n !== 'number' || !Number.isFinite(n) || n < 1) return null; const d = new Date(Math.round((n - 25569) * 86400000)); return isNaN(d) ? null : d.toISOString().slice(0, 10); }

/** Detect and parse a spreadsheet file into { sheets: [{name, headers, rows: [{header: value}]}] } */
function parseFile(buf, filename = '') {
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  const sheets = isZip ? readWorkbook(buf) : [{ name: filename.replace(/\.[^.]+$/, '') || 'Sheet1', rows: parseCsv(buf.toString('utf8')) }];
  return { sheets: sheets.map(s => { const [h, ...rest] = s.rows; const headers = (h || []).map(x => String(x ?? '').trim()); return { name: s.name, headers, rows: rest.map(r => Object.fromEntries(headers.map((k, i) => [k, r[i] === undefined ? null : r[i]]))) }; }) };
}

module.exports = { parseCsv, toCsv, writeWorkbook, writeWorkbookAsync, readWorkbook, parseFile, excelDate, zip, defer };
