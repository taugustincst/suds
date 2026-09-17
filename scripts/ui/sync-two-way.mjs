// Two-way sync between a device and the office server, end to end in a real browser.
// Every line here used to be a console.log compared to nothing, so this script passed with sync broken.
import { chromium } from 'playwright';
import { makeChecks } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, fail, finish } = makeChecks('sync-two-way');
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));

const browser = await chromium.launch(); const ctx = await browser.newContext(); const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });

const api = (m, p, b) => page.evaluate(([m, p, b]) => window.SUDS_LOCAL.handle(m, p, b, {}).then(r => r.json), [m, p, b]);
const sync = () => api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' });

try {
  // ---- a fresh device sets itself up and syncs for the first time ----
  await page.goto(base + '/?local=1#/'); await page.waitForTimeout(2500);
  ok(await page.$('input[name=username]'), 'the device offers first-run setup');
  await page.fill('input[name=display_name]', 'Dev Two');
  await page.fill('input[name=username]', 'mrivera');
  await page.fill('input[name=password]', 'Navigator2026!!');
  await page.fill('input[name=confirm]', 'Navigator2026!!');
  await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await page.waitForTimeout(500);

  const s1 = await sync();
  ok(s1 && s1.ok, 'the first sync completes', s1 && s1.error);
  ok(s1.pulled.clients > 0, 'the device pulls the office caseload', s1.pulled.clients);
  const me = await api('GET', '/api/auth/me');
  eq(me.user.username, 'mrivera', 'the device account merged into the office account');

  // ---- an office session, for the other half of each exchange ----
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1' }, body: JSON.stringify({ username: 'mrivera', password: 'Navigator2026!!' }) }).then(r => r.json());
  const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Authorization: 'Bearer ' + login.token };
  const list = await fetch(base + '/api/clients?limit=5', { headers: H }).then(r => r.json());
  ok(list.clients.length >= 2, 'the office has at least two clients to work with', list.clients.length);
  const [target, other] = list.clients;

  // ---- office edits one client, the device edits another, offline ----
  const officeGoal = 'Goal set at the office ' + Date.now();
  const phoneGoal = 'Goal set on the phone ' + Date.now();
  await fetch(base + '/api/clients/' + target.id, { method: 'PUT', headers: H, body: JSON.stringify({ goals: officeGoal }) });
  await api('PUT', '/api/clients/' + other.id, { goals: phoneGoal });

  const s2 = await sync();
  ok(s2 && s2.ok, 'the second sync completes', s2 && s2.error);
  eq((s2.rejected || []).length, 0, 'nothing was rejected');

  const devView = await api('GET', '/api/clients/' + target.id);
  eq(devView.client.goals, officeGoal, 'the office edit reached the device');
  const srvView = await fetch(base + '/api/clients/' + other.id, { headers: H }).then(r => r.json());
  eq(srvView.client.goals, phoneGoal, 'the device edit reached the office');

  // ---- a record created on the device, then deleted on the device ----
  const iv = await api('POST', '/api/interventions', { client_id: other.id, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 5 });
  ok(iv && iv.id, 'the device records a visit offline');
  await sync();
  eq(await fetch(base + '/api/interventions/' + iv.id, { headers: H }).then(r => r.status), 200, 'the visit reached the office');

  await api('DELETE', '/api/interventions/' + iv.id, {});
  await sync();
  eq(await fetch(base + '/api/interventions/' + iv.id, { headers: H }).then(r => r.status), 404, 'deleting it on the device deleted it at the office');

  // ---- a note written offline, with its content encrypted at both ends ----
  const body = 'Written offline on the phone.';
  const n = await api('POST', '/api/notes', { client_id: other.id, kind: 'admin', title: 'Offline visit', content: body, occurred_at: new Date().toISOString() });
  await sync();
  const srvNote = await fetch(base + '/api/notes/' + n.id, { headers: H }).then(r => r.json());
  eq(srvNote.note && srvNote.note.content, body, 'the office can read the note written on the phone');
  eq(srvNote.note && srvNote.note.title, 'Offline visit', 'and its title, which is encrypted in transit and at rest');

  // ---- an edit made at the office after the device last pulled must win ----
  const later = 'Office wins ' + Date.now();
  await fetch(base + '/api/clients/' + other.id, { method: 'PUT', headers: H, body: JSON.stringify({ goals: later }) });
  await sync();
  const after = await api('GET', '/api/clients/' + other.id);
  eq(after.client.goals, later, 'an untouched device row takes the office version');

  // ---- nothing left pending after a clean sync ----
  const status = await api('GET', '/api/local/sync/status');
  eq(status.pending, 0, 'no local changes are left unsent after a sync');
} catch (e) {
  fail('threw: ' + (e && e.stack || e));
}

finish(errors);
await browser.close();
