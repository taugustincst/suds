// Fingerprint sign-in, signing and approvals with passkeys (docs/FINGERPRINT.md), in Chromium with its WebAuthn
// virtual authenticator standing in for a phone's fingerprint reader (CDP WebAuthn.addVirtualAuthenticator: internal
// transport, resident keys, user verification that succeeds). The office server is opened as http://localhost: a
// passkey belongs to a host name, and a browser refuses an IP address as one (so the rest of the suite, at
// 127.0.0.1, is never offered it).
//   1. The sign-in page offers "Sign in with fingerprint"; a navigator signs in with the password and adds a passkey
//      under My profile (the password again, then the device); the device holds one resident credential.
//   2. With the quick-signing window off, signing a note offers "Confirm with fingerprint"; the note is signed and
//      its verification says the fingerprint evidence checks out; the status line is a live region.
//   3. Signed out, "Sign in with fingerprint" signs straight in (a discoverable passkey); with the device's user
//      verification failing, it is refused and the page says so; after the passkey is removed, it is refused too.
//   4. A supervisor adds a passkey and approves a navigator's submitted time with a fingerprint.
//   5. axe (WCAG 2.1 A/AA) on the sign-in page, My profile, the signature and approval dialogs, at 1280, 390 and
//      320 px; nothing scrolls sideways; the fingerprint buttons are reached by keyboard.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle, strayText } from './assert.mjs';

const require = createRequire(import.meta.url);
const base = (process.env.SUDS_URL || 'http://127.0.0.1:8090').replace('://127.0.0.1', '://localhost');
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('fingerprint');
let axeSource = null;
try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* reported below */ }
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];
const STRUCTURE = ['landmark-one-main', 'landmark-no-duplicate-main', 'landmark-unique', 'page-has-heading-one', 'heading-order', 'empty-heading', 'aria-dialog-name', 'empty-table-header'];
const today = new Date().toISOString().slice(0, 10);

const browser = await chromium.launch();
const errors = [];
function watch(page, who) {
  page.on('pageerror', e => errors.push(`${who} PAGEERROR ${e.message}`));
  page.on('response', r => { if (r.status() >= 500) errors.push(`${who} HTTP ${r.status()} ${r.url()}`); });
}
/** A browser of its own for one person, with a virtual platform authenticator (a phone's fingerprint reader). */
async function device(who, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage(); watch(page, who);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  return { ctx, page, cdp, authenticatorId };
}
const api = (page, method, p, body) => page.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: await r.json().catch(() => null) }; }, [method, p, body]);
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
const toast = (page, re) => until(async () => { const t = await page.$$eval('.toast', e => e.map(x => x.textContent)); return t.find(x => re.test(x)) || null; });
async function signInWithPassword(page, user, pw) {
  await page.goto(base + '/#/login'); await page.waitForSelector('input[name=username]'); await settle(page);
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('#account-panel button[type=submit]');
  // Every role must use two-step verification here (the default), so once an account has a passkey a password
  // sign-in finishes with the fingerprint: the second step (auth.login mfaPending, #/mfa).
  await page.waitForSelector('.layout, [data-fingerprint-mfa]');
  if (!(await page.$('.layout'))) { secondSteps.push(user); await page.click('[data-fingerprint-mfa]'); await page.waitForSelector('.layout'); }
  await api(page, 'PUT', '/api/me/prefs', { tour_done: true, first_day_skip: true, mfa_banner_collapsed: true }); await settle(page);
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
}
async function signOut(page) { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('input[name=username]'); await settle(page); }
async function axe(page, where) {
  if (!axeSource) { fail(`${where}: axe-core is not installed (npm i --no-save playwright axe-core)`); return; }
  await page.evaluate(axeSource + ';0').catch(() => {});
  const v = await page.evaluate(async ({ tags, extra }) => {
    const rules = [...new Set([...window.axe.getRules(tags).map(r => r.ruleId), ...extra])];
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  }, { tags: TAGS, extra: STRUCTURE });
  ok(v.length === 0, `${where}: no WCAG 2.1 A/AA violations`, v);
}
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
/** Tab from the top of the page (or dialog) until `selector` has the focus; true if it is reached. */
async function tabTo(page, selector, max = 40) {
  for (let i = 0; i < max; i++) { await page.keyboard.press('Tab'); if (await page.evaluate((s) => !!document.activeElement && document.activeElement.matches(s), selector)) return true; }
  return false;
}
/** Add a passkey on My profile, as a person does: the button, the password, the device's prompt. */
async function addPasskey(page, pw, name) {
  await go(page, 'profile');
  await page.waitForSelector('[data-passkeys-card]');
  await page.click('[data-passkey-add-open]'); await page.waitForSelector('.modal [data-passkey-add]');
  await page.fill('.modal input[name=name]', name); await page.fill('.modal input[name=password]', pw);
  await page.click('.modal button[type=submit]');
  return toast(page, /Passkey added/);
}

