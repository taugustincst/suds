'use strict';
// scripts/release-existing.js and the shape of release.yml since 1.16.4 (engineering review of 1.16.3, H1, M5, L1,
// L4): a GitHub Release someone else made for the owner's tag is refused, in the gate and after the approval; npm
// and the tests run in a read-only job; the job with the write token runs no npm and builds the zip with git archive.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const E = require('../scripts/release-existing');

const root = path.join(__dirname, '..');
const wf = (f) => fs.readFileSync(path.join(root, '.github', 'workflows', f), 'utf8');
const TAG = 'v1.16.4';
const [ZIP, SUM] = E.assetNames(TAG);
const bot = { login: 'github-actions[bot]' };
const rel = (o = {}) => ({ author: bot, isDraft: false, assets: [{ name: ZIP }, { name: SUM }], ...o });

test('no GitHub Release yet: create it', () => {
  assert.deepEqual(E.judge({ tag: TAG, release: null }), { action: 'create', publishDraft: false, problems: [] });
  assert.match(E.judge({ tag: TAG, release: null, afterPublish: true }).problems[0], /no GitHub Release v1\.16\.4 after publishing/);
});

test('this workflow\'s release with the files built from the tag: nothing is replaced', () => {
  const out = E.judge({ tag: TAG, release: rel(), identical: { [ZIP]: true, [SUM]: true } });
  assert.deepEqual(out, { action: 'none', publishDraft: false, problems: [] });
  assert.deepEqual(E.judge({ tag: TAG, release: rel(), identical: { [ZIP]: true, [SUM]: true }, afterPublish: true }).problems, []);
});

test('a release someone else made is refused, whatever its files (H1)', () => {
  // The forgery the review describes: a collaborator's Release, with a zip and checksum of their own, or none.
  const forged = E.judge({ tag: TAG, release: rel({ author: { login: 'collaborator' } }), identical: { [ZIP]: false, [SUM]: false } });
  assert.match(forged.problems.join('\n'), /made by @collaborator, not by the release workflow \(github-actions\[bot\]\)/);
  assert.match(forged.problems.join('\n'), /suds-v1\.16\.4\.zip on the GitHub Release v1\.16\.4 is not byte for byte the file built from the tag/);
  assert.ok(E.judge({ tag: TAG, release: rel({ author: { login: 'collaborator' }, assets: [] }) }).problems.length > 0, 'an empty release too');
  assert.ok(E.judge({ tag: TAG, release: rel({ author: { login: 'collaborator' } }), identical: { [ZIP]: true, [SUM]: true } }).problems.length > 0, 'even with the right bytes: the notes are not ours');
  assert.ok(E.judge({ tag: TAG, release: rel({ author: null }), identical: { [ZIP]: true, [SUM]: true } }).problems.length > 0);
});

test('the bot\'s account is not enough: the bytes decide, and no other file may be attached', () => {
  // Any workflow run with a write token acts as github-actions[bot], a branch's own workflow included.
  assert.match(E.judge({ tag: TAG, release: rel(), identical: { [ZIP]: false, [SUM]: true } }).problems[0], /suds-v1\.16\.4\.zip .* not byte for byte/);
  assert.match(E.judge({ tag: TAG, release: rel(), identical: { [ZIP]: true } }).problems[0], /\.sha256 .* not byte for byte/, 'a file not compared is not accepted');
  const extra = E.judge({ tag: TAG, release: rel({ assets: [{ name: ZIP }, { name: SUM }, { name: 'suds-installer.exe' }] }), identical: { [ZIP]: true, [SUM]: true } });
  assert.match(extra.problems[0], /carries files the release workflow never attaches: suds-installer\.exe/);
  assert.match(E.judge({ tag: TAG, release: rel({ assets: [{ name: ZIP }] }), identical: { [ZIP]: true } }).problems[0], /without its pair/);
});

