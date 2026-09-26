// Encryption at rest on the device (docs/architecture/ADR-0008-device-encryption.md), on the static build
// ("SUDS on this device") in a real browser: what is actually stored in IndexedDB and localStorage, the
// lock after every page load, a wrong password, a second account, a password change, the save timings,
// a device set up before encryption at rest (its database in the clear, its keys in localStorage)
// sealed at its next sign-in with every plaintext copy gone, and the key rotation after a restore.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { makeChecks, until, settle, saved, signInAgain } from './assert.mjs';

const base = process.env.SUDS_STATIC_URL || 'http://127.0.0.1:8878';
const { ok, eq, fail, finish } = makeChecks('device-encryption');
const PW = 'Navigator2026!!'; const PW2 = 'Second-Person-2026!';
const browser = await chromium.launch();
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', e => errors.push(`PAGEERROR (${tag}) ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_|region-pictures/.test(m.text())) errors.push(`CONSOLE (${tag}) ${m.text().slice(0, 300)}`); });
  return page;
};
const kernel = (page, method, p, body) => page.evaluate(async ([method, p, body]) => { const r = await window.SUDS_LOCAL.handle(method, p, body, { 'X-Requested-With': 'suds' }); return { status: r.status, json: r.json, body: r.body ? Array.from(r.body) : null }; }, [method, p, body]);
// Everything this origin keeps in IndexedDB, as the store holds it: for each key, whether the value contains
// any of `needles` (as bytes, anywhere in it, however it is nested) and what kind of value it is.
const rawStore = (page, needles) => page.evaluate((needles) => new Promise((resolve, reject) => {
  const o = indexedDB.open('suds-local', 1);
  o.onupgradeneeded = () => o.result.createObjectStore('kv');
  o.onerror = () => reject(o.error);
  o.onsuccess = () => {
    const s = o.result.transaction('kv', 'readonly').objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll();
    v.onsuccess = () => {
      const enc = new TextEncoder();
      const bytesOf = (x, out = []) => {
        if (x instanceof ArrayBuffer) out.push(new Uint8Array(x)); else if (ArrayBuffer.isView(x)) out.push(new Uint8Array(x.buffer, x.byteOffset, x.byteLength));
        else if (typeof x === 'string') out.push(enc.encode(x)); else if (x && typeof x === 'object') for (const y of Object.values(x)) bytesOf(y, out);
        return out;
      };
      const has = (hay, n) => { outer: for (let i = 0; i + n.length <= hay.length; i++) { for (let j = 0; j < n.length; j++) if (hay[i + j] !== n[j]) continue outer; return true; } return false; };
      const report = k.result.map((key, i) => {
        const parts = bytesOf(v.result[i]);
        return { key: String(key), kind: v.result[i] && v.result[i].format ? v.result[i].format : typeof v.result[i], bytes: parts.reduce((a, b) => a + b.length, 0), found: needles.filter(n => parts.some(p => has(p, enc.encode(n)))) };
      });
      o.result.close(); resolve(report);
    };
  };
}), needles);
const localStore = (page) => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
const hexKeyIn = (ls) => Object.entries(ls).filter(([, v]) => /[0-9a-f]{64}/i.test(String(v))).map(([k]) => k);
const logout = async (page) => { await page.evaluate(async () => (await import('./app.js')).logout()); await page.waitForSelector('.login input[name=username]'); await settle(page); };
async function tryLogin(page, username, password) {
  await page.fill('.login input[name=username]', username); await page.fill('.login input[name=password]', password);
  await page.click('.login button[type=submit]');
  return until(async () => (await page.$('.layout')) ? 'in' : ((await page.$('.login .banner.danger:not(.hidden)')) ? 'refused' : null), { timeout: 20000 });
}
async function firstRun(page, { name, username, password }) {
  await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  await page.fill('input[name=display_name]', name); await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', password); await page.fill('input[name=confirm]', password);
  await page.selectOption('select[name=role]', 'admin'); // may store documents (the large image below)
  await page.check('input[name=storage_ack]'); await page.click('button[type=submit]');
  await page.waitForSelector('.layout', { timeout: 20000 });
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
}

