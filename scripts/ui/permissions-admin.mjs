// Admin-managed permissions UI: an administrator opens a user's Permissions dialog, sees a Permissions section with the
// role baseline, grants audit:read with a reason (a "granted" badge appears) and revokes it (the badge is gone).
// Their own permissions (the owner's decision after 1.23.5): each change is confirmed first, naming what they lose
// or gain, and applies at once; removing the last administrator's user management is refused with the lockout
// message; and removing their own while another administrator remains takes them off the page. axe on the dialogs.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, fail, finish } = makeChecks('permissions-admin');
const errors = [];
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked below */ }
async function axe(page, where) {
  if (!axeSource) { fail('axe-core is not installed (npm i --no-save axe-core)'); return; }
  await page.evaluate(axeSource + ';0');
  const v = await page.evaluate(async () => {
    const rules = [...new Set([...window.axe.getRules(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).map(r => r.ruleId), 'heading-order', 'empty-heading', 'landmark-unique', 'page-has-heading-one'])];
    const r = await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] });
    return r.violations.map(x => `${x.id}: ${x.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  });
  eq(v.length, 0, `${where}: no WCAG 2.1 A/AA findings${v.length ? ' — ' + v.join('; ') : ''}`);
}

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
async function session(user, pass, viewport = { width: 1360, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
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
  return { page, api, close: () => ctx.close() };
}
const go = async (page, hash) => { await page.goto(`${base}/#/${hash}`); await page.waitForSelector('.main .boot', { state: 'detached', timeout: 10000 }).catch(() => {}); await settle(page); };

const admin = await session('admin', 'AdminPassw0rd!x');
const { page } = admin;

// A navigator to edit, created through the API with a known password.
const uname = 'permnav' + Date.now().toString().slice(-5);
const created = await admin.api('POST', '/api/users', { username: uname, display_name: 'Perm Nav', role: 'navigator', password: 'Navigator2026!!' });
eq(created.status, 201, 'a navigator is created for the permissions UI test');

const openEditor = async (who) => {
  await go(page, 'admin?tab=users');
  await page.waitForSelector('.main table');
  // 1.15.2: individual permissions have their own dialog, opened from the row's Permissions button.
  await page.click(`[data-user-permissions="${who}"]`);
  await page.waitForSelector('.modal', { timeout: 10000 }); await settle(page);
};
const closeEditor = async () => { await page.keyboard.press('Escape'); await until(async () => !(await page.$('.modal-bg')), { timeout: 5000 }); };

// ---- the navigator's Permissions section ----
await openEditor(uname);
const section = await until(() => page.$('[data-perm-section]'), { timeout: 8000 });
if (!section) { fail('Permissions section not found'); }
else {
  ok(await page.$('[data-perm-baseline]'), 'the section shows the role baseline');
  ok(/Open client records/.test(await page.textContent('[data-perm-baseline]')), 'with catalog labels, not bare permission strings', await page.textContent('[data-perm-baseline]'));
  ok(await page.$('[data-perm-grant-form]'), 'and the grant form');
  // 1.16.0: the navigator baseline says what widened and how to hold the person to their caseload.
  const roleNote = await page.$('[data-perm-role-note="navigator"]');
  ok(roleNote && /sees every client/.test(await roleNote.textContent()) && /deny See every client/.test(await roleNote.textContent()), 'the navigator baseline explains the 1.16.0 defaults and the caseload deny', roleNote && await roleNote.textContent());

  // Grant audit:read with a reason; the badge appears.
  await page.selectOption('[data-perm-select]', 'audit:read');
  await page.check('[data-perm-mode=grant]');
  ok(/client/.test(await page.textContent('[data-perm-reason-hint]')), 'the reason field says to keep client details out');
  eq(await page.getAttribute('[data-perm-reason]', 'maxlength'), '300', 'and is bounded');
  await page.fill('[data-perm-reason]', 'reviews the break-glass queue weekly');
  await page.click('[data-perm-save]');
  const grantedBadge = await until(() => page.$('[data-perm-overrides] [data-perm-badge="granted"]'), { timeout: 8000 });
  ok(grantedBadge, 'granting audit:read shows a "granted" badge on the override');
  ok(/Read the audit log/.test(await page.textContent('[data-perm-overrides]')), 'the override row carries the catalog label');
  ok(/reviews the break-glass queue weekly/.test(await page.textContent('[data-perm-overrides]')), 'and the reason that was given');

  // ---- Task 7: /api/me snapshot, deny-aware gating, mid-session refresh ----
  const navId = created.data.id;
  const nav = await session(uname, 'Navigator2026!!');
  // A user created through the API must change the temporary password before the API serves them.
  const pwChanged = await nav.api('POST', '/api/auth/password', { current_password: 'Navigator2026!!', new_password: 'Navigator2026!!x' });
  eq(pwChanged.status, 200, 'the navigator clears the forced password change');
  const me1 = await nav.api('GET', '/api/me');
  eq(me1.status, 200, 'GET /api/me returns the permission snapshot');
  ok(me1.data.permissions.includes('audit:read'), 'the grant is visible in the /api/me snapshot');
  ok(me1.data.permissions.includes('clients:read'), 'role defaults are in the snapshot');
  ok(!(me1.data.denied_permissions || []).includes('clients:read'), 'nothing denied yet');
  await go(nav.page, 'profile');
  ok(await nav.page.$('.sidebar a[href="#/clients"]'), 'the navigator sees My clients before the mid-session deny');
  // The administrator denies clients:read while the navigator is signed in.
  const denyMid = await admin.api('POST', `/api/users/${navId}/permissions`, { permission: 'clients:read', mode: 'deny', reason: 'task seven mid-session deny test' });
  eq(denyMid.status, 200, 'the administrator denies clients:read mid-session');
  const me2 = await nav.api('GET', '/api/me');
  ok(!(me2.data.permissions || []).includes('clients:read'), 'the deny is out of the effective list');
  ok((me2.data.denied_permissions || []).includes('clients:read'), 'and listed in denied_permissions');
  // Refresh picks it up without signing out; the denied page leaves the sidebar.
  await nav.page.click('[data-refresh-permissions]');
  const clientsGone = await until(async () => !(await nav.page.$('.sidebar a[href="#/clients"]')), { timeout: 8000 });
  ok(clientsGone, 'after Refresh permissions the denied page leaves the sidebar');
  await nav.close();

  // Revoke it; the badge is gone.
  await page.click('[data-perm-revoke="audit:read"]');
  await page.waitForSelector('.modal-bg .modal', { timeout: 5000 }); await settle(page);
  // The confirm dialog is the topmost modal; the editor's own Revoke buttons sit behind it. It asks why (1.15.4).
  const top = page.locator('.modal-bg').nth(-1);
  await top.locator('button:has-text("Revoke")').click();
  ok(await top.locator('.err').textContent().then(t => /reason is required/i.test(t)), 'revoking without a reason is refused in the dialog');
  ok(/never a client/.test(await top.textContent()), 'the dialog says to keep client details out of the reason');
  await top.locator('input').fill('The weekly review moved to the supervisor');
  await top.locator('button:has-text("Revoke")').click();
  const gone = await until(async () => !(await page.$('[data-perm-overrides] [data-perm-badge="granted"]')), { timeout: 8000 });
  ok(gone, 'revoking clears the badge');
  await closeEditor();

  // ---- the administrator's own account: editable like anyone's, each change confirmed first ----
  const me = (await admin.api('GET', '/api/me')).data;
  const topModal = () => page.locator('.modal-bg').nth(-1);
  const deniedNow = async (perm) => ((await admin.api('GET', '/api/me')).data.denied_permissions || []).includes(perm);
  const saveOwn = async (perm, mode, why) => {
    await page.selectOption('[data-perm-select]', perm);
    await page.check(`[data-perm-mode=${mode}]`);
    await page.fill('[data-perm-reason]', why);
    await page.click('[data-perm-save]');
    await until(async () => (await page.locator('.modal-bg').count()) >= 2, { timeout: 5000 }); await settle(page);
  };
  await openEditor('admin');
  ok(await until(() => page.$('[data-perm-section] [data-perm-self]'), { timeout: 8000 }), 'the administrator\'s own Permissions say they are their own');
  ok(await page.$('[data-perm-grant-form]'), 'with the grant form, as for anyone');
  await axe(page, 'Permissions dialog (own account)');

  // Deny their own graph:import: confirmed first, naming what they lose; cancelled, nothing changes.
  await saveOwn('graph:import', 'deny', 'Imports are done by the data team now');
  const conf = await topModal().textContent();
  ok(/You are removing your own access to Import from OneNote \(graph:import\)\. You will lose it immediately\./.test(conf), 'the confirmation names what they are about to lose', conf);
  await axe(page, 'Confirm a change to one\'s own permissions');
  await topModal().locator('button:has-text("Cancel")').click(); await settle(page);
  eq(await deniedNow('graph:import'), false, 'cancelled: nothing changed');
  // Confirmed: applied at once.
  await saveOwn('graph:import', 'deny', 'Imports are done by the data team now');
  await topModal().locator('button:has-text("Remove my access")').click();
  ok(await until(() => page.$('[data-perm-overrides] [data-perm-revoke="graph:import"]'), { timeout: 8000 }), 'confirmed, their own deny is listed');
  eq(await deniedNow('graph:import'), true, 'and applies to their session at once');
  const auditRow = await admin.api('GET', `/api/admin/audit?action=user.permission.deny&user_id=${me.id}&limit=1`);
  eq(auditRow.data.rows?.[0]?.details?.self, true, 'audited as user.permission.deny with self: true');
  // Revoke it: the reason, then the confirmation of what they get back.
  await page.click('[data-perm-revoke="graph:import"]');
  await until(async () => (await page.locator('.modal-bg').count()) >= 2, { timeout: 5000 }); await settle(page);
  await topModal().locator('input').fill('Back to the full administrator role');
  await topModal().locator('button:has-text("Revoke")').click(); await settle(page);
  ok(/You are lifting your own deny of Import from OneNote/.test(await topModal().textContent()), 'revoking their own deny is confirmed too');
  await topModal().locator('button:has-text("Lift my deny")').click();
  ok(await until(async () => !(await deniedNow('graph:import')), { timeout: 8000 }), 'and lifted at once');

  // ---- the lockout guard: as the only administrator, they cannot remove their own user management ----
  const otherAdmins = ((await admin.api('GET', '/api/users')).data.users || []).filter(u => u.role === 'admin' && u.is_active && u.id !== me.id);
  for (const u of otherAdmins) eq((await admin.api('PUT', `/api/users/${u.id}`, { is_active: false, wipe_devices: false })).status, 200, `another administrator (${u.username}) is set aside for the lockout check`);
  await saveOwn('users:manage', 'deny', 'Stepping back from user administration');
  ok(/That includes this page: Users & permissions/.test(await topModal().textContent()), 'denying their own users:manage says it includes this page');
  await topModal().locator('button:has-text("Remove my access")').click();
  const lockToast = await until(() => page.$('.toast.error'), { timeout: 8000 });
  ok(lockToast && /This would leave no active administrator who can manage users\. Give another account that access first\./.test(await lockToast.textContent()), 'as the last administrator it is refused with the lockout message', lockToast && await lockToast.textContent());
  eq(await deniedNow('users:manage'), false, 'and nothing changed');
  ok(await page.$('[data-perm-section]'), 'they stay on the dialog');
  await closeEditor();

  // ---- with another administrator, removing their own user management takes them off the page gracefully ----
  const a2name = 'permadm' + Date.now().toString().slice(-5);
  const a2 = await admin.api('POST', '/api/users', { username: a2name, display_name: 'Second Admin', role: 'admin', password: 'Copper2026!!y' });
  eq(a2.status, 201, 'a second administrator is created');
  await openEditor('admin');
  await until(() => page.$('[data-perm-grant-form]'), { timeout: 8000 });
  await saveOwn('users:manage', 'deny', 'Stepping back from user administration');
  await topModal().locator('button:has-text("Remove my access")').click();
  ok(await until(async () => /#\/dashboard/.test(page.url()), { timeout: 8000 }), 'having removed their own user management, they are taken off Users & permissions', page.url());
  const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '));
  ok(await until(async () => /You no longer manage users and permissions/.test(await toasts())), 'told why', await toasts());
  eq(await page.locator('.modal-bg').count(), 0, 'with no dialog left open');
  eq(await deniedNow('users:manage'), true, 'the deny applies at once');
  eq((await admin.api('GET', `/api/users/${me.id}/permissions`)).status, 403, 'and the server refuses them user management on the next request');
  // The second administrator gives it back (as only another administrator can), and the others return.
  const second = await session(a2name, 'Copper2026!!y');
  eq((await second.api('POST', '/api/auth/password', { current_password: 'Copper2026!!y', new_password: 'Copper2026!!z' })).status, 200, 'the second administrator clears the forced password change');
  eq((await second.api('DELETE', `/api/users/${me.id}/permissions/users:manage`, { reason: 'Back to managing users after the check' })).status, 200, 'and gives user management back');
  for (const u of otherAdmins) eq((await second.api('PUT', `/api/users/${u.id}`, { is_active: true })).status, 200, `${u.username} is active again`);
  eq((await second.api('PUT', `/api/users/${a2.data.id}`, { is_active: false, wipe_devices: false })).status, 200, 'and the second administrator deactivates their own account, another administrator remaining');
  await second.close();
  eq((await admin.api('GET', `/api/users/${me.id}/permissions`)).status, 200, 'the administrator manages users again');
}

finish(errors);
await browser.close();
