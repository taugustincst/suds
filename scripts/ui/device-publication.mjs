// A publication release on a device (1.17.0): the audit runs in a Web Worker (public/local/audit-worker.js, started
// by local/audit-runner.js), not on the page's thread, and the release prints the reversals by month, not the
// overdose events by month (docs/architecture/ADR-0009, "Where it runs" and "Events by month: not published").
import { chromium } from 'playwright';
import { makeChecks, until, settle, passRecoveryCode } from './assert.mjs';
const { ok, eq, finish } = makeChecks('device-publication');
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
// Count the Web Workers the page starts, and what each says, before any script of the page runs.
await ctx.addInitScript(() => {
  const Real = window.Worker; window.__workers = [];
  if (!Real) return;
  window.Worker = class extends Real {
    constructor(url, opts) {
      super(url, opts);
      const rec = { url: String(url), messages: 0, ready: false, errors: 0 }; window.__workers.push(rec);
      this.addEventListener('message', (e) => { rec.messages++; if (e.data && e.data.ready) rec.ready = true; });
      this.addEventListener('error', () => { rec.errors++; });
    }
  };
});
const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message)); page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto(base + '/?local=1#/');
await until(async () => (await page.$('input[name=username]')) || (await page.$('.boot.error')), { timeout: 20000 });
ok(await page.$('input[name=username]'), 'the device kernel booted and offered first-run setup');
await page.fill('input[name=display_name]', 'Device Admin'); await page.fill('input[name=username]', 'devadmin');
await page.fill('input[name=password]', 'DeviceAdmin2026!!'); await page.fill('input[name=confirm]', 'DeviceAdmin2026!!');
await page.selectOption('select[name=role]', 'admin');
await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 15000 }); await passRecoveryCode(page);
for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
ok(await page.$('.layout'), 'the device is set up and signed in');
// A quarter that has ended, with overdose events in its months (through the device's own API, as the app posts them).
const posted = await page.evaluate(async () => {
  const out = [];
  for (let i = 0; i < 14; i++) {
    const reversed = i % 3 !== 0; const month = ['01', '02', '03'][i % 3];
    const r = await window.SUDS_LOCAL.handle('POST', '/api/overdose-events', { occurred_at: `2025-${month}-1${i % 9}T12:00:00Z`, kind: reversed ? 'reversal' : 'overdose', naloxone_used: reversed, naloxone_doses: reversed ? 1 : 0, administered_by: 'staff', survived: true }, {});
    out.push(r.status);
  }
  return out;
});
ok(posted.every(s => s === 201), 'overdose events recorded on the device', posted);
const workersBefore = await page.evaluate(() => window.__workers.length);
eq(workersBefore, 0, 'no audit worker is started before a release is asked for');
// The release through the device's API: the audit runs in the worker.
const rel = await page.evaluate(async () => {
  const r = await window.SUDS_LOCAL.handle('GET', '/api/reports/funder?from=2025-01-01&to=2025-03-31&purpose=publication', undefined, {});
  return { status: r.status, body: r.json };
});
ok(rel.status === 200 || rel.status === 422, 'the device answered the publication release', rel.status);
const workers = await page.evaluate(() => window.__workers);
eq(workers.length, 1, 'one Web Worker was started for the audit', workers);
ok(workers[0] && /\/local\/audit-worker\.js\?v=/.test(workers[0].url), 'it is the versioned audit worker', workers[0] && workers[0].url);
ok(workers[0] && workers[0].ready && workers[0].messages >= 2 && workers[0].errors === 0, 'the worker started and answered the audit', workers[0]);
if (rel.status === 200) {
  const od = rel.body.overdose;
  eq(od.by_month.length, 3, 'every month of the quarter is listed');
  ok(od.by_month.every(m => !('n' in m) && 'reversals' in m), 'the months print their reversals, not their events', od.by_month);
  ok((rel.body.release.not_published || []).some(x => x.table === 'overdose.by_month.n'), 'the release says the events by month are not part of it', rel.body.release.not_published);
}
// A second release reuses the same worker.
await page.evaluate(() => window.SUDS_LOCAL.handle('GET', '/api/reports/funder?from=2024-10-01&to=2024-12-31&purpose=publication', undefined, {}));
eq(await page.evaluate(() => window.__workers.length), 1, 'the next audit goes to the same worker');
// The page: the reversals by month, and the note on what a release does not print.
await page.goto(base + '/?local=1#/funder?from=2025-01-01&to=2025-03-31&purpose=publication');
await until(async () => (await page.$('[data-run-kind="publication"]')) || (await page.$('.banner.error')), { timeout: 20000 });
await settle(page);
if (rel.status === 200) {
  ok(await page.$('h2:has-text("Reversals by month")'), 'the publication page draws the reversals by month');
  ok(await page.$('[data-not-published="overdose.by_month.n"]'), 'and says the events by month are not part of a publication release');
}
ok(errors.length === 0, 'no page errors', errors);
await browser.close();
finish();