let admin;
const secondSteps = [];
try {
  // An administrator turns the quick-signing window off, so every signature asks for proof (and so offers the fingerprint).
  admin = await device('admin');
  await signInWithPassword(admin.page, 'admin', 'AdminPassw0rd!x');
  eq((await api(admin.page, 'PUT', '/api/admin/settings', { sign_reauth_minutes: 0 })).status, 200, 'the administrator turns the quick-signing window off');

  // ---------------- 1. the sign-in page, and adding a passkey ----------------
  const nav = await device('navigator');
  const P = nav.page;
  await P.goto(base + '/#/login'); await P.waitForSelector('input[name=username]'); await settle(P);
  ok(await until(() => P.$('[data-fingerprint-signin]')), 'the sign-in page offers "Sign in with fingerprint"');
  eq(await P.getAttribute('input[name=username]', 'autocomplete'), 'username webauthn', 'and the username field offers this device\'s passkeys as suggestions (conditional UI)');
  await axe(P, 'sign-in page with fingerprint sign-in (1280)');
  await P.focus('input[name=username]');
  ok(await tabTo(P, '[data-fingerprint-signin]'), 'the fingerprint button is reached with the Tab key');
  await signInWithPassword(P, 'mrivera', PW);
  await go(P, 'profile');
  ok(await until(() => P.$('[data-passkeys-card] [data-passkey-add-open]')), 'My profile has a Fingerprint sign-in card with "Add a passkey on this device"');
  await axe(P, 'My profile with the Fingerprint sign-in card (1280)');
  { const st = await strayText(P); ok(st.length === 0, 'My profile shows no stray "null" or "undefined"', st); }
  await P.click('[data-passkey-add-open]'); await P.waitForSelector('.modal [data-passkey-add]'); await settle(P);
  eq(await P.evaluate(() => document.activeElement && document.activeElement.name), 'name', 'the Add a passkey dialog puts the focus on its first field');
  await axe(P, 'Add a passkey dialog (1280)');
  await P.fill('.modal input[name=password]', 'Wrong-Passw0rd!!'); await P.click('.modal button[type=submit]');
  ok(await until(async () => /incorrect|failed|not right/i.test(await P.textContent('.modal').catch(() => ''))), 'a wrong password is refused in the dialog');
  await P.fill('.modal input[name=name]', 'Maria’s test phone'); await P.fill('.modal input[name=password]', PW); await P.click('.modal button[type=submit]');
  ok(await toast(P, /Passkey added/), 'with the right password the device makes the passkey and SUDS says so');
  ok(await until(async () => /Maria’s test phone/.test(await P.textContent('[data-passkeys-card]'))), 'and it is listed under its name');
  const creds = (await nav.cdp.send('WebAuthn.getCredentials', { authenticatorId: nav.authenticatorId })).credentials;
  eq(creds.length, 1, 'the device holds one passkey');
  ok(creds[0] && creds[0].isResidentCredential, 'a discoverable (resident) one, so sign-in needs no username');
  const me = (await api(P, 'GET', '/api/auth/me')).data.user;
  eq(me.passkeys, 1, 'the account has one passkey');

  // ---------------- 2. signing a note with the fingerprint ----------------
  const clients = (await api(P, 'GET', '/api/clients?limit=1')).data;
  const clientId = (clients.rows || clients.clients || [])[0].id;
  const note = await api(P, 'POST', '/api/notes', { client_id: clientId, kind: 'admin', title: 'Fingerprint test', content: 'Met at the drop-in centre; signed with a fingerprint.', occurred_at: new Date().toISOString() });
  eq(note.status, 201, 'a draft note to sign');
  await go(P, `notes/${note.data.id}`);
  await P.waitForSelector('.modal button:has-text("Sign & lock")'); await P.click('.modal button:has-text("Sign & lock")');
  await P.waitForSelector('[data-signature-dialog] [data-fingerprint]'); await settle(P);
  ok(await P.$('[data-signature-dialog] input[name=password]'), 'the signature dialog still takes the password');
  ok(await P.$('[data-fingerprint-status][role=status][aria-live=polite]'), 'its fingerprint status line is a polite live region');
  await axe(P, 'signature dialog with "Confirm with fingerprint" (1280)');
  await P.focus('[data-signature-dialog] input[name=password]');
  ok(await tabTo(P, '[data-signature-dialog] [data-fingerprint]', 10), 'the fingerprint button follows the password field in the Tab order');
  await P.keyboard.press('Enter');
  ok(await toast(P, /Note signed and locked/), 'Enter on the fingerprint button signs the note');
  const signed = await api(P, 'GET', `/api/notes/${note.data.id}/verify`);
  ok(signed.data.intact && signed.data.fingerprint && signed.data.fingerprint.verified, 'the note is signed, and its fingerprint evidence verifies', signed.data);

  // ---------------- 3. sign in with the fingerprint; refused without user verification; refused once removed ----------------
  // Signed out, the username field's suggestions (conditional UI) offer the passkey; Chromium's virtual authenticator
  // picks it at once, as a person tapping the suggestion would.
  await signOut(P);
  ok(await P.waitForSelector('.layout', { timeout: 15000 }).catch(() => null), 'signed out, the passkey suggested in the username field (conditional UI) signs straight back in');
  eq((await api(P, 'GET', '/api/auth/me')).data.user.username, 'mrivera', 'as the passkey\'s owner');
  // The button, in a browser without those suggestions.
  await nav.ctx.addInitScript(() => { if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
  await P.reload(); await P.waitForSelector('.layout'); await settle(P);
  await signOut(P);
  await P.click('[data-fingerprint-signin]');
  ok(await P.waitForSelector('.layout', { timeout: 15000 }).catch(() => null), '"Sign in with fingerprint" signs straight in with no username or password');
  eq((await api(P, 'GET', '/api/auth/me')).data.user.username, 'mrivera', 'as the passkey\'s owner');
  await signOut(P);
  await nav.cdp.send('WebAuthn.setUserVerified', { authenticatorId: nav.authenticatorId, isUserVerified: false });
  await P.click('[data-fingerprint-signin]');
  const refused = await until(async () => { const t = await P.$eval('[data-fingerprint-login] [data-fingerprint-status]', e => e.textContent).catch(() => ''); return t && !/Waiting/.test(t) ? t : null; }, { timeout: 15000 });
  ok(refused, 'when the device cannot verify the person (no fingerprint), sign-in is refused and the page says why', refused);
  ok(!(await P.$('.layout')), 'and nobody is signed in');
  await nav.cdp.send('WebAuthn.setUserVerified', { authenticatorId: nav.authenticatorId, isUserVerified: true });
  await signInWithPassword(P, 'mrivera', PW);
  await go(P, 'profile'); await P.waitForSelector('[data-passkey-remove]');
  await P.click('[data-passkey-remove]'); await P.waitForSelector('.modal [data-passkey-remove]');
  await axe(P, 'Remove passkey dialog (1280)');
  await P.fill('.modal input[name=password]', PW); await P.click('.modal button[type=submit]');
  ok(await toast(P, /Removed/), 'the passkey is removed (with the password)');
  ok(await until(() => P.$('[data-passkeys-none]')), 'and the card says there are none');
  { const st = await strayText(P); ok(st.length === 0, 'with no passkey, My profile shows no stray "null" or "undefined"', st); }
  await signOut(P);
  await P.click('[data-fingerprint-signin]');
  const gone = await until(async () => { const t = await P.$eval('[data-fingerprint-login] [data-fingerprint-status]', e => e.textContent).catch(() => ''); return t && !/Waiting/.test(t) ? t : null; }, { timeout: 15000 });
  ok(gone && /not registered/.test(gone), 'the device still has it, but SUDS no longer accepts it', gone);

  // ---------------- 4. a supervisor approves time with the fingerprint ----------------
  await signInWithPassword(P, 'mrivera', PW);
  ok(secondSteps.includes('mrivera'), 'while the navigator had a passkey, a password sign-in finished with the fingerprint (two-step verification)');
  const t = await api(P, 'POST', '/api/time', { work_date: today, minutes: 45, category: 'documentation' });
  eq(t.status, 201, 'the navigator logs time');
  eq((await api(P, 'POST', `/api/time/${t.data.id}/submit`, {})).status, 200, 'and submits it');
  const sup = await device('supervisor', { width: 390, height: 844 });
  const S = sup.page;
  await signInWithPassword(S, 'jwalker', PW);
  ok(await addPasskey(S, PW, 'Supervisor phone'), 'the supervisor adds a passkey on their phone');
  await go(S, 'supervision');
  const approveBtn = S.locator(`button[aria-label^="Approve"]`).first();
  await approveBtn.waitFor();
  await approveBtn.click();
  await S.waitForSelector('[data-approval-proof] [data-fingerprint]'); await settle(S);
  ok(await S.$('[data-approve-without-fingerprint]'), 'approving offers the fingerprint, and approving without it (not required by this programme)');
  await axe(S, 'approval dialog with "Confirm with fingerprint" (390)');
  ok(await noSideScroll(S), 'the approval dialog does not scroll sideways at 390 px');
  await S.click('[data-approval-proof] [data-fingerprint]');
  ok(await toast(S, /approved/), 'the fingerprint approves the time');
  const entry = await api(P, 'GET', `/api/time/${t.data.id}`);
  eq((entry.data.row || entry.data).status, 'approved', 'the entry is approved');

  // ---------------- 5. phone widths ----------------
  for (const width of [390, 320]) {
    const d = await device(`phone ${width}`, { width, height: 844 });
    await d.page.goto(base + '/#/login'); await d.page.waitForSelector('[data-fingerprint-signin]'); await settle(d.page);
    await axe(d.page, `sign-in page with fingerprint sign-in (${width})`); ok(await noSideScroll(d.page), `the sign-in page does not scroll sideways at ${width} px`);
    await signInWithPassword(d.page, width === 390 ? 'kpatel' : 'dchen', PW);
    await go(d.page, 'profile'); await d.page.waitForSelector('[data-passkeys-card]');
    await axe(d.page, `My profile with the Fingerprint sign-in card (${width})`); ok(await noSideScroll(d.page), `My profile does not scroll sideways at ${width} px`);
    if (width === 390) ok(await addPasskey(d.page, PW, 'Clinician phone'), 'a clinician adds a passkey at 390 px');
    await d.page.evaluate(async () => { (await import('./views/notes.js')).signatureDialog({ title: 'Electronic signature', submitText: 'Sign note', intro: 'By signing you attest that this documentation is accurate and complete.', send: async () => {}, passkey: { purpose: 'note.sign', params: { note_id: 'x' } } }); });
    await d.page.waitForSelector('[data-signature-dialog]'); await settle(d.page);
    if (width === 390) ok(await d.page.$('[data-signature-dialog] [data-fingerprint]'), 'with a passkey, the signature dialog offers the fingerprint on a phone');
    await axe(d.page, `signature dialog (${width})`); ok(await noSideScroll(d.page), `the signature dialog does not scroll sideways at ${width} px`);
    await d.ctx.close();
  }
  await sup.ctx.close(); await nav.ctx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
  if (admin) { await api(admin.page, 'PUT', '/api/admin/settings', { sign_reauth_minutes: null }).catch(() => {}); await admin.ctx.close(); }
}
finish(errors);
await browser.close();
