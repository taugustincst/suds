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
//   4. A supervisor adds a passkey, chooses to confirm approvals with it, and approves a navigator's submitted time
//      with a fingerprint (no "without fingerprint" button).
//   5. axe (WCAG 2.1 A/AA) on the sign-in page, My profile, the signature and approval dialogs, at 1280, 390 and
//      320 px; nothing scrolls sideways; the fingerprint buttons are reached by keyboard.
//   6. The review's fixes (docs/FINGERPRINT.md): the second step on a device without the passkey offers the way back
//      and no code field; a failed fingerprint gives the focus back to its button, enabled; with fingerprint-or-code
//      required and neither set up, the signature dialog has no Sign button and links to My profile; a single sign-on
//      account sees the fingerprint beside "Confirm with single sign-on"; the icon is an SVG hidden from screen readers.
//   7. The authenticator allow-list (released in 1.21.0): an administrator loads a FIDO Metadata Service file signed under
//      the TEST-ONLY root (test/fixtures/fido-mds, trusted by the dev server only), picks a model from it, sees whose
//      passkeys would stop working, must confirm that, and saves with the password again; the supervisor's older
//      passkey is marked not accepted on My profile and refused at sign-in with the reason; a passkey the virtual
//      authenticator makes cannot prove a listed model and is refused with the reason; axe and no sideways scroll.
//   8. The allow-list's grace period (released in 1.22.0): the card says synced passkeys cannot be added while it is on
//      and offers a grace period of 14 days; the preview says when each passkey stops and lists apart the accounts
//      whose only second factor stops; saved, the supervisor's passkey keeps working, the supervisor is told the date
//      on every page and on My profile; saved again with 0 days, it stops at once (7's checks).
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
// `passkeyReturns`: the virtual authenticator answers the username field's passkey suggestion (conditional UI) at once,
// so the sign-in page can be gone before it is ever seen (a CI run waited 30 s for it): then the caller checks the
// sign-in that follows instead of the sign-in page.
async function signOut(page, { passkeyReturns = false } = {}) {
  await page.evaluate(async () => (await import('./app.js')).logout());
  if (!passkeyReturns) await page.waitForSelector('input[name=username]');
  await settle(page);
}
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
  return toast(page, /Fingerprint sign-in added/);
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
  ok(!/☝/.test(await P.textContent('[data-fingerprint-login]')) && !!(await P.$('[data-fingerprint-signin] svg.fp-icon[aria-hidden=true]')), 'its icon is an SVG hidden from screen readers, not a glyph read aloud');
  eq(await P.getAttribute('input[name=username]', 'autocomplete'), 'username webauthn', 'and the username field offers this device\'s passkeys as suggestions (conditional UI)');
  await axe(P, 'sign-in page with fingerprint sign-in (1280)');
  await P.focus('input[name=username]');
  ok(await tabTo(P, '[data-fingerprint-signin]'), 'the fingerprint button is reached with the Tab key');
  await signInWithPassword(P, 'mrivera', PW);
  await go(P, 'profile');
  ok(await until(() => P.$('[data-passkeys-card] [data-passkey-add-open]')), 'My profile has a Fingerprint sign-in card with "Add fingerprint sign-in on this device"');
  ok(await P.$('[data-mfa-required-note]'), 'before it, My profile says the role requires two-step verification');
  await axe(P, 'My profile with the Fingerprint sign-in card (1280)');
  { const st = await strayText(P); ok(st.length === 0, 'My profile shows no stray "null" or "undefined"', st); }
  await P.click('[data-passkey-add-open]'); await P.waitForSelector('.modal [data-passkey-add]'); await settle(P);
  eq(await P.evaluate(() => document.activeElement && document.activeElement.name), 'name', 'the Add a passkey dialog puts the focus on its first field');
  await axe(P, 'Add a passkey dialog (1280)');
  await P.fill('.modal input[name=password]', 'Wrong-Passw0rd!!'); await P.click('.modal button[type=submit]');
  ok(await until(async () => /incorrect|failed|not right/i.test(await P.textContent('.modal').catch(() => ''))), 'a wrong password is refused in the dialog');
  await P.fill('.modal input[name=name]', 'Maria’s test phone'); await P.fill('.modal input[name=password]', PW); await P.click('.modal button[type=submit]');
  ok(await toast(P, /Fingerprint sign-in added/), 'with the right password the device makes the passkey and SUDS says so');
  ok(await until(async () => /Maria’s test phone/.test(await P.textContent('[data-passkeys-card]'))), 'and it is listed under its name');
  ok(await until(() => P.$('[data-passkeys-card] [data-passkey-here]')), 'marked as the one on this device');
  ok(await until(async () => !(await P.$('[data-mfa-required-note]')) && !!(await P.$('[data-mfa-by-passkey]'))), 'the two-step verification card updates at once: it counts, and an authenticator app is recommended as well');
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
  ok(await P.$('[data-signature-dialog] [data-or-use] input[name=password]'), 'the signature dialog still takes the password, under "Or use your password"');
  ok(await P.$('[data-fingerprint-status][role=status][aria-live=polite]'), 'its fingerprint status line is a polite live region');
  ok(await P.evaluate(() => !!document.activeElement && document.activeElement.matches('[data-fingerprint]')), 'the fingerprint button comes first and has the focus');
  eq(await P.$$eval('[data-signature-dialog] button.primary', b => b.filter(x => !x.hidden).length), 1, 'one primary button: the fingerprint');
  ok(await P.evaluate(() => { const fp = document.querySelector('[data-signature-dialog] [data-fingerprint]'); const pw = document.querySelector('[data-signature-dialog] input[name=password]'); return !!(fp.compareDocumentPosition(pw) & Node.DOCUMENT_POSITION_FOLLOWING); }), 'the password comes after it');
  await axe(P, 'signature dialog with "Confirm with fingerprint" (1280)');
  await P.focus('[data-signature-dialog] [data-fingerprint]');
  ok(await tabTo(P, '[data-signature-dialog] input[name=password]', 10), 'the password field follows the fingerprint button in the Tab order');
  // A fingerprint that fails (the device cannot verify the person): the focus comes back to the button, enabled again.
  await nav.cdp.send('WebAuthn.setUserVerified', { authenticatorId: nav.authenticatorId, isUserVerified: false });
  await P.click('[data-signature-dialog] [data-fingerprint]');
  const failedSig = await until(async () => { const t = await P.$eval('[data-signature-dialog] [data-fingerprint-status]', e => e.textContent).catch(() => ''); return t && !/Waiting/.test(t) ? t : null; }, { timeout: 15000 });
  ok(failedSig, 'a fingerprint the device could not verify is refused, and the dialog says why', failedSig);
  ok(await P.evaluate(() => { const b = document.activeElement; return !!b && b.matches('[data-fingerprint]') && b.getAttribute('aria-disabled') !== 'true' && !b.disabled; }), 'and the focus is back on the fingerprint button, which works again');
  await nav.cdp.send('WebAuthn.setUserVerified', { authenticatorId: nav.authenticatorId, isUserVerified: true });
  await P.keyboard.press('Enter');
  ok(await toast(P, /Note signed and locked/), 'Enter on the fingerprint button signs the note');
  const signed = await api(P, 'GET', `/api/notes/${note.data.id}/verify`);
  ok(signed.data.intact && signed.data.fingerprint && signed.data.fingerprint.verified, 'the note is signed, and its fingerprint evidence verifies', signed.data);

  // ---------------- 3. sign in with the fingerprint; refused without user verification; refused once removed ----------------
  // Signed out, the username field's suggestions (conditional UI) offer the passkey; Chromium's virtual authenticator
  // picks it at once, as a person tapping the suggestion would.
  await signOut(P, { passkeyReturns: true });
  // Signed back in when the office says so (not when a page drawn before the sign-out is still showing).
  const back = await until(async () => { const r = await api(P, 'GET', '/api/auth/me').catch(() => null); return r && r.status === 200 && r.data && r.data.user ? r.data.user : null; }, { timeout: 15000 });
  ok(back && await P.waitForSelector('.layout', { timeout: 15000 }).catch(() => null), 'signed out, the passkey suggested in the username field (conditional UI) signs straight back in');
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
  ok(gone && /No fingerprint sign-in for SUDS was found on this device/.test(gone), 'the device still has it, but SUDS no longer accepts it, and says so plainly', gone);

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
  await S.waitForSelector('[data-approve-with-fingerprint]');
  await S.check('[data-approve-with-fingerprint]');
  ok(await toast(S, /confirm approvals with your fingerprint/), 'and chooses to confirm approvals with it (My profile)');
  await S.evaluate(async () => (await import('./app.js')).prefs.flush());
  // Outside the quick-signing window (the administrator set it to 0 above), so the fingerprint is asked for.
  await go(S, 'supervision');
  const approveBtn = S.locator(`button[aria-label^="Approve"]`).first();
  await approveBtn.waitFor();
  await approveBtn.click();
  await S.waitForSelector('[data-approval-proof] [data-fingerprint]'); await settle(S);
  ok(!(await S.$('[data-approve-without-fingerprint]')), 'no "approve without fingerprint" button: the person asked for this');
  ok(await S.evaluate(() => !!document.activeElement && document.activeElement.matches('[data-approval-proof] [data-fingerprint]')), 'the fingerprint button has the focus');
  await axe(S, 'approval dialog with "Confirm with fingerprint" (390)');
  ok(await noSideScroll(S), 'the approval dialog does not scroll sideways at 390 px');
  await S.click('[data-approval-proof] [data-fingerprint]');
  ok(await toast(S, /approved/), 'the fingerprint approves the time');
  const entry = await api(P, 'GET', `/api/time/${t.data.id}`);
  eq((entry.data.row || entry.data).status, 'approved', 'the entry is approved');

  // ---------------- 6. the review's fixes ----------------
  // The second step on a device without the passkey: the way back, and no code field for an account with no authenticator app.
  {
    const bare = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const B = await bare.newPage(); watch(B, 'no passkey here');
    await B.addInitScript(() => { if (window.PublicKeyCredential) window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false; });
    await B.goto(base + '/#/login'); await B.waitForSelector('input[name=username]'); await settle(B);
    await B.fill('input[name=username]', 'jwalker'); await B.fill('input[name=password]', PW); await B.click('#account-panel button[type=submit]');
    await B.waitForSelector('[data-no-passkey-here]'); await settle(B);
    ok(!(await B.$('input[name=code]')), 'the second step asks no code of an account without an authenticator app');
    ok(!(await B.$('[data-fingerprint-mfa]')), 'nor offers a fingerprint this device cannot give');
    ok(await B.$eval('[data-no-passkey-here]', e => e.open && /administrator to reset your two-step verification/.test(e.textContent)), '"No fingerprint sign-in on this device?" is open and says how to get back in');
    await axe(B, 'second step without the passkey on this device (1280)');
    await bare.close();
  }
  // Required, and nothing set up: no Sign button, a link to My profile.
  eq((await api(admin.page, 'PUT', '/api/admin/settings', { sign_strong_required: '1' })).status, 200, 'the administrator requires a fingerprint or code for signing');
  {
    const d = await device('nothing set up');
    await signInWithPassword(d.page, 'dchen', PW);
    await d.page.evaluate(async () => { (await import('./views/notes.js')).signatureDialog({ title: 'Electronic signature', submitText: 'Sign note', intro: 'By signing you attest that this documentation is accurate and complete.', send: async () => {}, passkey: { purpose: 'note.sign', params: { note_id: 'x' } } }); });
    await d.page.waitForSelector('[data-signature-dialog] [data-strong-required]'); await settle(d.page);
    ok(!(await d.page.$('[data-signature-dialog] button[type=submit]')), 'with neither a fingerprint nor a code set up, there is no Sign button');
    ok(await d.page.$('[data-signature-dialog] a[href="#/profile"][data-strong-setup-link]'), 'and a link to My profile to set one up');
    await axe(d.page, 'signature dialog, required and nothing set up (1280)');
    await d.ctx.close();
  }
  await api(admin.page, 'PUT', '/api/admin/settings', { sign_strong_required: null });
  // Single sign-on: the fingerprint beside "Confirm with single sign-on".
  await S.evaluate(async () => { (await import('./views/notes.js')).signatureDialog({ title: 'Electronic signature', submitText: 'Sign note', intro: 'By signing you attest that this documentation is accurate and complete.', send: async () => {}, passkey: { purpose: 'note.sign', params: { note_id: 'x' } }, preview: { recent: false, method: 'sso', sso: true, passkey: true } }); });
  await S.waitForSelector('[data-signature-dialog] [data-sso-reauth]'); await settle(S);
  ok(await S.$('[data-signature-dialog] [data-fingerprint]'), 'a single sign-on account is offered the fingerprint beside "Confirm with single sign-on"');
  await axe(S, 'signature dialog, single sign-on or fingerprint (390)');
  await S.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));

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
  // ---------------- 7. the authenticator allow-list (released in 1.21.0) ----------------
  {
    const A = admin.page;
    const X = require('../../test/x509.js');
    const rootPem = fs.readFileSync(new URL('../../test/fixtures/fido-mds/TEST-ONLY-mds-root.pem', import.meta.url), 'utf8');
    const rootKey = fs.readFileSync(new URL('../../test/fixtures/fido-mds/TEST-ONLY-mds-root.key.pem', import.meta.url), 'utf8');
    const crypto = require('node:crypto');
    const root = { der: new crypto.X509Certificate(rootPem).raw, keys: { privateKey: crypto.createPrivateKey(rootKey) }, subject: [['C', 'US'], ['O', 'SUDS tests'], ['CN', 'SUDS TEST-ONLY FIDO MDS root']] };
    const maker = X.ca('SUDS browser-suite maker root');
    const MODEL = 'b1eb1eb1-0000-4000-8000-00000000f1f1';
    const blob = X.mdsBlob({ payload: { no: 1000 + Math.floor(Date.now() / 1000) % 100000, nextUpdate: '2099-12-31', legalHeader: 'test', entries: [X.mdsEntry({ aaguid: MODEL, description: 'SUDS browser-suite key', roots: [maker.der] })] }, ...X.mdsSigner(root) });
    await go(A, 'admin?tab=settings');
    await A.waitForSelector('[data-allowlist-card]'); await settle(A);
    ok(/Off/.test(await A.textContent('[data-allowlist-card] dl')), 'Settings has the authenticator allow-list card, off by default');
    await axe(A, 'Settings with the authenticator allow-list card (1280)');
    // Load the metadata file: the file, then the password again.
    await A.setInputFiles('[data-allowlist-card] input[name=blob_file]', { name: 'blob.jwt', mimeType: 'application/jwt', buffer: Buffer.from(blob) });
    await A.click('[data-allowlist-card] form:has(input[name=blob_file]) button[type=submit]');
    await A.waitForSelector('[data-signature-dialog] input[name=password]'); await settle(A);
    await axe(A, 'allow-list: the password again to load the metadata file (1280)');
    await A.fill('[data-signature-dialog] input[name=password]', 'AdminPassw0rd!x'); await A.click('[data-signature-dialog] button[type=submit]');
    ok(await toast(A, /Metadata file number \d+ loaded: 1 authenticator model/), 'the metadata file is loaded and SUDS says what it holds');
    await A.waitForSelector('[data-allowlist-card] select[name=catalog_pick]'); await settle(A);
    // Choose the model from the file, turn the list on, check who is affected.
    await A.selectOption('[data-allowlist-card] select[name=catalog_pick]', MODEL);
    ok((await A.inputValue('[data-allowlist-card] textarea[name=models]')).includes(MODEL), 'choosing a model from the metadata file adds it to the list');
    await A.selectOption('[data-allowlist-card] select[name=enabled]', '1');
    // 8. The grace period, and what the card says of synced passkeys.
    const synced = await A.textContent('[data-allowlist-card] [data-allowlist-synced]');
    ok(/cannot be added while the list is on/.test(synced) && /iCloud Keychain/.test(synced) && /Google Password Manager/.test(synced), 'the card says synced passkeys (iCloud Keychain, Google Password Manager) cannot be added while the list is on', synced);
    eq(await A.inputValue('[data-allowlist-card] input[name=grace_days]'), '14', 'the grace period is 14 days unless the administrator chooses');
    eq(await A.getAttribute('[data-allowlist-card] input[name=grace_days]', 'max'), '90', 'and at most 90');
    await A.click('[data-allowlist-check]');
    const affected = await until(async () => { const n = await A.getAttribute('[data-allowlist-preview] [data-affected-count]', 'data-affected-count').catch(() => null); return n === null ? null : Number(n); });
    ok(affected >= 1, 'before saving, the administrator sees how many passkeys would stop working', affected);
    ok(/jwalker/.test(await A.textContent('[data-allowlist-preview]')), 'and whose: the supervisor\'s passkey, added before the list, is listed');
    ok(await A.$('[data-allowlist-preview][role=status][aria-live=polite]'), 'the preview is a polite live region');
    const graceUntil = await A.getAttribute('[data-allowlist-preview] [data-affected-count]', 'data-grace-until');
    ok(graceUntil && Math.abs(Date.parse(graceUntil) - (Date.now() + 14 * 86400000)) < 5 * 60_000, 'the preview says the passkeys stop 14 days from now', graceUntil);
    ok(/after a grace period ending/.test(await A.textContent('[data-allowlist-preview] [data-affected-count]')), 'in words');
    eq(await A.$$eval('[data-allowlist-preview] [data-stops-at=now]', e => e.length), 0, 'none of them stops at once');
    const pv14 = (await api(A, 'POST', '/api/admin/authenticator-allowlist/preview', { enabled: true, models: [{ name: 'SUDS browser-suite key', aaguid: MODEL }], grace_days: 14 })).data.affected;
    const onlyShown = Number(await A.getAttribute('[data-allowlist-preview] [data-allowlist-only-factor]', 'data-allowlist-only-factor').catch(() => '0'));
    eq(onlyShown, pv14.only_factor_count, 'the accounts whose only second factor stops are listed apart, as many as the server counts');
    if (pv14.only_factor_count) ok(/no other second factor/.test(await A.textContent('[data-allowlist-only-factor]')) && /authenticator-app code, or a new passkey on an accepted authenticator/.test(await A.textContent('[data-allowlist-only-factor]')), 'with what they will need');
    await axe(A, 'allow-list with who would be affected and when (1280)');
    // Saving without confirming is refused at the checkbox; confirming asks for the password again.
    await A.click('[data-allowlist-card] form:has(textarea[name=models]) button[type=submit]');
    ok(await until(async () => /confirm that you have checked who is affected/i.test(await A.textContent('[data-allowlist-card] [data-field=acknowledge]'))), 'saving without confirming who is affected is refused, at the checkbox');
    await A.check('[data-allowlist-card] input[name=acknowledge]');
    await A.click('[data-allowlist-card] form:has(textarea[name=models]) button[type=submit]');
    await A.waitForSelector('[data-signature-dialog] input[name=password]');
    await A.fill('[data-signature-dialog] input[name=password]', 'AdminPassw0rd!x'); await A.click('[data-signature-dialog] button[type=submit]');
    ok(await toast(A, /allow-list on: 1 model.*refused passkeys stop on/), 'the list is turned on with the password again, and the toast says when refused passkeys stop');
    eq((await api(A, 'GET', '/api/admin/authenticator-allowlist')).data.enabled, true, 'and is on');
    // In the grace period: the supervisor's passkey still works, and the supervisor is told when it stops.
    await S.reload(); await S.waitForSelector('.layout'); await settle(S);
    const graceBanner = await until(async () => S.textContent('#banners [data-banner="passkey-grace"]').catch(() => null));
    ok(graceBanner && /stops working on|stop working on/.test(graceBanner) && /add a passkey on an accepted authenticator/.test(graceBanner), 'every page tells the supervisor when the passkey stops and what to do', graceBanner);
    ok(await S.$('#banners [data-banner="passkey-grace"] a[href="#/profile"]'), 'with a link to My profile');
    await go(S, 'profile'); await S.waitForSelector('[data-passkeys-card] [data-passkey-grace-notice]');
    ok(await S.$('[data-passkey-stops]'), 'My profile marks the passkey with the date it stops');
    ok(!(await S.$('[data-passkey-not-accepted]')), 'and not as refused yet');
    await axe(S, 'My profile in the allow-list grace period (390)');
    ok(await noSideScroll(S), 'My profile with the grace notice does not scroll sideways at 390 px');
    { const st = await strayText(S); ok(st.length === 0, 'the grace notice shows no stray "null" or "undefined"', st); }
    // Saved again with a grace period of 0 days: it stops at once.
    await go(A, 'admin?tab=settings'); await A.waitForSelector('[data-allowlist-card] input[name=grace_days]'); await settle(A);
    await A.fill('[data-allowlist-card] input[name=grace_days]', '0');
    await A.click('[data-allowlist-check]');
    ok(await until(async () => (await A.$$eval('[data-allowlist-preview] [data-stops-at]', e => e.map(x => x.getAttribute('data-stops-at')))).includes('now')), 'with 0 days the preview says the passkeys stop at once');
    await A.check('[data-allowlist-card] input[name=acknowledge]');
    await A.click('[data-allowlist-card] form:has(textarea[name=models]) button[type=submit]');
    await A.waitForSelector('[data-signature-dialog] input[name=password]');
    await A.fill('[data-signature-dialog] input[name=password]', 'AdminPassw0rd!x'); await A.click('[data-signature-dialog] button[type=submit]');
    eq(await until(async () => { const g = (await api(A, 'GET', '/api/admin/authenticator-allowlist')).data.grace_days; return g === 0 ? 0 : null; }), 0, 'saved with the password again: the grace period is now 0 days');
    // The supervisor's passkey, added before the list, now says why it is refused.
    await go(S, `profile?_=${Date.now()}`); await S.waitForSelector('[data-passkeys-allowlist]'); await S.waitForSelector('[data-passkey-not-accepted]', { timeout: 5000 }).catch(() => null);
    ok(await S.$('[data-passkey-not-accepted]'), 'My profile marks the passkey as not accepted');
    ok(/accepts only these authenticator models: SUDS browser-suite key/.test(await S.textContent('[data-passkeys-allowlist]')), 'and names the models the programme accepts');
    await axe(S, 'My profile under the authenticator allow-list (390)');
    ok(await noSideScroll(S), 'My profile under the allow-list does not scroll sideways at 390 px');
    // The button, not the username field's suggestions (conditional UI), as in 3.
    await sup.ctx.addInitScript(() => { if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false; });
    await S.reload(); await S.waitForSelector('.layout'); await settle(S);
    await signOut(S);
    await S.click('[data-fingerprint-signin]');
    const notAccepted = await until(async () => { const t = await S.$eval('[data-fingerprint-login] [data-fingerprint-status]', e => e.textContent).catch(() => ''); return t && !/Waiting/.test(t) ? t : null; }, { timeout: 15000 });
    ok(notAccepted && /not accepted any more/.test(notAccepted), 'fingerprint sign-in with it is refused, and the page says why', notAccepted);
    // A new passkey from the browser's virtual authenticator cannot prove a listed model: refused with the reason.
    await signInWithPassword(S, 'jwalker', PW);
    // A fresh authenticator's credential store: the device already holding a passkey for the account is excluded.
    await sup.cdp.send('WebAuthn.clearCredentials', { authenticatorId: sup.authenticatorId });
    await go(S, 'profile'); await S.waitForSelector('[data-passkey-add-open]');
    await S.click('[data-passkey-add-open]'); await S.waitForSelector('.modal [data-passkey-add]');
    await S.fill('.modal input[name=name]', 'Unlisted key'); await S.fill('.modal input[name=password]', PW); await S.click('.modal button[type=submit]');
    const why = await until(async () => { const t = await S.textContent('.modal').catch(() => ''); return /could not be added|accepts only certain authenticator models/.test(t) ? t : null; }, { timeout: 15000 });
    ok(why, 'adding a passkey an unlisted authenticator makes is refused, and the dialog says why', why ? why.slice(0, 300) : (await S.textContent('.modal').catch(() => 'no dialog')).slice(0, 400));
    await S.keyboard.press('Escape');
    // Back as it was: the list off (the password again), and the supervisor's passkey works again.
    eq((await api(A, 'PUT', '/api/admin/authenticator-allowlist', { enabled: false, models: [{ name: 'SUDS browser-suite key', aaguid: MODEL }], grace_days: 14, password: 'AdminPassw0rd!x' })).status, 200, 'the administrator turns the list off again');
    await go(S, `profile?_=${Date.now()}`); await S.waitForSelector('[data-passkeys-card]'); await settle(S);
    ok(!(await S.$('[data-passkey-not-accepted]')) && !(await S.$('[data-passkeys-allowlist]')), 'and the passkey is accepted again');
    for (const width of [390, 320]) {
      await A.setViewportSize({ width, height: 844 }); await go(A, 'admin?tab=settings'); await A.waitForSelector('[data-allowlist-card]'); await settle(A);
      ok(await noSideScroll(A), `the allow-list card does not scroll sideways at ${width} px`);
      if (width === 320) await axe(A, 'Settings with the authenticator allow-list card (320)');
    }
    await A.setViewportSize({ width: 1280, height: 900 });
  }
  await sup.ctx.close(); await nav.ctx.close();
} catch (e) {
  fail(`the script stopped: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
} finally {
  if (admin) { await api(admin.page, 'PUT', '/api/admin/settings', { sign_reauth_minutes: null }).catch(() => {}); await admin.ctx.close(); }
}
finish(errors);
await browser.close();
