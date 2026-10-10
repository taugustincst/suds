'use strict';
// A node:test reporter for CI (1.25.4, G1): one `::error` annotation per failing test, naming the job, the file, the
// test and the first line of its error, and a list in the step summary ($GITHUB_STEP_SUMMARY). The GitHub API serves
// annotations where a CI log may not be readable (a check run otherwise says only "Process completed with exit code 1").
// Used beside the spec reporter, through NODE_OPTIONS in ci.yml's test steps, so npm test, scripts/test-evening.sh and
// scripts/test-thorough.js run unchanged:
//   --test-reporter=spec --test-reporter-destination=stdout --test-reporter=./scripts/ci-annotate.js --test-reporter-destination=stdout
// Node built-ins only. A node --test started inside a test (none is today) inherits NODE_OPTIONS; it reports nothing.
const fs = require('node:fs');
const path = require('node:path');

const MAX = 40; // GitHub shows 10 error annotations per step and 50 per job; the summary lists every failure
const data = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

module.exports = async function* annotate(source) {
  const nested = !!process.env.SUDS_CI_ANNOTATING;
  process.env.SUDS_CI_ANNOTATING = '1';
  const suite = process.env.GITHUB_JOB || 'node --test';
  const stderr = new Map(); // file -> its error lines, for a file that fails before any test runs
  const failures = [];
  for await (const e of source) {
    if (nested) continue;
    const d = e.data || {};
    if (e.type === 'test:stderr' && d.file && /Error\b|^\s+at /.test(d.message || '')) {
      const k = path.resolve(d.file); const lines = stderr.get(k) || []; if (lines.length < 5) lines.push(firstLine(d.message)); stderr.set(k, lines);
    }
    if (e.type !== 'test:fail') continue;
    const err = (d.details && d.details.error) || {};
    if (err.failureType === 'subtestsFailed') continue; // each failing subtest is reported itself
    const file = d.file ? path.relative(process.cwd(), d.file) : '';
    const cause = err.cause && err.cause.message ? err.cause : err;
    let why = firstLine(cause.message) || err.failureType || 'failed';
    const crash = d.file && stderr.get(path.resolve(d.file));
    if (why === 'test failed' && crash) why = crash.find((l) => /^[\w.]*Error\b/.test(l)) || crash.find((l) => /Error\b/.test(l)) || why;
    failures.push({ file, line: d.line, name: d.name, why });
    if (failures.length <= MAX) {
      const where = file ? `file=${prop(file)},${d.line ? `line=${d.line},` : ''}` : '';
      yield `::error ${where}title=${prop(suite)}::${data(`${file} › ${d.name}: ${why}`)}\n`;
    }
  }
  if (!failures.length) return;
  if (failures.length > MAX) yield `::error title=${prop(suite)}::${failures.length - MAX} more failing tests: see the step summary\n`;
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = (s) => String(s).replace(/[|<>`]/g, (c) => `\\${c}`);
    const list = failures.map((f) => `- \`${f.file}${f.line ? `:${f.line}` : ''}\` ${md(f.name)}: ${md(f.why)}`).join('\n');
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${md(suite)}: ${failures.length} failing\n\n${list}\n\n`); } catch {}
  }
};
