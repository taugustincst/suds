'use strict';
// The release policy on every push (1.23.1; docs/RELEASE.md, "Stabilisation (from 1.23.1)"). scripts/release-policy.js
// runs in release.yml's gate, against the previous release *tag*; but 1.16.3 to 1.23.0 have no tag, so the gate never
// ran for them and a patch could grow a migration, or a minor come a day after the last one, with nothing red until
// someone tried to release it. This job runs the same check in CI, from the newest release it can find: a pushed tag,
// or, while the tags are owed, the commit docs/evidence/RELEASE-HANDOFF.md records for that version.
//
//   node scripts/release-policy-ci.js [--root <dir>] [--now <ISO date>] [--fetch] [--dry-run]
//
// What it decides (`plan`, pure, tested in test/release-policy-ci.test.js), for package.json's version V:
//   * V is already released (a tag, or a hand-off row): the tree is work towards the next release. While the newest
//     feature release (X.Y.0) is less than FEATURE_INTERVAL_DAYS old, only a patch can be released next, so the
//     tree is checked as patch V+1 against V's commit (no migration, permission or route; the patch size limit).
//     After that the next release may be a minor, which release.yml's gate checks at its tag: nothing to check here.
//   * V is not released yet (stamped, or only bumped): a patch is checked against the newest release below it; a
//     minor or major fails when it is stamped (or, unstamped, would be released today) less than
//     FEATURE_INTERVAL_DAYS after the previous feature release, unless V's CHANGELOG section or its *Record* in
//     docs/RELEASE.md has a line "Security exception: <reason>" - the one exception the stabilisation allows.
// Dates are CHANGELOG release dates (the day a version was published), else the tag's date: a tag pushed weeks after
// its release must not move the window. The patch rules themselves are scripts/release-policy.js's, run as a child
// with --version, --previous and --previous-ref. With --fetch (what CI's job does) a hand-off commit missing from a
// shallow clone is fetched by its SHA first. Node built-ins and git only.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parseVersion, compareVersions, bumpKind, FEATURE_INTERVAL_DAYS } = require('./release-policy');
const { stampedVersions, parseHandoff } = require('./release-state');

