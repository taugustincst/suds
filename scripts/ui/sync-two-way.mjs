import { chromium } from 'playwright';
const base = process.env.SUDS_URL || 'http://127.0.0.1:8090';
import('node:fs').then(m => m.mkdirSync('/tmp/suds-shots', { recursive: true }));
const browser = await chromium.launch(); const ctx = await browser.newContext(); const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
const api = (m, p, b) => page.evaluate(([m, p, b]) => window.SUDS_LOCAL.handle(m, p, b, {}).then(r => r.json), [m, p, b]);
// fresh device, set up, sync
await page.goto(base + '/?local=1#/'); await page.waitForTimeout(2500);
await page.fill('input[name=display_name]', 'Dev Two'); await page.fill('input[name=username]', 'mrivera'); await page.fill('input[name=password]', 'Navigator2026!!'); await page.fill('input[name=confirm]', 'Navigator2026!!'); await page.click('button[type=submit]'); await page.waitForSelector('.layout'); await page.waitForTimeout(500);
const s1 = await api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' }); console.log('sync1 pulled clients:', s1.pulled.clients, 'pushed:', JSON.stringify(s1.pushed));
const me = await api('GET', '/api/auth/me'); console.log('device user after merge:', me.user.username, me.user.role);
// office edits a client (as mrivera via server API); device edits another field of a different client offline
const srv = await ctx.request.newContext ? null : null;
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Sync-Client': '1' }, body: JSON.stringify({ username: 'mrivera', password: 'Navigator2026!!' }) }).then(r => r.json());
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', Authorization: 'Bearer ' + login.token };
const list = await fetch(base + '/api/clients?limit=5', { headers: H }).then(r => r.json()); const target = list.clients[0];
await fetch(base + '/api/clients/' + target.id, { method: 'PUT', headers: H, body: JSON.stringify({ goals: 'Goal set at the office ' + Date.now() }) });
const other = list.clients[1];
await api('PUT', '/api/clients/' + other.id, { goals: 'Goal set on the phone ' + Date.now() });
const s2 = await api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' }); console.log('sync2 pulled clients:', s2.pulled.clients, 'pushed clients:', s2.pushed.clients);
const devView = await api('GET', '/api/clients/' + target.id); console.log('device sees office goal:', /office/.test(devView.client.goals));
const srvView = await fetch(base + '/api/clients/' + other.id, { headers: H }).then(r => r.json()); console.log('office sees phone goal:', /phone/.test(srvView.client.goals));
// delete on device → tombstone → server
const iv = await api('POST', '/api/interventions', { client_id: other.id, type: 'outreach', occurred_at: new Date().toISOString(), duration_minutes: 5 });
await api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' });
const onServer = await fetch(base + '/api/interventions/' + iv.id, { headers: H }).then(r => r.status); console.log('pushed intervention on server:', onServer);
await api('DELETE', '/api/interventions/' + iv.id, {});
const s4 = await api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' });
const afterDel = await fetch(base + '/api/interventions/' + iv.id, { headers: H }).then(r => r.status); console.log('after device delete, server status:', afterDel, '(404 expected)');
// note authored on device with content roundtrip
const n = await api('POST', '/api/notes', { client_id: other.id, kind: 'admin', content: 'Written offline on the phone.', occurred_at: new Date().toISOString() });
await api('POST', '/api/local/sync', { server: base, username: 'mrivera', password: 'Navigator2026!!' });
const srvNote = await fetch(base + '/api/notes/' + n.id, { headers: H }).then(r => r.json()); console.log('office reads phone note:', srvNote.note && srvNote.note.content);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'NO ERRORS'); if (errors.length) process.exitCode = 1;
await browser.close();
