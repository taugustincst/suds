'use strict';
process.env.SUDS_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const pocket = require('../server/importers/pocketai');
const onenote = require('../server/importers/onenote');
const T = require('../server/importers/text');

test('pocket ai JSON export', () => {
  const items = pocket.parse(JSON.stringify({ notes: [
    { id: 'a1', title: 'Field visit with Doe, Jane', transcript: 'Met client at shelter. Discussed MAT.', summary: 'Client interested in MAT.', action_items: ['Call clinic', 'Follow up Friday'], created_at: '2026-03-04T15:04:00Z', tags: ['field'] },
    { name: 'Quick memo', text: 'Callback re: C26-0007', date: 1772000000 },
  ] }));
  assert.equal(items.length, 2);
  assert.equal(items[0].external_id, 'a1');
  assert.match(items[0].content, /## Summary[\s\S]*## Action items[\s\S]*- Call clinic[\s\S]*## Transcript/);
  assert.equal(items[0].captured_at, '2026-03-04T15:04:00.000Z');
  assert.deepEqual(items[0].metadata.hints.names, ['Doe, Jane']);
  assert.deepEqual(items[1].metadata.hints.codes, ['C26-0007']);
  assert.ok(items[1].captured_at.startsWith('2026-02'));
});
test('pocket ai markdown export splits on separators', () => {
  const md = `# Note one\nDate: 2026-01-05\nSaw client.\n\n---\n\n# Note two\nCalled provider on 1/6/2026.`;
  const items = pocket.parse(md);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Note one');
  assert.ok(items[0].captured_at.startsWith('2026-01-05'));
  assert.ok(items[1].captured_at.startsWith('2026-01-06'));
});
test('onenote html and mht', () => {
  const html = `<html><head><title>Intake - Smith, John</title><meta name="created" content="2026-02-10T10:00:00"></head><body><p>Client:&nbsp;Smith, John</p><ul><li>Housing</li><li>MAT</li></ul></body></html>`;
  const [p] = onenote.parseFile(Buffer.from(html), 'page.html');
  assert.equal(p.title, 'Intake - Smith, John');
  assert.match(p.content, /• Housing/);
  assert.ok(p.captured_at.startsWith('2026-02-10'));
  assert.deepEqual(p.metadata.hints.names, ['Smith, John']);
  const qp = 'Client: Doe, Jane =E2=80=94 follow up';
  const mht = `MIME-Version: 1.0\r\nContent-Type: multipart/related; boundary="----=_NextPart_01D"\r\n\r\n------=_NextPart_01D\r\nContent-Location: file:///C:/page1.htm\r\nContent-Type: text/html; charset="utf-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<html><head><title>Page One</title></head><body><p>${qp}</p></body></html>\r\n------=_NextPart_01D\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw0KGgo=\r\n------=_NextPart_01D--\r\n`;
  const pages = onenote.parseFile(Buffer.from(mht), 'export.mht');
  assert.equal(pages.length, 1);
  assert.equal(pages[0].title, 'Page One');
  assert.match(pages[0].content, /Doe, Jane — follow up/);
});
test('onenote text export splits pages and docx parses', () => {
  const txt = `Weekly check-in\n\nMonday, March 2, 2026\n10:15 AM\n\nClient doing well.\n\nCrisis call\n\nTuesday, March 3, 2026\n4:00 PM\n\nOverdose reported.`;
  const pages = onenote.parseFile(Buffer.from(txt), 'notes.txt');
  assert.equal(pages.length, 2);
  assert.equal(pages[1].title, 'Crisis call');
  assert.ok(pages[1].captured_at.startsWith('2026-03-03'));
  // build minimal docx (zip with word/document.xml, deflate)
  const xml = `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p><w:p><w:r><w:t>World &amp; co</w:t></w:r></w:p></w:body></w:document>`;
  const docx = makeZip([['word/document.xml', Buffer.from(xml)]]);
  const [d] = onenote.parseFile(docx, 'export.docx');
  assert.match(d.content, /Hello\nWorld & co/);
});
function makeZip(entries) {
  const local = [], central = []; let off = 0;
  for (const [name, data] of entries) {
    const comp = zlib.deflateRawSync(data); const n = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    local.push(lh, n, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, n); off += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central); const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...local, cd, eocd]);
}
test('date sniffing', () => {
  assert.ok(T.sniffDate('Seen on 3/4/26 at 2pm').startsWith('2026-03-04'));
  assert.ok(T.sniffDate('March 4, 2026').startsWith('2026-03-04'));
  assert.equal(T.sniffDate('no date here'), null);
});
