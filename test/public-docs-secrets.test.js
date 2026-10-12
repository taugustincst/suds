'use strict';
// Public Markdown carries no operational secret of a live server (evaluation of 1.25.6, K3). The repository is
// public: every tracked .md file is published. The evaluation of 1.25.5 (J9) took two live administrator usernames out
// of the documents, and hours later HANDOFF.md gained the live server's disk-encryption identifier, the path of the key
// file that unlocks it unattended, and where two key-escrow bundles were staged on the box. Nothing checked what
// entered the file. This test does, for every tracked Markdown file, with rules meant to catch that class with few
// false positives:
//
//   disk-uuid     a UUID in a paragraph about a disk (UUID, LUKS, crypttab, fstab, blkid, /dev/, disk, volume…);
//   luks-key      a path under /etc/suds-luks/ (the directory alone, as the fleet tooling documents it, is fine);
//   root-path     a path under /root/ that is not a documented product or procedure path (ROOT_ALLOW);
//   home-ubuntu   /home/ubuntu, the default login user's home on a cloud VM: a staging place on a real box;
//   key-file      an absolute path to a private-key file (.key, .p12, .pfx, .jks, .keystore), unless it is a
//                 placeholder or an example (KEY_ALLOW);
//   escrow-path   in a paragraph or list item that mentions escrow (or within two lines of the word, with no blank
//                 line between), an absolute path that is not a documented product path (PRODUCT_PATHS): where
//                 escrow bundles or key copies sit on a machine;
//   admin-name    a username given for an administrator account in a sentence about the live server
//                 (suds.systems, "the live server", "on the box"), and, when a private list is supplied, any of the
//                 listed names next to an account word.
//
// The private list (live usernames, which must not be written into this public file either): one name per line in
// `.git/info/suds-private-names` (inside .git, so never committed) or comma-separated in SUDS_PRIVATE_NAMES. Without
// it the admin-name rule still applies its sentence rule.
//
// Allowing a line: a documented product path belongs in PRODUCT_PATHS, ROOT_ALLOW or KEY_ALLOW below, with its reason.
// A single line that must stay as it is (an example that looks like a secret) carries an HTML comment, invisible when
// the Markdown is rendered:  <!-- public-docs: allow <the reason> -->  (the reason is required). Never allow a line
// that names where a real machine keeps a key, a bundle or a backup: take the detail out, or keep it in the private
// operations records. docs/security/SDLC.md, *Public documents*.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const DISK_CONTEXT = /\b(?:uuid|luks2?|crypttab|fstab|blkid|cryptsetup|disk|volume|partition|mapper)\b|\/dev\//i;
const ABS_PATH = /(?<![\w.~:/@<>-])\/(?:etc|root|home|var|opt|srv|mnt|media|tmp|usr|run|data|backups?|boot)(?:\/[^\s`'"),;\]|*]*)?/g;
const ALLOW_MARK = /<!--\s*public-docs:\s*allow\s+\S[^>]*-->/;

/** Paths of the product itself (the installer, the fleet tooling, the Docker image), documented for every install. */
const PRODUCT_PATHS = [
  [/^\/etc\/suds(?:\/|$)/, 'the installer\'s configuration and credentials directory (deploy/linux)'],
  [/^\/var\/lib\/suds(?:-compliance)?(?:\/|$)/, 'the data directory and the compliance reports\' (deploy/linux)'],
  [/^\/opt\/suds(?:\/|$)/, 'the installed releases (deploy/linux)'],
  [/^\/etc\/caddy(?:\/|$)/, 'Caddy\'s configuration (deploy/linux)'],
  [/^\/etc\/(?:crypttab|fstab)$/, 'the system files a disk-encryption procedure names'],
  [/^\/etc\/suds-luks$/, 'the fleet tooling\'s key directory, named without its contents (deploy/fleet)'],
  [/^\/mnt\/(?:suds-offsite|worm)(?:\/|$)/, 'the documented offsite and write-once mount points'],
  [/^\/run\/(?:credentials|secrets)(?:\/|$)/, 'systemd and Docker credential directories'],
  [/^\/data(?:\/|$)/, 'the Docker image\'s data volume'],
  [/^\/media\/escrow\//, 'the documented example of an escrow USB drive (docs/DEPLOYMENT.md)'],
  [/^\/root\/escrowed-keys\.env$/, 'the escrowed-key drill\'s temporary file, shredded at its end (docs/evidence/INSTALLER-VM-RUN.md)'],
  [/^\/root\/(?:files|caddy-truncated)/, 'the installer container runs\' read-only inputs (docs/evidence/installer-container-run-*)'],
  [/^\/tmp(?:\/|$)/, 'temporary files'],
  [/^\/usr(?:\/|$)/, 'system programs'],
];
/** Paths under /root/ that the product documents (where an operator unpacks a release, examples, test fixtures). */
const ROOT_ALLOW = [
  [/^\/root\/suds-v(?:\d+\.\d+\.\d+|<v>|<version>|X\.Y\.Z)(?:\.zip|\/|$)/, 'where SELF-HOSTING.md and the upgrade procedures unpack a release'],
  [/^\/root\/Caddyfile\.launch-day$/, 'the copy deploy/linux/README.md tells an operator to keep of a hand-edited Caddyfile'],
  [/^\/root\/(?:files|pki|caddy-truncated|node-v|caddy_)/, 'the installer container runs\' inputs (docs/evidence/installer-container-run-*)'],
  [/^\/root\/suds-vm-run\.txt$/, 'the transcript file of docs/evidence/INSTALLER-VM-RUN.md'],
  [/^\/root\/escrowed-keys\.env$/, 'the escrowed-key drill\'s temporary file (docs/evidence/INSTALLER-VM-RUN.md)'],
  [/^\/root\/(?:suds\.county\.gov\.|county-ca\.pem)/, 'example certificate paths (docs/SELF-HOSTING.md)'],
];
/** Private-key paths that are placeholders or examples. */
const KEY_ALLOW = [
  [/^\/path\//, 'a placeholder'],
  [/county\.(?:gov|test)/, 'an example county domain'],
  [/^\/root\/pki\//, 'the installer container run\'s throwaway certificate'],
];
const LIVE_CONTEXT = /suds\.systems|\blive (?:server|install|box)\b|\bon[- ]the[- ]box\b|\bon-box\b|\bproduction server\b/i;
const ADMIN_NAME = /\b(?:admin(?:istrator)?|account)\b[^\n]{0,60}?\b(?:user ?name|named|login)\b\W{0,8}?[`*]{1,3}([A-Za-z][\w.-]{1,31})[`*]{1,3}/i;

const allowed = (p, list) => list.some(([re]) => re.test(p));
/** The private names, from the environment or the clone's own .git/info (never committed). */
function privateNames() {
  const names = String(process.env.SUDS_PRIVATE_NAMES || '').split(',');
  try {
    const f = execFileSync('git', ['rev-parse', '--git-path', 'info/suds-private-names'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
    if (fs.existsSync(p)) names.push(...fs.readFileSync(p, 'utf8').split('\n'));
  } catch { /* not a git clone: the environment only */ }
  return [...new Set(names.map((n) => n.trim()).filter((n) => n && !n.startsWith('#')))];
}

/** Blocks of a Markdown file: paragraphs and list items (a table row is its own), as [first line index, last]. */
function blocks(lines) {
  const out = []; let start = -1;
  const close = (i) => { if (start >= 0) out.push([start, i - 1]); start = -1; };
  lines.forEach((l, i) => {
    if (!l.trim()) { close(i); return; }
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(l) || /^\s*\|/.test(l) || /^#{1,6}\s/.test(l)) close(i);
    if (start < 0) start = i;
    if (/^\s*\|/.test(l) || /^#{1,6}\s/.test(l)) close(i + 1);
  });
  close(lines.length);
  return out;
}

/** Findings in one file's text: [{ line, rule, found }] (`found` is cut short: it may be the secret). */
function scanText(text, names = []) {
  const lines = text.split('\n');
  const out = [];
  const add = (i, rule, found) => { if (!ALLOW_MARK.test(lines[i])) out.push({ line: i + 1, rule, found: String(found).slice(0, 24) }); };
  // A private name as written (case-sensitive: "Folder" is a name, "folder" a word), in a code span or after a word
  // that introduces a username.
  const nameRes = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).map((n) => [new RegExp(`[\`*]{1,3}${n}[\`*]{1,3}|\\b(?:[Uu]ser ?name|[Nn]amed|[Ll]ogin|[Uu]ser)\\W{0,8}${n}\\b`), new RegExp(`\\b${n}\\b`)]);
  for (const [a, b] of blocks(lines)) {
    const block = lines.slice(a, b + 1).join('\n');
    const disk = DISK_CONTEXT.test(block);
    for (let i = a; i <= b; i++) {
      const l = lines[i];
      // Escrow nearby: in this block, or two lines either side with no blank line between (a wrapped line that
      // starts with "+" or "-" is a block of its own to the parser, not to the reader).
      let escrow = /escrow/i.test(block);
      for (let j = i - 1; !escrow && j >= Math.max(0, i - 2) && lines[j].trim(); j--) escrow = /escrow/i.test(lines[j]);
      for (let j = i + 1; !escrow && j <= Math.min(lines.length - 1, i + 2) && lines[j].trim(); j++) escrow = /escrow/i.test(lines[j]);
      if (disk) for (const m of l.matchAll(UUID)) add(i, 'disk-uuid', m[0]);
      for (const m of l.matchAll(ABS_PATH)) {
        const p = m[0].replace(/[.:]+$/, '');
        if (/^\/etc\/suds-luks\/./.test(p)) add(i, 'luks-key', p);
        else if (/^\/home\/ubuntu(?:\/|$)/.test(p)) add(i, 'home-ubuntu', p);
        else if (/^\/root\/./.test(p) && !allowed(p, ROOT_ALLOW)) add(i, 'root-path', p);
        else if (/\.(?:key|p12|pfx|jks|keystore)$/.test(p) && !allowed(p, KEY_ALLOW)) add(i, 'key-file', p);
        else if (escrow && !allowed(p, PRODUCT_PATHS) && !allowed(p, ROOT_ALLOW)) add(i, 'escrow-path', p);
      }
      const n = LIVE_CONTEXT.test(l) && ADMIN_NAME.exec(l);
      if (n && !/^(?:x+|example|name|username)$/i.test(n[1])) add(i, 'admin-name', n[1]);
      for (const [named, any] of nameRes) if (named.test(l) && /\b(?:admin(?:istrator)?|account|user ?name|login|sign(?:s|ed)? in)\b/i.test(l) && any.test(l)) add(i, 'admin-name', '(a private name)');
    }
  }
  // One finding per line and rule.
  return out.filter((f, k) => out.findIndex((g) => g.line === f.line && g.rule === f.rule) === k);
}

