'use strict';
// Released in 1.24.0: the public "Security & procurement" page's published facts (GET /api/procurement, the
// procurement_* settings) and the administrator's hardening checklist (GET /api/admin/security/hardening).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers');

let admin, sup, nav;
before(async () => {
  await H.start();
  admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  H.makeUser('pcsup', 'supervisor'); sup = H.client(); await sup.login('pcsup', 'StaffPassw0rd!x');
  H.makeUser('pcnav', 'navigator'); nav = H.client(); await nav.login('pcnav', 'StaffPassw0rd!x');
});
after(() => H.stop());

const FIELDS = ['contact_email', 'contact_name', 'contact_url', 'legal_entity', 'pricing', 'sla'];

test('the procurement facts are public, blank until published, and carry nothing else', async () => {
  // Settings that must never reach someone without an account, set so a leak would show.
  H.db.setSetting('program_contact', 'Privacy officer: Sam Lee, 555-0100');
  H.db.setSetting('org_name', 'North County Outreach');
  const r = await H.client().get('/api/procurement', { 'X-Requested-With': '' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), FIELDS);
  for (const f of FIELDS) assert.equal(r.data[f], null, `${f} is null until an administrator publishes it`);
  const text = JSON.stringify(r.data);
  assert.ok(!/Sam Lee|North County|version|admin/i.test(text), 'no program contact, organization, version or account in it');
});

