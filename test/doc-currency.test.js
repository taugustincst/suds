'use strict';
// The buyer and security documents name the release they were checked against. When they fall behind, a county
// reads a questionnaire, an evidence index and an SBOM for a version it is not running (the market-readiness review
// of 1.19.0 found all three two releases behind). The rule (docs/RELEASE.md, stamp checklist):
//
//   Once package.json's version X.Y.Z is stamped (its CHANGELOG section has a date: "## X.Y.Z — YYYY-MM-DD"),
//     * docs/security/QUESTIONNAIRE.md's "**Checked against:**" line,
//     * docs/evidence/README.md's "**Version.**" line, and
//     * the newest SBOM, docs/evidence/sbom-<version>.cdx.json,
//   each name a version on the X.Y line (X.Y.0 up to X.Y.Z). A patch may keep the minor's documents; a new minor
//   may not. And every document that links an SBOM outside the evidence index links the newest one.
//
// While the version is not stamped (a release being prepared), the documents still describe the last stamped
// release, so the rule is checked against that one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const parse = (v) => v.split('.').map(Number);
const cmp = (a, b) => { const x = parse(a); const y = parse(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };
const minor = (v) => parse(v).slice(0, 2).join('.');

/** Stamped versions (dated CHANGELOG headings), newest first. */
function stamped(log) {
  return [...log.matchAll(/^## (\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/gm)].map(m => m[1]).sort(cmp).reverse();
}
/** The version the documents must describe: package.json's once stamped, else the newest stamped one. */
function target(pkgVersion, log) {
  const dated = stamped(log);
  return dated.includes(pkgVersion) ? pkgVersion : dated[0];
}
/** The version the questionnaire says it was checked against. */
function questionnaireVersion(text) {
  const m = text.match(/^\*\*Checked against:\*\*\s*(\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}
/** The version the evidence index says it describes. */
function evidenceVersion(text) {
  const m = text.match(/^\*\*Version\.\*\*\s*It describes (\d+\.\d+\.\d+)/m);
  return m ? m[1] : null;
}
/** The newest committed SBOM's version. */
function newestSbom(files) {
  const v = files.map(f => (f.match(/^sbom-(\d+\.\d+\.\d+)\.cdx\.json$/) || [])[1]).filter(Boolean).sort(cmp);
  return v.length ? v[v.length - 1] : null;
}
// From 1.25.2 every release, patches included, has an SBOM of its own (evaluation of 1.25.1, F6: county supply-chain
// reviewers expect one per shipped artifact, and 1.25.1 shipped with 1.25.0's). Before it a patch kept its minor's.
const SBOM_EVERY_RELEASE_FROM = '1.25.2';
/** Problems with the three against the target version: [] when each is on its minor line and not above it, and (from
 *  SBOM_EVERY_RELEASE_FROM) the newest SBOM is the target version's own. */
function problems({ version, questionnaire, evidence, sbom }) {
  const out = [];
  const check = (what, v) => {
    if (!v) out.push(`${what} names no version`);
    else if (minor(v) !== minor(version) || cmp(v, version) > 0) out.push(`${what} names ${v}, not the ${minor(version)} line of ${version}`);
  };
  check('docs/security/QUESTIONNAIRE.md "Checked against"', questionnaire);
  check('docs/evidence/README.md "Version."', evidence);
  check('the newest docs/evidence/sbom-*.cdx.json', sbom);
  if (sbom && cmp(version, SBOM_EVERY_RELEASE_FROM) >= 0 && sbom !== version) out.push(`the newest docs/evidence/sbom-*.cdx.json names ${sbom}, not ${version}: from ${SBOM_EVERY_RELEASE_FROM} every release, patches included, has its own SBOM (docs/RELEASE.md, stamp checklist)`);
  return out;
}

function current() {
  const log = read('CHANGELOG.md');
  const version = target(require('../package.json').version, log);
  return {
    version,
    questionnaire: questionnaireVersion(read('docs/security/QUESTIONNAIRE.md')),
    evidence: evidenceVersion(read('docs/evidence/README.md')),
    sbom: newestSbom(fs.readdirSync(path.join(ROOT, 'docs', 'evidence'))),
  };
}

test('the questionnaire, the evidence index and the newest SBOM are on the stamped version\'s minor line', () => {
  const c = current();
  assert.deepEqual(problems(c), [], `package.json ${require('../package.json').version} (documents checked against ${c.version}). Bring them up to date (docs/RELEASE.md, stamp checklist): the questionnaire's "Checked against", the evidence index's "Version.", and an SBOM from the release commit (node scripts/sbom.js --ref <commit> --out docs/evidence/sbom-<version>.cdx.json)`);
});

test('every SBOM link outside the evidence index is to the newest SBOM', () => {
  const newest = newestSbom(fs.readdirSync(path.join(ROOT, 'docs', 'evidence')));
  const files = [path.join(ROOT, 'README.md'), path.join(ROOT, 'SECURITY.md')];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.md')) files.push(p); } };
  walk(path.join(ROOT, 'docs'));
  const stale = [];
  for (const f of files) {
    // The evidence index lists every SBOM as history; everything else points at the current one.
    if (f === path.join(ROOT, 'docs', 'evidence', 'README.md') || !fs.existsSync(f)) continue;
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/sbom-(\d+\.\d+\.\d+)\.cdx\.json/g)) if (m[1] !== newest) stale.push(`${path.relative(ROOT, f)}: sbom-${m[1]}`);
  }
  assert.deepEqual(stale, [], `link sbom-${newest}.cdx.json`);
});

test('the rule finds what it is for', () => {
  const log = '## Unreleased\n\n## 1.19.0 — 2026-09-30\n\n## 1.18.0 — 2026-09-30\n\n## 1.17.0 — 2026-09-29\n';
  // Stamped: the documents must be on its line.
  assert.equal(target('1.19.0', log), '1.19.0');
  // Being prepared (not dated yet): the last stamped release.
  assert.equal(target('1.20.0', log), '1.19.0');
  assert.equal(questionnaireVersion('x\n**Checked against:** 1.17.0 (the stamp commit `485548c`)\n'), '1.17.0');
  assert.equal(evidenceVersion('**Version.** It describes 1.17.0, the stamp commit'), '1.17.0');
  assert.equal(newestSbom(['README.md', 'sbom-1.16.4.cdx.json', 'sbom-1.17.0.cdx.json', 'sbom-1.9.9.cdx.json']), '1.17.0');
  // 3dc20dc (Release 1.19.0) left all three on 1.17.0: refused, each named.
  const on3dc = problems({ version: '1.19.0', questionnaire: '1.17.0', evidence: '1.17.0', sbom: '1.17.0' });
  assert.equal(on3dc.length, 3);
  assert.match(on3dc[0], /QUESTIONNAIRE.*1\.17\.0, not the 1\.19 line/);
  // A patch keeps its minor's documents; a newer minor, or a version above the stamp, does not pass.
  assert.deepEqual(problems({ version: '1.19.1', questionnaire: '1.19.0', evidence: '1.19.1', sbom: '1.19.0' }), []);
  assert.equal(problems({ version: '1.20.0', questionnaire: '1.19.0', evidence: '1.20.0', sbom: '1.20.0' }).length, 1);
  assert.equal(problems({ version: '1.19.0', questionnaire: '1.19.1', evidence: '1.19.0', sbom: '1.19.0' }).length, 1);
  assert.equal(problems({ version: '1.19.0', questionnaire: null, evidence: '1.19.0', sbom: '1.19.0' }).length, 1);
  // From 1.25.2 a patch has its own SBOM: keeping its minor's is refused (F6); 1.25.1 kept 1.25.0's under the old rule.
  assert.deepEqual(problems({ version: '1.25.1', questionnaire: '1.25.1', evidence: '1.25.1', sbom: '1.25.0' }), []);
  const kept = problems({ version: '1.25.2', questionnaire: '1.25.2', evidence: '1.25.2', sbom: '1.25.0' });
  assert.equal(kept.length, 1); assert.match(kept[0], /names 1\.25\.0, not 1\.25\.2: from 1\.25\.2 every release, patches included/);
  assert.deepEqual(problems({ version: '1.25.2', questionnaire: '1.25.2', evidence: '1.25.2', sbom: '1.25.2' }), []);
  assert.equal(problems({ version: '1.26.3', questionnaire: '1.26.3', evidence: '1.26.3', sbom: '1.26.0' }).length, 1);
});
