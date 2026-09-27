'use strict';
// Release policy check (docs/RELEASE.md, "Release cadence"): a fix release — a PATCH bump — carries no schema
// migration, no new permission and no new route; a feature release — a MINOR or MAJOR bump — comes at most
// once every FEATURE_INTERVAL_DAYS days. 1.12.1–1.12.4 broke the first by hand, and 1.12.0 -> 1.13.0 came
// within a day while only patch releases were checked; this makes both a check.
//
//   node scripts/release-policy.js [--version 1.12.5] [--previous v1.12.4 [--previous-ref <commit>]] [--next-ref <commit>] [--now <ISO date>] [--notes-out file]
//   RELEASE_POLICY_EXCEPTION="<reason>" node scripts/release-policy.js ...   # an explicit, recorded policy exception
//   ALLOW_PATCH_CHANGES="<reason>" ...                                      # the same (its name before 1.13.1)
//
// It compares the tree being released (the working directory) with the previous release tag (the highest
// vX.Y.Z tag below the version in package.json, unless --previous names one), both loaded the same way:
//   * migrations  — server/db.js LATEST_SCHEMA_VERSION (the length of the migrations array)
//   * permissions — server/auth.js PERMS, as role:permission grants; a permission name never seen before is
//                   reported as new, a new grant of an existing one to a role as widened
//   * routes      — every METHOD path the route modules register (parameter names ignored)
// For a patch bump any addition fails the check. For a major or minor bump any addition is allowed, but the
// previous feature release (the newest vX.Y.0 tag below the version, dated by its tag - its commit's date for
// a lightweight tag) must be at least FEATURE_INTERVAL_DAYS old. Either failure passes only with a policy
// exception: RELEASE_POLICY_EXCEPTION (release.yml's `policy_exception` input; ALLOW_PATCH_CHANGES and
// `allow_patch_changes`, its earlier name, still work) gives the reason, and the reason and the list of what it
// let through are written to --notes-out, which release.yml puts at the top of the release notes.
//
// The previous tag's tree is read with `git archive` into a temporary directory and its modules are loaded
// in a child process with a test environment and an in-memory database: nothing is opened or written.
// `bumpKind`, `diffSurfaces`, `previousFeatureTag` and `decide` are pure (decide takes the clock as `now`) and
// tested in test/release-policy.test.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}
/** 'major' | 'minor' | 'patch' | 'none' (same version) | 'downgrade'. */
function bumpKind(prev, next) {
  const a = parseVersion(prev), b = parseVersion(next);
  if (!a || !b) throw new Error(`not a version: ${!a ? prev : next}`);
  const c = compareVersions(next, prev);
  if (c === 0) return 'none';
  if (c < 0) return 'downgrade';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  return 'patch';
}
/** The highest vX.Y.Z tag strictly below `version`, or null. */
function previousTag(tags, version) {
  return tags.filter((t) => parseVersion(t) && compareVersions(t, version) < 0).sort(compareVersions).pop() || null;
}
/** Feature releases (minor or major) come at most once in this many days (docs/RELEASE.md, "Release cadence"). */
const FEATURE_INTERVAL_DAYS = 28;
/** The newest feature release tag (vX.Y.0) strictly below `version`, or null. */
function previousFeatureTag(tags, version) {
  return tags.filter((t) => { const v = parseVersion(t); return v && v[2] === 0 && compareVersions(t, version) < 0; }).sort(compareVersions).pop() || null;
}
const ageText = (ms) => (ms < 48 * 3600e3 ? `${Math.max(0, Math.round(ms / 3600e3))} hours` : `${Math.floor(ms / 86400e3)} days`);

/**
 * What a release adds over the previous one.
 * @param {{migrations:number, perms:Object<string,string[]>, routes:string[]}} prev
 * @param {{migrations:number, perms:Object<string,string[]>, routes:string[]}} next
 */
function diffSurfaces(prev, next) {
  const allPrev = new Set(Object.values(prev.perms).flat());
  const grantsPrev = new Set(Object.entries(prev.perms).flatMap(([role, ps]) => ps.map((p) => `${role}:${p}`)));
  const newPermissions = [...new Set(Object.values(next.perms).flat())].filter((p) => !allPrev.has(p)).sort();
  const widenedGrants = Object.entries(next.perms).flatMap(([role, ps]) => ps.filter((p) => allPrev.has(p) && !grantsPrev.has(`${role}:${p}`)).map((p) => `${role} += ${p}`)).sort();
  const routesPrev = new Set(prev.routes);
  return {
    migrations: Math.max(0, next.migrations - prev.migrations),
    schema: { from: prev.migrations, to: next.migrations },
    newPermissions,
    widenedGrants,
    newRoutes: [...new Set(next.routes)].filter((r) => !routesPrev.has(r)).sort(),
  };
}

