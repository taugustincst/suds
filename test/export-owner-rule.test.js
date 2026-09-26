'use strict';
// Security review of 1.13.0, finding 4: an export ignored the rule that a record with no client belongs to the
// worker who owns it (sync-tables.js `unlinked`, which crud.js applies to REST and routes/sync.js to devices).
// Navigator 1's calls export held navigator 2's unlinked crisis call while GET /api/calls/:id answered 403;
// to-dos, visits and overdose events used the same `client_id IS NULL OR <caseload>` filter. Each of those
// datasets now takes the same rule from sync-tables.js (clientOrNullScope).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav1, nav2, sup, fin;
const ids = {};
const KINDS = ['calls', 'interventions', 'overdose_events', 'tasks'];
// A de-identified export keeps only the year of a date (Safe Harbor), so a row is told apart by the number of
// rows each person's export holds before and after navigator 2 records one with no client.
const rowsIn = (csv) => (csv.trim() ? csv.trim().split('\n').length - 1 : 0);
const exportOf = async (c, kind) => {
  const r = await c.raw(`/api/reports/export/${kind}?from=2020-01-01&to=2032-12-31`);
  assert.equal(r.status, 200, `${kind} export`);
  return r.text();
};
const counts = {};
const countAll = async (who, c) => { counts[who] = {}; for (const k of KINDS) counts[who][k] = rowsIn(await exportOf(c, k)); };
before(async () => {
  await H.start();
  H.makeUser('eo_nav1', 'navigator'); H.makeUser('eo_nav2', 'navigator'); H.makeUser('eo_sup', 'supervisor'); H.makeUser('eo_fin', 'finance');
  nav1 = H.client(); await nav1.login('eo_nav1', 'StaffPassw0rd!x');
  nav2 = H.client(); await nav2.login('eo_nav2', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('eo_sup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('eo_fin', 'StaffPassw0rd!x');
  for (const [who, c] of [['nav1', nav1], ['nav2', nav2], ['sup', sup], ['fin', fin]]) await countAll(who, c);
  const mk = async (path, body) => { const r = await nav2.post(path, body); assert.equal(r.status, 201, `${path}: ${JSON.stringify(r.data)}`); return r.data.id; };
  const at = new Date(Date.now() - 3600e3).toISOString();
  ids.calls = await mk('/api/calls', { direction: 'inbound', contact_name: 'Zebulon Crisiscaller', phone: '555-9911', summary: 'crisis', started_at: at, crisis: true });
  ids.interventions = await mk('/api/interventions', { occurred_at: at, type: 'outreach', summary: 'Encampment walk, met Zebulon' });
  ids.overdose_events = await mk('/api/overdose-events', { occurred_at: at, kind: 'reversal', notes: 'Bystander Zebulon' });
  ids.tasks = await mk('/api/tasks', { title: 'Call Zebulon back', due_at: '2031-07-19', priority: 'high' });
});
after(() => H.stop());

const REST = { calls: '/api/calls', interventions: '/api/interventions', overdose_events: '/api/overdose-events', tasks: '/api/tasks' };
const grew = async (who, c, kind) => rowsIn(await exportOf(c, kind)) - counts[who][kind];

for (const kind of KINDS) {
  test(`${kind}: another worker's record with no client is in neither their REST view nor their export`, async () => {
    assert.equal((await nav1.get(`${REST[kind]}/${ids[kind]}`)).status, 403, 'REST refuses it');
    assert.equal(await grew('nav1', nav1, kind), 0, 'and the export leaves it out');
  });
  test(`${kind}: its owner and a supervisor still export it`, async () => {
    assert.equal(await grew('nav2', nav2, kind), 1, 'the worker who owns it');
    assert.equal(await grew('sup', sup, kind), 1, 'a supervisor (clients:all)');
  });
}

test('finance (not caseload-scoped, no clients:all) does not export another worker\'s unlinked records either', async () => {
  for (const kind of KINDS) assert.equal(await grew('fin', fin, kind), 0, kind);
});

test('the workbook applies the same rule to every sheet', async () => {
  const r = await nav1.raw('/api/reports/export/workbook?from=2020-01-01&to=2032-12-31');
  assert.equal(r.status, 200);
  const sheets = require('../server/spreadsheet').readWorkbook(Buffer.from(await r.arrayBuffer()));
  const label = { calls: 'Calls', interventions: 'Visits & services', overdose_events: 'Overdose & reversal events', tasks: 'To-dos' };
  for (const kind of KINDS) {
    const sh = sheets.find(s => s.name === label[kind]);
    assert.ok(sh, `${kind} sheet`);
    assert.equal(Math.max(0, sh.rows.length - 1), counts.nav1[kind], `${kind}: the same rows as before navigator 2's record`);
  }
});
