'use strict';
// Minimal PDF writer (built-ins only): Letter pages, Helvetica, word-wrapped text, simple lines and checkboxes.
// Used to render completed county forms and blank sample templates. Not a general PDF library.
const W = 612, H = 792, M = 54; // points; 0.75in margins
function esc(s) { return String(s).replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }
function wrap(text, maxChars) { const out = []; for (const para of String(text ?? '').split(/\r?\n/)) { let line = ''; for (const w of para.split(/\s+/)) { if (!w) continue; if ((line + ' ' + w).trim().length > maxChars) { if (line) out.push(line); line = w.length > maxChars ? w.slice(0, maxChars) : w; } else line = (line + ' ' + w).trim(); } out.push(line); } return out; }

class Doc {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = H - M; }
  ensure(h) { if (this.y - h < M) this.newPage(); }
  text(str, { size = 10, bold = false, x = M, indent = 0, color = '0 0 0' } = {}) {
    const maxChars = Math.floor((W - 2 * M - indent) / (size * 0.5));
    for (const line of wrap(str, maxChars)) { this.ensure(size * 1.4); this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${color} rg ${x + indent} ${this.y - size} Td (${esc(line)}) Tj ET`); this.y -= size * 1.4; }
  }
  gap(n = 6) { this.y -= n; }
  rule(color = '0.75 0.75 0.75') { this.ensure(8); this.ops.push(`${color} RG 0.5 w ${M} ${this.y - 2} m ${W - M} ${this.y - 2} l S`); this.y -= 8; }
  box(checked, label, size = 10) { this.ensure(size * 1.5); const y = this.y - size; this.ops.push(`0 0 0 RG 0.8 w ${M} ${y - 1} ${size} ${size} re S`); if (checked) this.ops.push(`BT /F2 ${size} Tf 0 0 0 rg ${M + 2} ${y + 1} Td (X) Tj ET`); this.ops.push(`BT /F1 ${size} Tf 0 0 0 rg ${M + size + 6} ${y} Td (${esc(label)}) Tj ET`); this.y -= size * 1.5; }
  field(label, value, { lines = 1 } = {}) {
    this.text(label, { size: 8.5, color: '0.35 0.35 0.35' });
    if (value === null || value === undefined || value === '') { for (let i = 0; i < lines; i++) { this.ensure(16); this.ops.push(`0.6 0.6 0.6 RG 0.5 w ${M} ${this.y - 12} m ${W - M} ${this.y - 12} l S`); this.y -= 16; } }
    else this.text(value, { size: 10.5, indent: 4 });
    this.gap(4);
  }
  render() {
    const objs = []; const add = (s) => { objs.push(s); return objs.length; };
    const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const font2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + 1 + this.pages.length * 2; const pageIds = [];
    for (const ops of this.pages) {
      const content = ops.join('\n'); const cId = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${cId} 0 R /Resources << /Font << /F1 ${font1} 0 R /F2 ${font2} 0 R >> >> >>`));
    }
    const pages = add(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] /Count ${pageIds.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${pages} 0 R >>`);
    let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'; const offsets = [];
    objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
/** Render a form (template fields + optional values) as a printable PDF. */
function renderForm({ title, subtitle, org, meta = [], fields = [], values = {}, footer }) {
  const d = new Doc();
  if (org) d.text(org, { size: 9, color: '0.35 0.35 0.35' });
  d.text(title, { size: 16, bold: true }); if (subtitle) d.text(subtitle, { size: 10, color: '0.3 0.3 0.3' });
  if (meta.length) { d.gap(2); d.text(meta.filter(Boolean).join('   ·   '), { size: 9, color: '0.35 0.35 0.35' }); }
  d.rule(); d.gap(4);
  for (const f of fields) {
    if (f.type === 'section') { d.gap(6); d.text(f.label, { size: 12, bold: true }); d.rule('0.85 0.85 0.85'); continue; }
    if (f.type === 'note') { d.text(f.label, { size: 9, color: '0.3 0.3 0.3' }); d.gap(4); continue; }
    const v = values[f.key];
    if (f.type === 'checkbox') { d.box(v === true || v === 1 || v === '1' || v === 'true', f.label); continue; }
    if (f.type === 'signature') { d.field(f.label + (v ? ' (signed electronically)' : ' (signature)'), v ? `/s/ ${v}` : '', { lines: 2 }); continue; }
    d.field(f.label + (f.required ? ' *' : ''), Array.isArray(v) ? v.join(', ') : v, { lines: f.type === 'textarea' ? 3 : 1 });
  }
  if (footer) { d.gap(10); d.rule(); d.text(footer, { size: 8, color: '0.4 0.4 0.4' }); }
  return d.render();
}
module.exports = { Doc, renderForm };
