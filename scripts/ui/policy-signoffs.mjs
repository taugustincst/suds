// Policy sign-offs and the PowerDMS report (docs/integration/POWERDMS.md; public/views/documents.js), in a browser, on
// the seed's sample data (two policies kept in PowerDMS, some workers' signatures recorded):
//   1. a navigator's Policy sign-offs: their policies, signed or not, each opening PowerDMS in a new tab; no staff view;
//   2. Policies & contracts: a PowerDMS policy says who signs it and opens PowerDMS; its form has the link, the revision
//      and a box per role, ticked as stored;
//   3. the supervisor's Staff view: by policy and by person; Record a sign-off moves the counts;
//   4. Import from PowerDMS: a report previewed (what will be recorded, what is not matched), then recorded;
//   5. axe on each of them.
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { makeChecks, settle, until } from './assert.mjs';

const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const PW = 'Navigator2026!!';
const { ok, eq, fail, finish } = makeChecks('policy-signoffs');
const require = createRequire(import.meta.url);
let axeSource = null; try { axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8'); } catch { /* checked in axe() */ }
const browser = await chromium.launch();
const errors = [];

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

async function signIn(username) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`PAGEERROR ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/40[0134]/.test(m.text())) errors.push(`CONSOLE ${m.text().slice(0, 200)}`); });
  await page.goto(base + '/#/login'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', PW); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 15000 }); await settle(page);
  const go = async (hash) => { await page.goto(`${base}/#/${hash}`); await settle(page); };
  return { ctx, page, go };
}