test('an empty release of the bot\'s gets its files; a draft of the bot\'s is published once checked (L1)', () => {
  assert.deepEqual(E.judge({ tag: TAG, release: rel({ assets: [] }) }), { action: 'upload', publishDraft: false, problems: [] });
  assert.deepEqual(E.judge({ tag: TAG, release: rel({ isDraft: true }), identical: { [ZIP]: true, [SUM]: true } }), { action: 'none', publishDraft: true, problems: [] });
  assert.deepEqual(E.judge({ tag: TAG, release: rel({ isDraft: true, assets: [] }) }), { action: 'upload', publishDraft: true, problems: [] });
  assert.ok(E.judge({ tag: TAG, release: rel({ isDraft: true, author: { login: 'someone' } }), identical: { [ZIP]: true, [SUM]: true } }).problems.length > 0, 'anyone else\'s draft is refused');
  assert.match(E.judge({ tag: TAG, release: rel({ isDraft: true }), identical: { [ZIP]: true, [SUM]: true }, afterPublish: true }).problems[0], /still a draft after publishing/);
});

test('the Windows server zip pair: attached with the source zip, compared when this run built it, never alone', () => {
  const [WZ, WS] = E.windowsAssetNames(TAG);
  assert.deepEqual([WZ, WS], ['suds-1.16.4-windows-x64.zip', 'suds-1.16.4-windows-x64.zip.sha256']);
  const all = rel({ assets: [{ name: ZIP }, { name: SUM }, { name: WZ }, { name: WS }] });
  const same = { [ZIP]: true, [SUM]: true, [WZ]: true, [WS]: true };
  // The gate builds the source zip only: the Windows pair is accepted when paired, not compared.
  assert.deepEqual(E.judge({ tag: TAG, release: all, identical: { [ZIP]: true, [SUM]: true } }), { action: 'none', publishDraft: false, problems: [] });
  // The release job built it: compared byte for byte, like the source zip.
  assert.deepEqual(E.judge({ tag: TAG, release: all, identical: same, windows: true }).problems, []);
  assert.match(E.judge({ tag: TAG, release: all, identical: { ...same, [WZ]: false }, windows: true }).problems[0], /suds-1\.16\.4-windows-x64\.zip .* not byte for byte the Windows server zip this run built/);
  assert.match(E.judge({ tag: TAG, release: rel({ assets: [{ name: ZIP }, { name: SUM }, { name: WZ }] }), identical: same }).problems[0], /windows-x64\.zip without its pair/);
  // Missing Windows files are uploaded (only those), and their absence after publishing is a problem.
  const old = E.judge({ tag: TAG, release: rel(), identical: same, windows: true });
  assert.deepEqual(old, { action: 'upload', publishDraft: false, problems: [] });
  assert.deepEqual(E.missingAssets({ tag: TAG, release: rel(), windows: true }), [WZ, WS]);
  assert.deepEqual(E.missingAssets({ tag: TAG, release: null, windows: true }), [ZIP, SUM, WZ, WS]);
  assert.deepEqual(E.missingAssets({ tag: TAG, release: rel(), windows: false }), []);
  assert.match(E.judge({ tag: TAG, release: rel(), identical: same, windows: true, afterPublish: true }).problems[0], /missing its files after publishing/);
  // Any other file is still refused.
  assert.match(E.judge({ tag: TAG, release: rel({ assets: [{ name: ZIP }, { name: SUM }, { name: 'suds-1.16.4-windows-arm64.zip' }] }), identical: same }).problems[0], /never attaches: suds-1\.16\.4-windows-arm64\.zip/);
});

