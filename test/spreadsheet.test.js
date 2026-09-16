'use strict';
process.env.SUDS_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../server/spreadsheet');

test('csv parse and write round trip', () => {
  const rows = S.parseCsv('﻿name,phone,notes\r\n"Doe, Jane",555-0100,"line1\nline2"\r\nSmith,,"say ""hi"""\r\n');
  assert.deepEqual(rows, [['name', 'phone', 'notes'], ['Doe, Jane', '555-0100', 'line1\nline2'], ['Smith', '', 'say "hi"']]);
  const csv = S.toCsv([{ a: 'x,y', b: 5 }, { a: null, b: 'q"r' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
  assert.equal(S.parseCsv(csv)[1][0], 'x,y'); assert.equal(S.parseCsv(csv)[2][1], 'q"r');
});
test('xlsx write then read', () => {
  const buf = S.writeWorkbook([{ name: 'Clients', columns: [{ key: 'code', label: 'Client code' }, { key: 'n', label: 'Visits' }, { key: 'ok', label: 'Active' }], rows: [{ code: 'C26-0001', n: 3, ok: true }, { code: 'Ünïcode <&>', n: 0, ok: false }] }, { name: 'Empty/Sheet:2', columns: ['x'], rows: [] }]);
  assert.equal(buf[0], 0x50);
  const sheets = S.readWorkbook(buf);
  assert.equal(sheets.length, 2); assert.equal(sheets[0].name, 'Clients'); assert.equal(sheets[1].name, 'Empty Sheet 2');
  assert.deepEqual(sheets[0].rows[0], ['Client code', 'Visits', 'Active']);
  assert.deepEqual(sheets[0].rows[1], ['C26-0001', 3, true]); assert.equal(sheets[0].rows[2][0], 'Ünïcode <&>');
  const parsed = S.parseFile(buf, 'x.xlsx');
  assert.equal(parsed.sheets[0].rows[0]['Client code'], 'C26-0001');
});
test('xlsx with shared strings (as Excel writes) is read', () => {
  const files = [['[Content_Types].xml', '<Types/>'], ['xl/workbook.xml', '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>'], ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/sharedStrings.xml', '<sst><si><t>Last name</t></si><si><t>O&apos;Brien</t></si></sst>'], ['xl/worksheets/sheet1.xml', '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>DOB</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>33000</v></c></row></sheetData></worksheet>']];
  const p = S.parseFile(S.zip(files), 'excel.xlsx');
  assert.equal(p.sheets[0].rows[0]['Last name'], "O'Brien"); assert.equal(S.excelDate(p.sheets[0].rows[0].DOB), '1990-05-07');
});
