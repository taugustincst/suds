'use strict';
const LD = require('../server/local-date'); // the programme's calendar, as the server dates things
// Usability of navigation (1.14.0): what the API and the shipped pages decide about finding things.
//   * Home's "Naloxone kits given" counts kits on any visit type and opens the visits behind the number
//     (GET /api/interventions?naloxone=1), not only the naloxone-distribution visits;
//   * a client record says how much is in each module (counts.problems/goals/assessments/suprt), so the
//     record shows a module's tab only when it has something in it or the reader may add to it;
//   * the funder report's submission reads one snapshot of the data, as a publication release does;
//   * the words on the buttons: one verb per action across public/ ("Log a visit", "Make a referral",
//     "Clients", "To-dos"), and the sidebar entries for the state reporting modules.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

const PW = 'StaffPassw0rd!x';
let admin, nav, ro, clientId;
const at = () => new Date(Date.now() - 3600000).toISOString();
before(async () => {
  await H.start();
  H.makeCaseloadUser('navux', 'navigator'); H.makeUser('roux', 'readonly');
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  nav = H.client(); await nav.login('navux', PW);
  ro = H.client(); await ro.login('roux', PW);
  clientId = (await nav.post('/api/clients', { first_name: 'Tomas', last_name: 'Ibarra', status: 'active' })).data.id;
});
after(H.stop);

test('Home counts kits on any visit type, and naloxone=1 lists exactly the visits behind that number', async () => {
  const visits = [
    { client_id: clientId, type: 'post_overdose_follow_up', naloxone_kits: 2 }, // a kit on a follow-up
    { client_id: clientId, type: 'naloxone_distribution', naloxone_kits: 1 },
    { client_id: clientId, type: 'naloxone_distribution', naloxone_kits: 0 }, // a distribution visit with nothing given
    { type: 'outreach', naloxone_kits: 3 }, // anonymous street outreach
    { client_id: clientId, type: 'case_management' },
  ];
  for (const v of visits) assert.equal((await nav.post('/api/interventions', { occurred_at: at(), ...v })).status, 201);
  const d = (await nav.get('/api/reports/dashboard')).data;
  assert.equal(d.interventions.naloxone_kits, 6, 'every kit, whatever the visit type');
  const list = (await nav.get('/api/interventions?naloxone=1&limit=100')).data;
  assert.equal(list.rows.length, 3, 'the three visits that handed out a kit');
  assert.ok(list.rows.every(x => x.naloxone_kits > 0));
  assert.equal(list.rows.reduce((n, x) => n + x.naloxone_kits, 0), d.interventions.naloxone_kits, 'they add up to Home\'s number');
  assert.deepEqual([...new Set(list.rows.map(x => x.type))].sort(), ['naloxone_distribution', 'outreach', 'post_overdose_follow_up']);
  // The old link (type=naloxone_distribution) missed the follow-up and the outreach kits.
  const old = (await nav.get('/api/interventions?type=naloxone_distribution&limit=100')).data;
  assert.notEqual(old.rows.reduce((n, x) => n + x.naloxone_kits, 0), d.interventions.naloxone_kits);
  // Without the filter everything is listed, as before.
  assert.equal((await nav.get('/api/interventions?limit=100')).data.rows.length, 5);
});

test('a client record counts what is in each module, for the roles that may read the module', async () => {
  const c = (await nav.get(`/api/clients/${clientId}`)).data.client;
  for (const k of ['problems', 'goals', 'suprt']) assert.equal(c.counts[k], 0, k);
  // A navigator holds careplan but not assessments: that count is not given.
  assert.equal(c.counts.assessments, null);
  const p = await nav.post(`/api/clients/${clientId}/problems`, { problem: 'Housing instability' });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const c2 = (await nav.get(`/api/clients/${clientId}`)).data.client;
  assert.equal(c2.counts.problems, 1);
});