/** Every tracked Markdown file (the repository is public: each one is published). */
function trackedMarkdown() {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', '*.md'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const r = path.join(d, e.name); if (e.isDirectory()) walk(r); else if (e.name.endsWith('.md')) out.push(r); } };
    walk('.');
    return out;
  }
}

test('the rules: what a live server\'s secrets look like is found; documented product paths and allowed lines are not', () => {
  const live = [
    '- **Disk.** New volume formatted LUKS2 (UUID `0f0e0d0c-0b0a-4908-8706-050403020100`), key file',
    '  `/etc/suds-luks/data.key` (0400); crypttab entry added.',
    '- **Escrow bundles** created on-box. Originals in `/root`; staged copies in `/home/ubuntu` for download.',
    '- Copied the bundle to `/srv/keys/bundle.tar.gpg` (escrow B).',
    '- Cleanup: `/root/old-escrow.tar` can go.',
    '- The TLS key is `/etc/ssl/private/site.key`.',
    'The owner\'s admin account on suds.systems is named **`opsadmin`**.',
  ].join('\n');
  assert.deepEqual(scanText(live).map((f) => `${f.line} ${f.rule}`), [
    '1 disk-uuid', '2 luks-key', '3 escrow-path', '3 home-ubuntu', '4 escrow-path', '5 root-path', '6 key-file', '7 admin-name',
  ]);
  // The product's own documented paths and procedures, and a UUID with nothing to do with a disk.
  const product = [
    'Escrow the keys: copy `/etc/suds/credentials` and `/var/lib/suds/keys.json` to `/media/escrow/suds-keys-KEEP-SECRET.json`.',
    '',
    'cd /root && unzip -q suds-v1.21.0.zip && sudo /root/suds-v1.21.0/deploy/linux/upgrade.sh 1.21.0 --source=/root/suds-v1.21.0.zip',
    'Keep the edited file: `sudo cp /etc/caddy/Caddyfile /root/Caddyfile.launch-day`.',
    'With a county certificate: `--cert=/root/suds.county.gov.fullchain.pem --key=/root/suds.county.gov.key`.',
    '',
    'The LUKS key file is on the root disk (`/etc/suds-luks`, root only).',
    '',
    'A request id such as `3f2b8c1e-9d4a-4b7e-8c2f-1a2b3c4d5e6f` is in every log line.',
    'The first administrator is called `guest` unless you type another name.',
  ].join('\n');
  assert.deepEqual(scanText(product), []);
  // An allowed line, with its reason; a marker without a reason allows nothing.
  assert.deepEqual(scanText('Staged in `/home/ubuntu` <!-- public-docs: allow a fictional example for the training deck -->'), []);
  assert.equal(scanText('Staged in `/home/ubuntu` <!-- public-docs: allow -->').length, 1);
  // A private list (never in this file): the name next to an account word, as a code span or after "named".
  assert.deepEqual(scanText('The admin account is `zed42` there.\nzed42 wrote this entry.', ['zed42']).map((f) => `${f.line} ${f.rule}`), ['1 admin-name']);
});

test('tracked public Markdown carries no operational secret of a live server (evaluation of 1.25.6, K3)', () => {
  const names = privateNames();
  const files = trackedMarkdown();
  assert.ok(files.length > 50, `the tracked Markdown files are found (${files.length})`);
  const findings = [];
  for (const f of files) for (const x of scanText(fs.readFileSync(path.join(ROOT, f), 'utf8'), names)) findings.push(`${f}:${x.line}: ${x.rule}`);
  // Each finding names the file, the line and the rule, not the value. Take the detail out of the public file (it
  // belongs in the private operations records), or, for a documented product path, add it to this file's lists.
  assert.deepEqual(findings, []);
});