/** One line per thing the policy forbids in a patch release. */
function violations(diff) {
  const out = [];
  if (diff.migrations) out.push(`${diff.migrations} schema migration(s) (schema ${diff.schema.from} -> ${diff.schema.to})`);
  for (const p of diff.newPermissions) out.push(`new permission ${p}`);
  for (const g of diff.widenedGrants) out.push(`permission granted to another role: ${g}`);
  for (const r of diff.newRoutes) out.push(`new route ${r}`);
  return out;
}

/**
 * The decision. `override`: the policy exception's reason (RELEASE_POLICY_EXCEPTION, or ALLOW_PATCH_CHANGES;
 * '' or undefined = none given). `feature`: { tag, date } of the previous feature release (previousFeatureTag,
 * dated), for a minor or major bump; `now`: the clock (ms or a Date).
 * @returns {{ decision: 'pass'|'fail'|'override', kind: string, violations: string[], notes: string, reason: string }}
 */
function decide({ prevVersion, nextVersion, diff, override, feature = null, now = Date.now() }) {
  const kind = bumpKind(prevVersion, nextVersion);
  const why = String(override || '').trim();
  if (kind === 'downgrade' || kind === 'none') return { decision: 'fail', kind, violations: violations(diff), notes: '', reason: `${nextVersion} is not newer than the previous release ${prevVersion}` };
  let found; let what;
  if (kind === 'patch') {
    found = violations(diff);
    if (!found.length) return { decision: 'pass', kind, violations: found, notes: '', reason: `patch release ${prevVersion} -> ${nextVersion} adds no migration, permission or route` };
    what = `patch release ${prevVersion} -> ${nextVersion} adds what only a feature release may: ${found.join('; ')}. Make it a minor release, take the change out`;
  } else {
    const at = feature && feature.date ? new Date(feature.date).getTime() : NaN;
    const age = Number(now instanceof Date ? now.getTime() : now) - at;
    found = Number.isFinite(age) && age < FEATURE_INTERVAL_DAYS * 86400e3 ? [`feature release ${nextVersion} ${ageText(age)} after the previous one (${feature.tag}); feature releases come at most once every ${FEATURE_INTERVAL_DAYS} days`] : [];
    if (!found.length) return { decision: 'pass', kind, violations: found, notes: '', reason: `${kind} release ${prevVersion} -> ${nextVersion}${feature && feature.tag ? `, ${ageText(age)} after ${feature.tag}` : ''}: migrations, permissions and routes allowed` };
    what = `${found[0]}. Wait until ${new Date(at + FEATURE_INTERVAL_DAYS * 86400e3).toISOString().slice(0, 10)}, make it a patch release (defect and security fixes only)`;
  }
  if (!why) return { decision: 'fail', kind, violations: found, notes: '', reason: `${what}, or re-run the release with policy_exception (allow_patch_changes, its earlier name, still works) set to the reason (it is printed in the release notes).` };
  const rule = kind === 'patch' ? 'This is a patch release, but it contains changes the release policy (docs/RELEASE.md) keeps for feature releases.' : `This is a ${kind} release less than ${FEATURE_INTERVAL_DAYS} days after the previous feature release, sooner than the release policy (docs/RELEASE.md) allows.`;
  const notes = `> **Release policy override: a policy exception.** ${rule} Reason given (\`policy_exception\`): ${why.replace(/\s+/g, ' ')}\n>\n${found.map((f) => `> * ${f}`).join('\n')}\n`;
  return { decision: 'override', kind, violations: found, notes, reason: `${kind} release with ${found.length} policy exception(s), allowed by policy_exception: ${why}` };
}
/** The date a tag was made (an annotated tag's own date; a lightweight tag's commit date), or null. */
function tagDate(tag) {
  try { const d = execFileSync('git', ['for-each-ref', '--format=%(creatordate:iso-strict)', `refs/tags/${tag}`], { cwd: ROOT, encoding: 'utf8' }).trim(); return d || null; } catch { return null; }
}

// ---- Reading a tree ----------------------------------------------------------------------------------------

