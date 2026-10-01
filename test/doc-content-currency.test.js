'use strict';
// test/doc-currency.test.js keeps three version lines on the stamped minor. The market review of 1.20.0 found that
// was not enough: the documents' version lines said 1.20.0 while their content stopped at 1.19.0 (no county.entry.*
// audit action in LOGGING-AND-AUDIT, the threat model "describes 1.19.0", the README's "What's new" at 1.19.0, the
// hosting page's "Current status (1.19.0)", the authorship figures "in the history of 1.19.0"). This ties content,
// mechanically, to what the code and the newest stamped release hold:
//
//   1. Every audit action the server writes is named, in backticks, in docs/security/LOGGING-AND-AUDIT.md (its
//      *Audit action catalogue*), unless INTERNAL below lists it with a reason. Actions are collected from
//      server/**/*.js: string literals in an `action: …` or `action = …` expression (both branches of a ternary),
//      and the action argument of routes/county.js's `throttle(ctx, bucket, action, …)`. Actions built from a
//      template (`${entity}.view`) are described in the catalogue by pattern and are not collected.
//   2. The newest migration (server/db.js's `// N:` comments), and every migration the newest stamped CHANGELOG
//      section names, is named in docs/security/DATA-INVENTORY.md (*Schema versions*).
//   3. Every line in the documents that says which release it is current for ("describes X.Y.Z", "Current status
//      (X.Y.Z)", "State on … (X.Y.Z)", "the history of X.Y.Z", "X.Y.Z, the latest release", "X.Y.x is the latest
//      minor", README's "What's new" heading) names the stamped minor line; the threat model's *Version.* line is
//      one of them.
//   4. Every document a buyer reads (BUYER_DOCS) names a version on the stamped minor line at least once: a new
//      minor that no buyer document mentions was not written up for buyers.
//
// "Stamped" is as in test/doc-currency.test.js: package.json's version once its CHANGELOG heading has a date, else
// the newest dated one. The evidence folders (docs/evidence/<run>/) describe their own run and are not checked.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const rel = (p) => path.relative(ROOT, p);
const parse = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = parse(a); const y = parse(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const minor = (v) => parse(v).slice(0, 2).join('.');
const flat = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ');

function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out); else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

