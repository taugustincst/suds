// Starter directory: load the Sacramento region into the resource directory, check cards, counties, filters and unverified flagging.
import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch(); const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } }); const page = await ctx.newPage(); let loggedIn = false;
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error' && (loggedIn || !/401/.test(m.text()))) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto(base + '/#/login'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.click('button[type=submit]');
await page.waitForSelector('.layout'); loggedIn = true; await page.waitForTimeout(1500);
for (let i = 0; i < 3; i++) { const skip = await page.$('.modal-bg:last-child .modal button:has-text("Skip")'); if (!skip) break; await skip.click({ force: true }); await page.waitForTimeout(150); }
await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
await page.goto(base + '/#/resources'); await page.waitForTimeout(1200);
const before = await page.$$eval('.res-card', c => c.length);
const card = await page.$('[data-region=sacramento-metro]'); console.log('starter directory card shown:', !!card); if (!card) errors.push('no starter directory card');
console.log('card text:', (await page.textContent('[data-region=sacramento-metro]')).replace(/\s+/g, ' ').slice(0, 170));
await page.click('[data-region=sacramento-metro] button:has-text("Add")'); await page.waitForTimeout(6000);
await page.evaluate(() => document.querySelectorAll('.modal-bg').forEach(m => m.remove()));
const after = await page.$$eval('.res-card', c => c.length);
console.log('resource cards before/after load:', before, after); if (after < before + 70) errors.push(`expected 80+ programs, got ${after - before}`);
const covers = await page.$$eval('.res-card', c => c.filter(x => x.querySelector('img.res-cover')).length); console.log('cards with cover pictures:', covers, 'of', after); if (covers < after - before) errors.push('some imported programs have no cover picture');
const needsVerify = await page.$$eval('.res-card', c => c.filter(x => /needs verification/.test(x.textContent)).length);
console.log('cards flagged as needing verification:', needsVerify); if (needsVerify < 70) errors.push('imported programs should all be flagged unverified');
console.log('loaded card state:', (await page.textContent('[data-region=sacramento-metro]')).replace(/\s+/g, ' ').slice(0, 200));
// search for the named provider and open its profile
await page.fill('.filters input[type=search]', 'Granite'); await page.click('.filters button:has-text("Search")'); await page.waitForTimeout(1200);
const granite = await page.$$eval('.res-card b', b => b.map(x => x.textContent)); console.log('Granite programs:', granite.length, '|', granite.slice(0, 3).join(' / '));
if (granite.length < 5) errors.push('expected Granite Wellness programs');
await page.click('.res-card'); await page.waitForTimeout(1200);
console.log('profile:', (await page.textContent('h1')).trim(), '| summary starts:', ((await page.textContent('.res-lead').catch(() => '')) || '').slice(0, 60));
console.log('internal note mentions provenance:', /starter directory/.test(await page.textContent('.main')));
await page.screenshot({ path: '/tmp/suds-shots/region-profile.png', fullPage: true });
await page.goto(base + '/#/resources?q=&category=&tag=mat_methadone'); await page.waitForTimeout(1200);
console.log('methadone programs across the region:', await page.$$eval('.res-card', c => c.length));
await page.goto(base + '/#/resources'); await page.waitForTimeout(1500); await page.screenshot({ path: '/tmp/suds-shots/region-directory.png' });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();
