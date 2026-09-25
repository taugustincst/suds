// The clinical-side fixes from the functional audit, checked in a real browser: a saved form does not
// come back as a draft, the discharge dialog has no default reason, Edit cannot close a client with an
// open episode, break-glass says why a short reason was refused and nothing fails silently, a merged-away
// link goes on to the keeper, patient requests reach Home and Supervision, a dialog sits above the
// banners on a phone, contact details are checked before saving, expired consents are not offered,
// bulk "Mark done" asks first, assigning a new primary warns, and an unknown address says so.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, finish } = makeChecks('clinical-audit');
const errors = [];

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(user, pass, viewport = { width: 1360, height: 900 }, extra = {}) {
  const ctx = await browser.newContext({ viewport, ...extra });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('response', r => { if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(base + '/#/login');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pass);
  await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 10000 });
  await page.evaluate((h) => fetch('/api/me/prefs', { method: 'PUT', headers: h, body: JSON.stringify({ tour_done: true }) }), H);
  await settle(page); await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
  const api = (method, path, body) => page.evaluate(async ({ method, path, body, h }) => { const r = await fetch(path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, data: j }; }, { method, path, body, h: H });
  return { page, ctx, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}${hash.includes('?') ? '&' : '?'}_=${Date.now()}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };
const closeModal = async (page) => { await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg'))); };
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const stamp = Date.now().toString().slice(-5);
let createdId;

// ---------------- navigator on a desktop ----------------
const nav = await session('mrivera', 'Navigator2026!!');
{
  const { page, api } = nav;

  // H2. a client saved from + New client does not come back as a draft in the next + New client
  await go(page, 'clients');
  await page.click('text=+ New client'); await page.waitForSelector('.modal input[name=first_name]');
  await page.fill('.modal input[name=first_name]', 'Draft'); await page.fill('.modal input[name=last_name]', 'Gone' + stamp);
  await page.fill('.modal input[name=city]', 'Auburn');
  await page.click('.modal button[type=submit]'); await page.waitForURL(/#\/client\//, { timeout: 10000 });
  createdId = page.url().split('/client/')[1].split('/')[0];
  await page.waitForTimeout(900); // intentional: let the 400ms autosave debounce window pass (it used to fire after the save)
  await go(page, 'clients');
  await page.click('text=+ New client'); await page.waitForSelector('.modal input[name=first_name]');
  eq(await page.inputValue('.modal input[name=first_name]'), '', 'the next New client form opens empty');
  eq(await page.inputValue('.modal input[name=city]'), '', 'including fields typed later');
  ok(!(await page.$('.modal .banner:has-text("Restored")')), 'and shows no "Restored" banner');
  // L1. contact details are checked in the form, under the field, before any request
  await page.fill('.modal input[name=first_name]', 'Bad'); await page.fill('.modal input[name=last_name]', 'Email' + stamp);
  await page.fill('.modal input[name=email]', 'notanemail'); await page.fill('.modal input[name=phone]', 'abc');
  await page.fill('.modal input[name=dob]', day(3));
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(await page.$('.modal .field[data-field=email].error'), 'a bad email is flagged under its field');
  ok(await page.$('.modal .field[data-field=phone].error'), 'so is a phone with no digits');
  ok(await page.$('.modal .field[data-field=dob].error'), 'and a birth date in the future');
  ok(/^\d{4}-\d{2}-\d{2}$/.test(await page.$eval('.modal input[name=dob]', i => i.max)), 'the date picker itself stops at today');
  ok(await page.$('.modal'), 'the form stays open to be corrected');
  await closeModal(page);

  // M2. Edit on a client with an open episode cannot pick Closed or Deceased
  await go(page, `client/${createdId}`);
  await page.click('button:has-text("Edit")'); await page.waitForSelector('.modal select[name=status]');
  eq(await page.$eval('.modal select[name=status] option[value=closed]', o => o.disabled), true, 'Closed is disabled while an episode is open');
  eq(await page.$eval('.modal select[name=status] option[value=deceased]', o => o.disabled), true, 'so is Deceased');
  eq(await page.$eval('.modal select[name=status] option[value=inactive]', o => o.disabled), false, 'Inactive is still a choice');
  ok(/Episodes tab/.test(await page.$eval('.modal .field[data-field=status]', f => f.textContent)), 'the help text says to discharge on the Episodes tab');
  await closeModal(page);
  const refused = await api('PUT', `/api/clients/${createdId}`, { status: 'closed' });
  eq(refused.status, 400, 'and the server refuses it regardless');

  // M1. the discharge dialog has no default reason and will not submit without one
  await go(page, `client/${createdId}/episodes`);
  await page.click('button:has-text("Discharge")'); await page.waitForSelector('.modal select[name=discharge_reason]');
  eq(await page.inputValue('.modal select[name=discharge_reason]'), '', 'the reason starts blank');
  ok(/Choose a reason/.test(await page.$eval('.modal select[name=discharge_reason] option:first-child', o => o.textContent)), 'with a placeholder, not "Completed the program"');
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(await page.$('.modal .banner.danger:not(.hidden)'), 'submitting without a reason is refused in the dialog');
  ok(await page.$('.modal .field[data-field=discharge_reason].error'), 'with the reason field marked');
  eq((await api('GET', `/api/clients/${createdId}`)).data.client.open_episode, true, 'and the episode is still open');
  await closeModal(page);

  // L2. a client whose only consent has expired: the referral form says so and points at the Consents tab
  const exp = (await api('POST', '/api/clients', { first_name: 'Expired', last_name: 'Consent' + stamp, confirm_duplicate: true })).data;
  await api('POST', `/api/clients/${exp.id}/consents`, { type: 'part2_disclosure', recipient: 'Granite Detox', purpose: 'referral', scope: 'dates of service', signed_at: day(-400), expires_at: day(-1), signed_on_paper: true, redisclosure_notice_given: true });
  await go(page, `client/${exp.id}/referrals`);
  await page.click('button:has-text("+ New referral")'); await page.waitForSelector('.modal select[name=consent_id]');
  eq(await page.$$eval('.modal select[name=consent_id] option', o => o.filter(x => x.value).length), 0, 'the expired consent is not offered');
  ok(/\(expired\)/.test(await page.$eval('.modal select[name=consent_id] option:first-child', o => o.textContent)), 'the empty choice reads "(expired)"');
  ok(await page.$('.modal a[data-add-consent]'), 'with a link to record a new release');
  ok(/expired/.test(await page.$eval('.modal .field[data-field=consent_id] .help', f => f.textContent)), 'and the help text says why');
  await closeModal(page);

  // L5. bulk "Mark selected done" asks first, with the count
  await api('POST', '/api/tasks', { client_id: createdId, title: 'Bulk one ' + stamp, due_at: day(1) });
  await api('POST', '/api/tasks', { client_id: createdId, title: 'Bulk two ' + stamp, due_at: day(1) });
  await go(page, 'tasks');
  await page.evaluate(() => { const t = document.querySelector('.has-compact table'); if (t) t.style.display = 'table'; });
  const selectBoxes = await page.$$('tbody input[aria-label^="Select "]');
  ok(selectBoxes.length >= 2, 'the to-do list offers per-row selection', selectBoxes.length);
  if (selectBoxes.length >= 2) {
    await selectBoxes[0].check(); await selectBoxes[1].check();
    await page.click('button:has-text("Mark selected done")');
    const dlg = await until(() => page.$('.modal:has-text("Mark selected done")'));
    ok(dlg, 'a confirmation appears');
    ok(dlg && /Mark 2 to-dos as done\?/.test(await dlg.textContent()), 'naming how many', dlg && (await dlg.textContent()).slice(0, 120));
    const openBefore = (await api('GET', '/api/tasks?status=open&mine=1&limit=300')).data.total;
    await page.click('.modal button:has-text("Cancel")'); await settle(page);
    eq((await api('GET', '/api/tasks?status=open&mine=1&limit=300')).data.total, openBefore, 'Cancel changes nothing');
  }

  // M7. an overdue patient request shows on Home
  await api('POST', '/api/patient-requests', { client_id: createdId, kind: 'access', received_at: day(-40) });
  await go(page, 'dashboard');
  const prCard = await page.$('[data-patient-requests]');
  ok(prCard, 'Home has an open patient requests card');
  ok(prCard && /overdue/.test(await prCard.textContent()), 'which says one is overdue', prCard && (await prCard.textContent()).trim());
  ok(await page.$('a.badge:has-text("patient request")'), 'and an alert badge links to the list');
  await go(page, 'clients?status=all&patient_requests=1');
  ok(/open patient request/.test(await page.textContent('.main')), 'the badge leads to the clients with an open request');
  ok((await page.textContent('.main')).includes('Gone' + stamp), 'including this one');

  // L9. an address that goes nowhere
  await go(page, 'nonsense');
  ok(await page.$('[data-not-found]'), 'an unknown address renders a "Page not found" view');
  ok(/Page not found/.test(await page.textContent('.main')), 'saying so');
  ok(await page.$('[data-not-found] a[href="#/dashboard"]'), 'with a link home');

  // M5b. a rejection nobody caught is shown, not swallowed
  await page.evaluate(() => { Promise.reject(new Error('Boom test ' + 'unhandled')); });
  const boom = await until(() => page.$('.toast.error:has-text("Boom test")'));
  ok(boom, 'an unhandled rejection becomes an error toast');
  // The rejection is deliberately still reported to the console (for whoever is debugging), so it is
  // not a page error this script should fail on.
  for (let i = errors.length - 1; i >= 0; i--) if (/Boom test/.test(errors[i])) errors.splice(i, 1);
}

// ---------------- supervisor: merged-away links, supervision count, consent revoke ----------------
const sup = await session('jwalker', 'Navigator2026!!');
{
  const { page, api } = sup;
  const keep = (await api('POST', '/api/clients', { first_name: 'Keeper', last_name: 'Merge' + stamp, confirm_duplicate: true })).data;
  const dup = (await api('POST', '/api/clients', { first_name: 'Dup', last_name: 'Merge' + stamp, confirm_duplicate: true })).data;
  eq((await api('POST', `/api/clients/${keep.id}/merge`, { source_id: dup.id })).status, 200, 'the duplicate merges');
  await go(page, `client/${dup.id}`);
  await until(() => page.url().includes(`/client/${keep.id}`));
  ok(page.url().includes(`/client/${keep.id}`), 'an old link to the merged-away record goes on to the keeper');
  ok(await page.$('.toast:has-text("merged into")'), 'and says so');
  await go(page, `client/${keep.id}/team`);
  ok(/an old link to it sends you here/.test(await page.textContent('.main')), 'the merge copy describes what actually happens');
  ok(/legal hold cannot be merged/.test(await page.textContent('.main')), 'and that a held record cannot be merged');

  // L7. assigning a new primary says the current one will be ended (the navigator is primary from intake)
  await go(page, `client/${createdId}/team`);
  await page.click('button:has-text("+ Assign worker")'); await page.waitForSelector('.modal select[name=role_on_case]');
  ok(/Maria Rivera is the current primary/.test(await page.$eval('.modal .field[data-field=role_on_case]', f => f.textContent)), 'the Assign dialog warns that the current primary will be ended');
  const users = (await api('GET', '/api/users')).data.users; const other = users.find(u => u.username === 'dchen');
  if (other) {
    await page.selectOption('.modal select[name=user_id]', other.id);
    await page.click('.modal button[type=submit]');
    const confirm = await until(() => page.$('.modal:has-text("Replace the primary worker?")'));
    ok(confirm, 'and asks before replacing them');
    if (confirm) { await page.click('.modal button:has-text("Cancel")'); await settle(page); }
    const primaries = (await api('GET', `/api/clients/${createdId}`)).data.client.assignments.filter(a => a.role_on_case === 'primary' && !a.end_date);
    eq(primaries.length, 1, 'Cancel leaves the current primary in place');
    ok(primaries[0] && primaries[0].user_id !== other.id, 'unchanged');
  }
  await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));

  await go(page, 'supervision');
  const block = await page.$('[data-patient-requests]');
  ok(block, 'Supervision shows the open patient requests');
  ok(block && /overdue/.test(await block.textContent()), 'with the overdue count');

  // L6. revoking a consent says so
  const rc = (await api('POST', '/api/clients', { first_name: 'Revoke', last_name: 'Toast' + stamp, confirm_duplicate: true })).data;
  await api('POST', `/api/clients/${rc.id}/consents`, { type: 'roi', recipient: 'Hope Housing', purpose: 'housing referral', signed_at: day(-1) });
  await go(page, `client/${rc.id}/consents`);
  await page.click('button:has-text("Revoke")'); const rd = await until(() => page.$('.modal input'));
  if (rd) { await rd.fill('Client withdrew consent in person'); await page.click('.modal button:has-text("Revoke")'); }
  ok(await until(() => page.$('.toast:has-text("Consent revoked")')), 'revoking a consent shows a toast');
}

