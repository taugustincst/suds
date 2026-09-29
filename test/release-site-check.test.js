'use strict';
// scripts/release-site-check.js and the shape of web-app.yml since 1.16.4 (engineering review of 1.16.3, M1, M2,
// L3): the site is packed before Playwright or apt runs, the rebuilt kernel is compared with the committed one, the
// publish job checks the site byte for byte against what the tag's public/ builds to, the deploy key has a name no
// older copy of the workflow reads, and one tag's run cannot displace another's.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const C = require('../scripts/release-site-check');
const { stageShell, copyDir, LOCAL_BOOT_JS } = require('../scripts/build-static-site');

const root = path.join(__dirname, '..');
const B = (s) => Buffer.from(s);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const WEBP = Buffer.concat([B('RIFF'), Buffer.alloc(4), B('WEBP'), Buffer.alloc(8)]);

test('compareSites: the same files with the same bytes pass; a missing, changed or added file does not', () => {
  const want = new Map([['index.html', B('<html>')], ['local/kernel.js', B('kernel')]]);
  assert.deepEqual(C.compareSites(want, new Map(want)), []);
  assert.deepEqual(C.compareSites(want, new Map([['index.html', B('<html>')]])), ['local/kernel.js is missing']);
  assert.deepEqual(C.compareSites(want, new Map([...want, ['local/kernel.js', B('kernel + a few lines')]])), ['local/kernel.js differs from the one built from the tag']);
  assert.deepEqual(C.compareSites(want, new Map([...want, ['extra.js', B('x')]])), ['extra.js is not built from the tag and is not a provider picture']);
  assert.deepEqual(C.compareSites(want, new Map([...want, ['region-pictures/x/../../evil.js', PNG]])), ['region-pictures/x/../../evil.js is not built from the tag and is not a provider picture']);
});

test('compareSites: provider pictures are allowed only as JPEG, PNG or WebP that are what they say, and a manifest', () => {
  const want = new Map([['index.html', B('<html>')]]);
  const site = (rel, bytes) => new Map([...want, [rel, bytes]]);
  for (const [rel, bytes] of [['region-pictures/pa-allegheny/a_b-1.png', PNG], ['region-pictures/pa-allegheny/x.jpg', JPG], ['region-pictures/nyc/y.webp', WEBP], ['region-pictures/nyc/manifest.json', B('{"pictures":{}}')]]) {
    assert.deepEqual(C.compareSites(want, site(rel, bytes)), [], rel);
  }
  assert.deepEqual(C.compareSites(want, site('region-pictures/nyc/y.png', JPG)), ['region-pictures/nyc/y.png is not the kind of file its name says']);
  assert.deepEqual(C.compareSites(want, site('region-pictures/nyc/y.png', B('<script>alert(1)</script>'))), ['region-pictures/nyc/y.png is not the kind of file its name says']);
  assert.deepEqual(C.compareSites(want, site('region-pictures/nyc/manifest.json', B('{nope'))), ['region-pictures/nyc/manifest.json is not the kind of file its name says']);
  for (const rel of ['region-pictures/nyc/y.svg', 'region-pictures/nyc/y.html', 'region-pictures/y.png', 'region-pictures/nyc/sub/y.png', 'region-pictures/NYC/y.png']) {
    assert.match(C.compareSites(want, site(rel, PNG))[0], /is not built from the tag and is not a provider picture/, rel);
  }
  assert.match(C.compareSites(want, site('region-pictures/nyc/big.png', Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)])))[0], /bytes, over/);
});

/** A tree as the publish job extracts it with `git archive`: public/ and the four scripts, no node_modules. */
function tagTree(dir) {
  copyDir(path.join(root, 'public'), path.join(dir, 'public'));
  for (const f of ['server/csp.js', 'scripts/build-static-site.js', 'scripts/static-site-security.js', 'scripts/release-site-check.js']) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(dir, f));
  }
}