try {
  // 1. A navigator's own sign-offs.
  {
    const { ctx, page, go } = await signIn('mrivera');
    await go('signoffs');
    const cards = await page.$$eval('[data-signoff]', els => els.map(e => ({ title: e.querySelector('b').textContent, badge: e.querySelector('.badge').textContent, link: e.querySelector('a[data-powerdms-link]') ? { href: e.querySelector('a[data-powerdms-link]').href, target: e.querySelector('a[data-powerdms-link]').target, rel: e.querySelector('a[data-powerdms-link]').rel } : null })));
    eq(cards.length, 2, 'a navigator is asked to sign both sample policies', cards);
    ok(cards.every(c => ['Signed', 'Needs your signature'].includes(c.badge)), 'each says whether it is signed', cards);
    ok(cards.every(c => c.link && /^https:\/\/powerdms\.com\//.test(c.link.href) && c.link.target === '_blank' && /noopener/.test(c.link.rel)), 'each opens its PowerDMS document in a new tab, without an opener', cards);
    ok(!(await page.$('[data-tab="staff"]')), 'a navigator has no staff view');
    ok(await page.evaluate(() => [...document.querySelectorAll('nav a, .nav a, a')].some(a => /#\/signoffs/.test(a.getAttribute('href') || ''))), 'Policy sign-offs is in the menu');
    await axe(page, 'a navigator\'s Policy sign-offs');
    // 2. Policies & contracts.
    await go('documents');
    const nal = await page.evaluate(() => { const c = [...document.querySelectorAll('.doc-card')].find(x => /Naloxone Distribution Policy/.test(x.textContent)); return c && { roles: c.querySelector('[data-ack-roles]')?.textContent || null, link: !!c.querySelector('a[data-powerdms-link]') }; });
    ok(nal && /Clinician, Navigator sign it in PowerDMS/i.test(nal.roles || ''), 'a PowerDMS policy says who signs it', nal);
    ok(nal && nal.link, '…and opens in PowerDMS');
    await ctx.close();
  }
  // 3. The supervisor's staff view.
  const { ctx, page, go } = await signIn('jwalker');
  await go('documents');
  await page.evaluate(() => { const c = [...document.querySelectorAll('.doc-card')].find(x => /Naloxone Distribution Policy/.test(x.textContent)); [...c.querySelectorAll('button')].find(b => b.textContent === 'Edit').click(); });
  await page.waitForSelector('.modal [name=powerdms_url]'); await settle(page);
  eq(await page.inputValue('.modal [name=powerdms_url]'), 'https://powerdms.com/ui/document/900101', 'the form shows the PowerDMS link');
  eq(await page.inputValue('.modal [name=revision]'), '3', '…the revision');
  eq(await page.$$eval('.modal [data-ack-role]', els => els.filter(e => e.checked).map(e => e.value).sort().join(',')), 'clinician,navigator', '…and the roles asked to sign it, ticked');
  await axe(page, 'the document form with its PowerDMS fields');
  await page.keyboard.press('Escape'); await settle(page);

  await go('signoffs?tab=staff');
  const before = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-policy-signed]')].map(e => [e.closest('tr').querySelector('td').textContent.trim(), e.textContent])));
  ok(Object.keys(before).length === 2, 'by policy: both sample policies', before);
  const person = await page.evaluate(() => { const tr = [...document.querySelectorAll('[data-staff-signed]')].map(e => e.closest('tr')).find(r => !/All signed/.test(r.textContent)); return tr && tr.querySelector('[data-record-signoff]').dataset.recordSignoff; });
  ok(person, 'by person: someone still has a policy to sign');
  await axe(page, 'the staff view');
  if (person) {
    await page.click(`[data-record-signoff="${person}"]`);
    await page.waitForSelector('.modal [name=acknowledged_at]'); await settle(page);
    await axe(page, 'Record a sign-off');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await page.fill('.modal [name=acknowledged_at]', yesterday);
    await page.click('.modal button[type=submit]');
    const moved = await until(() => page.evaluate((b) => { const now = Object.fromEntries([...document.querySelectorAll('[data-policy-signed]')].map(e => [e.closest('tr').querySelector('td').textContent.trim(), e.textContent])); return JSON.stringify(now) !== JSON.stringify(b) ? now : null; }, before), { timeout: 15000 });
    ok(moved, 'recording a sign-off moves a policy\'s signed count', { before, moved });
  }

  // 4. Import from PowerDMS.
  const c = await page.evaluate(async () => (await fetch('/api/policies/compliance', { headers: { 'X-Requested-With': 'suds' } })).json());
  const nalId = c.documents.find(d => /Naloxone/.test(d.title)).id;
  const owes = c.staff.find(s => s.items.some(x => x.document_id === nalId && !x.current));
  const csv = ['Name,Document ID,Document,Revision,Status,Date Signed',
    owes ? `"${owes.display_name}",900101,Naloxone Distribution Policy,3,Signed,${new Date().toISOString().slice(0, 10)}` : null,
    'Nobody Atall,900101,Naloxone Distribution Policy,3,Signed,2026-10-01',
  ].filter(Boolean).join('\n');
  await go('signoffs?tab=import');
  await axe(page, 'Import from PowerDMS');
  await page.setInputFiles('#powerdms-report', { name: 'signature-status.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.waitForSelector('[data-report-counts]', { timeout: 15000 }); await settle(page);
  const counts = await page.$$eval('[data-report-counts] [data-outcome]', els => Object.fromEntries(els.map(e => [e.dataset.outcome, e.textContent])));
  ok(owes ? /: 1$/.test(counts.record || '') : !counts.record, 'the preview says what it will record', counts);
  ok(/: 1$/.test(counts.unknown_staff || ''), '…and what it cannot match to a SUDS account', counts);
  await axe(page, 'a PowerDMS report previewed');
  if (owes) {
    await page.click('[data-report-import]');
    const listed = await until(() => page.evaluate(() => [...document.querySelectorAll('table tbody tr')].some(tr => /signature-status\.csv/.test(tr.textContent))), { timeout: 15000 });
    ok(listed, 'the report is listed as imported');
    await go('signoffs?tab=staff');
    ok(await page.evaluate((id) => { const tr = [...document.querySelectorAll('[data-staff-signed]')].map(e => e.closest('tr')).find(r => r.querySelector(`[data-record-signoff="${id}"]`)); return tr && !/Naloxone Distribution Policy/.test(tr.querySelector('td:nth-child(4)').textContent); }, owes.id), 'the person the report signed no longer owes that policy');
  }
  await ctx.close();
} catch (e) { fail(`threw: ${e.stack || e.message}`); }
await browser.close();
for (const e of errors) fail(e);
finish();
