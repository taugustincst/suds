'use strict';
// docs/security/PEN-TEST-SCOPE.md against docs/security/THREAT-MODEL.md (1.22.0). The review of 1.21.0 found the scope
// a county would commission a test from had fallen behind the threat model: no row for field devices or the
// authenticator allow-list although QUESTIONNAIRE #38 said it had them, and four county rows duplicated by a merge.
//
// The anchor is every row of the threat model's mitigation tables (each table headed "| Threat | Mitigation |"),
// by its first cell. Each must map, through MAP below, to one or more areas of the scope's tables (the in-scope table
// and *Classes fixed after the project's own reviews*), so a threat added to the model fails here until the scope
// says how a tester would try it. MAP is matched by prefix of the threat's first cell; a key that matches no row
// (a threat renamed or removed) fails too, so the map never goes stale. An area is a scope row's first cell without
// its parenthesised notes and links ("Sync (if local mode enabled)" is "Sync").
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** A table row's cells (a `\|` inside a cell is not a separator). */
function cells(line) {
  return line.replace(/\\\|/g, '\u0000').split('|').slice(1, -1).map((c) => c.replace(/\u0000/g, '|').trim());
}
/** A scope row's area: its first cell without links and parenthesised notes. */
function areaName(cell) {
  let s = cell.replace(/\[([^\]]*)\]\([^)]*\)/g, '');
  for (let prev = null; prev !== s;) { prev = s; s = s.replace(/\s*\([^()]*\)/g, ''); }
  return s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
}

