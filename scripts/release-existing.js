'use strict';
// What release.yml does about a GitHub Release that already exists for the tag (engineering review of 1.16.3, H1).
// Anyone with write access can create or edit a GitHub Release for an existing tag (the web page, the API,
// `gh release create --verify-tag`): the `v*` tag ruleset guards the tag, not the Release. Until 1.16.4 the release
// job, finding the zip and checksum already attached, said "nothing is replaced" and went green, so a zip the owner
// never approved stayed the release, and with immutable releases on it would have stayed for good.
//
// Now a Release that exists is accepted only when:
//   * this workflow made it: its author is github-actions[bot] (not proof on its own: any workflow run with a
//     write token acts as that account, so the bytes below are what decide);
//   * it carries no file but suds-<tag>.zip and suds-<tag>.zip.sha256, and not one of them without the other;
//   * each of those it carries is byte for byte the one built from the tag here (`git archive` is reproducible:
//     the 1.16.2 review rebuilt the published suds-v1.16.2.zip to the same bytes).
// Then the job uploads the two files if neither is there, publishes a draft this workflow left behind (a
// `gh release create` interrupted between its upload and its publish leaves one), or does nothing. Anything else
// is refused, with how to recover. The gate runs this before the owner's approval (its read-only token sees
// published releases only) and the release job again after it, and once more after publishing (--after-publish).
//
//   node scripts/release-existing.js --tag vX.Y.Z --dir <folder holding the zip and checksum built from the tag>
//        [--repo owner/name] [--after-publish]
// Writes action=create|upload|none and publish_draft=true|false to $GITHUB_OUTPUT. `judge` is pure and tested in
// test/release-existing.test.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BOT = 'github-actions[bot]';
const assetNames = (tag) => [`suds-${tag}.zip`, `suds-${tag}.zip.sha256`];

function recovery(tag) {
  return `To recover: delete that GitHub Release, keeping the tag (\`gh release delete ${tag} --yes\`, without --cleanup-tag), and run the release again (Actions -> Release -> Run workflow on ${tag}). If it cannot be deleted or its files cannot be replaced (an immutable release), release the next patch version instead: a new version stamp on main, and its tag (docs/RELEASE.md, "A GitHub Release made by someone else")`;
}

/**
 * release: null (none), or { author: { login }, isDraft, assets: [{ name }] } as `gh release view --json` gives it.
 * identical: { <asset name>: true | false } for the expected files the release carries.
 */
function judge({ tag, release, identical = {}, afterPublish = false }) {
  if (!release) {
    return afterPublish
      ? { action: 'none', publishDraft: false, problems: [`there is no GitHub Release ${tag} after publishing it`] }
      : { action: 'create', publishDraft: false, problems: [] };
  }
  const problems = [];
  const who = release.author && release.author.login;
  if (who !== BOT) problems.push(`the GitHub Release ${tag} was made by @${who || '(unknown)'}, not by the release workflow (${BOT})`);
  const want = assetNames(tag);
  const names = (release.assets || []).map((a) => a.name);
  const extra = names.filter((n) => !want.includes(n));
  if (extra.length) problems.push(`the GitHub Release ${tag} carries files the release workflow never attaches: ${extra.join(', ')}`);
  const present = want.filter((n) => names.includes(n));
  if (present.length === 1) problems.push(`the GitHub Release ${tag} has ${present[0]} without its pair; a new file is never paired with a published one`);
  for (const n of present) if (identical[n] !== true) problems.push(`${n} on the GitHub Release ${tag} is not byte for byte the file built from the tag (git archive of ${tag})`);
  const action = present.length === 2 ? 'none' : 'upload';
  if (afterPublish && (action !== 'none' || release.isDraft)) problems.push(`the GitHub Release ${tag} is ${release.isDraft ? 'still a draft' : 'missing its files'} after publishing it`);
  return { action, publishDraft: !!release.isDraft, problems };
}

function gh(args) { return spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); }

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function main(argv) {
  const tag = arg(argv, '--tag'); const dir = arg(argv, '--dir');
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !dir) { console.log('usage: node scripts/release-existing.js --tag vX.Y.Z --dir <folder> [--repo owner/name] [--after-publish]'); return 2; }
  const repo = arg(argv, '--repo') ? ['--repo', arg(argv, '--repo')] : [];
  const afterPublish = argv.includes('--after-publish');
  const view = gh(['release', 'view', tag, ...repo, '--json', 'author,isDraft,assets']);
  let release = null;
  if (view.status === 0) release = JSON.parse(view.stdout);
  else if (!/not found/i.test(view.stderr || '')) throw new Error(`gh release view ${tag} failed: ${(view.stderr || '').trim()}`);
  const identical = {};
  if (release) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suds-release-'));
    try {
      for (const n of assetNames(tag).filter((x) => (release.assets || []).some((a) => a.name === x))) {
        const dl = gh(['release', 'download', tag, ...repo, '--pattern', n, '--dir', tmp]);
        if (dl.status !== 0) throw new Error(`could not download ${n}: ${(dl.stderr || '').trim()}`);
        identical[n] = fs.readFileSync(path.join(tmp, n)).equals(fs.readFileSync(path.join(dir, n)));
      }
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const out = judge({ tag, release, identical, afterPublish });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `action=${out.action}\npublish_draft=${out.publishDraft}\n`);
  if (out.problems.length) {
    for (const p of out.problems) console.log(`::error::Release refused: ${p}.`);
    console.log(`::error::${recovery(tag)}.`);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Release refused: the GitHub Release ${tag} is not this workflow's\n${out.problems.map((p) => `- ${p}`).join('\n')}\n\n${recovery(tag)}.\n`);
    return 1;
  }
  console.log(release
    ? `[release-existing] the GitHub Release ${tag} is this workflow's, and ${out.action === 'none' ? 'its zip and checksum are the ones built from the tag' : 'carries no file yet'}${out.publishDraft ? '; it is a draft' : ''}`
    : `[release-existing] there is no GitHub Release ${tag} yet`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.log(`::error::The check of an existing GitHub Release could not run: ${e.message}`); process.exitCode = 1; }
}
module.exports = { judge, recovery, assetNames, BOT, main };
