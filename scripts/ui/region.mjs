// Starter directory: load the Sacramento region into the resource directory, check cards, counties, filters and unverified flagging.
import { chromium } from 'playwright';
import { makeChecks, settle } from './assert.mjs';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const { ok, finish } = makeChecks('region');
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } }); const page = await ctx.newPage(); let loggedIn = false;
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]');
await page.waitForSelector('.layout'); loggedIn = true; await settle(page);
for (let i = 0; i < 3; i++) { const skip = await page.$('.modal-bg:last-child .modal button:has-text("Skip")'); if (!skip) break; await skip.click({ force: true }); await settle(page); }
await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
await page.goto(base + '/#/resources'); await settle(page);
const before = await page.$$eval('.res-card', c => c.length);
ok(await page.$('[data-region=sacramento-metro]'), 'the regional starter directory is offered');
ok(/Sacramento/i.test(await page.textContent('[data-region=sacramento-metro]')), 'and says which region it covers');
await page.click('[data-region=sacramento-metro] button:has-text("Add")'); await settle(page, { timeout: 60000 });
await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
const after = await page.$$eval('.res-card', c => c.length);
ok(after >= before + 70, 'loading it adds the regional programmes', after - before);
const covers = await page.$$eval('.res-card', c => c.filter(x => x.querySelector('img.res-cover')).length);
ok(covers >= after - before, 'every imported programme has a picture on its card', `${covers} of ${after}`);
const needsVerify = await page.$$eval('.res-card', c => c.filter(x => /needs verification/.test(x.textContent)).length);
ok(needsVerify >= 70, 'imported programmes are flagged as needing verification until someone checks them', needsVerify);
// search for the named provider and open its profile
await page.fill('.filters input[type=search]', 'Granite'); await page.click('.filters button:has-text("Search")'); await settle(page);
const granite = await page.$$eval('.res-card b', b => b.map(x => x.textContent));
ok(granite.length >= 5, 'a named provider is found with all its programmes', granite.slice(0, 3).join(' / '));
await page.click('.res-card'); await settle(page);
ok(((await page.textContent('.res-lead').catch(() => '')) || '').trim().length > 20, 'its profile carries a written summary of services');
ok(/starter directory/.test(await page.textContent('.main')), 'and records where the entry came from');
await page.screenshot({ path: '/tmp/suds-shots/region-profile.png', fullPage: true });
await page.goto(base + '/#/resources?q=&category=&tag=mat_methadone'); await settle(page);
ok(await page.$$eval('.res-card', c => c.length) > 0, 'the directory can be filtered to methadone programmes across the region');
await page.goto(base + '/#/resources'); await settle(page); await page.screenshot({ path: '/tmp/suds-shots/region-directory.png' });
finish(errors);
await browser.close();
