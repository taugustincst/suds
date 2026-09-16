'use strict';
process.env.SUDS_ENV = 'test';
process.env.SUDS_DB_PATH = ':memory:';
process.env.SUDS_ADMIN_PASSWORD = 'AdminPassw0rd!x';
const http = require('node:http');
const db = require('../server/db');
const { createHandler } = require('../server/app');
const { ensureBootstrap } = require('../server/bootstrap');
const { hashPassword, uuid } = require('../server/crypto');

let server, base;
async function start() {
  if (server) return base;
  db.open(':memory:');
  ensureBootstrap();
  db.run(`UPDATE users SET must_change_password=0`);
  const handler = createHandler();
  server = http.createServer(handler);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
async function stop() { if (server) { await new Promise(res => server.close(res)); server = null; } db.close(); }

function client() {
  let cookie = '';
  const headers = {};
  async function req(method, path, body, extra = {}) {
    const h = { 'Content-Type': 'application/json', 'X-Requested-With': 'suds', ...headers, ...extra };
    if (cookie) h.Cookie = cookie;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)) });
    const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  return {
    req, get: (p, e) => req('GET', p, undefined, e), post: (p, b, e) => req('POST', p, b, e), put: (p, b, e) => req('PUT', p, b, e), del: (p, b, e) => req('DELETE', p, b, e),
    setHeader: (k, v) => { headers[k] = v; },
    async login(username, password) { const r = await req('POST', '/api/auth/login', { username, password }); if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.data)); return r.data; },
  };
}

function makeUser(username, role, password = 'StaffPassw0rd!x') {
  const id = uuid();
  db.run(`INSERT INTO users(id,username,password_hash,display_name,role,password_changed_at) VALUES(?,?,?,?,?,?)`, id, username, hashPassword(password), username, role, db.now());
  return { id, username, password };
}

module.exports = { start, stop, client, makeUser, db };
