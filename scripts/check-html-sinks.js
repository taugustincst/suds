#!/usr/bin/env node
'use strict';
// Stored XSS guard for the browser code. Every string a person typed reaches the screen through h()/text
// nodes (public/app.js), which cannot run markup. The raw-HTML sinks below are where that stops being true,
// so a new one fails `npm test` (test/html-sinks.test.js) until it is reviewed and added to ALLOWED with a
// reason. The printable pages that do build HTML (document.write into a print window) must pass every
// interpolated value through esc(), and that esc() must escape all five HTML-special characters.
//
// Usage: node scripts/check-html-sinks.js   (exit 1 and a list of findings when something is wrong)
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// public/local/ is the esbuild bundle of local/ (and of sql.js); local/ itself is scanned.
const DIRS = ['public', 'local'];
const SKIP = ['public/local/'];

const SINKS = [
  [/\.innerHTML\s*[+]?=/, 'innerHTML assignment'], [/\.outerHTML\s*[+]?=/, 'outerHTML assignment'], [/\.insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
  [/\bdocument\.write(ln)?\s*\(/, 'document.write'], [/createContextualFragment\s*\(/, 'createContextualFragment'],
  [/\.parseFromString\s*\(/, 'DOMParser.parseFromString'], [/\bsrcdoc\b/, 'iframe srcdoc'], [/setHTMLUnsafe\s*\(|parseHTMLUnsafe\s*\(/, 'setHTMLUnsafe'],
  [/(^|[^.\w])eval\s*\(/, 'eval'], [/\bnew\s+Function\s*\(/, 'new Function'], [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'string timer'],
  [/\bh\s*\([^)]*\{[^}]*\bhtml\s*:/, 'h() html attribute'],
];

// file -> [{ line: a pattern the offending line must match, why: the reason it is safe }]
const ALLOWED = {
  'public/app.js': [{ line: /getElementById\('app'\)\.innerHTML = '<div class="boot">Starting SUDS on this device…<\/div>'/, why: 'a fixed string, no data' }],
  'public/views/client.js': [{ line: /w\.document\.write\(html\)/, why: 'accounting of disclosures print page; every value through esc()', printable: true }],
  'public/views/clinical.js': [{ line: /w\.document\.write\(html\)/, why: 'care plan print page; every value through esc()', printable: true }],
  'public/views/compliance.js': [{ line: /w\.document\.write\(`<!doctype html>/, why: 'notice of privacy practices print page; every value through esc()', printable: true }],
};

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

/** Each ${...} in the text, as the expression inside (balanced braces; strings are not parsed). */
function interpolations(text) {
  const out = [];
  for (let i = text.indexOf('${'); i >= 0; i = text.indexOf('${', i + 2)) {
    let depth = 1, j = i + 2;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    out.push({ at: i, expr: text.slice(i + 2, depth ? j : j - 1).trim() });
  }
  return out;
}

// An interpolation in printable HTML is safe when it escapes (esc(...) somewhere in it -- its own nested
// interpolations are checked separately), is a count, or is an HTML fragment variable built the same way.
const SAFE_EXPR = [/\besc\(/, /^[\w.]+\.length$/, /^(rows|cons|probs|gl)\s*\|\|\s*'[^']*'$/];

function checkPrintable(rel, src, findings) {
  const esc = /const esc = \(s\) => String\(s \?\? ''\)\.replace\(\/\[([^\]]*)\]\/g/.exec(src);
  if (!esc) findings.push(`${rel}: a printable page must define esc() the standard way`);
  else for (const ch of `&<>"'`) if (!esc[1].includes(ch)) findings.push(`${rel}: esc() does not escape ${ch}`);
  src.split('\n').forEach((line, n) => {
    if (!/<\/?[a-z][\w-]*[\s>]/i.test(line) || !line.includes('${')) return; // only lines that build markup
    for (const { expr } of interpolations(line)) {
      if (!SAFE_EXPR.some(re => re.test(expr))) findings.push(`${rel}:${n + 1}: \${${expr.slice(0, 80)}} in printable HTML is not escaped with esc()`);
    }
  });
}

/** Findings for one file's source (exported so the test can feed it hostile snippets). */
function scan(rel, src, findings = [], used = new Set()) {
  if (rel.endsWith('.html')) {
    // CSP forbids inline script; keep the pages free of it so nothing depends on relaxing that.
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(src)) findings.push(`${rel}: inline <script>`);
    if (/\son[a-z]+\s*=\s*["']/i.test(src)) findings.push(`${rel}: inline event handler attribute`);
    if (/href\s*=\s*["']\s*javascript:/i.test(src)) findings.push(`${rel}: javascript: URL`);
    return findings;
  }
  let printable = false;
  src.split('\n').forEach((line, n) => {
    const code = line.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/\s.*$/, ''); // comments, whole-line or trailing
    for (const [re, what] of SINKS) {
      if (!re.test(code)) continue;
      const ok = (ALLOWED[rel] || []).find(a => a.line.test(code));
      if (ok) { used.add(rel + ok.line); if (ok.printable) printable = true; continue; }
      findings.push(`${rel}:${n + 1}: ${what} — render with h()/textContent, or review it and add it to ALLOWED in scripts/check-html-sinks.js`);
    }
    if (/href:\s*['"`]\s*javascript:/i.test(code)) findings.push(`${rel}:${n + 1}: javascript: URL`);
  });
  if (printable) checkPrintable(rel, src, findings);
  return findings;
}

function check() {
  const findings = []; const used = new Set();
  for (const dir of DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (SKIP.some(s => rel.startsWith(s)) || !/\.(m?js|html)$/.test(rel)) continue;
      scan(rel, fs.readFileSync(file, 'utf8'), findings, used);
    }
  }
  // An allowance whose line is gone is stale: remove it so it cannot quietly cover a new sink.
  for (const [rel, list] of Object.entries(ALLOWED)) for (const a of list) if (!used.has(rel + a.line)) findings.push(`${rel}: allowlisted sink no longer present (${a.why}); remove it from ALLOWED`);
  return findings;
}

module.exports = { check, scan, interpolations, ALLOWED };

if (require.main === module) {
  const f = check();
  if (f.length) { console.error(f.join('\n')); process.exit(1); }
  console.log('No unreviewed raw-HTML sinks in public/ or local/.');
}