// ---------------------------------------------------------------------------------------------------------
// 1. A new device: sealed from its first save.
// ---------------------------------------------------------------------------------------------------------
const NAME = { first: 'Quintessa', last: 'Zabriskie', city: 'Xanaduville' };
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = watch(await ctx.newPage(), 'device');
  await firstRun(page, { name: 'Encryption Owner', username: 'owner', password: PW });
  ok(await page.$('.layout'), 'the first account is set up (the notice on that screen is checked in part 3)');
  const c = await kernel(page, 'POST', '/api/clients', { first_name: NAME.first, last_name: NAME.last, city: NAME.city });
  eq(c.status, 201, 'a client is recorded on the device');
  await saved(page);
  const store = await rawStore(page, [NAME.first, NAME.last, NAME.city, 'Encryption Owner', 'SQLite format 3']);
  const image = store.find(x => x.key.startsWith('db2:'));
  ok(image && image.kind === 'suds-sealed-db' && image.bytes > 50000, 'the database in IndexedDB is a sealed image', store);
  eq(store.flatMap(x => x.found).join(','), '', 'nothing stored in IndexedDB contains the client\'s name, a plaintext column (city), the account\'s name, or a SQLite header');
  ok(store.some(x => x.key === 'vault' && x.kind === 'suds-device-vault'), 'the vault is there, beside it');
  ok(!store.some(x => x.key === 'db'), 'and no pre-1.9.3 copy');
  const ls = await localStore(page);
  eq(hexKeyIn(ls).join(','), '', 'localStorage holds no key material (no 256-bit hex value anywhere)');
  ok(!('suds.local.enc' in ls) && !('suds.local.idx' in ls) && !('suds.local.session' in ls), 'no column keys and no session token in localStorage', Object.keys(ls));

  // ---- the lock ----
  await page.reload(); await page.waitForSelector('.layout, .login input[name=username]', { timeout: 20000 });
  ok(!(await page.$('.layout')) && await page.$('.login input[name=username]'), 'after a reload the device is locked: the sign-in form, nothing else');
  eq(await page.evaluate(() => window.SUDS_LOCAL.phase()), 'locked', 'and the kernel has no database open');
  const locked = await kernel(page, 'GET', '/api/clients?limit=5');
  ok(locked.status === 401 && locked.json.locked && !JSON.stringify(locked.json).includes(NAME.last), 'a request for records is refused while locked', locked.json);
  const st = await kernel(page, 'GET', '/api/local/status');
  ok(st.status === 200 && st.json.locked === true && st.json.users === 1, 'the sign-in page still learns that the device has an account', st.json);
  eq(await tryLogin(page, 'owner', 'Not-The-Password-1!'), 'refused', 'a wrong password does not unlock it');
  ok(/incorrect/i.test(await page.textContent('.login .banner.danger')), 'and says so');
  eq(await page.evaluate(() => window.SUDS_LOCAL.phase()), 'locked', 'the device stays locked');
  eq(await tryLogin(page, 'nobody', PW), 'refused', 'nor does a name with no account');
  eq(await tryLogin(page, 'owner', PW), 'in', 'the right password unlocks it');
  eq(await page.evaluate(() => window.SUDS_LOCAL.phase()), 'open', 'the database is open again');
  const back = await kernel(page, 'GET', '/api/clients/' + c.json.id);
  eq(back.json.client && back.json.client.last_name, NAME.last, 'with the client recorded before the reload');

  // ---- signing out locks too ----
  await logout(page);
  eq(await page.evaluate(() => window.SUDS_LOCAL.phase()), 'locked', 'signing out locks the device (the key and the open database are dropped)');
  eq((await kernel(page, 'GET', '/api/clients?limit=5')).status, 401, 'and nothing can be read after it');

  // ---- a second account ----
  await page.click('[data-mode-tab=signup]'); await page.waitForSelector('[data-device-signup]');
  await page.fill('input[name=display_name]', 'Second Person'); await page.fill('input[name=username]', 'second');
  await page.fill('input[name=password]', PW2); await page.fill('input[name=confirm]', PW2);
  await page.fill('input[name=sponsor_username]', 'owner'); await page.fill('input[name=sponsor_password]', PW);
  await page.click('button[type=submit]'); await page.waitForSelector('.layout', { timeout: 20000 });
  for (let i = 0; i < 5; i++) { const b = await page.$('.modal button.primary'); if (!b) break; await b.click(); await settle(page); }
  ok(await page.$('.layout'), 'a second person signs up, let in by the first');
  const vault = await rawStore(page, []);
  ok(vault.find(x => x.key === 'vault'), 'the vault now has a wrap for them');
  await logout(page);
  await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await tryLogin(page, 'second', PW2), 'in', 'after a reload, the second account unlocks the device with its own password');
  eq((await kernel(page, 'GET', '/api/auth/me')).json.user.username, 'second', 'as itself');
  // Their own records only (caseload scoping), but the same database: the owner's client is still there.
  await logout(page);
  eq(await tryLogin(page, 'owner', PW), 'in', 'and the first account still does too');

  // ---- a password change re-wraps ----
  const NEWPW = 'Changed-Password-2026!';
  eq((await kernel(page, 'POST', '/api/auth/password', { current_password: PW, new_password: NEWPW })).status, 200, 'the owner changes their password');
  await logout(page); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await tryLogin(page, 'owner', PW), 'refused', 'the old password no longer unlocks the device');
  eq(await tryLogin(page, 'owner', NEWPW), 'in', 'the new one does');

  // ---- save timings: a database of about 5 MB (a large document), sealed on every save ----
  const blob = 'x'.repeat(16) + Array.from({ length: 2400 * 1024 }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789'[(i * 7919) % 36]).join('');
  const doc = await kernel(page, 'POST', '/api/documents', { title: 'Large reference', category: 'policy', file_url: 'data:text/plain;base64,' + Buffer.from(blob).toString('base64') });
  eq(doc.status, 201, 'a large document is stored on the device');
  await page.evaluate(() => window.SUDS_LOCAL.flush());
  const times = [];
  for (let i = 0; i < 3; i++) {
    await kernel(page, 'PUT', '/api/clients/' + c.json.id, { goals: 'timing ' + i });
    await page.evaluate(() => window.SUDS_LOCAL.flush());
    times.push(await page.evaluate(() => window.SUDS_LOCAL.saveStats()));
  }
  await kernel(page, 'PUT', '/api/clients/' + c.json.id, { goals: 'timing urgent' });
  await page.evaluate(() => window.SUDS_LOCAL.flush({ urgent: true }));
  const urgent = await until(() => page.evaluate(() => { const s = window.SUDS_LOCAL.saveStats(); return s && s.urgent ? s : null; }), { timeout: 10000 });
  console.log('save timings (bytes, export/seal/write/total ms):', JSON.stringify(times), 'urgent:', JSON.stringify(urgent));
  const last = times[times.length - 1];
  ok(last && last.bytes > 4 * 1024 * 1024 && last.total_ms < 3000, 'a ~5 MB image is sealed and saved in well under the coalescing ceiling', last);
  ok(urgent && urgent.total_ms < 5000, 'and the synchronous (unload) path seals it too', urgent);
  const after = await rawStore(page, ['Large reference', 'abcdefghijklmnop', 'SQLite format 3']);
  eq(after.flatMap(x => x.found).join(','), '', 'the large image is sealed as well: no document title, content or SQLite header in IndexedDB');
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------
// 2. A device set up before encryption at rest: its database stored in the clear under db2:<epoch>, its two
//    column keys in localStorage (the 1.9.3–1.11 layout). Built here from a device backup of a real device,
//    written into a new browser profile the way those releases stored it, then opened with this build.
// ---------------------------------------------------------------------------------------------------------
{
  const backupMod = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '../../local/backup.js')).toString('base64'));
  const src = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const sp = watch(await src.newPage(), 'source');
  await firstRun(sp, { name: 'Migrating Owner', username: 'migrant', password: PW });
  eq((await kernel(sp, 'POST', '/api/clients', { first_name: 'Mona', last_name: 'Plaintext', city: 'Oldtownburg' })).status, 201, 'migration: a client on the source device');
  eq((await kernel(sp, 'POST', '/api/local/signup', { display_name: 'Later Person', username: 'later', password: PW2 })).status, 200, 'migration: and a second account on it');
  const b = await kernel(sp, 'POST', '/api/local/backup', { passphrase: 'migration passphrase' });
  eq(b.status, 200, 'migration: its backup is taken');
  const opened = await backupMod.open(Uint8Array.from(b.body), 'migration passphrase');
  ok(backupMod && opened.bytes.length > 50000 && Buffer.from(opened.bytes.subarray(0, 15)).toString() === 'SQLite format 3', 'migration: the database in the clear, and its keys, from that backup');
  await src.close();

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = watch(await ctx.newPage(), 'migrated');
  // A page of this origin that does not start the kernel, to write the old layout.
  await page.goto(base + '/get-app.html');
  const EPOCH = Date.now() - 60000;
  await page.evaluate(async ([bytes, keys, epoch]) => {
    localStorage.setItem('suds.local.enc', keys.enc); localStorage.setItem('suds.local.idx', keys.idx); localStorage.setItem('suds.local.session', 'old-session-token');
    await new Promise((res, rej) => { const o = indexedDB.open('suds-local', 1); o.onupgradeneeded = () => o.result.createObjectStore('kv'); o.onsuccess = () => { const t = o.result.transaction('kv', 'readwrite'); const s = t.objectStore('kv'); s.put(epoch, 'epoch'); s.put(new Uint8Array(bytes), 'db2:' + epoch); s.put(new Uint8Array(bytes), 'db'); t.oncomplete = () => { o.result.close(); res(); }; t.onerror = () => rej(t.error); }; o.onerror = () => rej(o.error); });
  }, [Array.from(opened.bytes), opened.meta.keys, EPOCH]);
  const before = await rawStore(page, ['Oldtownburg', 'SQLite format 3']);
  ok(before.filter(x => x.found.includes('SQLite format 3')).length === 2 && before.some(x => x.found.includes('Oldtownburg')), 'migration: the old layout is in place — the database readable in the clear, twice', before);
  eq(hexKeyIn(await localStore(page)).sort().join(','), 'suds.local.enc,suds.local.idx', 'migration: with both keys in localStorage');

  await page.goto(base + '/'); await page.waitForSelector('.layout, .login input[name=username], .boot.error', { timeout: 20000 });
  ok(await page.$('.login input[name=username]'), 'migration: the new build asks for the password (the old session token is not honoured)');
  eq(await tryLogin(page, 'migrant', PW), 'in', 'migration: signing in with the account\'s password works');
  const mine = (await kernel(page, 'GET', '/api/clients?limit=10')).json.clients.map(x => x.last_name);
  ok(mine.includes('Plaintext'), 'migration: the records are all there', mine);
  await saved(page);
  const sealedNow = await until(async () => { const r = await rawStore(page, ['Oldtownburg', 'Plaintext', 'SQLite format 3']); return r.some(x => x.key === 'vault') && !r.some(x => x.found.length) ? r : null; }, { timeout: 15000 });
  ok(sealedNow, 'migration: after that sign-in nothing in IndexedDB is readable: the image is sealed and the vault written', sealedNow || await rawStore(page, ['Oldtownburg', 'Plaintext', 'SQLite format 3']));
  ok(sealedNow && !sealedNow.some(x => x.key === 'db') && sealedNow.filter(x => x.key.startsWith('db2:')).every(x => x.kind === 'suds-sealed-db'), 'migration: the plaintext copies are gone (the old `db` key too)', sealedNow);
  const lsAfter = await localStore(page);
  eq(hexKeyIn(lsAfter).join(','), '', 'migration: and the keys are gone from localStorage');
  ok(!('suds.local.session' in lsAfter), 'migration: so is the old session token');
  await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await page.evaluate(() => window.SUDS_LOCAL.phase()), 'locked', 'migration: from now on the device starts locked');
  eq(await tryLogin(page, 'migrant', PW), 'in', 'migration: and unlocks with the same password');
  ok((await kernel(page, 'GET', '/api/clients?limit=10')).json.clients.some(x => x.last_name === 'Plaintext' && x.city === 'Oldtownburg'), 'migration: with the records intact, decrypted fields and all');
  // The device's other account had no password typed while it was being sealed, so it has no wrap yet: its
  // first sign-in is vouched for by someone who can unlock the device, and from then on it has its own.
  await logout(page);
  eq(await tryLogin(page, 'later', PW2), 'refused', 'migration: the other account on the device cannot unlock it alone the first time');
  ok(await page.isVisible('.login input[name=sponsor_username]') && /already log in here/.test(await page.textContent('.login')), 'migration: the sign-in form asks for someone who can already log in here');
  await page.fill('.login input[name=sponsor_username]', 'migrant'); await page.fill('.login input[name=sponsor_password]', PW);
  await page.click('.login button[type=submit]'); await page.waitForSelector('.layout', { timeout: 20000 });
  eq((await kernel(page, 'GET', '/api/auth/me')).json.user.username, 'later', 'migration: vouched for, it signs in as itself');
  await logout(page); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await tryLogin(page, 'later', PW2), 'in', 'migration: and next time unlocks the device with its own password alone');
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------
// 3. What the set-up screen says, before any record is entered.
// ---------------------------------------------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = watch(await ctx.newPage(), 'notice');
  await page.goto(base + '/'); await page.waitForSelector('[data-storage-notice]', { timeout: 20000 });
  const notice = await page.textContent('[data-storage-notice]');
  ok(/encrypted with your password/.test(notice) && /cannot be recovered/.test(notice) && /backup/.test(notice), 'the set-up screen says the records are encrypted with the password, and that a forgotten one cannot be recovered without a backup', notice);
  ok(!/keys are kept in the same browser/.test(notice), 'and no longer says the keys sit beside the data');
  await ctx.close();
}