// Loaded in a child process so an old tree's modules never mix with this one's, and with an environment that
// makes config.js neither generate keys nor touch a data directory.
const PROBE = `
const path = require('node:path');
const root = process.cwd();
const { LATEST_SCHEMA_VERSION } = require(path.join(root, 'server/db'));
const { PERMS } = require(path.join(root, 'server/auth'));
const routes = [];
const rec = (m) => (p) => { if (typeof p === 'string') routes.push(m + ' ' + p.replace(/:[A-Za-z_]+/g, ':')); return r; };
const r = { get: rec('GET'), post: rec('POST'), put: rec('PUT'), patch: rec('PATCH'), delete: rec('DELETE'), add: (m, p) => rec(m)(p), routes: [], use() { return r; } };
let mods;
try { mods = require(path.join(root, 'server/app')).ROUTE_MODULES; } catch {}
if (!Array.isArray(mods)) mods = require('node:fs').readdirSync(path.join(root, 'server/routes')).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
for (const m of mods) require(path.join(root, 'server/routes', m))(r);
process.stdout.write(JSON.stringify({ migrations: LATEST_SCHEMA_VERSION, perms: PERMS, routes: [...new Set(routes)].sort() }));
`;

/** { migrations, perms, routes } for the tree at `dir`. */
function surface(dir) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-policy-'));
  try {
    const out = execFileSync(process.execPath, ['--no-warnings', '-e', PROBE], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, SUDS_ENV: 'test', SUDS_DB_PATH: ':memory:', SUDS_DATA_DIR: data, SUDS_ENCRYPTION_KEY: '0'.repeat(64), SUDS_INDEX_KEY: '1'.repeat(64), NODE_ENV: 'test' },
    });
    return JSON.parse(out);
  } finally { fs.rmSync(data, { recursive: true, force: true }); }
}

/** The tree at a git ref, extracted to a temporary directory (only what surface() loads). */
function extractRef(ref) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-policy-tree-'));
  const tar = execFileSync('git', ['archive', '--format=tar', ref, 'server', 'package.json'], { cwd: ROOT, maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

function main() {
  const version = arg('--version') || require(path.join(ROOT, 'package.json')).version;
  const tags = execFileSync('git', ['tag', '-l', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
  const prev = arg('--previous') || previousTag(tags, version);
  if (!prev) { console.log(`[release-policy] no release tag below ${version}; nothing to compare with`); return 0; }
  // --previous-ref: compare with a commit that has no tag yet (a dry run), under the version --previous names.
  const tree = extractRef(arg('--previous-ref') || prev);
  let diff;
  // --next-ref: check a past release (or any commit) instead of the working tree — how the 1.12.x record in
  // docs/RELEASE.md was produced.
  const next = arg('--next-ref') ? extractRef(arg('--next-ref')) : ROOT;
  try { diff = diffSurfaces(surface(tree), surface(next)); } finally { fs.rmSync(tree, { recursive: true, force: true }); if (next !== ROOT) fs.rmSync(next, { recursive: true, force: true }); }
  const kind = bumpKind(prev, version);
  const featureTag = kind === 'minor' || kind === 'major' ? previousFeatureTag(tags, version) : null;
  const feature = featureTag ? { tag: featureTag, date: tagDate(featureTag) } : null;
  if (featureTag && !feature.date) console.log(`::warning::The date of ${featureTag} could not be read (fetch the tags); the feature-release interval was not checked.`);
  const now = arg('--now') ? Date.parse(arg('--now')) : Date.now();
  const out = decide({ prevVersion: prev, nextVersion: version, diff, override: process.env.RELEASE_POLICY_EXCEPTION || process.env.ALLOW_PATCH_CHANGES, feature, now });
  console.log(`[release-policy] ${out.decision}: ${out.reason}`);
  for (const v of out.violations) console.log(`  - ${v}`);
  const notesOut = arg('--notes-out');
  if (notesOut) fs.writeFileSync(notesOut, out.notes);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release policy\n${out.decision}: ${out.reason}\n${out.violations.map((v) => `- ${v}`).join('\n')}\n`);
  if (out.decision === 'fail') { console.log(`::error::Release refused by the release policy. ${out.reason}`); return 1; }
  if (out.decision === 'override') console.log(`::warning::Release policy exception (policy_exception): ${out.reason}. The exception and its reason go at the top of the release notes.`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.log(`::error::The release policy check could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { parseVersion, compareVersions, bumpKind, previousTag, previousFeatureTag, FEATURE_INTERVAL_DAYS, diffSurfaces, violations, decide, tagDate, surface, extractRef };