test('the check, run as the publish job runs it (the tag\'s scripts, no npm package), passes the real build and refuses a changed one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-sitecheck-'));
  try {
    const tag = path.join(dir, 'tag'); const site = path.join(dir, 'site');
    tagTree(tag);
    // The site as build-static-site.js makes it: public/ copied, then stageShell(), then the provider pictures.
    copyDir(path.join(root, 'public'), site); stageShell(site);
    fs.mkdirSync(path.join(site, 'region-pictures', 'pa-allegheny'), { recursive: true });
    fs.writeFileSync(path.join(site, 'region-pictures', 'pa-allegheny', 'provider.png'), PNG);
    fs.writeFileSync(path.join(site, 'region-pictures', 'pa-allegheny', 'manifest.json'), '{}\n');
    const run = () => {
      try { return { code: 0, out: execFileSync(process.execPath, [path.join(tag, 'scripts', 'release-site-check.js'), tag, site], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH } }) }; } catch (e) { return { code: e.status, out: e.stdout }; }
    };
    const ok = run();
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /the site's \d+ built files are the tag's, byte for byte/);
    // What the build generates is checked too: the boot script, the frame guard, the pages' policy, the shell list.
    assert.equal(fs.readFileSync(path.join(site, 'local-boot.js'), 'utf8'), LOCAL_BOOT_JS);
    const tamper = (rel, f) => { const p = path.join(site, rel); const before = fs.readFileSync(p); fs.writeFileSync(p, f(before.toString('utf8'))); const r = run(); fs.writeFileSync(p, before); return r; };
    for (const [rel, f] of [
      ['local/kernel.js', (s) => s + '\n;fetch("https://evil.example/")'],
      ['index.html', (s) => s.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")],
      ['frame-guard.js', () => ''],
      ['local-boot.js', (s) => s + 'window.SUDS_EXTRA = 1;\n'],
      ['sw.js', (s) => s.replace("'local-boot.js', ", '')],
    ]) {
      const r = tamper(rel, f);
      assert.equal(r.code, 1, `${rel} changed is refused`);
      assert.match(r.out, new RegExp(`::error::The site is not the tag's: ${rel.replace('.', '\\.')} differs from the one built from the tag`));
    }
    fs.writeFileSync(path.join(site, 'evil.js'), 'x');
    const extra = run();
    assert.equal(extra.code, 1);
    assert.match(extra.out, /evil\.js is not built from the tag and is not a provider picture/);
    fs.rmSync(path.join(site, 'evil.js'));
    fs.symlinkSync('/etc/passwd', path.join(site, 'link'));
    assert.match(run().out, /::error::The site check could not run: link is neither a file nor a directory/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('build-static-site.js builds with the same stageShell the check uses, and loads the kernel build only when run', () => {
  const src = fs.readFileSync(path.join(root, 'scripts', 'build-static-site.js'), 'utf8');
  const main = src.slice(src.indexOf('if (require.main !== module) return;'));
  assert.ok(main.length > 0, 'the build itself runs only as a script');
  assert.ok(src.indexOf("require('./build-local.js')") > src.indexOf('if (require.main !== module) return;'), 'requiring it builds nothing');
  assert.match(main, /const count = copyDir\(path\.join\(root, 'public'\), outDir\);\nstageShell\(outDir\);/);
});

const wa = () => fs.readFileSync(path.join(root, '.github', 'workflows', 'web-app.yml'), 'utf8');

test('web-app.yml packs and uploads the site before Playwright or apt runs, and checks the rebuilt kernel (M2)', () => {
  const y = wa();
  const build = y.slice(y.indexOf('\n  build:'), y.indexOf('\n  publish:'));
  const at = (s) => { const i = build.indexOf(s); assert.ok(i > 0, s); return i; };
  const built = at('node scripts/build-static-site.js _site'); const pack = at('tar -C src/_site -cf "$RUNNER_TEMP/site.tar" .');
  const upload = at('uses: actions/upload-artifact@'); const pw = at('npm i --no-save --no-audit --no-fund playwright@');
  const drift = at('git diff --exit-code -- public/local server/schema-text.js public/sw.js');
  assert.ok(built < pack && pack < upload && upload < pw && upload < drift, 'build, pack, upload, then everything else');
  assert.ok(pack < at('Version being published'), 'no other step between the build and the pack');
  const between = build.slice(built, pack);
  assert.equal((between.match(/\n {6}- name:/g) || []).length, 1, 'the pack is the very next step');
  assert.match(build, /node scripts\/serve-static\.js "\$RUNNER_TEMP\/boot" 8877/, 'the boot test serves a copy unpacked from the archive');
});

test('web-app.yml\'s publish job checks the site against the tag, with the tag\'s own check, before it pushes (M2)', () => {
  const y = wa();
  const publish = y.slice(y.indexOf('\n  publish:'));
  const check = publish.indexOf('node tag/scripts/release-site-check.js tag site');
  assert.ok(check > publish.indexOf('mkdir site && tar -xf in/site.tar') && check < publish.indexOf('git push -q --force'), 'after the unpack, before the push');
  assert.match(publish, /git init -q --bare tag\.git\n/);
  assert.match(publish, /git --git-dir=tag\.git archive "\$\{GITHUB_SHA\}" public server\/csp\.js scripts\/build-static-site\.js scripts\/static-site-security\.js scripts\/release-site-check\.js \| tar -x -C tag/);
  // Exactly the files the check loads: it runs with nothing else of the tag, and no node_modules (test above).
  const req = (f) => [...fs.readFileSync(path.join(root, f), 'utf8').matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).filter((m) => !m.startsWith('node:'));
  assert.deepEqual(req('scripts/static-site-security.js'), ['../server/csp']);
  assert.deepEqual(req('server/csp.js'), []);
});

test('the deploy key has a new name no older web-app.yml reads, is removed on any exit, and one tag cannot displace another\'s run (M1, L3)', () => {
  const y = wa();
  const code = y.replace(/^\s*#.*$/gm, '');
  assert.ok(!/secrets\.PAGES_DEPLOY_KEY/.test(code), 'the name the v1.16.2 and v1.16.3 copies read is not read');
  assert.match(code, /PAGES_PUBLISH_KEY: \$\{\{ secrets\.PAGES_PUBLISH_KEY \}\}/);
  assert.match(y, /trap 'rm -f "\$RUNNER_TEMP\/pages_key"' EXIT\n\s+if \[ -n "\$\{PAGES_PUBLISH_KEY\}" \]/, 'the trap is set before the key is written');
  assert.match(y, /\nconcurrency:\n {2}group: web-app-pages-\$\{\{ github\.ref_name \}\}\n {2}cancel-in-progress: false\n/);
  const release = fs.readFileSync(path.join(root, 'docs', 'RELEASE.md'), 'utf8');
  assert.match(release, /`PAGES_PUBLISH_KEY`/);
  assert.match(release, /Run workflow\*\* on `v1\.16\.0` and on `v1\.16\.2`/, 'the step-6 check covers the copy that read the old name next to npm');
});
