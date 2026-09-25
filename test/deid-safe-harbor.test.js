'use strict';
// "De-identified (HIPAA Safe Harbor)" has to be literally true of every file that says it (§164.514(b)(2)):
// no date element but the year, no age over 89, no ZIP3 whose area holds 20,000 people or fewer, no free
// text, and no record number the programme could hand back to identify the person. Each de-identified
// export path is checked here: every single-table export, the workbook, and the outcome measures CSV.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let fin, nav, sup, clin, oldId, youngId, oldCode, youngCode;
const FREE_TEXT = ['John', 'Smith', '555 12 3456', 'Elm St', 'Chico', 'Aunt Rosa', 'under the overpass', 'until she moves', 'hand delivered by Pat'];
const PART2 = { type: 'part2_disclosure', recipient: 'County OTP', purpose: 'MAT intake', signed_at: '2026-07-01', scope: 'Referral summary', expires_event: 'until she moves', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const KINDS = ['clients', 'interventions', 'calls', 'time', 'referrals', 'tasks', 'forms', 'consents', 'disclosures', 'episodes', 'overdose_events', 'expenditures'];
const RANGE = 'from=2026-01-01&to=2026-12-31';

before(async () => {
  await H.start();
  H.makeUser('dhnav', 'navigator'); H.makeUser('dhsup', 'supervisor'); H.makeUser('dhfin', 'finance'); const clinId = H.makeUser('dhclin', 'clinician').id;
  nav = H.client(); await nav.login('dhnav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('dhsup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('dhfin', 'StaffPassw0rd!x');
  clin = H.client(); await clin.login('dhclin', 'StaffPassw0rd!x');
  // A 96-year-old in a restricted ZIP3 (036), referred by a named relative with a phone number.
  const a = await sup.post('/api/clients', { first_name: 'Olive', last_name: 'Harbor', dob: '1930-02-01', zip: '03601', city: 'Walpole', status: 'active', intake_date: '2026-07-15',
    referral_source: 'Her brother John Q. Smith, 555 12 3456', referral_date: '2026-07-10', engagement_date: '2026-07-20', gender: 'Aunt Rosa said female' });
  assert.equal(a.status, 201, JSON.stringify(a.data)); oldId = a.data.id; oldCode = a.data.client_code;
  const b = await sup.post('/api/clients', { first_name: 'Yuri', last_name: 'Young', dob: '1995-05-05', zip: '95814', status: 'active', intake_date: '2026-03-02', confirm_duplicate: true });
  assert.equal(b.status, 201, JSON.stringify(b.data)); youngId = b.data.id; youngCode = b.data.client_code;
  // A discharge reason typed in free text before the field was a list: kept in the record, never exported.
  H.db.run(`UPDATE clients SET discharge_date='2026-08-03', discharge_reason='moved to 12 Elm St Chico' WHERE id=?`, oldId);

  const ok = async (p) => { const r = await p; assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.data)); return r; };
  await ok(sup.post('/api/interventions', { client_id: oldId, type: 'outreach', occurred_at: '2026-07-16T10:00:00Z', duration_minutes: 20, follow_up_due: '2026-07-30' }));
  await ok(sup.post('/api/calls', { client_id: oldId, direction: 'outbound', started_at: '2026-07-16T11:00:00Z', follow_up_needed: true, follow_up_due: '2026-07-31' }));
  await ok(sup.post('/api/tasks', { client_id: oldId, title: 'Call back', due_at: '2026-07-21' }));
  const consent = await ok(sup.post(`/api/clients/${oldId}/consents`, PART2));
  await ok(sup.post(`/api/clients/${oldId}/disclosures`, { disclosed_to: 'County OTP', purpose: 'MAT intake', info_disclosed: 'Referral summary', disclosed_at: '2026-07-17T12:00:00Z', basis: 'consent', consent_id: consent.data.id, method: 'hand delivered by Pat' }));
  assert.equal((await sup.post('/api/overdose-events', { client_id: oldId, occurred_at: '2026-07-18T02:00:00Z', kind: 'reversal', location_type: 'under the overpass', naloxone_used: true })).status, 201);
  const ep = H.db.one(`SELECT id FROM episodes WHERE client_id=? AND status='open'`, youngId);
  assert.equal((await sup.post(`/api/episodes/${ep.id}/close`, { discharge_reason: 'moved', discharge_disposition: 'moved in with Aunt Rosa in Chico', closed_at: '2026-08-01' })).status, 200);
  // Outcome measures for the outcomes export.
  assert.equal((await sup.post(`/api/clients/${oldId}/assignments`, { user_id: clinId, role_on_case: 'clinician' })).status, 201);
  assert.equal((await clin.post(`/api/clients/${oldId}/outcomes`, { instrument: 'phq9', administered_at: '2026-03-01', responses: [3, 3, 3, 2, 2, 2, 1, 1, 0] })).status, 201);
  assert.equal((await clin.post(`/api/clients/${oldId}/outcomes`, { instrument: 'phq9', administered_at: '2026-06-01', responses: [1, 1, 1, 1, 1, 0, 0, 0, 0] })).status, 201);
});
after(() => H.stop());

