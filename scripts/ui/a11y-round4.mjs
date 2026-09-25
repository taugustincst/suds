// QA round 4 (on 1.10.1): what an automated tester reading the accessibility tree reported.
// - A read-only (oversight) account's Home numbers linked to pages it may not open ("Not available for your
//   role"); they must not be links for that role.
// - The client header's status badge ran into the other badges as one piece of text in the accessibility
//   tree ("Inactive Risk: Moderate No naloxone"); each badge is its own list item and the status reads
//   "Status: Inactive".
// - Opening a dialog copied its title into the page's live region: a second "Add resource" in the tree.
// - The Home empty-state sentence was 102 characters, and a tool that cuts text at 100 read "…or compute".
import { chromium } from 'playwright';
import { makeChecks, settle, until } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const { ok, eq, finish } = makeChecks('a11y-round4');
const browser = await chromium.launch();
const errors = [];
const signIn = async (page, username) => {
  await page.goto(base + '/#/login'); await page.waitForSelector('input[name=username]'); await settle(page);
  await page.fill('input[name=username]', username); await page.fill('input[name=password]', 'Navigator2026!!');
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 10000 }); await settle(page);
  for (let i = 0; i < 6; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
};
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await signIn(page, 'rreader');
  await page.goto(base + '/#/dashboard'); await page.waitForSelector('.card.stat', { timeout: 10000 }); await settle(page);
  const stats = await page.$$eval('.card.stat', els => els.map(e => ({ link: e.tagName === 'A', href: e.getAttribute('href'), label: e.querySelector('.l')?.textContent })));
  ok(stats.length > 0, 'the read-only account sees the Home numbers', stats.length);
  const dead = [];
  for (const s of stats.filter(s => s.link)) {
    await page.goto(base + '/' + s.href); await settle(page);
    if (await page.$('text=Not available for your role')) dead.push(s.label);
  }
  eq(dead.join(', '), '', 'no Home number links a read-only account to "Not available for your role"');
  ok(stats.some(s => !s.link && /Active clients/i.test(s.label || '')), '"Active clients" is shown as a number, not a link', JSON.stringify(stats.map(s => `${s.label}:${s.link}`)));
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
  await signIn(page, 'mrivera');
  await page.goto(base + '/#/dashboard'); await settle(page);
  // Every empty state on Home fits in 100 characters, so nothing that cuts text there loses a word.
  const long = await page.$$eval('.empty-state p', ps => ps.map(p => p.textContent.trim()).filter(t => t.length > 100));
  eq(long.join(' | '), '', 'no Home empty-state sentence is longer than 100 characters');
  // An inactive client's header
  const r = await page.evaluate(async () => {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' };
    const res = await fetch('/api/clients', { method: 'POST', headers: h, body: JSON.stringify({ first_name: 'Ina', last_name: 'Active' + Date.now(), status: 'inactive' }) });
    return res.json();
  });
  const id = r.client?.id || r.id;
  ok(id, 'an inactive client is created', JSON.stringify(r).slice(0, 200));
  await page.goto(base + '/#/client/' + id); await page.waitForSelector('ul.badge-list'); await settle(page);
  const tree = await page.locator('main').ariaSnapshot();
  ok(/listitem: "?Status: Inactive"?/.test(tree), 'the accessibility tree has the status on its own: "Status: Inactive"', tree.split('\n').filter(l => /Inactive|list/i.test(l)).join(' / '));
  ok(!/Inactive Risk/.test(tree), 'and it no longer runs into the risk badge');
  ok(/term: Status\s*\n\s*- definition: Inactive/.test(tree), 'the Overview\'s Status row reads Inactive');
  // A dialog's title is not copied into the live region.
  await page.goto(base + '/#/resources'); await settle(page);
  await page.getByRole('button', { name: '+ Add resource' }).first().click(); await page.waitForSelector('.modal');
  await page.waitForTimeout(300);
  const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map(e => e.textContent).join('|'));
  ok(!/Add resource/.test(live), 'opening "Add resource" does not put a second copy of its title in the live region', live);
  const body = await page.locator('body').ariaSnapshot();
  eq((body.match(/Add resource/g) || []).length - (body.match(/button "\+ Add resource"/g) || []).length, 3, 'inside the dialog "Add resource" is only its name, its heading and its Save button');
  await ctx.close();
}
await browser.close();
finish(errors);