const DAY = 86400e3;
const dayOf = (iso) => { const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`); return Number.isFinite(t) ? t : NaN; };
const nextPatch = (v) => { const p = parseVersion(v); return `${p[0]}.${p[1]}.${p[2] + 1}`; };
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * The line naming a security exception for `version`, from its CHANGELOG section or its `**Record: X.Y.Z**`
 * paragraph in docs/RELEASE.md: "Security exception: <reason>". Returns the reason, or null.
 */
function securityException(version, { changelog = '', release = '' } = {}) {
  const esc = version.replace(/\./g, '\\.');
  const block = (text, start) => {
    const m = start.exec(text); if (!m) return '';
    const rest = text.slice(m.index + m[0].length);
    const end = rest.search(/^## |^\*\*Record: /m);
    return end < 0 ? rest : rest.slice(0, end);
  };
  for (const body of [block(changelog, new RegExp(`^## ${esc}\\b[^\\n]*$`, 'm')), block(release, new RegExp(`^\\*\\*Record: ${esc}\\b[^\\n]*$`, 'm'))]) {
    const m = /^\s*(?:[*-]\s+)?\**Security exception:\**\s*(\S[^\n]*)$/im.exec(body);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * The released versions CI can compare with: pushed tags (`tags`: ['v1.16.2', ...]) and the hand-off's rows that name
 * a commit (`handoffRows`: parseHandoff().rows). A tag wins over a row for the same version.
 * @returns {Map<string, { version, ref, from: 'tag'|'handoff' }>}
 */
function releases(tags, handoffRows) {
  const out = new Map();
  for (const r of handoffRows || []) if (parseVersion(r.version) && r.commit) out.set(r.version, { version: r.version, ref: r.commit, from: 'handoff' });
  for (const t of tags || []) if (parseVersion(t)) { const v = t.replace(/^v/, ''); out.set(v, { version: v, ref: t, from: 'tag' }); }
  return out;
}

/**
 * The plan. `version`: package.json's; `stamped`: stampedVersions(CHANGELOG) ([{ version, date }]); `tags`, `handoffRows`:
 * as releases(); `tagDates`: { 'v1.16.0': ISO } for tags whose version has no CHANGELOG date; `now`: ms; `exception`:
 * securityException() for `version` (only read for a minor or major).
 * @returns {{ action: 'skip'|'patch'|'pass'|'fail', reason: string, version?: string, previous?: string, previousRef?: string }}
 *   'patch': run scripts/release-policy.js --version <version> --previous v<previous> --previous-ref <previousRef>
 */
function plan({ version, stamped = [], tags = [], handoffRows = [], tagDates = {}, now = Date.now(), exception = null }) {
  if (!parseVersion(version)) return { action: 'fail', reason: `package.json's version ${version} is not X.Y.Z` };
  const rel = releases(tags, handoffRows);
  const dateOf = (v) => { const s = stamped.find((x) => x.version === v); if (s) return dayOf(s.date); const d = tagDates[`v${v}`]; return d ? dayOf(d) : NaN; };
  // The newest feature release (X.Y.0) at or below `upTo` (strictly below when `strict`), among the releases.
  const feature = (upTo, strict) => [...rel.keys()].filter((v) => parseVersion(v)[2] === 0 && (strict ? compareVersions(v, upTo) < 0 : compareVersions(v, upTo) <= 0)).sort(compareVersions).pop() || null;
  const today = dayOf(new Date(now).toISOString());
  const window = (feat) => {
    const at = dateOf(feat);
    return { at, until: at + FEATURE_INTERVAL_DAYS * DAY };
  };

  const own = rel.get(version);
  if (own) {
    // Work after a released version: within the freeze only a patch can follow it.
    const feat = feature(version, false);
    if (!feat) return { action: 'skip', reason: `${version} is released and no feature release is recorded below it; the release gate checks the next one` };
    const w = window(feat);
    if (!Number.isFinite(w.at)) return { action: 'fail', reason: `the date of the feature release ${feat} could not be read (no CHANGELOG section, no tag date), so the ${FEATURE_INTERVAL_DAYS}-day interval could not be checked` };
    if (today >= w.until) return { action: 'skip', reason: `${version} is released and ${feat} is ${Math.floor((today - w.at) / DAY)} days old: the next release may be a minor, which the release gate checks at its tag` };
    return { action: 'patch', version: nextPatch(version), previous: version, previousRef: own.ref, reason: `${version} is released (${own.from === 'tag' ? `tag v${version}` : `hand-off commit ${own.ref.slice(0, 12)}`}); until ${isoDay(w.until)} (${FEATURE_INTERVAL_DAYS} days after ${feat}) only a patch may follow it, so this tree is checked as ${nextPatch(version)}` };
  }
  const below = [...rel.keys()].filter((v) => compareVersions(v, version) < 0).sort(compareVersions).pop();
  if (!below) return { action: 'skip', reason: `no release below ${version} is recorded (no tag, no hand-off row); nothing to compare with` };
  const kind = bumpKind(below, version);
  if (kind === 'patch') return { action: 'patch', version, previous: below, previousRef: rel.get(below).ref, reason: `${version} is a patch of ${below} (${rel.get(below).from === 'tag' ? `tag v${below}` : `hand-off commit ${rel.get(below).ref.slice(0, 12)}`})` };
  // A minor or major: the interval from the previous feature release, by the day it was released.
  const feat = feature(version, true);
  if (!feat) return { action: 'pass', reason: `${kind} release ${version}: no earlier feature release is recorded` };
  const w = window(feat);
  if (!Number.isFinite(w.at)) return { action: 'fail', reason: `the date of the feature release ${feat} could not be read, so the ${FEATURE_INTERVAL_DAYS}-day interval could not be checked` };
  const own2 = stamped.find((x) => x.version === version);
  const when = own2 ? dayOf(own2.date) : today;
  const days = Math.floor((when - w.at) / DAY);
  if (when >= w.until) return { action: 'pass', reason: `${kind} release ${version} ${own2 ? `stamped ${own2.date}` : 'not stamped yet'}, ${days} days after ${feat}` };
  const what = `${kind} release ${version} ${own2 ? `stamped ${own2.date}` : 'not stamped yet (dated today)'}, ${days} days after the feature release ${feat}; feature releases come at most once every ${FEATURE_INTERVAL_DAYS} days (no earlier than ${isoDay(w.until)})`;
  if (exception) return { action: 'pass', reason: `${what}: allowed by the security exception recorded for ${version} (${exception})` };
  return { action: 'fail', reason: `${what}. Make it a patch release, wait, or, for a security fix only, record "Security exception: <reason>" in its CHANGELOG section or its Record in docs/RELEASE.md` };
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

function main() {
  const root = path.resolve(arg('--root') || path.join(__dirname, '..'));
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const version = JSON.parse(read('package.json')).version;
  const changelog = read('CHANGELOG.md');
  const stamped = stampedVersions(changelog);
  const handoffRows = parseHandoff(read('docs/evidence/RELEASE-HANDOFF.md')).rows;
  let tags = []; try { tags = git('tag', '-l', 'v*').split('\n').filter(Boolean); } catch { tags = []; }
  const tagDates = {};
  for (const t of tags) { if (stamped.some((s) => `v${s.version}` === t)) continue; try { tagDates[t] = git('for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${t}`) || null; } catch { /* unread: plan() fails closed */ } }
  const now = arg('--now') ? Date.parse(arg('--now')) : Date.now();
  const p = plan({ version, stamped, tags, handoffRows, tagDates, now, exception: securityException(version, { changelog, release: read('docs/RELEASE.md') }) });
  console.log(`[release-policy-ci] ${p.action}: ${p.reason}`);
  const summary = (s) => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, s); };
  summary(`### Release policy on this push\n${p.action}: ${p.reason}\n`);
  if (p.action === 'fail') { console.log(`::error::Release policy: ${p.reason}`); return 1; }
  if (p.action !== 'patch') return 0;
  if (!/^v/.test(p.previousRef)) {
    let have = true; try { git('cat-file', '-e', `${p.previousRef}^{commit}`); } catch { have = false; }
    if (!have && process.argv.includes('--fetch')) { try { git('fetch', '--quiet', '--depth', '1', 'origin', p.previousRef); have = true; } catch { have = false; } }
    if (!have) { console.log(`::error::Release policy: the hand-off commit ${p.previousRef} for ${p.previous} is not in this clone (run with --fetch, or git fetch origin ${p.previousRef})`); return 1; }
  }
  const args = [path.join(__dirname, 'release-policy.js'), '--root', root, '--version', p.version, '--previous', `v${p.previous}`, ...(/^v/.test(p.previousRef) ? [] : ['--previous-ref', p.previousRef])];
  if (process.argv.includes('--dry-run')) { console.log(`[release-policy-ci] would run: node ${args.join(' ')}`); return 0; }
  // No exception passes here: RELEASE_POLICY_EXCEPTION is for release.yml's gate, where it is printed in the notes.
  const env = { ...process.env }; delete env.RELEASE_POLICY_EXCEPTION; delete env.ALLOW_PATCH_CHANGES;
  try { execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit', env }); return 0; } catch { return 1; }
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.log(`::error::The release policy check could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { plan, releases, securityException };
