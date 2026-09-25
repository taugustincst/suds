'use strict';
// What SUDS generates from text people typed: PDFs (server/pdf.js — consents, county forms, blank
// templates), download names in Content-Disposition, and the security headers every response carries.
// A client named `<script>`, a witness called `) Tj ET`, a file named with a CR/LF must come out inert.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const H = require('./helpers');
const pdf = require('../server/pdf');
const config = require('../server/config');

const EVIL = [
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', ') Tj ET BT /F1 99 Tf 0 0 Td (pwned', '\\) Tj (\\', '((nested)) \\\\ back',
  'line one\r\nline two\rline three', 'endstream endobj 9 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj', '%PDF-1.4 %%EOF',
  'Zoë Ångström — naïve “quotes” 文件 😀', '\u0000\u0007\u001b[31m control', '/OpenAction << /S /URI /URI (https://evil.example) >>',
];

let admin, base;
before(async () => { base = await H.start(); admin = H.client(); await admin.login('admin', 'AdminPassw0rd!x'); });
after(async () => { await H.stop(); });

/** Every text-showing operator in every content stream must be exactly one well-formed literal string. */
function assertInertPdf(buf, label) {
  const s = buf.toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4\n'), label);
  const streams = [...s.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m => m[1]);
  assert.ok(streams.length > 0, label);
  const STRING = String.raw`\((?:[^()\\\r\n]|\\[\\()])*\)`;
  const TEXT = new RegExp(String.raw`^BT /F[12] [\d.]+ Tf [\d. ]+ rg [\d.]+ [\d.-]+ Td ${STRING} Tj ET$`);
  for (const st of streams) {
    for (const line of st.split('\n')) {
      if (line.startsWith('BT')) assert.match(line, TEXT, `${label}: a text operator was broken out of: ${line}`);
      else assert.match(line, /^[\d. ]+ (RG|rg) [\d. ]+w [\d. -]+ (m [\d. -]+ l|re) S$/, `${label}: unexpected operator: ${line}`);
    }
  }
  // The document structure is the writer's alone: fonts, pages, one catalog. No actions, no scripts.
  const outside = s.replace(/stream\n[\s\S]*?\nendstream/g, '');
  for (const bad of ['/JavaScript', '/JS', '/OpenAction', '/AA', '/URI', '/Launch', '/EmbeddedFile', '/SubmitForm']) assert.ok(!outside.includes(bad), `${label}: ${bad} outside a string`);
  assert.equal((s.match(/\/Type \/Catalog/g) || []).length, 1, `${label}: one catalog`);
  assert.equal((outside.match(/%%EOF/g) || []).length, 1, `${label}: typed text cannot end the file early`);
}

test('the PDF writer escapes everything typed into it', () => {
  const buf = pdf.renderForm({ title: EVIL[2], subtitle: EVIL[6], org: EVIL[3], meta: EVIL.slice(0, 3), fields: [
    { type: 'section', label: EVIL[4] }, { type: 'note', label: EVIL[10] },
    ...EVIL.map((e, i) => ({ key: 'f' + i, label: e, type: i % 3 === 0 ? 'textarea' : i % 3 === 1 ? 'signature' : 'text' })), { key: 'cb', label: EVIL[1], type: 'checkbox' },
  ], values: Object.fromEntries(EVIL.map((e, i) => ['f' + i, e])), footer: EVIL[7] });
  assertInertPdf(buf, 'renderForm');
});

test('a consent PDF naming a client and witness with markup and PDF syntax is inert', async () => {
  const c = await admin.post('/api/clients', { first_name: EVIL[0], last_name: EVIL[2], preferred_name: EVIL[1], confirm_duplicate: true });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const k = await admin.post(`/api/clients/${c.data.id}/consents`, { type: 'part2_disclosure', recipient: EVIL[1], purpose: EVIL[3], scope: EVIL[6], signed_at: '2026-01-10',
    expires_at: '2027-01-10', witness: EVIL[2].slice(0, 120), document_ref: EVIL[10], signer_relationship: 'parent_or_guardian', signer_name: EVIL[5], signed_on_paper: true,
    redisclosure_notice_given: true, revocation_right_given: true, refusal_consequences_given: true });
  assert.equal(k.status, 201, JSON.stringify(k.data));
  const res = await admin.raw(`/api/consents/${k.data.id}/pdf`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/pdf/);
  assertDisposition(res.headers.get('content-disposition'), 'inline');
  const raw = Buffer.from(await res.arrayBuffer());
  assertInertPdf(raw, 'consent PDF');
  assert.ok(raw.toString('latin1').includes('\\) Tj ET BT'), 'the text is there, escaped');
});