test('the funder report\'s submission is read from one snapshot of the data', async () => {
  const db = require('../server/db');
  const orig = db.readSnapshot; let calls = 0;
  db.readSnapshot = (fn) => { calls++; return orig(fn); };
  try {
    const today = LD.today();
    const r = await admin.get(`/api/reports/funder?from=${today.slice(0, 4)}-01-01&to=${today}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.suppression.purpose, 'submission');
    assert.ok(calls >= 1, 'db.readSnapshot was used');
  } finally { db.readSnapshot = orig; }
});

const PUBLIC = path.join(__dirname, '..', 'public');
const sources = () => [path.join(PUBLIC, 'app.js'), path.join(PUBLIC, 'nav.js'), ...fs.readdirSync(path.join(PUBLIC, 'views')).map(f => path.join(PUBLIC, 'views', f))]
  .map(f => [path.relative(PUBLIC, f), fs.readFileSync(f, 'utf8')]);

test('one verb per action: the old words for logging a visit, making a referral and the client list are gone from public/', () => {
  const banned = [
    [/'\+ Visit'/, '"+ Visit" (say "+ Log a visit")'], [/Record a visit/, '"Record a visit" (say "Log a visit")'],
    [/'New referral'/, '"New referral" (say "Make a referral")'], [/'\+ Referral'/, '"+ Referral" (say "+ Make a referral")'], [/\+ Refer a client/, '"+ Refer a client"'],
    [/label: 'My clients'/, 'a "My clients" menu label (the page is Clients)'], [/pageHead\('My clients'/, 'a "My clients" heading'],
    [/h\('h2', \{\}, 'Today'\)/, 'a "Today" heading for the to-dos card (say "To-dos for today")'],
  ];
  const found = [];
  for (const [file, text] of sources()) for (const [re, what] of banned) if (re.test(text)) found.push(`${file}: ${what}`);
  assert.deepEqual(found, []);
  const all = sources().map(([, t]) => t).join('\n');
  for (const want of ["'Log a visit'", "'+ Log a visit'", "'Make a referral'", "'+ Make a referral'", "label: 'Clients'", "'To-dos for today'"]) assert.ok(all.includes(want), want);
});

test('the sidebar has State reporting and SUPRT-A entries, shown only when the module is on; the funder report is in a front-line worker\'s More', () => {
  // The menu's entries live in nav.js (1.23.0); app.js builds the menu from them.
  const app = fs.readFileSync(path.join(PUBLIC, 'nav.js'), 'utf8');
  const entry = (name) => (app.match(new RegExp(`\\{ name: '${name}',[^\\n]*`)) || [''])[0];
  assert.match(entry('caloms'), /label: 'State reporting'/);
  assert.match(entry('caloms'), /show: \(c\) =>[^\n]*c\.moduleOn\('caloms'\)/);
  assert.match(entry('suprt'), /label: 'SUPRT-A'/);
  assert.match(entry('suprt'), /show: \(c\) => c\.moduleOn\('suprt'\)/);
  assert.match(entry('funder'), /front: 'more'/, 'the funder report folds into More for front-line roles instead of vanishing');
  // Waitlist: in the main list of a treatment-adjacent programme, under More in a harm-reduction one (1.23.0,
  // test/nav-menu.test.js has the placement for every role and profile).
  assert.match(entry('waitlist'), /front: \{ harm_reduction: 'more' \}/);
  assert.match(app, /\(n\.show && !n\.show\(c\)\)/, 'the placement honours show()');
  // Both pages are registered views, so the entries lead somewhere.
  assert.match(fs.readFileSync(path.join(PUBLIC, 'views', 'caloms.js'), 'utf8'), /route\('caloms'/);
  assert.match(fs.readFileSync(path.join(PUBLIC, 'views', 'suprt.js'), 'utf8'), /route\('suprt'/);
});

test('a front-line worker who holds reports:read can run the funder report for their own caseload (what the More entry opens)', async () => {
  const today = LD.today();
  const r = await nav.get(`/api/reports/funder?from=${today.slice(0, 4)}-01-01&to=${today}`);
  assert.equal(r.status, 200);
  assert.notEqual(r.data.suppression.purpose, 'publication', 'an internal run, not a publication release');
  assert.ok(r.data.caseload_scope_note, 'and it says it covers their caseload');
  // Read-only has no clients:read: SUPRT-A (a client-level page) is not for it; the route refuses it too.
  assert.equal((await ro.get('/api/suprt/completion')).status, 403);
});