test('only an administrator may publish them, and each value is checked', async () => {
  const body = { procurement_legal_entity: 'Example Services LLC', procurement_contact_name: 'Sales desk', procurement_contact_email: 'buyers@example.org',
    procurement_contact_url: 'https://example.org/contact', procurement_pricing: 'Evaluation free for 90 days.\nServices quoted per programme.', procurement_sla: 'Business hours support.' };
  for (const c of [sup, nav, H.client()]) assert.ok([401, 403].includes((await c.put('/api/admin/settings', body)).status), 'a supervisor, a navigator or no session may not');
  assert.equal((await H.client().get('/api/procurement')).data.legal_entity, null, 'nothing was stored');
  assert.equal((await admin.put('/api/admin/settings', { procurement_contact_email: 'not an email' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { procurement_contact_url: 'http://example.org' })).status, 400, 'https only');
  assert.equal((await admin.put('/api/admin/settings', { procurement_contact_url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await admin.put('/api/admin/settings', { procurement_legal_entity: 'Two\nlines' })).status, 400, 'a one-line field');
  assert.equal((await admin.put('/api/admin/settings', { procurement_sla: 'x'.repeat(2001) })).status, 400, 'at most 2,000 characters');
  assert.equal((await admin.put('/api/admin/settings', body)).status, 200);
  const r = await H.client().get('/api/procurement');
  assert.equal(r.data.legal_entity, 'Example Services LLC');
  assert.equal(r.data.contact_email, 'buyers@example.org');
  assert.equal(r.data.pricing, 'Evaluation free for 90 days.\nServices quoted per programme.', 'paragraphs kept');
  assert.equal((await admin.get('/api/admin/settings')).data.procurement_sla, 'Business hours support.', 'the Settings form reads them back');
  // Blank clears one again.
  assert.equal((await admin.put('/api/admin/settings', { procurement_contact_name: null })).status, 200);
  assert.equal((await H.client().get('/api/procurement')).data.contact_name, null);
  const a = H.db.one(`SELECT details FROM audit_log WHERE action='settings.update' ORDER BY id DESC LIMIT 1`);
  assert.match(a.details, /procurement_contact_name/);
});

test('the static build ships public/procurement.json with the licensor\'s legal entity, the published pricing, and one repository URL', () => {
  const j = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'procurement.json'), 'utf8'));
  assert.equal(j.legal_entity, 'AugustInnovations LLC', 'the licensor (LICENSE, owner decision of 2026-10-03)');
  assert.match(j.pricing, /90-DAY PILOT — \$2,500 flat/, 'the pilot tier is published');
  assert.match(j.pricing, /PROGRAM — \$4,800 \/ year/, 'the program tier is published');
  assert.match(j.pricing, /MULTI-SITE — \$12,000 \/ year/, 'the multi-site tier is published');
  assert.match(j.pricing, /COUNTY-WIDE — custom/, 'the county-wide tier is published');
  for (const f of ['contact_email', 'contact_name', 'contact_url']) assert.equal(j[f], '', `${f} is blank: the owner supplies it`);
  assert.match(j.sla, /2 business days/, 'the paid-plan support terms are published');
  assert.match(j.repository_url, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  assert.match(j.default_branch, /^[\w./-]+$/);
  // Every document the page links to exists on the default branch's tree (here: this checkout).
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'procurement.html'), 'utf8');
  const docs = [...html.matchAll(/data-doc="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(docs.length >= 10, 'the page links the buyer documents');
  for (const d of docs) assert.ok(fs.existsSync(path.join(__dirname, '..', d)), `${d} exists`);
  assert.ok(!/<script>|\son[a-z]+="/i.test(html), 'no inline script or handler (CSP)');
  assert.ok(!/\bdemo\b|evaluation copy|trial version/i.test(html.replace(/organizations evaluating/i, '')), 'no demo or evaluation wording about SUDS itself');
});

test('the hardening checklist is for administrators only and ticks itself off from the configuration', async () => {
  for (const c of [sup, nav, H.client()]) assert.ok([401, 403].includes((await c.get('/api/admin/security/hardening')).status));
  const get = async () => (await admin.get('/api/admin/security/hardening')).data;
  const item = (s, id) => s.items.find((i) => i.id === id);
  let s = await get();
  for (const i of s.items) {
    assert.ok(i.title && i.why && i.status && i.action && /^#\//.test(i.action.href), `${i.id} says what, why, and where`);
    assert.equal(typeof i.done, 'boolean');
  }
  // The suite runs with MFA_REQUIRED_ROLES='' and nothing configured: these start undone.
  for (const id of ['mfa_privileged', 'backups', 'dr_drill', 'session_idle', 'sign_strong', 'https', 'audit_anchor']) assert.equal(item(s, id).done, false, `${id} starts undone`);
  assert.equal(item(s, 'audit_retention').done, true, 'on by default');
  assert.match(item(s, 'mfa_privileged').action.href, /section=security&field=mfa_required_roles/);
  assert.match(item(s, 'backups').action.href, /field=backup_schedule_hours/);
  assert.equal(s.open, s.items.filter((i) => i.recommended && !i.done).length);

  // Each is computed from the settings: saving them ticks the item off.
  assert.equal((await admin.put('/api/admin/settings', { mfa_required_roles: 'admin,supervisor,navigator', backup_schedule_hours: 4, session_idle_minutes: 15, sign_strong_required: '1', dr_drill_monthly: '1' })).status, 200);
  s = await get();
  assert.equal(item(s, 'mfa_privileged').done, false, 'required now, but the administrator and supervisor have not enrolled');
  assert.match(item(s, 'mfa_privileged').why, /2 administrator or supervisor accounts/);
  assert.equal(item(s, 'backups').done, false, 'scheduled, but with no offsite copy');
  assert.match(item(s, 'backups').action.href, /field=backup_offsite_dir/);
  for (const id of ['session_idle', 'sign_strong', 'dr_drill']) assert.equal(item(s, id).done, true, `${id} done`);
  H.db.run(`UPDATE users SET mfa_enabled=1 WHERE role IN ('admin','supervisor')`);
  assert.equal((await admin.put('/api/admin/settings', { backup_offsite_dir: '/mnt/offsite' })).status, 200);
  s = await get();
  assert.equal(item(s, 'mfa_privileged').done, true);
  assert.equal(item(s, 'backups').done, true);
  // And comes back when someone turns it off again.
  assert.equal((await admin.put('/api/admin/settings', { sign_strong_required: '0', session_idle_minutes: 30 })).status, 200);
  s = await get();
  assert.equal(item(s, 'sign_strong').done, false);
  assert.equal(item(s, 'session_idle').done, false);
  assert.match(item(s, 'session_idle').why, /30 minutes/);
  H.db.run(`UPDATE users SET mfa_enabled=0`);
});

test('the checklist surfaces the host compliance check: no report yet, then the last report\'s result', async () => {
  const s = (await admin.get('/api/admin/security/hardening')).data;
  const c = s.items.find((i) => i.id === 'compliance_check');
  assert.equal(c.done, false);
  assert.equal(c.status, 'no report yet');
  assert.equal(c.recommended, false, 'not nagged about on a server SUDS Server did not install');
});
