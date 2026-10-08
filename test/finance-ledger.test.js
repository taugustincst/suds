'use strict';
// 1.25.2, BO6: finance's "Export to Excel" of spending and of staff time is a ledger it can reconcile. Spending
// and time with no client are the programme's own books, not health information: they keep their exact date,
// vendor and receipt number. A row linked to a client keeps Safe Harbor (year only, vendor and receipt left out,
// a random record id), and no description is ever written to a de-identified file (server/exports.js LEDGER).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let fin, sup, nav, clientId, clientCode;
const RANGE = 'from=2026-01-01&to=2026-12-31';
const rows = (text) => require('../server/spreadsheet').parseCsv(String(text).replace(/^﻿/, ''));

before(async () => {
  await H.start();
  H.makeUser('lgfin', 'finance'); H.makeUser('lgsup', 'supervisor'); H.makeUser('lgnav', 'navigator');
  fin = H.client(); await fin.login('lgfin', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('lgsup', 'StaffPassw0rd!x');
  nav = H.client(); await nav.login('lgnav', 'StaffPassw0rd!x');
  const c = await sup.post('/api/clients', { first_name: 'Ledger', last_name: 'Person', status: 'active', intake_date: '2026-07-01' });
  assert.equal(c.status, 201, JSON.stringify(c.data)); clientId = c.data.id; clientCode = c.data.client_code;
  const fund = await sup.post('/api/budget/funds', { name: 'Ledger Fund', source_type: 'sor_grant', fiscal_year_start: '2026-07-01', fiscal_year_end: '2027-06-30', total_amount: 5000 });
  assert.equal(fund.status, 201, JSON.stringify(fund.data));
  const spend = async (body) => { const r = await sup.post('/api/budget/expenditures', { funding_source_id: fund.data.id, ...body }); assert.equal(r.status, 201, JSON.stringify(r.data)); };
  await spend({ spent_at: '2026-09-14', amount: 240.5, category: 'supplies', vendor: 'Valley Medical Supply', receipt_ref: 'INV-77031', description: 'Naloxone restock for the van' });
  await spend({ client_id: clientId, spent_at: '2026-09-15', amount: 18, category: 'transportation', vendor: 'Ledger Person Taxi', receipt_ref: 'RCPT-LP-9', description: 'Ride for Ledger Person' });
  const t1 = await nav.post('/api/time', { work_date: '2026-09-05', minutes: 90, category: 'documentation', description: 'Monthly paperwork' });
  assert.equal(t1.status, 201, JSON.stringify(t1.data));
  const t2 = await nav.post('/api/time', { work_date: '2026-09-06', minutes: 45, category: 'direct_service', client_id: clientId, description: 'Drove Ledger Person to detox' });
  assert.equal(t2.status, 201, JSON.stringify(t2.data));
});
after(() => H.stop());

test('finance\'s spending export: exact date, vendor and receipt for spending with no client; Safe Harbor for a client\'s', async () => {
  const r = await fin.get(`/api/reports/export/expenditures?${RANGE}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-suds-export'), /^De-identified \(HIPAA Safe Harbor\).*no client are the programme's own books/);
  const [header, ...body] = rows(r.data);
  const col = (row, name) => row[header.indexOf(name)];
  const books = body.find(x => col(x, 'Vendor') === 'Valley Medical Supply');
  assert.ok(books, `the vendor of spending with no client is written: ${r.data}`);
  assert.equal(col(books, 'Spent At'), '2026-09-14', 'with its exact date');
  assert.equal(col(books, 'Receipt Ref'), 'INV-77031', 'and its receipt number');
  assert.equal(col(books, 'Amount'), '240.5');
  assert.equal(col(books, 'Record Id'), '', 'and no record id: it is about nobody');
  const linked = body.find(x => /^R-[0-9A-F]{10}$/.test(col(x, 'Record Id')));
  assert.ok(linked, 'the client\'s spending carries a random record id');
  assert.equal(col(linked, 'Spent At'), '2026', 'its date reduced to the year');
  assert.equal(col(linked, 'Vendor'), ''); assert.equal(col(linked, 'Receipt Ref'), '');
  const text = String(r.data);
  for (const leak of ['Ledger Person', 'RCPT-LP', 'Naloxone restock', 'Ride for', clientCode, clientId, '2026-09-15']) assert.ok(!text.includes(leak), `"${leak}" must not appear`);
  assert.ok(!header.includes('Description') && !header.includes('Client Code'));
});

test('finance\'s time export: exact work date for time with no client; year only for time on a client', async () => {
  const r = await fin.get(`/api/reports/export/time?${RANGE}`);
  assert.equal(r.status, 200);
  const [header, ...body] = rows(r.data);
  const col = (row, name) => row[header.indexOf(name)];
  const own = body.find(x => col(x, 'Minutes') === '90');
  assert.equal(own && col(own, 'Work Date'), '2026-09-05', 'time with no client keeps its date');
  const linked = body.find(x => col(x, 'Minutes') === '45');
  assert.equal(linked && col(linked, 'Work Date'), '2026', 'time on a client is reduced to the year');
  assert.match(linked && col(linked, 'Record Id'), /^R-[0-9A-F]{10}$/);
  const text = String(r.data);
  for (const leak of ['Ledger Person', 'paperwork', 'detox', '2026-09-06', clientCode]) assert.ok(!text.includes(leak), `"${leak}" must not appear`);
});

test('the workbook carries the same ledger, and an identified export is unchanged', async () => {
  const bearer = (await H.client().post('/api/auth/login', { username: 'lgfin', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token;
  const res = await fetch(`${await H.start()}/api/reports/export/workbook?${RANGE}`, { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(res.status, 200);
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await res.arrayBuffer()));
  const sp = sheets.find(s => s.name === 'Expenditures');
  const header = sp.rows[0].map(String);
  const books = sp.rows.slice(1).find(x => String(x[header.indexOf('Vendor')]) === 'Valley Medical Supply');
  assert.ok(books, 'the workbook\'s Expenditures sheet has the vendor');
  assert.ok(JSON.stringify(sheets.find(s => s.name === 'About').rows).includes('own books'), 'and its About sheet says why');
  // Finance cannot ask for an identified export (no export:identified): the request is answered de-identified.
  const id = await fin.get(`/api/reports/export/expenditures?identified=1&recipient=x&purpose=y&basis=audit_evaluation&${RANGE}`);
  assert.equal(id.status, 200);
  assert.ok(!String(id.data).includes('Ledger Person'), 'still nothing that names the client');
});
