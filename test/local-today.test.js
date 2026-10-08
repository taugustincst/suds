'use strict';
// "Today" is the programme's date, never the UTC one (evaluation of 1.25.0, E1: after 5pm in California an intake
// was dated tomorrow, CalOMS refused that admission as in the future, and a discharge with no date on that
// evening's episode was refused). The programme here is in a zone whose date differs from the UTC date at the
// moment the test runs, whatever that moment is; CI's evening job (scripts/test-evening.sh) runs the whole suite
// with the local date behind the UTC one.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const LD = require('../server/local-date');

// UTC-12 while the UTC hour is before noon (its date is then yesterday's), else UTC+14 (tomorrow's).
const ZONE = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
const utcToday = () => new Date().toISOString().slice(0, 10);
let nav, navId;
before(async () => {
  await H.start();
  H.db.setSetting('org_timezone', ZONE);
  navId = H.makeCaseloadUser('ltnav', 'navigator').id;
  nav = H.client(); await nav.login('ltnav', 'StaffPassw0rd!x');
});
after(async () => { await H.stop(); });

test('the helpers: today is the programme zone\'s date; an instant is read on its calendar, a bare date kept', () => {
  assert.equal(LD.orgTimezone(), ZONE);
  assert.equal(LD.today(), LD.localDate(new Date(), ZONE));
  assert.notEqual(LD.today(), utcToday(), `${ZONE}'s date differs from the UTC date now`);
  assert.equal(LD.localDate(new Date('2026-09-20T03:00:00Z'), 'America/Los_Angeles'), '2026-09-19', '8pm in Los Angeles');
  assert.equal(LD.dayOf('2026-09-20'), '2026-09-20', 'a date is not moved');
  assert.equal(LD.dayOf(new Date().toISOString()), LD.today());
  assert.equal(LD.dayOf(null), null);
  assert.equal(LD.addDays('2026-03-08', 1), '2026-03-09'); assert.equal(LD.addDays('2026-11-01', -1), '2026-10-31'); assert.equal(LD.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(require('../server/routes/budget').localDate, LD.localDate, 'budget.js re-exports the one helper');
});

test('intake, its episode, a new episode and a discharge with no date are all dated the programme\'s today', async () => {
  const today = LD.today();
  const c = await nav.post('/api/clients', { first_name: 'Evening', last_name: 'Intake', confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const row = H.db.one(`SELECT intake_date FROM clients WHERE id=?`, c.data.id);
  const ep = H.db.one(`SELECT id, opened_at FROM episodes WHERE client_id=?`, c.data.id);
  assert.equal(row.intake_date, today); assert.equal(ep.opened_at, today);
  assert.equal(H.db.one(`SELECT start_date FROM assignments WHERE client_id=? AND user_id=?`, c.data.id, navId).start_date, today);
  // The discharge default was already local (1.24.2), the open default not: "cannot be before the episode was opened".
  const closed = await nav.post(`/api/episodes/${ep.id}/close`, { discharge_reason: 'completed', keep_client_active: true });
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  assert.equal(H.db.one(`SELECT closed_at FROM episodes WHERE id=?`, ep.id).closed_at, today);
  const again = await nav.post(`/api/clients/${c.data.id}/episodes`, {});
  assert.equal(again.status, 201, JSON.stringify(again.data));
  assert.equal(H.db.one(`SELECT opened_at FROM episodes WHERE id=?`, again.data.id).opened_at, today);
});

test('a consent that runs out today is in force all day, and a fatal overdose now is dated today', async () => {
  const today = LD.today();
  const c = (await nav.post('/api/clients', { first_name: 'Evening', last_name: 'Consent', confirm_duplicate: true })).data;
  assert.equal((await nav.post(`/api/clients/${c.id}/consents`, { type: 'roi', signed_at: LD.addDays(today, -30), expires_at: today })).status, 201);
  const got = await nav.get(`/api/clients/${c.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.data.client.active_consents.length, 1, 'still in force on its last day');
  const ev = await nav.post('/api/overdose-events', { client_id: c.id, occurred_at: new Date().toISOString(), kind: 'fatal' });
  assert.equal(ev.status, 201, JSON.stringify(ev.data));
  assert.equal(H.db.one(`SELECT discharge_date FROM clients WHERE id=?`, c.id).discharge_date, today);
});

test('an assignment whose last day is today still opens the client today', () => {
  const today = LD.today();
  const frag = require('../server/auth').activeAssignment('a.');
  assert.ok(frag.includes(`a.end_date >= '${today}'`), frag);
  assert.ok(!/date\('now'\)/.test(frag), 'not SQLite\'s UTC date');
});