const rows = (text) => require('../server/spreadsheet').parseCsv(String(text).replace(/^﻿/, ''));
/** The things no de-identified file may carry, whichever dataset it is. */
function assertSafeHarbor(label, header, body) {
  const all = body.map(r => r.join('\u0001')).join('\n');
  for (const s of FREE_TEXT) assert.ok(!all.includes(s), `${label}: free text "${s}" must not appear`);
  assert.ok(!/\b\d{4}-\d{2}\b/.test(all), `${label}: no month-level (or finer) date may appear: ${all.match(/.{0,30}\b\d{4}-\d{2}\b.{0,10}/)?.[0]}`);
  for (const id of [oldCode, youngCode, oldId, youngId]) assert.ok(!all.includes(id), `${label}: the real client code / id ${id} must not appear`);
  assert.ok(!header.includes('Client Code'), `${label}: no client code column`);
  assert.ok(!all.includes('036'), `${label}: a restricted ZIP3 is never written`);
}

test('client free-text discharge reasons are refused on new writes, legacy values still read and update', async () => {
  const bad = await sup.put(`/api/clients/${youngId}`, { discharge_reason: 'went to live with her boyfriend on 3rd Ave' });
  assert.equal(bad.status, 400, 'a new discharge reason must come from the list');
  assert.equal((await sup.put(`/api/clients/${youngId}`, { discharge_reason: 'moved' })).status, 200, 'a listed reason is accepted');
  // The legacy value is kept and does not block editing the record.
  assert.equal((await sup.put(`/api/clients/${oldId}`, { risk_level: 'high', discharge_reason: 'moved to 12 Elm St Chico' })).status, 200);
  assert.equal((await sup.get(`/api/clients/${oldId}`)).status, 200);
  assert.equal(H.db.one(`SELECT discharge_reason FROM clients WHERE id=?`, oldId).discharge_reason, 'moved to 12 Elm St Chico');
});

test('every single-table de-identified export meets Safe Harbor', async () => {
  for (const kind of KINDS) {
    const r = await fin.get(`/api/reports/export/${kind}?${RANGE}`);
    assert.equal(r.status, 200, kind);
    const [header, ...body] = rows(r.data);
    assertSafeHarbor(kind, header, body);
    assert.ok(header.includes('Record Id'), `${kind}: rows carry a pseudonymous record id`);
  }
});

test('the clients export: year-only dates, 90+, ZIP3 000, coded discharge reason, random record ids', async () => {
  const r1 = await fin.get(`/api/reports/export/clients?${RANGE}`);
  const [header, ...body] = rows(r1.data);
  const col = (row, name) => row[header.indexOf(name)];
  const old = body.find(r => col(r, 'Age Band') === '90+');
  assert.ok(old, 'the 96-year-old is in the 90+ band');
  assert.equal(col(old, 'Zip'), '000', 'a ZIP3 on the restricted list becomes 000');
  assert.equal(col(old, 'Intake Date'), '2026', 'dates are reduced to the year');
  assert.equal(col(old, 'Discharge Date'), '2026');
  assert.equal(col(old, 'Discharge Reason'), 'Other', 'a discharge reason outside the list is "other"');
  assert.equal(col(old, 'Gender'), 'Other', 'a value outside the offered choices is "other"');
  assert.ok(!header.includes('Referral Source') || ['', 'Other'].includes(col(old, 'Referral Source')), 'referral source is never free text');
  assert.equal(col(old, 'Days To Engagement'), '10', 'a duration is not a date element and is kept');
  const young = body.find(r => col(r, 'Zip') === '958');
  assert.ok(young, 'an unrestricted ZIP3 is kept');
  // A fresh pseudonym per export: nothing the recipient can carry from one file to the next.
  const [h2, ...b2] = rows((await fin.get(`/api/reports/export/clients?${RANGE}`)).data);
  const ids1 = body.map(r => col(r, 'Record Id')).sort(); const ids2 = b2.map(r => r[h2.indexOf('Record Id')]).sort();
  assert.equal(new Set(ids1).size, ids1.length, 'one pseudonym per client');
  assert.ok(ids1.every(x => !ids2.includes(x)), 'pseudonyms are not reused between exports');
});

test('the workbook meets Safe Harbor and links a client across sheets within the one file', async () => {
  const bearer = (await H.client().post('/api/auth/login', { username: 'dhfin', password: 'StaffPassw0rd!x' }, { 'X-Sync-Client': '1' })).data.token;
  const res = await fetch(`${await H.start()}/api/reports/export/workbook?${RANGE}`, { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(res.status, 200);
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await res.arrayBuffer()));
  const ids = {};
  for (const s of sheets) {
    if (s.name === 'About' || ['Resource directory', 'Funding sources', 'Budget lines'].includes(s.name)) continue;
    const header = s.rows[0].map(String); const body = s.rows.slice(1).map(r => r.map(v => String(v ?? '')));
    assertSafeHarbor(`workbook ${s.name}`, header, body);
    ids[s.name] = new Set(body.map(r => r[header.indexOf('Record Id')]).filter(Boolean));
  }
  const clientIds = ids.Clients; const overdose = [...ids['Overdose & reversal events']];
  assert.ok(overdose.length && overdose.every(x => clientIds.has(x)), 'the same client carries the same pseudonym on every sheet of one workbook');
});

test('the outcome measures export meets Safe Harbor', async () => {
  const r = await fin.get('/api/reports/outcomes/export?from=2026-01-01&to=2026-12-31');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('x-suds-export'), /^De-identified \(HIPAA Safe Harbor\)/);
  const [header, ...body] = rows(r.data);
  assertSafeHarbor('outcomes', header, body);
  const phq = body.find(x => x[header.indexOf('Instrument')] === 'PHQ-9');
  assert.ok(phq, String(r.data));
  assert.equal(phq[header.indexOf('Baseline Year')], '2026');
  assert.equal(phq[header.indexOf('Latest Year')], '2026');
  assert.match(phq[header.indexOf('Record Id')], /^R-[0-9A-F]{10}$/);
});