test('the refusal says how to recover: delete the release but not the tag, or release the next patch', () => {
  const r = E.recovery(TAG);
  assert.match(r, /gh release delete v1\.16\.4 --yes`, without --cleanup-tag/);
  assert.match(r, /immutable release\), release the next patch version/);
});

test('main() reads the release with gh, compares the downloaded files and writes the action (a fake gh)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-existing-'));
  try {
    const bin = path.join(dir, 'bin'); const pkg = path.join(dir, 'pkg'); const pub = path.join(dir, 'pub');
    for (const d of [bin, pkg, pub]) fs.mkdirSync(d);
    fs.writeFileSync(path.join(pkg, ZIP), 'zip built from the tag'); fs.writeFileSync(path.join(pkg, SUM), 'sum');
    fs.writeFileSync(path.join(pub, ZIP), 'a forged zip'); fs.writeFileSync(path.join(pub, SUM), 'sum');
    // `gh release view` prints RELEASE_JSON (or fails as gh does when there is none); `download` copies from pub/.
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
if [ "$2" = view ]; then [ -n "$RELEASE_JSON" ] || { echo "release not found" >&2; exit 1; }; printf '%s' "$RELEASE_JSON"; exit 0; fi
if [ "$2" = download ]; then while [ $# -gt 0 ]; do case "$1" in --pattern) p="$2";; --dir) d="$2";; esac; shift; done; cp "${pub}/$p" "$d/$p"; exit 0; fi
exit 3
`, { mode: 0o755 });
    const run = (json) => {
      const out = path.join(dir, `out-${Math.random()}`);
      try {
        const stdout = execFileSync(process.execPath, [path.join(root, 'scripts', 'release-existing.js'), '--tag', TAG, '--dir', pkg, '--repo', 'o/r'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_JSON: json || '', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: '' }, encoding: 'utf8' });
        return { code: 0, stdout, output: fs.readFileSync(out, 'utf8') };
      } catch (e) { return { code: e.status, stdout: e.stdout, output: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' }; }
    };
    const none = run('');
    assert.equal(none.code, 0); assert.match(none.output, /^action=create\npublish_draft=false\n$/);
    const forged = run(JSON.stringify(rel()));
    assert.equal(forged.code, 1, 'a forged zip on a bot-made release is refused');
    assert.match(forged.stdout, /::error::Release refused: suds-v1\.16\.4\.zip on the GitHub Release v1\.16\.4 is not byte for byte/);
    assert.match(forged.stdout, /::error::To recover: delete that GitHub Release/);
    fs.writeFileSync(path.join(pub, ZIP), 'zip built from the tag');
    const same = run(JSON.stringify(rel({ isDraft: true })));
    assert.equal(same.code, 0); assert.match(same.output, /^action=none\npublish_draft=true\n$/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('release.yml checks an existing release in the gate, before the approval, and again in the release job (H1)', () => {
  const y = wf('release.yml');
  const gate = y.slice(y.indexOf('\n  gate:'), y.indexOf('\n  verify:'));
  const job = y.slice(y.indexOf('\n  release:'));
  // The zip is built the same way in both, and the way scripts/package.js builds it.
  const archive = /git archive --format=zip --prefix="suds-\$ver\/" -o "\$RUNNER_TEMP\/pkg\/suds-\$ver\.zip" "\$\{GITHUB_SHA\}"/;
  assert.match(gate, archive); assert.match(job, archive);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'package.js'), 'utf8'), /\['archive', '--format=zip', `--prefix=suds-v\$\{version\}\/`, '-o', out, 'HEAD'\]/);
  for (const t of [gate, job]) assert.match(t, /\(cd "\$RUNNER_TEMP\/pkg" && sha256sum "suds-\$ver\.zip" > "suds-\$ver\.zip\.sha256"\)/);
  assert.match(gate, /node "\$RUNNER_TEMP\/main\/scripts\/release-existing\.js" --tag "\$ver" --dir "\$RUNNER_TEMP\/pkg"/, 'main\'s copy, in the gate');
  assert.ok(gate.indexOf('release-existing.js" --tag') > gate.indexOf('release-policy.js" --root src'), 'after the policy has checked the tag against package.json');
  assert.match(job, /git show "\$\{MAIN_SHA\}:scripts\/release-existing\.js" > "\$RUNNER_TEMP\/release-existing\.js"/);
  assert.match(job, /\n {8}id: existing\n {8}run: node "\$RUNNER_TEMP\/release-existing\.js" --tag "\$\{GITHUB_REF_NAME\}" --dir "\$RUNNER_TEMP\/pkg"/);
  assert.match(job, /--after-publish/, 'and once more after publishing');
  // What the check decided is all the publish step does; a draft is published only after the check.
  assert.match(job, /ACTION: \$\{\{ steps\.existing\.outputs\.action \}\}/);
  // The source zip pair and the Windows server zip pair are created together (an immutable release takes no file after
  // it is published); an upload sends only what the check found missing.
  assert.match(job, /case "\$\{ACTION\}" in\n\s+create\)\n(?:[^\n]*\n)+?\s+gh release create "\$ver" "suds-\$ver\.zip" "suds-\$ver\.zip\.sha256" "suds-\$\{ver#v\}-windows-x64\.zip" "suds-\$\{ver#v\}-windows-x64\.zip\.sha256" --verify-tag[^\n]*;;\n(?:\s+#[^\n]*\n)*\s+upload\) gh release upload "\$ver" \$\{MISSING\} ;;\n\s+none\) echo/);
  assert.match(job, /MISSING: \$\{\{ steps\.existing\.outputs\.missing \}\}/);
  assert.match(job, /if \[ "\$\{PUBLISH_DRAFT\}" = "true" \]; then gh release edit "\$ver" --draft=false "\$latest_flag"; fi/);
  assert.ok(!/--clobber/.test(y));
});

test('release.yml: npm and the tests run in a read-only job; the job with the write token runs no npm (M5)', () => {
  const y = wf('release.yml');
  assert.match(y, /\npermissions:\n {2}contents: read\njobs:/, 'read-only at the top');
  const gate = y.slice(y.indexOf('\n  gate:'), y.indexOf('\n  verify:'));
  const verify = y.slice(y.indexOf('\n  verify:'), y.indexOf('\n  windows-exe:'));
  const job = y.slice(y.indexOf('\n  release:'));
  assert.match(gate, /\n {4}permissions:\n {6}contents: read\n {6}actions: read\n/);
  assert.match(verify, /\n {4}needs: gate\n/);
  assert.match(verify, /\n {4}permissions:\n {6}contents: read\n {4}steps:/);
  assert.ok(!/environment:|secrets\.|GH_TOKEN/.test(verify.replace(/^\s*#.*$/gm, '')), 'no environment, secret or gh token');
  for (const s of ['run: npm ci --no-audit --no-fund', 'run: npm test', 'npm run build:local', 'git diff --exit-code -- public/local server/schema-text.js public/sw.js']) assert.ok(verify.includes(s), `verify: ${s}`);
  assert.match(verify, /git checkout --quiet "\$\{GITHUB_SHA\}"/, 'the gated commit');
  assert.match(job, /\n {4}needs: \[gate, verify, windows-sign\]\n/);
  assert.match(job, /\n {4}environment: release\n/);
  assert.match(job, /\n {4}permissions:\n {6}contents: write\n(?: {6}#[^\n]*\n)* {6}actions: write\n/);
  const code = job.replace(/^\s*#.*$/gm, '');
  for (const bad of [/\bnpm\b/, /\bnpx\b/, /scripts\/package\.js/, /GITHUB_ENV|GITHUB_PATH/, /node -p|node -e|node scripts\//, /release-policy\.js/]) assert.ok(!bad.test(code), `the release job runs no ${bad}`);
  assert.deepEqual([...code.matchAll(/\bnode (\S+)/g)].map((m) => m[1]), ['"$RUNNER_TEMP/release-existing.js"', '"$RUNNER_TEMP/release-existing.js"'], 'Node only for main\'s check');
  assert.match(job, /ver="v\$\(jq -r \.version package\.json\)"/);
});

test('ci.yml runs with a read-only token (L4)', () => {
  const ci = wf('ci.yml');
  assert.match(ci, /\npermissions:\n {2}contents: read\n[a-z#]/, 'top-level, read only');
  assert.ok(!/^\s+[a-z-]+: write\s*$/m.test(ci), 'no job asks for a write scope');
});