// ---------------------------------------------------------------------------------------------------------
// 4. A restore moves the device off the key its backup carried. The backup holds the restored device's key
//    (next_dek), so whoever has the file and its passphrase, and later the browser's storage, could read what
//    was recorded after the restore; the first backed-up account to sign in rotates it (vault.rekeyAfterRestore).
// ---------------------------------------------------------------------------------------------------------
{
  const here = path.dirname(new URL(import.meta.url).pathname);
  const backupMod = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(here, '../../local/backup.js')).toString('base64'));
  const V = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(here, '../../local/vault.js')).toString('base64'));
  // The sealed image and the vault's sealed column keys, as stored.
  const sealedNow = (page) => page.evaluate(() => new Promise((resolve, reject) => {
    const o = indexedDB.open('suds-local', 1);
    o.onerror = () => reject(o.error);
    o.onsuccess = () => {
      const s = o.result.transaction('kv', 'readonly').objectStore('kv'); const k = s.getAllKeys(); const v = s.getAll();
      v.onsuccess = () => {
        const at = (key) => v.result[k.result.findIndex(x => String(x) === key)];
        const epoch = at('epoch'); const img = at('db2:' + epoch); const vault = at('vault');
        o.result.close();
        resolve({ image: img ? { iv: Array.from(img.iv), ct: Array.from(img.ct) } : null, keys: vault && vault.keys ? { iv: Array.from(vault.keys.iv), ct: Array.from(vault.keys.ct) } : null });
      };
    };
  }));
  const opensWith = async (dekHex, s) => {
    const key = await V.importDek(Uint8Array.from(Buffer.from(dekHex, 'hex')));
    const image = await V.open(key, { format: 'suds-sealed-db', version: 1, iv: Uint8Array.from(s.image.iv), ct: Uint8Array.from(s.image.ct) }).then(() => true, () => false);
    const keys = await V.openKeys(key, { iv: Uint8Array.from(s.keys.iv), ct: Uint8Array.from(s.keys.ct) }).then(() => true, () => false);
    return { image, keys };
  };

  const src = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const sp = watch(await src.newPage(), 'rekey-source');
  await firstRun(sp, { name: 'Rekey Owner', username: 'rkowner', password: PW });
  eq((await kernel(sp, 'POST', '/api/clients', { first_name: 'Before', last_name: 'Backup', city: 'Restoreville' })).status, 201, 'rekey: a client on the source device');
  eq((await kernel(sp, 'POST', '/api/local/signup', { display_name: 'Rekey Second', username: 'rksecond', password: PW2 })).status, 200, 'rekey: and a second account');
  const b = await kernel(sp, 'POST', '/api/local/backup', { passphrase: 'rekey passphrase' });
  eq(b.status, 200, 'rekey: its backup is taken');
  const opened = await backupMod.open(Uint8Array.from(b.body), 'rekey passphrase');
  const known = opened.meta.device && opened.meta.device.next_dek;
  ok(/^[0-9a-f]{64}$/.test(known || ''), 'rekey: the backup carries the restored device\'s key (what its holder would know)');
  await src.close();

  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const page = watch(await ctx.newPage(), 'rekey-restored');
  await page.goto(base + '/'); await page.waitForSelector('input[name=display_name]', { timeout: 20000 });
  const r = await kernel(page, 'POST', '/api/local/restore', { file_b64: Buffer.from(b.body).toString('base64'), passphrase: 'rekey passphrase', confirm: 'RESTORE' });
  eq(r.status, 200, 'rekey: the backup is restored onto a new device', r.json);
  await page.evaluate(() => window.SUDS_LOCAL.flush({ force: true }));
  eq(await page.evaluate(() => window.SUDS_LOCAL.rekeyPending()), true, 'rekey: until someone signs in, the device runs under the backup\'s key');
  const before = await opensWith(known, await sealedNow(page));
  ok(before.image && before.keys, 'rekey: (the window: the restored image opens with the key in the backup)', before);

  const login = await kernel(page, 'POST', '/api/auth/login', { username: 'rkowner', password: PW });
  eq(login.status, 200, 'rekey: the backed-up owner signs in with the password they had', login.json);
  eq(await page.evaluate(() => window.SUDS_LOCAL.rekeyPending()), false, 'rekey: and the device key is rotated at that sign-in');
  eq((await kernel(page, 'POST', '/api/clients', { first_name: 'After', last_name: 'Restore', city: 'Newkeyton' })).status, 201, 'rekey: a client recorded after the restore');
  await page.evaluate(() => window.SUDS_LOCAL.flush({ force: true }));
  const after = await opensWith(known, await sealedNow(page));
  ok(!after.image && !after.keys, 'rekey: neither the stored image nor the vault\'s column keys open with the key in the backup any more', after);

  // The restore was made from the first-run page (#/login?mode=signup): open Log in.
  await page.goto(base + '/#/login?mode=login'); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await tryLogin(page, 'rksecond', PW2), 'in', 'rekey: the second backed-up account, not yet signed in since the restore, still unlocks the device with its old password');
  eq((await kernel(page, 'GET', '/api/auth/me')).json.user.username, 'rksecond', 'rekey: as itself');
  await logout(page); await page.reload(); await page.waitForSelector('.login input[name=username]', { timeout: 20000 });
  eq(await tryLogin(page, 'rkowner', PW), 'in', 'rekey: and the owner signs in again under the new key');
  const mine = (await kernel(page, 'GET', '/api/clients?limit=10')).json.clients;
  ok(mine.some(x => x.last_name === 'Backup') && mine.some(x => x.last_name === 'Restore' && x.city === 'Newkeyton'), 'rekey: with the restored records and what was recorded after the restore', mine.map(x => x.last_name));
  const later = await opensWith(known, await sealedNow(page));
  ok(!later.image && !later.keys, 'rekey: still nothing the backup\'s key opens', later);
  await ctx.close();
}

finish(errors.slice(0, 10));
await browser.close();