/** The threat model's mitigation-table rows: { section, threat, line }. */
function threatRows(text) {
  const out = [];
  let section = '';
  let inTable = false;
  for (const [i, l] of text.split('\n').entries()) {
    if (/^#{2,4} /.test(l)) { section = l.replace(/^#+ /, ''); inTable = false; continue; }
    if (/^\|\s*Threat\s*\|\s*Mitigation\s*\|/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    if (!l.startsWith('|')) { inTable = false; continue; }
    if (/^\|\s*-+\s*\|/.test(l)) continue;
    out.push({ section, threat: cells(l)[0], line: i + 1 });
  }
  return out;
}

/** The scope's rows: those of every table between "## In scope" and "## Out of scope". */
function scopeRows(text) {
  const start = text.indexOf('\n## In scope');
  const end = text.indexOf('\n## Out of scope');
  assert.ok(start > 0 && end > start, 'PEN-TEST-SCOPE.md has "## In scope" before "## Out of scope"');
  const first = text.slice(0, start).split('\n').length;
  const out = [];
  for (const [i, l] of text.slice(start, end).split('\n').entries()) {
    if (!l.startsWith('| ') || /^\|\s*-+\s*\|/.test(l) || /^\|\s*(Area|Class)\s*\|/.test(l)) continue;
    const c = cells(l);
    out.push({ cell: c[0], area: areaName(c[0]), row: l, line: first + i });
  }
  return out;
}

// Threat (prefix of its first cell in THREAT-MODEL.md) -> the scope areas a tester uses to try it.
const MAP = [
  // Office server: the web and API edge
  ['Password guessing', ['Authentication']],
  ['Session theft', ['Authentication']],
  ['XSS', ['Input handling', 'Stored-file serving']],
  ['Injection', ['Input handling']],
  ['SSRF through admin-configured', ['Input handling']],
  ['Passkey (fingerprint) sign-in and signing abused', ['Fingerprint sign-in and signing']],
  ['OIDC token forgery', ['SSO']],
  ['Resource exhaustion', ['Input handling']],
  // Authorisation and insiders
  ['A role reads beyond itself', ['Authorisation']],
  ['Escalating one\'s own rights', ['Authorisation']],
  ['Changing another worker\'s work', ['Authorisation', 'Sync attribution and column smuggling']],
  ['New staff seeing every client', ['Authorisation']],
  ['Reading a client\'s earlier values', ['Authorisation', 'Audit integrity']],
  ['Approving one\'s own time or spending', ['Separation of duties']],
  ['A fingerprint confirmation replayed', ['Fingerprint sign-in and signing']],
  ['Signing a note as someone else', ['Note signatures via sync']],
  ['Reading SUD counseling notes', ['SUD counseling-note access']],
  ['Taking a client off the care team', ['Care-team standing by sync']],
  ['Silencing the notice', ['Client-change notices']],
  ['Administrator reading clinical content', ['Authorisation']],
  // Devices and SUDS on this device
  ['Theft of a device', ['SUDS on this device', 'Shared devices']],
  ['A revoked person keeps the data', ['Sync']],
  ['Unsynced work lost on a shared device', ['Shared devices']],
  ['Framing, or another site on a shared Pages origin', ['SUDS on this device']],
  ['Altered code served to the on-device app', ['SUDS on this device', 'Release and publish pipeline']],
  // Data at rest, keys and audit
  ['A stolen database file or backup', ['Data at rest and keys', 'Admin functions']],
  ['A key holder learns low-entropy values', ['Data at rest and keys']],
  ['Identifying an anonymous SSP participant', ['Data at rest and keys', 'Field devices and participant codes']],
  ['An imported page\'s text outliving its record', ['Data at rest and keys']],
  ['A database administrator rewrites the audit log', ['Audit integrity']],
  ['Forged evidence', ['Audit integrity']],
  ['The county signing key read from a copy', ['Data at rest and keys']],
  // Disclosure and publication
  ['Identified data leaving without a lawful basis', ['Disclosure controls']],
  ['PHI sent to an AI provider', ['AI documentation copilot']],
  ['Prompt injection or a wrong draft', ['AI documentation copilot']],
  ['A secure referral link read by the wrong person', ['Secure referral links']],
  ['A scheduled CalOMS file disclosed', ['Disclosure controls']],
  ['Re-identification from the programme\'s own outcome figures', ['Disclosure controls']],
  ['Client-level data leaving in a county submission file', ['County submissions']],
  ['Forged or altered county submissions', ['County submissions']],
  ['The county connection\'s public endpoint abused', ['County connection', 'County push endpoint', 'County read API']],
  ['The programme\'s server sending its county token or file somewhere else', ['County connection', 'County connection: the programme\'s server facing a hostile county']],
  ['A hostile or compromised county server', ['County connection: the programme\'s server facing a hostile county']],
  ['The county\'s exact combined figures published or differenced', ['County publication releases']],
  ['Re-identification from published counts', ['Disclosure controls', 'County publication releases']],
  // The county surface
  ['Entered figures passing for signed ones', ['County-entered figures: the CSV import parser']],
  ['Entered figures displacing a signed file', ['County-entered figures: the CSV import parser']],
  ['Another programme\'s figures imported through a CSV', ['County-entered figures: the CSV import parser']],
  ['A malformed or hostile CSV or form body', ['County-entered figures: the CSV import parser']],
  ['Formula injection', ['County-entered figures: the CSV import parser', 'County submissions', 'County read API']],
  ['The export and import disagreeing', ['County-entered figures: the CSV import parser']],
  ['Correct, withdraw and reinstate used to rewrite history', ['County-entered figures: the CSV import parser', 'County submissions']],
  ['The source document\'s reference reaching someone', ['County-entered figures: the CSV import parser']],
  ['Guessing or grinding through refusals', ['County-entered figures: the CSV import parser', 'County push endpoint']],
  ['A figure from `?entered=` read the wrong way', ['County-entered figures: the CSV import parser', 'County read API']],
  ['The county connection and read API: a token guessed', ['County push endpoint', 'County read API']],
  ['A hostile signed file', ['County submissions']],
  // SUDS Server: the installed host
  ['A substituted release zip, Node.js or Caddy', ['SUDS Server installer and upgrade']],
  ['The release zip\'s checksum taken from the same place', ['SUDS Server installer and upgrade']],
  ['A staged release changed on disk', ['SUDS Server installer and upgrade']],
  ['PHI on an unencrypted disk', ['SUDS Server installer and upgrade']],
  ['The service account reading keys', ['Host/container']],
  ['Caddy as an attack surface', ['Transport', 'Host/container']],
  ['An upgrade that leaves the service on unproven code', ['SUDS Server installer and upgrade', 'SUDS Server upgrade hand-over']],
  ['A forged or edited compliance report', ['Compliance report']],
  ['The service account using the root-run check', ['Host/container']],
  ['A report that says "pass" for what it could not see', ['Compliance report', 'Host/container']],
  ['Installer options used to inject', ['SUDS Server installer and upgrade']],
  // What 1.21.0 adds
  ['A county publication release differenced', ['County publication releases']],
  ['A publication changed after review', ['County publication releases']],
  ['A field device pulling or pushing beyond its scope', ['Field devices and participant codes']],
  ['A participant code leaking where a name would not', ['Field devices and participant codes']],
  ['A field worker leaving the field scope through the device id', ['Field devices and participant codes']],
  ['A passkey registered on an authenticator the programme did not list', ['Authenticator allow-list and metadata upload']],
  ['A forged, stale or rolled-back FIDO Metadata Service file', ['Authenticator allow-list and metadata upload']],
  ['A version 2 county file', ['County file version 2: award amounts']],
  // Release pipeline and supply chain
  ['A malicious npm package in the server', ['Release and publish pipeline']],
  ['A malicious build tool changes the kernel', ['Release and publish pipeline']],
  ['Releasing untested or unapproved code', ['Release and publish pipeline']],
  ['A backport released from the wrong line', ['Release and publish pipeline']],
  ['An edit silently changes what a released migration does', ['Release and publish pipeline', 'SUDS Server upgrade hand-over']],
  ['A forged GitHub Release for the owner\'s tag', ['Release and publish pipeline']],
  ['A dependency steals the write token', ['Release and publish pipeline']],
  ['Replacing a published zip, or republishing an old build', ['Release and publish pipeline']],
  ['An owner setting switched off unnoticed', ['Release and publish pipeline']],
];

const tm = threatRows(read('docs/security/THREAT-MODEL.md'));
const scopeText = read('docs/security/PEN-TEST-SCOPE.md');
const scope = scopeRows(scopeText);

test('the parsers find the threat model\'s mitigation tables and the scope\'s rows', () => {
  assert.ok(tm.length >= 60, `threat rows found: ${tm.length}`);
  for (const s of ['Office server: the web and API edge', 'The county surface', 'SUDS Server: the installed host', 'What 1.21.0 adds', 'Release pipeline and supply chain']) {
    assert.ok(tm.some((r) => r.section === s), `a mitigation table under "${s}"`);
  }
  assert.ok(scope.length >= 20, `scope rows found: ${scope.length}`);
  assert.strictEqual(areaName('Sync (if local mode enabled)'), 'Sync');
  assert.strictEqual(areaName('Fingerprint sign-in and signing (passkeys; released in 1.19.0; [FINGERPRINT.md](../FINGERPRINT.md))'), 'Fingerprint sign-in and signing');
});

test('every threat in THREAT-MODEL.md\'s mitigation tables maps to a PEN-TEST-SCOPE.md row', () => {
  const areas = new Set(scope.map((r) => r.area));
  const unmapped = [];
  const ambiguous = [];
  const missingArea = [];
  for (const r of tm) {
    const keys = MAP.filter(([k]) => r.threat.startsWith(k));
    if (!keys.length) { unmapped.push(`THREAT-MODEL.md:${r.line} (${r.section}): "${r.threat.slice(0, 90)}"`); continue; }
    if (keys.length > 1) ambiguous.push(`THREAT-MODEL.md:${r.line}: matched by ${keys.map(([k]) => `"${k}"`).join(', ')}`);
    for (const a of keys[0][1]) if (!areas.has(a)) missingArea.push(`THREAT-MODEL.md:${r.line} "${r.threat.slice(0, 60)}" -> "${a}"`);
  }
  assert.deepStrictEqual(unmapped, [], 'threats with no entry in MAP (add the scope row a tester would use, then the entry)');
  assert.deepStrictEqual(ambiguous, [], 'threats matched by more than one MAP key');
  assert.deepStrictEqual([...new Set(missingArea)], [], 'threats mapped to an area PEN-TEST-SCOPE.md does not have');
});

test('the map has no stale entry: every key names a threat that exists', () => {
  const stale = MAP.filter(([k]) => !tm.some((r) => r.threat.startsWith(k))).map(([k]) => k);
  assert.deepStrictEqual(stale, [], 'MAP keys matching no threat in THREAT-MODEL.md (renamed or removed: update the key)');
});

test('no PEN-TEST-SCOPE.md row is duplicated', () => {
  const seen = new Map();
  const dups = [];
  for (const r of scope) {
    const k = r.area.toLowerCase();
    if (seen.has(k)) dups.push(`PEN-TEST-SCOPE.md:${r.line} repeats the area "${r.area}" of line ${seen.get(k)}`);
    else seen.set(k, r.line);
  }
  assert.deepStrictEqual(dups, []);
});

test('QUESTIONNAIRE #38 names only areas PEN-TEST-SCOPE.md has, including those 1.21.0 added', () => {
  const q = read('docs/security/QUESTIONNAIRE.md');
  const row = q.split('\n').find((l) => /^\|\s*38\s*\|/.test(l));
  assert.ok(row, 'QUESTIONNAIRE.md has a #38 row');
  const named = [...row.matchAll(/(?<![*\w])\*([^*]+)\*(?!\*)/g)].map((m) => m[1].trim());
  const areas = new Set(scope.map((r) => r.area));
  const unknown = named.filter((n) => !areas.has(n));
  assert.deepStrictEqual(unknown, [], '#38 names (in italics) areas that are not PEN-TEST-SCOPE.md rows');
  for (const a of ['Field devices and participant codes', 'Authenticator allow-list and metadata upload', 'County file version 2: award amounts', 'County publication releases', 'SUDS Server upgrade hand-over']) {
    assert.ok(named.includes(a), `#38 names the scope's "${a}" row`);
  }
});