test('a blank form template with a hostile name: inert PDF and a safe download name', async () => {
  const t = await admin.post('/api/forms/templates', { name: 'Intake "form"\r\nSet-Cookie: pwned=1; ) Tj ( 文件', fields: [{ key: 'a', label: EVIL[2], type: 'text' }] });
  assert.equal(t.status, 201, JSON.stringify(t.data));
  const res = await admin.raw(`/api/forms/templates/${t.data.id}/blank.pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null, 'no header was injected');
  assertDisposition(res.headers.get('content-disposition'), 'inline', 'Intake "form"Set-Cookie: pwned=1; ) Tj ( 文件-blank.pdf');
  assertInertPdf(Buffer.from(await res.arrayBuffer()), 'blank template');
});

/** One quoted ASCII filename with nothing that could end it early, plus the exact name in filename*. */
function assertDisposition(v, type, expectedName) {
  assert.ok(v, 'Content-Disposition is set');
  assert.ok(!/[\r\n]/.test(v));
  const m = /^(inline|attachment); filename="([\x20-\x7e]*)"(?:; filename\*=UTF-8''([A-Za-z0-9%\-_.!~]*))?$/.exec(v);
  assert.ok(m, `well-formed: ${v}`);
  assert.equal(m[1], type);
  assert.ok(!/["\\;]/.test(m[2]), `no quote, backslash or semicolon in the quoted name: ${m[2]}`);
  if (expectedName !== undefined) assert.equal(m[3] ? decodeURIComponent(m[3]) : m[2], expectedName);
}

test('downloads named by an uploader: no header injection, and a non-Latin name no longer breaks the download', async () => {
  const fake = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n%%EOF').toString('base64');
  for (const filename of ['policy"; filename=evil.exe', 'a\r\nSet-Cookie: x=1\r\n.pdf', 'back\\slash\\', '政策文件.pdf', 'résumé.pdf', 'plain-name.pdf', '%22.pdf']) {
    const d = await admin.post('/api/documents', { title: 'Doc ' + filename.slice(0, 5), category: 'policy', file_url: fake, filename });
    assert.equal(d.status, 201, JSON.stringify(d.data));
    const res = await admin.raw(`/api/documents/${d.data.id}/file`);
    assert.equal(res.status, 200, filename);
    assert.equal(res.headers.get('set-cookie'), null);
    assertDisposition(res.headers.get('content-disposition'), 'attachment', filename.replace(/[\r\n]/g, ''));
    const inline = await admin.raw(`/api/documents/${d.data.id}/file?inline=1`);
    assertDisposition(inline.headers.get('content-disposition'), 'inline');
  }
  const { contentDisposition } = require('../server/http');
  assert.equal(contentDisposition('attachment', 'plain.pdf'), 'attachment; filename="plain.pdf"');
  assert.equal(contentDisposition('attachment', ''), 'attachment; filename="download"');
  assert.equal(contentDisposition('evil\r\n', 'x'), 'attachment; filename="x"', 'the disposition type is never taken from input');
});

test('security headers on the app shell, the API and static files', async () => {
  for (const p of ['/', '/api/health', '/app.js', '/api/auth/me', '/nope.js']) {
    const res = await fetch(base + p);
    const h = (k) => res.headers.get(k) || '';
    const csp = Object.fromEntries(h('content-security-policy').split(';').map(x => x.trim().split(/\s+/)).filter(x => x[0]).map(([k, ...v]) => [k, v]));
    assert.ok(csp['script-src'], p);
    assert.deepEqual(csp['script-src'].filter(x => /unsafe-inline|unsafe-eval|\*|data:|blob:|https?:/.test(x) && x !== "'wasm-unsafe-eval'"), [], `${p}: script-src allows only same-origin scripts (and WebAssembly for the device kernel)`);
    assert.ok(!Object.entries(csp).some(([k, v]) => k !== 'script-src' && v.includes("'wasm-unsafe-eval'")), 'wasm only where scripts are');
    assert.deepEqual(csp['default-src'], ["'self'"]);
    assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
    assert.deepEqual(csp['base-uri'], ["'none'"]);
    assert.deepEqual(csp['form-action'], ["'self'"]);
    assert.equal(csp['object-src'], undefined, 'object-src falls back to default-src self');
    assert.equal(h('x-content-type-options'), 'nosniff', p);
    assert.equal(h('x-frame-options'), 'DENY', p);
    assert.equal(h('referrer-policy'), 'no-referrer', p);
    assert.equal(h('cache-control').includes('no-store') || p === '/app.js', true, p);
    assert.equal(h('strict-transport-security'), '', `${p}: no HSTS over plain http`);
  }
  // The app shell carries no inline script for the CSP to have to allow.
  const html = await (await fetch(base + '/')).text();
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script> in index.html');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline event handlers in index.html');
});

test('HSTS: sent when this process terminates TLS, or when a trusted proxy says the request came over https', async () => {
  const saved = { cert: config.tls.cert, trust: config.trustProxy };
  try {
    config.trustProxy = false;
    assert.equal((await fetch(base + '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security'), null, 'an untrusted header is ignored');
    config.trustProxy = true;
    assert.equal((await fetch(base + '/api/health', { headers: { 'X-Forwarded-Proto': 'http' } })).headers.get('strict-transport-security'), null);
    assert.match((await fetch(base + '/api/health', { headers: { 'X-Forwarded-Proto': 'https' } })).headers.get('strict-transport-security') || '', /^max-age=31536000; includeSubDomains$/);
    config.trustProxy = false; config.tls.cert = '/some/cert.pem';
    assert.match((await fetch(base + '/api/health')).headers.get('strict-transport-security') || '', /max-age=31536000/);
  } finally { config.tls.cert = saved.cert; config.trustProxy = saved.trust; }
});