/** The stamped version and the text of its CHANGELOG section. */
function stampedRelease() {
  const log = read('CHANGELOG.md');
  const heads = [...log.matchAll(/^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/gm)];
  const dated = heads.map(m => m[1]).sort(cmp).reverse();
  const pkg = require('../package.json').version;
  const version = dated.includes(pkg) ? pkg : dated[0];
  const at = heads.find(m => m[1] === version).index;
  const next = log.slice(at + 1).search(/^## /m);
  return { version, section: next < 0 ? log.slice(at) : log.slice(at, at + 1 + next) };
}

// ---- 1. Audit actions ----

/** Actions written by code that no buyer or auditor searches for, each with the reason. Keep it short. */
const INTERNAL = new Map([
]);
// A whole action: dotted, lower case, not ending in "_" or "." (a prefix such as 'auth.login.access_' + status is
// described in the catalogue by pattern).
const ACTION = /^[a-z][a-z0-9_]*(\.[a-z0-9_]*[a-z0-9])+$/;

/** Every audit action literal in a file's text. */
function actionsIn(text) {
  const out = new Set();
  for (const m of text.matchAll(/\baction\s*(?::|=(?![=>]))\s*([^,;\n}]+)/g)) {
    for (const q of m[1].matchAll(/'([^'\\]*)'/g)) if (ACTION.test(q[1])) out.add(q[1]);
  }
  for (const m of text.matchAll(/\bthrottle\(ctx,\s*'[^']*',\s*'([^']+)'/g)) if (ACTION.test(m[1])) out.add(m[1]);
  // A constant used as the action (routes/overdose.js: `action: FATAL_APPLIED`).
  for (const m of text.matchAll(/\baction:\s*([A-Z][A-Z0-9_]+)\b/g)) {
    const c = text.match(new RegExp(`\\bconst ${m[1]}\\s*=\\s*'([^']+)'`));
    if (c && ACTION.test(c[1])) out.add(c[1]);
  }
  return out;
}

/** Every audit action the server writes: Map(action → first file). */
function serverActions() {
  const out = new Map();
  for (const f of walk(path.join(ROOT, 'server'), '.js').sort()) {
    for (const a of actionsIn(fs.readFileSync(f, 'utf8'))) if (!out.has(a)) out.set(a, rel(f));
  }
  return out;
}

test('every audit action the server writes is in LOGGING-AND-AUDIT.md', () => {
  const doc = read('docs/security/LOGGING-AND-AUDIT.md');
  const missing = [...serverActions()].filter(([a]) => !INTERNAL.has(a) && !doc.includes('`' + a + '`')).map(([a, f]) => `${a} (${f})`);
  assert.deepEqual(missing, [], 'name each action in docs/security/LOGGING-AND-AUDIT.md, *Audit action catalogue*, in backticks under its area, with what the entry records');
});

test('LOGGING-AND-AUDIT.md names no audit action the server no longer writes', () => {
  // Only the catalogue is checked (the prose names read-side actions such as the SQL filters use), so the catalogue
  // does not keep an action that was renamed or removed.
  const doc = read('docs/security/LOGGING-AND-AUDIT.md');
  const cat = doc.split(/^## /m).find(s => s.startsWith('Audit action catalogue'));
  assert.ok(cat, 'LOGGING-AND-AUDIT.md has a section "## Audit action catalogue"');
  const actions = serverActions();
  const named = [...cat.matchAll(/`([a-z][a-z0-9_.]*)`/g)].map(m => m[1]).filter(a => ACTION.test(a));
  const stale = [...new Set(named.filter(a => !actions.has(a) && !INTERNAL.has(a)))];
  assert.deepEqual(stale, [], 'these are in the catalogue but no server code writes them: remove or rename them');
});

// ---- 2. Migrations ----

/** The newest migration's number: the highest `// N:` comment in server/db.js's migrations list. */
function newestMigration() {
  return Math.max(...[...read('server/db.js').matchAll(/^\s*\/\/ (\d+): /gm)].map(m => Number(m[1])));
}
/** Migration numbers a text names: "migration 60", "migrations 58 and 59", "migrations 56, 57 and 58". */
function migrationsNamed(text) {
  const out = new Set();
  for (const m of flat(text).matchAll(/\b[Mm]igrations? ((?:\d+)(?:(?:, | and | to |–|-)\d+)*)/g)) {
    for (const n of m[1].match(/\d+/g)) out.add(Number(n));
  }
  return out;
}

test('DATA-INVENTORY.md names the newest migration and those the stamped release added', () => {
  const doc = migrationsNamed(read('docs/security/DATA-INVENTORY.md'));
  const { version, section } = stampedRelease();
  const want = new Set([newestMigration(), ...migrationsNamed(section)]);
  const missing = [...want].filter(n => !doc.has(n)).sort((a, b) => a - b);
  assert.deepEqual(missing, [], `name each in docs/security/DATA-INVENTORY.md, *Schema versions* ("migration N": what it adds to what is stored), for ${version}`);
});

// ---- 3. Lines that say which release they are current for ----

/** Documents checked: README.md, SECURITY.md and docs/**, less the evidence runs' own folders. */
function docs() {
  const out = [path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')].filter(f => fs.existsSync(f));
  for (const f of walk(path.join(ROOT, 'docs'), '.md')) {
    const r = rel(f).split(path.sep);
    if (r[1] === 'evidence' && r.length > 3) continue;
    out.push(f);
  }
  return out;
}
const CURRENT_FOR = [
  /\bdescribes (\d+\.\d+\.\d+)/gi,
  /\bCurrent status \((\d+\.\d+\.\d+)\)/gi,
  /\bState on [^()|]{1,40}\((\d+\.\d+\.\d+)\)/gi,
  /\bthe history of (\d+\.\d+\.\d+)/gi,
  /\b(\d+\.\d+\.\d+),? the latest release/gi,
  /\b(\d+\.\d+)\.x is the latest minor/gi,
];
/** Versions a text says it is current for: [version, context]. */
function currentFor(text) {
  const out = [];
  const t = flat(text);
  for (const re of CURRENT_FOR) {
    for (const m of t.matchAll(re)) out.push([/^\d+\.\d+$/.test(m[1]) ? `${m[1]}.0` : m[1], t.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10)]);
  }
  return out;
}
/** A version is current for `version` when it is on its minor line and not above it. */
const onLine = (v, version) => minor(v) === minor(version) && cmp(v, version) <= 0;

test('every "describes / current status / state on / history of / latest release" line names the stamped minor', () => {
  const { version } = stampedRelease();
  const stale = [];
  for (const f of docs()) for (const [v, c] of currentFor(fs.readFileSync(f, 'utf8'))) if (!onLine(v, version)) stale.push(`${rel(f)} (${v}): "…${c}…"`);
  assert.deepEqual(stale, [], `the ${minor(version)} line (${version}) is stamped: say what is true of it, or word the line so it does not go stale`);
});

test('the threat model and the README\'s "What\'s new" name the stamped minor', () => {
  const { version } = stampedRelease();
  const tm = read('docs/security/THREAT-MODEL.md').match(/^\*\*Version\.\*\*\s*It describes (\d+\.\d+\.\d+)/m);
  assert.ok(tm, 'docs/security/THREAT-MODEL.md has a line "**Version.** It describes X.Y.Z"');
  assert.ok(onLine(tm[1], version), `THREAT-MODEL.md describes ${tm[1]}; ${version} is stamped`);
  const heads = [...read('README.md').matchAll(/^#+ What's new in (.+)$/gm)];
  assert.ok(heads.length, 'README.md has a "What\'s new in …" heading');
  const named = [...heads[0][1].matchAll(/(\d+\.\d+\.\d+)/g)].map(m => m[1]);
  assert.ok(named.some(v => onLine(v, version)), `README.md's first "What's new" names ${named.join(', ')}; ${version} is stamped`);
});

// ---- 4. Buyer documents mention the stamped minor ----

const BUYER_DOCS = [
  'README.md',
  'docs/security/QUESTIONNAIRE.md', 'docs/security/ARCHITECTURE.md', 'docs/security/DATA-LIFECYCLE.md',
  'docs/security/DATA-INVENTORY.md', 'docs/security/LOGGING-AND-AUDIT.md', 'docs/security/THREAT-MODEL.md',
  'docs/market/README.md', 'docs/market/BUYER-GUIDE-IT.md', 'docs/market/BUYER-GUIDE-PROGRAM.md',
  'docs/market/PILOT-KIT.md', 'docs/market/STRATEGY.md', 'docs/market/EVALUATION-RESPONSE.md',
];

test('every buyer document names a version on the stamped minor line', () => {
  const { version } = stampedRelease();
  const silent = BUYER_DOCS.filter(f => ![...read(f).matchAll(/\b(\d+\.\d+\.\d+)\b/g)].some(m => onLine(m[1], version)));
  assert.deepEqual(silent, [], `these never mention ${minor(version)}: say what ${minor(version)} changed for their reader (or that it changed nothing)`);
});

// ---- 5. Released features are not called unbuilt or planned (built for 1.22.0) ----
// The market review of 1.21.0 found documents a buyer reads still calling released features unbuilt: COUNTY-KIT
// "until the publication screen … exists", DATA-NETWORK "Not built: the publication screen", DEMO-SCRIPT naming the
// field device scope as planned, and the data contribution agreement saying SUDS has no publication function. This
// keeps it mechanical: each feature phrase below, with the release that shipped it (whose CHANGELOG heading has a
// date), is looked for in every buyer, market and security document; a sentence that names it and says "not built",
// "planned", "not yet" or "until … exists" fails. A sentence that also says "released" (or is struck through) is
// about the release that shipped it and is not flagged. Add a row when a release ships what the documents called planned.
const RELEASED_FEATURES = [
  [/\bcounty view\b/i, '1.18.0'],
  [/\bcounty connection\b/i, '1.18.0'],
  [/\bfingerprint sign-in\b/i, '1.19.0'],
  [/\bcounty-entered figures\b|\bfigures (?:that )?the county enter(?:s|ed)\b/i, '1.20.0'],
  [/\bpublication screen\b/i, '1.21.0'],
  [/\bpublication function\b/i, '1.21.0'],
  [/\bfield[- ]device scope\b/i, '1.21.0'],
  [/\bauthenticator allow-list\b/i, '1.21.0'],
  [/\baward amounts\b/i, '1.21.0'],
];
const UNBUILT = /\bnot built\b|\bplanned\b|\bnot yet\b|\buntil\b[^.;]*\bexists?\b|\bha(?:s|ve) no\b[^.;]*\bfunction\b/i;
/** Buyer, market and security documents: README.md, SECURITY.md, BUYER_DOCS, docs/market/** and docs/security/**. */
function buyerFacing() {
  const out = new Set(['README.md', 'SECURITY.md', ...BUYER_DOCS].filter(f => fs.existsSync(path.join(ROOT, f))));
  for (const d of ['docs/market', 'docs/security']) for (const f of walk(path.join(ROOT, d), '.md')) out.add(rel(f));
  return [...out].sort();
}
/** The sentences of a Markdown text: paragraphs, list items and table rows, each split at . ! ? and ;. */
function sentences(text) {
  const blocks = [];
  let cur = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || /^(?:[-*+]|\d+\.)\s/.test(t) || t.startsWith('#') || t.startsWith('|')) { if (cur.length) blocks.push(cur.join(' ')); cur = []; }
    // A table row is one unit (a feature in one cell, its state in the next), its cells joined by " — ".
    if (t.startsWith('|')) { blocks.push(t.replace(/^\|\s*|\s*\|$/g, '').split(/\s\|\s/).join(' — ')); continue; }
    if (t) cur.push(t.replace(/^(?:[-*+]|\d+\.)\s+/, ''));
  }
  if (cur.length) blocks.push(cur.join(' '));
  return blocks.flatMap(b => flat(b).split(/(?<=[.!?;])\s+/)).filter(Boolean);
}
/** Each sentence that names a released feature and calls it unbuilt: [feature, release, sentence]. */
function unbuiltClaims(text, released) {
  const out = [];
  for (const s of sentences(text)) {
    if (!UNBUILT.test(s) || /\breleased\b|~~/i.test(s)) continue;
    for (const [re, v] of RELEASED_FEATURES) if (released(v) && re.test(s)) out.push([re.source, v, s]);
  }
  return out;
}

test('no buyer, market or security document calls a released feature "not built", "planned", "not yet" or "until … exists"', () => {
  const { version } = stampedRelease();
  const log = read('CHANGELOG.md');
  for (const [, v] of RELEASED_FEATURES) assert.match(log, new RegExp(`^## ${v.replace(/\./g, '\\.')} — \\d{4}-\\d{2}-\\d{2}\\s*$`, 'm'), `${v} is a dated release in CHANGELOG.md`);
  const released = (v) => cmp(v, version) <= 0;
  const stale = [];
  for (const f of buyerFacing()) for (const [, v, s] of unbuiltClaims(read(f), released)) stale.push(`${f}: released in ${v}, but "${s.slice(0, 220)}"`);
  assert.deepEqual(stale, [], 'say what was released (and what is still not built) instead');
});

// ---- 6. The authenticator allow-list's grace period (built for 1.22.0) ----
// The integration review of 1.22.0 found QUESTIONNAIRE #19a and the RFI template (written in the same release) saying
// turning the allow-list on "ends unproven passkeys with no grace period", which the grace period built beside them
// made false. A buyer-facing sentence about the allow-list that says "no grace period" must say it of 1.21.0 or of a
// model reported compromised or revoked (which never gets one).
function graceClaims(text) {
  return sentences(text).filter(s => /allow-list|unproven passkeys|not proven at enrolment/i.test(s) && /\bno grace period\b/i.test(s) && !/1\.21\.0|compromised|revoked/i.test(s));
}
test('no buyer, market or security document says the authenticator allow-list stops passkeys with no grace period', () => {
  const stale = [];
  for (const f of buyerFacing()) for (const s of graceClaims(read(f))) stale.push(`${f}: "${s.slice(0, 220)}"`);
  assert.deepEqual(stale, [], 'the grace period (docs/FINGERPRINT.md, Grace period) keeps such passkeys working for 0 to 90 days');
  assert.equal(graceClaims('Turning it on also ends existing unproven passkeys, with no grace period.').length, 1);
  assert.equal(graceClaims('Under 1.21.0 turning the allow-list on ended them with no grace period.').length, 0);
});

test('the checks find what they are for', () => {
  // Released features called unbuilt: what the review of 1.21.0 found, and what is fine.
  const all = () => true;
  for (const s of ['nothing on the county view is for publication until the publication screen over the combined release exists.',
    '**Not built:** the publication screen over the combined release (so nothing from the county view can be published), and the template.',
    'Planned capabilities (the referral network, the outcomes dataset, a field device scope, a published county dashboard) are named as planned.',
    'The SUDS county view and its files are labelled internal and exact and have no publication function.',
    '| Authenticator allow-list | Not yet |']) assert.ok(unbuiltClaims(s, all).length, s);
  for (const s of ['The publication screen is released in 1.21.0.', 'A published county dashboard is planned.', '~~Publication screen~~: not built until 1.21.0.',
    'The county view was planned in 1.17.0 and released in 1.18.0.', 'Each consent in the county view is built for 1.22.0, not yet released.']) assert.deepEqual(unbuiltClaims(s, all), [], s);
  assert.equal(unbuiltClaims('The publication screen is planned.', (v) => v === '1.18.0').length, 0, 'a feature not yet released may be called planned');
  assert.deepEqual(sentences('A first. A second; a third\n\n- an item\n| cell one | cell two |'), ['A first.', 'A second;', 'a third', 'an item', 'cell one — cell two']);

  // Audit actions: both branches of a ternary, a const, the throttle helper; never a non-action string.
  assert.deepEqual([...actionsIn(`audit.log({ user, action: entered ? 'county.entry.withdraw' : 'county.submission.withdraw', ip })`)].sort(), ['county.entry.withdraw', 'county.submission.withdraw']);
  assert.deepEqual([...actionsIn(`const action = out.status === 'duplicate' ? 'county.submission.duplicate' : 'county.submission.import';`)].sort(), ['county.submission.duplicate', 'county.submission.import']);
  assert.deepEqual([...actionsIn(`throttle(ctx, 'county-entry-refuse', 'county.entry.throttled', 'Too many')`)], ['county.entry.throttled']);
  assert.deepEqual([...actionsIn(`{ label: 'x', action: 'Recovery Café; sister' }`)], []);
  assert.deepEqual([...actionsIn(`const FATAL = 'overdose_event.fatal_outcome';\naudit.log({ user, action: FATAL, ip });`)], ['overdose_event.fatal_outcome']);
  assert.deepEqual([...actionsIn(`audit.log({ user: who, action: 'auth.login.access_' + user.access_status })`)], []);
  assert.ok(serverActions().has('county.entry.create'), 'the 1.20.0 action is collected from server/routes/county.js');
  // Migrations: every spelling the CHANGELOG uses.
  assert.deepEqual([...migrationsNamed('Migration 60 and new routes; migrations 58 and 59; migrations 56, 57 and 58')].sort(), [56, 57, 58, 59, 60]);
  assert.ok(newestMigration() >= 60);
  // Version lines: every form the review of 1.20.0 found stale.
  const seen = currentFor('**Version.** It describes 1.19.0; x. **Current status (1.19.0): no.** | Capability | State on 30 September 2026 (1.19.0) | of the 662 commits in the history of 1.19.0, its status through 1.19.0, the latest release. 1.19.x is the latest minor').map(([v]) => v);
  assert.deepEqual(seen, ['1.19.0', '1.19.0', '1.19.0', '1.19.0', '1.19.0', '1.19.0']);
  assert.ok(!onLine('1.19.0', '1.20.0') && onLine('1.20.0', '1.20.1') && !onLine('1.20.1', '1.20.0'));
});
