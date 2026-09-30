'use strict';
// The host compliance report (scripts/compliance-check.js): its signature, its offline check, and its human
// forms (text and a self-contained HTML page). Kept free of the database and of config at require time,
// like server/dr-report.js, so scripts/verify-compliance-report.js runs on an auditor's laptop with nothing
// but Node and the public key from GET /api/admin/security/signing-key.
//
// A report file is { report, integrity }, exactly the shape of a recovery-drill report, and is signed the
// same way: Ed25519 over the canonical JSON of `report` (server/dr-report.js canonical, keys sorted) with the
// compliance check's own key on SUDS Server (/etc/suds/compliance-signing-key, root-only, never given to the
// service it audits), or the server's evidence signing key (server/signing.js) elsewhere. The HTML page embeds that signed document and is itself
// a pure function of it, so the verifier re-renders the page and compares: an edit to what the page shows is
// caught as surely as an edit to the JSON.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const signing = require('./signing');
const drReport = require('./dr-report');

const FORMAT = 'suds-compliance-report';
const FILE_RE = /^compliance-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/;
const { canonical } = drReport;

/** The integrity block for a report, signed with `seed` (the 32-byte signing key). Unsigned when seed is null. */
function seal(report, seed) {
  const body = canonical(report);
  const out = { sha256: crypto.createHash('sha256').update(body).digest('hex') };
  if (seed) {
    const pub = signing.publicInfo(seed);
    Object.assign(out, { ed25519_signature: signing.sign(body, seed), signing_key_id: pub.key_id, public_key_pem: pub.public_key_pem });
  }
  out.algorithm = 'SHA-256 and an Ed25519 signature (report.host.signed_with names the key) over the canonical JSON of "report" (keys sorted)';
  return out;
}

/** Verify a { report, integrity } document; with publicKeyPem, against that key rather than the embedded one. */
function verifyDoc(doc, { publicKeyPem = null } = {}) {
  if (!doc || typeof doc !== 'object' || !doc.report || !doc.integrity || doc.report.format !== FORMAT) {
    return { ok: false, errors: ['this is not a SUDS compliance report ({ report, integrity } with report.format "suds-compliance-report")'], warnings: [], key_id: null };
  }
  const r = drReport.verifyDoc(doc, { publicKeyPem });
  r.errors = r.errors.map((e) => e.replace('recovery-drill report', 'compliance report'));
  return r;
}

const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RESULT_LABEL = { pass: 'Pass', fail: 'Fail', warn: 'Warning', 'not-checked': 'Could not check' };

function counts(checks) {
  const c = { pass: 0, fail: 0, warn: 0, 'not-checked': 0 };
  for (const k of checks || []) c[k.result] = (c[k.result] || 0) + 1;
  return c;
}
/** The overall verdict. "Could not check" is never a pass: a report with any is at best "incomplete". */
function overall(checks) {
  const c = counts(checks);
  return c.fail ? 'fail' : c['not-checked'] ? 'incomplete' : c.warn ? 'pass-with-warnings' : 'pass';
}

/** The human summary printed at the end of a run (and by the installer). */
function renderText(report) {
  const c = report.summary.counts;
  const lines = [`SUDS compliance check — ${report.host.hostname} — ${report.generated_at}`,
    `Result: ${report.summary.overall.toUpperCase()}  (${c.pass} pass, ${c.fail} fail, ${c.warn} warning, ${c['not-checked']} could not check)`];
  if (report.risk_accepted && report.risk_accepted.length) for (const r of report.risk_accepted) lines.push(`!!! RISK ACCEPTED: ${r}`);
  const order = { fail: 0, 'not-checked': 1, warn: 2, pass: 3 };
  for (const k of [...report.checks].sort((a, b) => order[a.result] - order[b.result])) {
    lines.push(`  [${RESULT_LABEL[k.result].toUpperCase().padEnd(15)}] ${k.id.padEnd(22)} ${k.title}`);
    if (k.result !== 'pass') {
      if (k.evidence) lines.push(`      observed: ${k.evidence}`);
      if (k.remediation) lines.push(`      fix: ${k.remediation}`);
    }
  }
  return lines.join('\n') + '\n';
}

