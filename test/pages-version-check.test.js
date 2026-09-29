'use strict';
// scripts/pages-version-check.js and its place in web-app.yml (1.17.1; engineering review of 1.17.0, H1): the web
// app is never published over a newer one. 1.17.0 went to gh-pages before it had a tag, so a later v1.16.4 tag was
// the "newest" by the tags alone, and its publish would have taken device users back to a kernel that refuses their
// schema-55 database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const V = require('../scripts/pages-version-check');

const root = path.join(__dirname, '..');
const live = (v) => JSON.stringify({ version: v });

test('compareVersions orders X.Y.Z numerically, not as text', () => {
  assert.ok(V.compareVersions('1.16.4', '1.17.0') < 0);
  assert.ok(V.compareVersions('v1.17.10', '1.17.9') > 0, 'numbers, and a leading v is allowed');
  assert.ok(V.compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(V.compareVersions('1.17.1', 'v1.17.1'), 0);
  assert.throws(() => V.compareVersions('1.17', '1.17.0'), /not an X\.Y\.Z version: 1\.17/);
});

test('check: older than gh-pages is refused; the same (a republish) or newer passes; nothing published passes', () => {
  const old = V.check('1.16.4', live('1.17.0'));
  assert.equal(old.ok, false);
  assert.match(old.reason, /gh-pages serves 1\.17\.0, newer than 1\.16\.4/);
  assert.equal(V.check('1.16.3', live('1.17.0')).ok, false);
  assert.equal(V.check('1.17.0', live('1.17.0')).ok, true, 'republishing the live release');
  assert.equal(V.check('1.17.1', live('1.17.0')).ok, true);
  assert.equal(V.check('1.18.0', live('1.17.9')).ok, true);
  assert.equal(V.check('1.17.0', null).ok, true, 'no gh-pages branch, or no version.json on it');
});

test('check fails closed on a version.json it cannot read, and on a bad version to publish', () => {
  for (const bad of ['', 'not json', '{}', live('1.17'), live(null), '[]']) assert.equal(V.check('1.17.1', bad).ok, false, bad);
  assert.equal(V.check('latest', live('1.17.0')).ok, false);
});

test('the command line: exit 1 with an ::error:: for an older tag, 0 otherwise; a leading v on the tag is fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-pages-version-'));
  try {
    const f = path.join(dir, 'pages-version.json');
    fs.writeFileSync(f, live('1.17.0'));
    const run = (...a) => spawnSync(process.execPath, [path.join(root, 'scripts', 'pages-version-check.js'), ...a], { encoding: 'utf8' });
    const old = run('v1.16.4', f);
    assert.equal(old.status, 1);
    assert.match(old.stdout, /^::error::The web app is not published: gh-pages serves 1\.17\.0, newer than 1\.16\.4/);
    assert.equal(run('v1.17.0', f).status, 0);
    assert.equal(run('v1.17.1', f).status, 0);
    assert.equal(run('v1.16.4', path.join(dir, 'absent.json')).status, 0, 'no version.json: nothing to go back from');
    assert.equal(run('v1.16.4').status, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the script loads only Node\'s own modules (the publish job runs it from git archive, without npm)', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'pages-version-check.js'), 'utf8');
  const req = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(req.length > 0 && req.every((m) => m.startsWith('node:')), req.join(', '));
});

test('web-app.yml checks gh-pages\' version.json before the build and again after the approval, before the push', () => {
  const y = fs.readFileSync(path.join(root, '.github', 'workflows', 'web-app.yml'), 'utf8');
  const build = y.slice(y.indexOf('\n  build:'), y.indexOf('\n  publish:'));
  const publish = y.slice(y.indexOf('\n  publish:'));
  const read = /if live="\$\(gh api -H 'Accept: application\/vnd\.github\.raw' "repos\/\$\{GITHUB_REPOSITORY\}\/contents\/version\.json\?ref=gh-pages" 2>"\$RUNNER_TEMP\/pages-version\.err"\)"; then printf '%s' "\$live" > "\$RUNNER_TEMP\/pages-version\.json"\n\s+elif grep -q 'HTTP 404' [^\n]*\n\s+else [^\n]*exit 1; fi\n/;
  assert.match(build, read, 'a 404 is "nothing published"; any other failure stops the run');
  assert.match(publish, read);
  const b = build.indexOf('node src/scripts/pages-version-check.js "${GITHUB_REF_NAME}" "$RUNNER_TEMP/pages-version.json"');
  assert.ok(b > build.indexOf('name: Check out') && b < build.indexOf('node scripts/build-static-site.js _site'), 'after the checkout, before the build');
  const p = publish.indexOf('node tag/scripts/pages-version-check.js "${GITHUB_REF_NAME}" "$RUNNER_TEMP/pages-version.json"');
  assert.ok(p > publish.indexOf('git --git-dir=tag.git archive') && p < publish.indexOf('git push -q --force'), 'the tag\'s own copy, before the push');
});