// ---------------- admin: break-glass reason length ----------------
const adm = await session('admin', 'AdminPassw0rd!x');
{
  const { page, api } = adm;
  const list = (await api('GET', '/api/clients?limit=5&status=active')).data.clients;
  await go(page, `client/${list[0].id}/notes`);
  const bg = await page.$('button[data-breakglass]');
  ok(bg, 'an administrator is offered emergency access on the Notes tab');
  if (bg) {
    await bg.click(); await page.waitForSelector('.modal input');
    await page.fill('.modal input', 'short');
    await page.click('.modal button:has-text("Show clinical notes")'); await settle(page);
    ok(await page.$('.modal'), 'a too-short reason keeps the dialog open');
    ok(/at least 15 characters/.test(await page.$eval('.modal .err', e => e.textContent)), 'and says why', await page.$eval('.modal .err', e => e.textContent).catch(() => ''));
    await page.fill('.modal input', 'Client in ED, treating physician needs the plan');
    await page.click('.modal button:has-text("Show clinical notes")');
    const shown = await until(() => page.$('#breakglass-notes h4'));
    ok(shown, 'a proper reason opens the clinical notes');
    ok(!(await page.$('.modal')), 'and the dialog has closed');
  }
}

// ---------------- phone: a dialog sits above the banners ----------------
const phone = await session('mrivera', 'Navigator2026!!', { width: 390, height: 844 }, { hasTouch: true, isMobile: true });
{
  const { page } = phone;
  await go(page, 'dashboard');
  // The MFA banner is there in a fresh development install; put one there regardless so the check is
  // about layering, not about which roles need two-step verification this week.
  await page.evaluate(() => {
    let host = document.getElementById('banners'); if (!host) { host = document.createElement('div'); host.id = 'banners'; document.body.prepend(host); }
    if (!host.querySelector('.banner')) { const b = document.createElement('div'); b.className = 'banner warn'; b.setAttribute('data-banner', 'test'); b.textContent = 'Your role requires two-step verification. Set it up now.'; host.append(b); }
  });
  ok(await page.$('#banners .banner'), 'a banner is on the page');
  await page.click('.fab button');
  const first = await until(() => page.$('.modal .quick-list .btn'));
  ok(first, 'the + Log sheet opens');
  if (first) {
    const zBanner = await page.$eval('#banners', b => Number(getComputedStyle(b).zIndex) || 0);
    const zModal = await page.$eval('.modal-bg', m => Number(getComputedStyle(m).zIndex) || 0);
    ok(zModal > zBanner, 'the dialog layer is above the banner layer', [zModal, zBanner]);
    const zToasts = await page.$eval('.toasts', t => Number(getComputedStyle(t).zIndex) || 0);
    ok(zToasts > zModal, 'and toasts are above the dialog', [zToasts, zModal]);
    const box = await first.boundingBox();
    const hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? !!el.closest('.quick-list .btn') : false; }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    ok(hit, 'the first item of the sheet is what a tap would land on, not the banner');
    await first.tap();
    ok(await until(() => page.$('.modal form')), 'and tapping it opens the visit form');
  }
}