// Deterministic: the same document always renders to the same bytes (the verifier depends on it). No
// external assets, no script that runs (the embedded document is application/json data).
function renderHtml(doc) {
  const { report, integrity } = doc;
  const c = report.summary.counts;
  const rows = report.checks.map((k) => `<tr class="r-${esc(k.result)}"><td><code>${esc(k.id)}</code></td><td>${esc(k.title)}</td><td><span class="badge b-${esc(k.result)}">${esc(RESULT_LABEL[k.result] || k.result)}</span></td><td>${(k.rules || []).map((r) => `<div>${esc(r.cite)} <span class="muted">${esc(r.title)}</span></div>`).join('')}</td><td>${esc(k.evidence)}</td><td>${k.result === 'pass' ? '' : esc(k.remediation)}</td></tr>`).join('\n');
  const embedded = JSON.stringify(doc).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SUDS compliance report ${esc(report.host.hostname)} ${esc(report.generated_at)}</title>
<style>
body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0 auto;padding:16px;max-width:1200px;color:#1b1f24;background:#fff}
h1{font-size:1.5rem;margin:.2em 0}h2{font-size:1.15rem;margin-top:1.6em}
table{border-collapse:collapse;width:100%;font-size:.9rem}th,td{border:1px solid #c9ced6;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef1f5}code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.85em;overflow-wrap:anywhere}
.muted{color:#4a5360}.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;white-space:nowrap}
.b-pass{background:#dcf2e3;color:#0d4f25}.b-fail{background:#fbdcdc;color:#7a0b0b}.b-warn{background:#fdf0cf;color:#5c3d00}.b-not-checked{background:#e4e7ec;color:#1b1f24}
.risk{border:3px solid #7a0b0b;background:#fbdcdc;color:#7a0b0b;padding:10px;font-weight:700}
.wrap{overflow-x:auto}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px}dt{font-weight:600}dd{margin:0;overflow-wrap:anywhere}
</style>
</head>
<body>
<main>
<h1>SUDS compliance report</h1>
<p><strong>Result: ${esc(report.summary.overall)}</strong> — ${c.pass} pass, ${c.fail} fail, ${c.warn} warning, ${c['not-checked']} could not check. “Could not check” is never counted as a pass.</p>
${(report.risk_accepted || []).map((r) => `<p class="risk">RISK ACCEPTED: ${esc(r)}</p>`).join('\n')}
<dl>
<dt>Host</dt><dd>${esc(report.host.hostname)} (${esc(report.host.os)})</dd>
<dt>Generated</dt><dd>${esc(report.generated_at)}</dd>
<dt>SUDS</dt><dd>${esc(report.host.suds_version)}; Node ${esc(report.host.node_version)}</dd>
<dt>Run as</dt><dd>${esc(report.host.run_as)}</dd>
<dt>Report id</dt><dd><code>${esc(report.report_id)}</code></dd>
<dt>SHA-256</dt><dd><code>${esc(integrity.sha256)}</code></dd>
<dt>Signed by</dt><dd>${integrity.ed25519_signature ? `Ed25519 key id <code>${esc(integrity.signing_key_id)}</code>` : 'NOT SIGNED (the signing key was not available to the check)'}</dd>
</dl>
<h2>Checks</h2>
<div class="wrap"><table>
<caption class="muted">Each check, the rule it produces evidence for, what was observed and how to fix it</caption>
<thead><tr><th scope="col">Check</th><th scope="col">Title</th><th scope="col">Result</th><th scope="col">Rule</th><th scope="col">Observed</th><th scope="col">Remediation</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<h2>Scope</h2>
<p>${esc(report.scope)}</p>
<h2>Verifying this report</h2>
<p>The signed report is embedded in this page. Verify it with the public key of the key that signed it, obtained independently of this page: on SUDS Server the compliance key's public half (/etc/suds/compliance-signing-key.pub.pem, recorded at install), elsewhere the server's signing key (Settings → Security status → Download signing public key): <code>node scripts/verify-compliance-report.js ${esc(report.report_id)}.html --public-key &lt;public key&gt;.pem</code>. The verifier also re-renders this page from the signed report and fails if what it shows was edited.</p>
</main>
<script type="application/json" id="suds-compliance-report">${embedded}</script>
</body>
</html>
`;
}

/** The signed document embedded in an HTML report, or null. */
function extractFromHtml(html) {
  const m = /<script type="application\/json" id="suds-compliance-report">([\s\S]*?)<\/script>/.exec(String(html));
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

/** Verify an HTML report: the embedded document, and that the page is exactly what that document renders to. */
function verifyHtml(html, opts = {}) {
  const doc = extractFromHtml(html);
  if (!doc) return { ok: false, errors: ['no signed SUDS compliance report is embedded in this page'], warnings: [], key_id: null };
  const r = verifyDoc(doc, opts);
  if (renderHtml(doc) !== String(html)) { r.errors.push('the page does not match the signed report embedded in it: what it shows was edited'); r.ok = false; }
  return r;
}

/** The newest report in `dir` ({ file, doc }) or null. Never throws. */
function latest(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort(); } catch { return null; }
  for (let i = names.length - 1; i >= 0; i--) {
    try { return { file: names[i], doc: JSON.parse(fs.readFileSync(path.join(dir, names[i]), 'utf8')) }; } catch {}
  }
  return null;
}

module.exports = { FORMAT, FILE_RE, canonical, seal, verifyDoc, verifyHtml, renderHtml, renderText, extractFromHtml, latest, counts, overall, RESULT_LABEL };
