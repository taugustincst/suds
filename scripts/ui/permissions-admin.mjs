// Admin-managed permissions UI: an administrator edits a user, sees a Permissions section with the
// role baseline, grants audit:read with a reason (a "granted" badge appears), revokes it (the badge
// is gone), and is told they cannot change their own permissions.
import { chromium } from 'playwright';
import { makeChecks, until, settle } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome' }).catch(() => chromium.launch());
const { ok, eq, fail, finish } = makeChecks('permissions-admin');
const errors = [];

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
  await page.locator('table tr', { hasText: who }).locator('button', { hasText: 'Edit' }).click();
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

  // Grant audit:read with a reason; the badge appears.
  await page.selectOption('[data-perm-select]', 'audit:read');
  await page.check('[data-perm-mode=grant]');
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
  // The confirm dialog is the topmost modal; the editor's own Revoke buttons sit behind it.
  await page.locator('.modal-bg').nth(-1).locator('button:has-text("Revoke")').click();
  const gone = await until(async () => !(await page.$('[data-perm-overrides] [data-perm-badge="granted"]')), { timeout: 8000 });
  ok(gone, 'revoking clears the badge');
  await closeEditor();

  // ---- the administrator's own account: explained, not editable ----
  await openEditor('admin');
  const selfSection = await until(() => page.$('[data-perm-section]'), { timeout: 8000 });
  ok(selfSection, 'the Permissions section also renders on the administrator\'s own account');
  ok(/You cannot change your own permissions/.test(await page.textContent('[data-perm-section]')), 'saying their own permissions cannot be changed');
  ok(!(await page.$('[data-perm-grant-form]')), 'with no grant form');
  await closeEditor();
}

finish(errors);
await browser.close();