// ---------------- completeness audit (1.9.4): the gaps closed after it ----------------
{
  const { page, api } = sup;
  // A fatal overdose is a discharge, confirmed first; deleting the event puts the client back.
  const c = (await api('POST', '/api/clients', { first_name: 'Fatal', last_name: 'Browser' + stamp, confirm_duplicate: true })).data;
  const ev = (await api('POST', '/api/overdose-events', { client_id: c.id, occurred_at: new Date().toISOString(), kind: 'overdose' })).data;
  await go(page, 'overdose');
  const row = await until(async () => { for (const tr of await page.$$('tbody tr')) if ((await tr.textContent()).includes(c.client_code)) return tr; return null; });
  ok(row, 'the event is listed');
  if (row) {
    await row.click(); await page.waitForSelector('.modal select[name=kind]');
    ok(await page.$('.modal button:has-text("Delete event")'), 'the event dialog offers Delete');
    await page.selectOption('.modal select[name=kind]', 'fatal');
    await page.click('.modal button[type=submit]');
    const confirm = await until(() => page.$('.modal button:has-text("Record as fatal")'));
    ok(confirm, 'recording a fatal outcome asks first');
    const text = await page.$$eval('.modal p', ps => ps.map(p => p.textContent).join(' '));
    ok(/deceased/.test(text) && /episode/.test(text), 'and says the client is discharged as deceased', text.slice(0, 120));
    if (confirm) await confirm.click();
    await settle(page);
    eq((await api('GET', `/api/clients/${c.id}`)).data.client.status, 'deceased', 'the client is recorded as deceased');
    eq((await api('GET', `/api/clients/${c.id}/episodes`)).data.episodes[0].discharge_reason, 'deceased', 'and their episode closed with that reason');
    await go(page, 'overdose');
    const again = await until(async () => { for (const tr of await page.$$('tbody tr')) if ((await tr.textContent()).includes(c.client_code)) return tr; return null; });
    if (again) {
      await again.click(); await (await until(() => page.$('.modal button:has-text("Delete event")'))).click();
      const dels = page.locator('.modal button:has-text("Delete event")');
      ok(await until(async () => (await dels.count()) === 2), 'Delete asks for confirmation');
      const warn = await page.$$eval('.modal p', ps => ps.map(p => p.textContent).join(' '));
      ok(/no longer recorded as deceased/.test(warn), 'deleting a fatal event says the client will be restored', warn.slice(0, 120));
      await dels.last().click(); await settle(page);
    }
    eq((await api('GET', `/api/overdose-events/${ev.id}`)).status, 404, 'the event is gone');
    eq((await api('GET', `/api/clients/${c.id}`)).data.client.status, 'active', 'and the client is active again');
    eq((await api('GET', `/api/clients/${c.id}/episodes`)).data.episodes[0].status, 'open', 'with the episode reopened');
  }

  // A signed note says whether it is still what was signed.
  // (The sample data's notes are marked signed without a signature, so sign one here.)
  const draft = (await api('POST', '/api/notes', { client_id: c.id, kind: 'admin', format: 'narrative', content: 'Met at the drop-in; plan for housing.', occurred_at: new Date().toISOString() })).data;
  const signRes = await api('POST', `/api/notes/${draft.id}/sign`, { password: 'Navigator2026!!' });
  eq(signRes.status, 200, 'a note signed for the check');
  const signed = signRes.status === 200 ? { id: draft.id } : null;
  if (signed) {
    await go(page, `notes/${signed.id}`);
    const btn = await until(() => page.$('.modal [data-verify-signature]'));
    ok(btn, 'the signed note has a Verify signature button');
    if (btn) {
      await btn.click();
      ok(await until(async () => /Signature intact/.test(await page.$eval('.modal .sig-verify-result', e => e.textContent))), 'and it reports "Signature intact"');
      await page.click('.modal .sig-hash summary');
      const full = await page.$eval('.modal .sig-hash-full', e => e.textContent);
      ok(full.length >= 64 && await page.$eval('.modal .sig-hash-full', e => e.offsetParent !== null), 'the full hash shows on demand', full.length);
      await closeModal(page);
      // Alter the stored note behind the signature (as a database edit would), then check again.
      const { DatabaseSync } = await import('node:sqlite');
      const dbFile = (process.env.SUDS_DATA_DIR || '/tmp/suds-ui-data') + '/suds.db';
      const raw = new DatabaseSync(dbFile);
      const other = raw.prepare(`SELECT content_enc FROM notes WHERE id<>? AND content_enc IS NOT NULL LIMIT 1`).get(signed.id);
      const orig = raw.prepare(`SELECT content_enc FROM notes WHERE id=?`).get(signed.id);
      raw.prepare(`UPDATE notes SET content_enc=? WHERE id=?`).run(other.content_enc, signed.id);
      try {
        await go(page, `notes/${signed.id}`);
        await (await until(() => page.$('.modal [data-verify-signature]'))).click();
        ok(await until(async () => /Changed after signing/.test(await page.$eval('.modal .sig-verify-result', e => e.textContent))), 'a note altered after signing reports "Changed after signing"');
        await closeModal(page);
      } finally { raw.prepare(`UPDATE notes SET content_enc=? WHERE id=?`).run(orig.content_enc, signed.id); raw.close(); }
    }
  }

  // Patient-rights requests: edit and delete on the client's Requests tab.
  const pr = (await api('POST', '/api/patient-requests', { client_id: c.id, kind: 'access', received_at: day(0), notes: 'Asked at the front desk' })).data;
  await go(page, `client/${c.id}/requests`);
  const edit = await until(() => page.$(`[data-edit-request="${pr.id}"]`));
  ok(edit, 'a request has an Edit action');
  if (edit) {
    await edit.click(); await page.waitForSelector('.modal select[name=kind]');
    await page.selectOption('.modal select[name=kind]', 'amendment');
    await page.fill('.modal input[name=due_at]', day(45));
    await page.click('.modal button[type=submit]'); await settle(page);
    const after = (await api('GET', `/api/patient-requests/${pr.id}`)).data.row;
    eq(after.kind, 'amendment', 'Edit changes the kind'); eq(after.due_at, day(45), 'and the due date');
    await (await until(() => page.$(`[data-delete-request="${pr.id}"]`))).click();
    await (await until(() => page.$('.modal button:has-text("Delete request")'))).click(); await settle(page);
    eq((await api('GET', `/api/patient-requests/${pr.id}`)).status, 404, 'Delete removes it');
    ok(!(await page.$(`[data-edit-request="${pr.id}"]`)), 'and the tab no longer lists it');
  }

  // The discharge reasons come from the server's list.
  const reasons = (await api('GET', '/api/meta/discharge-reasons')).data.discharge_reasons;
  await go(page, `client/${c.id}/episodes`);
  const discharge = await until(() => page.$('.card-head button:has-text("Discharge")'));
  if (discharge) {
    await discharge.click(); await page.waitForSelector('.modal select[name=discharge_reason]');
    const opts = await page.$$eval('.modal select[name=discharge_reason] option', os => os.map(o => o.value).filter(Boolean));
    eq(opts.join(','), reasons.join(','), 'the discharge dialog offers the server\'s reasons');
    await closeModal(page);
  } else ok(false, 'the client has a Discharge button');

  // Reports: episodes of care, and the single-table exports.
  await go(page, 'reports');
  ok(await until(() => page.$('[data-episodes-report]')), 'Reports has an Episodes of care card');
  const epText = await page.$eval('[data-episodes-report]', e => e.textContent).catch(() => '');
  ok(/Admissions/.test(epText) && /Discharges by reason/.test(epText), 'with admissions and discharges by reason', epText.slice(0, 120));
  for (const label of ['Episodes (Excel)', 'Overdose events (Excel)', 'Client forms (Excel)', 'Disclosures (Excel)']) ok(await page.$(`button:has-text("${label}")`), `an export button for ${label}`);
}
{
  // CalAIM clinical depth: a problem on the problem list, a care plan goal with a step, an ASAM assessment and
  // a PHQ-9 whose score is shown — and item 9 raising the safety alert — all through the forms, as a
  // supervisor (a clinical role). Then the Overview's clinical card, the navigator's tabs, and Reports.
  const { page, api } = sup;
  const c = (await api('POST', '/api/clients', { first_name: 'Careplan', last_name: 'Browser' + stamp, confirm_duplicate: true })).data;

  // Problem list
  await go(page, `client/${c.id}/problems`);
  await (await until(() => page.$('[data-add-problem]'))).click();
  await page.waitForSelector('.modal textarea[name=problem]');
  await page.fill('.modal textarea[name=problem]', 'Unsheltered, wants housing ' + stamp);
  await page.fill('.modal input[name=icd10_code]', 'f1120');
  await page.fill('.modal input[name=onset_date]', day(-20));
  await page.click('.modal [data-zcodes] summary');
  await page.check('.modal [data-zcodes] input[value="Z59.02"]');
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  const probRow = await until(() => page.$(`[data-problem-row]:has-text("wants housing ${stamp}")`));
  ok(probRow, 'the new problem is on the Problems tab');
  const probText = probRow ? await probRow.textContent() : '';
  ok(/F11\.20/.test(probText) && /Z59\.02/.test(probText), 'with its ICD-10 code normalised and its Z code', probText);
  const problems = (await api('GET', `/api/clients/${c.id}/problems`)).data.rows;
  eq(problems.length, 1, 'one problem was saved');
  // A code that is not ICD-10 shaped is flagged under its field, not saved.
  await (await until(() => page.$('[data-add-problem]'))).click();
  await page.waitForSelector('.modal textarea[name=problem]');
  await page.fill('.modal textarea[name=problem]', 'Bad code');
  await page.fill('.modal input[name=icd10_code]', '12345');
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(await until(() => page.$('.modal .field[data-field=icd10_code].error')), 'an impossible ICD-10 code is flagged under the field');
  await closeModal(page);

  // Care plan: a goal tied to the problem, review date passed, and a step that goes on the to-do list
  await go(page, `client/${c.id}/careplan`);
  await (await until(() => page.$('[data-add-goal]'))).click();
  await page.waitForSelector('.modal textarea[name=goal]');
  await page.fill('.modal textarea[name=goal]', 'I want my own place by winter ' + stamp);
  await page.selectOption('.modal select[name=problem_id]', problems[0].id);
  await page.fill('.modal input[name=review_date]', day(-1));
  await page.click('.modal button[type=submit]');
  const goal = await until(() => page.$(`[data-goal]:has-text("own place by winter ${stamp}")`));
  ok(goal, 'the goal is on the care plan');
  ok(goal && /Review overdue/.test(await goal.textContent()), 'a review date in the past shows as overdue');
  ok(goal && /Addresses: Unsheltered/.test(await goal.textContent()), 'and names the problem it addresses');
  await (await until(() => page.$('[data-add-step]'))).click();
  await page.waitForSelector('.modal textarea[name=step]');
  await page.fill('.modal textarea[name=step]', 'Apply for coordinated entry');
  await page.fill('.modal input[name=target_date]', day(7));
  await page.check('.modal input[name=create_task]');
  await page.click('.modal button[type=submit]');
  ok(await until(() => page.$('[data-step]:has-text("Apply for coordinated entry")')), 'the step is listed under the goal');
  const plan = (await api('GET', `/api/clients/${c.id}/care-plan`)).data;
  ok(plan.goals[0] && plan.goals[0].steps[0] && plan.goals[0].steps[0].task_id, 'and a to-do was made for it');
  ok(await page.$('[data-print-careplan]'), 'the care plan has a Print button');

  // ASAM: six ratings and the level of care
  await go(page, `client/${c.id}/assessments`);
  await (await until(() => page.$('[data-add-asam]'))).click();
  await page.waitForSelector('.modal select[name=d1_rating]');
  for (const [k, v] of [['d1', '1'], ['d2', '0'], ['d3', '2'], ['d4', '3'], ['d5', '3'], ['d6', '4']]) await page.selectOption(`.modal select[name=${k}_rating]`, v);
  await page.fill('.modal textarea[name=note_d6]', 'Sleeping outside; partner still using');
  await page.selectOption('.modal select[name=recommended_loc]', '3.5');
  await page.selectOption('.modal select[name=actual_loc]', '2.1');
  await page.click('.modal button[type=submit]'); await settle(page);
  ok(await until(() => page.$('.modal .field[data-field=discrepancy_reason].error')), 'a different level referred to needs a reason');
  await page.selectOption('.modal select[name=discrepancy_reason]', 'waitlist');
  await page.click('.modal button[type=submit]');
  await until(async () => !(await page.$('.modal-bg')));
  const asamRow = await until(() => page.$('[data-asam] tbody tr'));
  const asamText = asamRow ? await asamRow.textContent() : '';
  ok(/3\.5/.test(asamText) && /2\.1/.test(asamText) && /Waitlist/.test(asamText), 'the ASAM assessment is listed with both levels and the reason', asamText);
  eq((await api('GET', `/api/clients/${c.id}`)).data.client.asam_level, '2.1', 'and the client\'s level of care follows it');

  // PHQ-9: the score is shown while answering and after saving; item 9 raises the safety alert
  await (await until(() => page.$('[data-add-outcome=phq9]'))).click();
  await page.waitForSelector('.modal select[name=q0]');
  const answers = ['2', '2', '1', '1', '1', '1', '0', '0', '1']; // 9
  for (let i = 0; i < answers.length; i++) await page.selectOption(`.modal select[name=q${i}]`, answers[i]);
  const preview = await until(async () => { const t = await page.$eval('[data-outcome-preview]', e => e.textContent); return /Score: 9 of 27/.test(t) ? t : null; });
  ok(preview && /Mild/.test(preview), 'the form shows the score and band before saving', preview);
  ok(preview && /safety alert/.test(preview), 'and warns that question 9 will raise a safety alert');
  await page.click('.modal button[type=submit]');
  ok(await until(() => page.$('[data-safety-alert-dialog]')), 'saving raises the safety alert');
  ok(await page.$('[data-safety-alert-dialog] [data-write-safety-plan], [data-safety-alert-dialog] [data-open-safety-plan]'), 'which offers the safety plan');
  await page.click('[data-safety-alert-dialog] button:has-text("Close")');
  await until(async () => !(await page.$('.modal-bg')));
  await settle(page);
  const scoreCell = await until(() => page.$('[data-outcomes] [data-outcome-score]'));
  eq(scoreCell ? (await scoreCell.textContent()).trim() : '', '9', 'the saved PHQ-9 score is in the table');
  const urgent = (await api('GET', `/api/tasks?client_id=${c.id}&limit=50`)).data.rows.filter(t => t.priority === 'urgent');
  eq(urgent.length, 1, 'an urgent safety follow-up to-do was created');

  // The Overview sums it up
  await go(page, `client/${c.id}/overview`);
  const card = await until(() => page.$('[data-clinical-card]'));
  ok(card, 'the Overview has a Clinical picture card');
  ok(await page.$('[data-clinical-card] [data-safety-alert]'), 'with the PHQ-9 safety alert');
  ok(/wants housing/.test(await page.$eval('[data-overview-problems]', e => e.textContent).catch(() => '')), 'the active problem');
  ok(await page.$('[data-overview-careplan] [data-review-overdue]'), 'the overdue care plan review');
  ok(await page.$('[data-overview-asam]:not([data-overview-asam=""])'), 'the latest ASAM assessment');
  eq((await page.$eval('[data-latest-score=phq9]', e => e.textContent).catch(() => '')).trim(), '9 · Mild', 'and the latest PHQ-9 score');

  // Reports: the programme outcomes card
  await go(page, 'reports');
  ok(await until(() => page.$('[data-outcomes-report]')), 'Reports has an Outcome measures card');
  ok(await page.$('[data-export-outcomes]'), 'with a de-identified export');
}
{
  // A navigator keeps the problem list and care plan, but not ASAM ratings or screening answers.
  const { page } = nav;
  await go(page, `client/${createdId}`);
  await until(() => page.$('[data-tab=overview]'));
  ok(await page.$('[data-tab=problems]') && await page.$('[data-tab=careplan]'), 'a navigator has the Problems and Care plan tabs');
  ok(!(await page.$('[data-tab=assessments]')), 'but no Assessments tab');
}
{
  // Finance: client codes are plain text where it cannot open the client, and a direct link says why.
  const fin = await session('afinance', 'Navigator2026!!');
  const { page, api } = fin;
  await go(page, 'time');
  await until(() => page.$('tbody tr'));
  eq((await page.$$('.main a[href^="#/client/"]')).length, 0, 'finance sees no client links on Time');
  await go(page, 'budget');
  await until(() => page.$('.main'));
  eq((await page.$$('.main a[href^="#/client/"]')).length, 0, 'or on Budget');
  const someClient = (await sup.api('GET', '/api/clients?limit=1')).data.clients[0];
  await go(page, `client/${someClient.id}`);
  ok(await until(() => page.$('[data-client-forbidden="role"]')), 'a client link opened by finance says it is not available for the role');
  ok(/Not available for your role/.test(await page.$eval('.main', e => e.textContent)), 'in those words');
  await go(page, 'supervision');
  const supText = await page.$eval('.main', e => e.textContent);
  const headings = await page.$$eval('.main h2', hs => hs.map(x => x.textContent).join(' | '));
  ok(!/countersignature|Unsigned notes/i.test(headings) && !(await page.$('[data-section=cosign]')) && !(await page.$('[data-section=unsigned]')), 'finance\'s Supervision page has no note sections', headings);
  ok(/Staff time/i.test(supText), 'but still has the staff time it approves');
  await go(page, 'reports');
  ok(!(await page.$('[data-episodes-report]')), 'and Reports shows finance no episode list');
  ok(await page.$('button:has-text("Episodes (Excel)")'), 'though the de-identified Episodes export is there');
  await fin.close();
}

await phone.close(); await adm.close(); await sup.close(); await nav.close();
await browser.close();
if (errors.length) { console.log('ERRORS:'); errors.forEach(e => console.log('  ' + e)); } else console.log('NO ERRORS');
finish(errors);
