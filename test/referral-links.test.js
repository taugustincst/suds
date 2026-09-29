'use strict';
// Secure referral links (1.17.0; server/referral-links.js, docs/security/REFERRAL-LINKS.md): a referral to an
// organisation that does not use SUDS sent as a one-time link. A packet that names the client needs a live Part 2
// consent naming the recipient (the disclosure gate, at creation and at open) and is accounted when first opened;
// without one only a de-identified "please contact us" notice can go. Tokens are random and stored hashed, the
// packet needs an access code and is claimed by the first browser, links expire and can be revoked, every open is
// audited, and the recipient's acknowledgement closes the loop with a to-do for the worker.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');

let nav, sup, fin, anon, other;
const ELEMENTS = { signed_at: '2026-09-01', scope: 'Referral summary', expires_at: '2099-09-01', signed_on_paper: true, redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true };
const consent = (recipient, extra = {}) => ({ type: 'part2_disclosure', recipient, purpose: 'Referral for treatment', ...ELEMENTS, ...extra });
const tokenOf = (path) => path.split('#')[1];

async function newClient(who = nav) { const r = await who.post('/api/clients', { first_name: 'Link', last_name: `Recipient${Math.random().toString(36).slice(2, 7)}`, dob: '1991-02-03', phone: '555-0142', status: 'active', confirm_duplicate: true }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function resource(name) { const r = await nav.post('/api/resources', { name, category: 'outpatient' }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function addConsent(clientId, body) { const r = await nav.post(`/api/clients/${clientId}/consents`, body); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
async function pendingReferral(clientId, resourceId) { const r = await nav.post('/api/referrals', { client_id: clientId, resource_id: resourceId, referred_at: '2026-09-03T09:00:00Z', status: 'pending', warm_handoff: false }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; }
const lastAudit = (action) => H.db.one(`SELECT * FROM audit_log WHERE action=? ORDER BY id DESC LIMIT 1`, action);

before(async () => {
  await H.start();
  H.makeUser('rl_nav', 'navigator'); H.makeUser('rl_sup', 'supervisor'); H.makeUser('rl_fin', 'finance'); H.makeCaseloadUser('rl_other', 'navigator');
  nav = H.client(); await nav.login('rl_nav', 'StaffPassw0rd!x');
  sup = H.client(); await sup.login('rl_sup', 'StaffPassw0rd!x');
  fin = H.client(); await fin.login('rl_fin', 'StaffPassw0rd!x');
  other = H.client(); await other.login('rl_other', 'StaffPassw0rd!x');
  anon = H.client();
  H.db.setSetting('org_name', 'Riverside Recovery'); H.db.setSetting('program_contact', 'Privacy officer, 555-0100');
});

// Off until an administrator switches it on (market review of the 1.17.0 candidate): the first test sees the
// default and switches it on for the rest.
test('"Secure referral links" is a programme setting, off by default; only an administrator switches it', async () => {
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  assert.equal((await nav.get('/api/referral-links/settings')).data.enabled, false, 'off on a new install (and an upgrade: no setting means off)');
  assert.equal((await nav.get('/api/auth/me')).data.programme.referral_links, false, 'the browser hides the Secure link button');
  const c = await newClient(); const res = await resource('Offswitch Clinic'); const ref = await pendingReferral(c, res);
  const refused = await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' });
  assert.equal(refused.status, 409, JSON.stringify(refused.data)); assert.equal(refused.data.referral_links_off, true);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM referral_links WHERE referral_id=?`, ref).n, 0);
  for (const who of [nav, sup]) assert.equal((await who.put('/api/referral-links/settings', { enabled: true })).status, 403);
  const on = await admin.put('/api/referral-links/settings', { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.data)); assert.equal(on.data.enabled, true);
  const a = JSON.parse(lastAudit('settings.update').details);
  assert.deepEqual(a.changed, ['referral_links_enabled']); assert.equal(a.referral_links_enabled, true);
  assert.equal((await nav.get('/api/auth/me')).data.programme.referral_links, true);
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  // Switched off again, a link already sent stops opening (the same answer as any link that cannot be opened).
  assert.equal((await admin.put('/api/referral-links/settings', { enabled: false })).status, 200);
  const off = await anon.post('/api/referral-links/open', { token: tokenOf(made.data.path) });
  assert.equal(off.status, 404);
  assert.equal((await admin.put('/api/referral-links/settings', { enabled: true })).status, 200);
  assert.equal((await anon.post('/api/referral-links/open', { token: tokenOf(made.data.path) })).status, 200);
});
after(async () => { await H.stop(); });

test('a packet needs a live Part 2 consent that names the recipient; without one only a contact notice can go', async () => {
  const c = await newClient(); const res = await resource('Hillside Clinic'); const ref = await pendingReferral(c, res);
  const none = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet' });
  assert.equal(none.status, 400, JSON.stringify(none.data));
  const elsewhere = await addConsent(c, consent('Someone Else'));
  const wrong = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: elsewhere });
  assert.equal(wrong.status, 409, 'a consent that names another recipient is refused (disclosure.js recipient match)');
  const notice = await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' });
  assert.equal(notice.status, 201, JSON.stringify(notice.data));
  assert.equal(notice.data.code, null, 'a notice has no access code');
  assert.match(notice.data.path, /^\/referral-link\.html#[A-Za-z0-9_-]{43}$/, 'the token travels in the fragment, never the query or the path');
  const row = H.db.one(`SELECT * FROM referral_links WHERE id=?`, notice.data.id);
  assert.equal(row.packet_enc, null, 'a notice holds nothing about the client');
  assert.notEqual(row.token_hash, tokenOf(notice.data.path), 'the token is stored hashed');
  assert.ok(!JSON.stringify(row).includes(tokenOf(notice.data.path)));
  // Opening it names nobody and accounts nothing.
  const opened = await anon.post('/api/referral-links/open', { token: tokenOf(notice.data.path) });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  assert.equal(opened.data.kind, 'contact_notice'); assert.equal(opened.data.packet, undefined);
  assert.ok(!JSON.stringify(opened.data).includes('Link'), 'no client name in the notice');
  assert.equal(opened.data.programme, 'Riverside Recovery'); assert.match(opened.data.reference, /^R-[A-Z2-9]{6}$/);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, c).n, 0, 'no disclosure: nothing identifying left');
});

test('a packet: access code, first-browser claim, accounting at first open, forwarding refused and audited', async () => {
  const c = await newClient(); const res = await resource('Valley Treatment'); const ref = await pendingReferral(c, res);
  const k = await addConsent(c, consent('Valley Treatment'));
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k, message: 'Needs MAT intake this week', include_phone: true, expires_hours: 24 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match(made.data.code, /^\d{6}$/);
  const token = tokenOf(made.data.path);
  const row = H.db.one(`SELECT * FROM referral_links WHERE id=?`, made.data.id);
  assert.match(row.packet_enc, /^v1:/, 'the packet is encrypted'); assert.notEqual(row.code_hash, made.data.code);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, c).n, 0, 'not accounted until it is opened');
  assert.ok(lastAudit('referral_link.create'));
  // Without the code: asked for it; the packet is not sent.
  const ask = await anon.post('/api/referral-links/open', { token });
  assert.equal(ask.status, 200); assert.equal(ask.data.code_required, true); assert.equal(ask.data.packet, undefined);
  const bad = await anon.post('/api/referral-links/open', { token, code: '000000' === made.data.code ? '111111' : '000000' });
  assert.equal(bad.status, 401); assert.equal(bad.data.tries_left, 4);
  const good = await anon.post('/api/referral-links/open', { token, code: made.data.code });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.match(good.data.packet.client.name, /^Link Recipient/); assert.equal(good.data.packet.client.phone, '555-0142');
  assert.equal(good.data.packet.client.dob, undefined, 'date of birth only when the worker ticks it');
  assert.equal(good.data.packet.reason, 'Needs MAT intake this week');
  assert.match(good.data.notice, /42 CFR part 2/i, 'the §2.32 notice travels with the disclosure');
  assert.ok(good.data.claim);
  const d = H.db.one(`SELECT * FROM disclosures WHERE client_id=? AND source='referral_link'`, c);
  assert.ok(d, 'accounted at first open'); assert.equal(d.consent_id, k); assert.equal(d.source_ref, made.data.id); assert.equal(d.basis, 'consent');
  assert.equal(d.disclosed_by, H.db.one(`SELECT id FROM users WHERE username='rl_nav'`).id, 'as the worker who made the link');
  // The same browser (with its claim) may read it again; it is not accounted twice.
  assert.equal((await anon.post('/api/referral-links/open', { token, claim: good.data.claim })).status, 200);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, c).n, 1);
  // A forwarded link, even with the code, is refused in another browser, and that is audited.
  const fwd = await H.client().post('/api/referral-links/open', { token, code: made.data.code });
  assert.equal(fwd.status, 409); assert.equal(fwd.data.packet, undefined);
  assert.match(lastAudit('referral_link.open').details, /claimed_elsewhere/);
  // Audit entries never carry the token, the code or the client's name.
  for (const a of H.db.all(`SELECT details FROM audit_log WHERE action LIKE 'referral_link.%'`)) {
    assert.ok(!String(a.details || '').includes(token) && !String(a.details || '').includes(made.data.code) && !String(a.details || '').includes('Recipient'));
  }
});

test('wrong codes lock the link; unknown, expired and revoked links get the same answer', async () => {
  const c = await newClient(); const res = await resource('Lakeside Detox'); const ref = await pendingReferral(c, res);
  const k = await addConsent(c, consent('Lakeside Detox'));
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k });
  const token = tokenOf(made.data.path); const wrong = made.data.code === '999999' ? '888888' : '999999';
  // A code that is not six digits is a slip, not a guess: refused without using up one of the tries (r10 L6).
  for (const slip of ['12345', '1234567', 'abcdef']) {
    const r = await anon.post('/api/referral-links/open', { token, code: slip });
    assert.equal(r.status, 400); assert.equal(r.data.malformed, true); assert.match(r.data.error, /6 digits/);
  }
  assert.equal(H.db.one(`SELECT failed_attempts FROM referral_links WHERE id=?`, made.data.id).failed_attempts, 0, 'no try used up');
  for (let i = 0; i < 4; i++) assert.equal((await anon.post('/api/referral-links/open', { token, code: wrong })).status, 401);
  const locked = await anon.post('/api/referral-links/open', { token, code: wrong });
  assert.equal(locked.status, 404);
  const after = await anon.post('/api/referral-links/open', { token, code: made.data.code });
  assert.equal(after.status, 404, 'locked even with the right code');
  const unknown = await anon.post('/api/referral-links/open', { token: 'A'.repeat(43) });
  assert.equal(unknown.status, 404); assert.equal(unknown.data.error, after.data.error, 'one message: no oracle for which tokens exist');
  // Expired.
  const m2 = await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' });
  H.db.run(`UPDATE referral_links SET expires_at='2020-01-01T00:00:00.000Z' WHERE id=?`, m2.data.id);
  const exp = await anon.post('/api/referral-links/open', { token: tokenOf(m2.data.path) });
  assert.equal(exp.status, 404); assert.equal(exp.data.error, unknown.data.error);
  // Revoked, by the worker.
  const m3 = await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' });
  const rv = await nav.post(`/api/referral-links/${m3.data.id}/revoke`, {});
  assert.equal(rv.status, 200); assert.equal(rv.data.status, 'revoked');
  assert.equal((await anon.post('/api/referral-links/open', { token: tokenOf(m3.data.path) })).status, 404);
  // Only 24, 72 or 168 hours.
  assert.equal((await nav.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice', expires_hours: 720 })).status, 400);
});

test('a consent revoked after the link was made withholds the packet at open', async () => {
  const c = await newClient(); const res = await resource('Oak Street Services'); const ref = await pendingReferral(c, res);
  const k = await addConsent(c, consent('Oak Street Services'));
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k });
  assert.equal((await nav.post(`/api/consents/${k}/revoke`, { reason: 'Client withdrew consent in person' })).status, 200);
  const r = await anon.post('/api/referral-links/open', { token: tokenOf(made.data.path), code: made.data.code });
  assert.equal(r.status, 200); assert.equal(r.data.withheld, true); assert.equal(r.data.packet, undefined);
  assert.equal(H.db.one(`SELECT COUNT(*) n FROM disclosures WHERE client_id=?`, c).n, 0, 'nothing accounted: nothing went');
  // Revoked after the provider opened it: their own browser's next open is withheld too.
  const k2 = await addConsent(c, consent('Oak Street Services'));
  const m2 = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k2 });
  const first = await anon.post('/api/referral-links/open', { token: tokenOf(m2.data.path), code: m2.data.code });
  assert.ok(first.data.packet && first.data.claim);
  await nav.post(`/api/consents/${k2}/revoke`, { reason: 'Client withdrew consent by phone' });
  const again = await anon.post('/api/referral-links/open', { token: tokenOf(m2.data.path), claim: first.data.claim });
  assert.equal(again.status, 200); assert.equal(again.data.withheld, true); assert.equal(again.data.packet, undefined);
});

test('the recipient acknowledges; the worker gets a to-do and sees the answer; who may make and list links', async () => {
  const c = await newClient(); const res = await resource('Pine Recovery'); const ref = await pendingReferral(c, res);
  const k = await addConsent(c, consent('Pine Recovery'));
  const made = await nav.post(`/api/referrals/${ref}/links`, { kind: 'packet', consent_id: k });
  const token = tokenOf(made.data.path);
  const early = await anon.post('/api/referral-links/ack', { token, status: 'accepted', by: 'Intake, Pine Recovery' });
  assert.equal(early.status, 403, 'a packet is acknowledged only by the browser that opened it');
  const o = await anon.post('/api/referral-links/open', { token, code: made.data.code });
  const ack = await anon.post('/api/referral-links/ack', { token, claim: o.data.claim, status: 'scheduled', by: 'J. Rivera, Pine Recovery intake', note: 'Appointment Tuesday 10am' });
  assert.equal(ack.status, 200, JSON.stringify(ack.data));
  const list = await nav.get(`/api/referrals/${ref}/links`);
  assert.equal(list.status, 200);
  const mine = list.data.rows.find(x => x.id === made.data.id);
  assert.equal(mine.status, 'acknowledged'); assert.equal(mine.ack_status, 'scheduled'); assert.equal(mine.ack_by, 'J. Rivera, Pine Recovery intake'); assert.equal(mine.accounted, true);
  assert.ok(!('token_hash' in mine) && !('code_hash' in mine) && !('packet_enc' in mine), 'the office list never carries the secrets or the packet');
  const task = H.db.one(`SELECT * FROM tasks WHERE referral_id=? AND assigned_to=(SELECT id FROM users WHERE username='rl_nav') ORDER BY created_at DESC LIMIT 1`, ref);
  assert.match(require('../server/crypto').decrypt(task.title_enc), /Pine Recovery scheduled the client/);
  // Permissions: finance holds no referrals permission; a caseload-held worker cannot reach another's client.
  assert.equal((await fin.get(`/api/referrals/${ref}/links`)).status, 403);
  assert.equal((await fin.post(`/api/referrals/${ref}/links`, { kind: 'contact_notice' })).status, 403);
  assert.equal((await other.get(`/api/referrals/${ref}/links`)).status, 403);
  assert.equal((await other.post(`/api/referral-links/${made.data.id}/revoke`, {})).status, 403);
  assert.equal((await anon.get(`/api/referrals/${ref}/links`)).status, 401);
  assert.equal((await sup.post(`/api/referral-links/${made.data.id}/revoke`, {})).status, 200, 'a supervisor may withdraw one');
});

test('the invitation link is an administrator setting, https only', async () => {
  assert.equal((await nav.put('/api/referral-links/settings', { invite_url: 'https://example.org/suds' })).status, 403);
  const admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x');
  assert.equal((await admin.put('/api/referral-links/settings', { invite_url: 'javascript:alert(1)' })).status, 400);
  const ok = await admin.put('/api/referral-links/settings', { invite_url: 'https://example.org/suds' });
  assert.equal(ok.status, 200); assert.equal(ok.data.invite_url, 'https://example.org/suds');
  assert.equal((await nav.get('/api/referral-links/settings')).data.invite_url, 'https://example.org/suds');
});

test('the public routes are rate limited per address', async () => {
  const { rateLimitReset } = require('../server/app');
  let last;
  for (let i = 0; i < 31; i++) last = await anon.post('/api/referral-links/open', { token: 'B'.repeat(43) });
  assert.equal(last.status, 429);
  rateLimitReset('referral-link:127.0.0.1'); rateLimitReset('referral-link:::ffff:127.0.0.1');
});

test('referral links are office-only: not in the device kernel\'s routes, never synchronised', () => {
  const { LOCAL_ROUTE_MODULES, ROUTE_MODULES } = require('../server/app');
  assert.ok(ROUTE_MODULES.includes('referral-links') && !LOCAL_ROUTE_MODULES.includes('referral-links'));
  const S = require('../server/sync-tables');
  assert.ok(S.server_only.includes('referral_links') && !S.tables.some(t => t.name === 'referral_links'));
});
