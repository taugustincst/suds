'use strict';
// Release gate: refuse to release a commit unless the CI workflow (.github/workflows/ci.yml) concluded
// success for that exact commit, with every required job green — including `browser`, which runs the whole
// browser suite (scripts/ui/run-all.sh: accessibility, the QA-regression script a11y-round4, and the rest).
// Run by .github/workflows/release.yml before anything is built or published. Bugs are prevented from
// shipping, not only caught by QA afterwards.
//
//   GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release-gate.js <commit-sha>
//
// Uses the GitHub REST API with the workflow's own token (no marketplace action, no dependency). Only
// `push` runs count: a pull_request run tests a merge commit, not the commit being released. When CI for the
// commit is still running (a tag pushed together with its commit), it waits, up to RELEASE_GATE_WAIT_MINUTES
// (default 60). The `evaluate` function is pure and tested in test/release-gate.test.js.

// Jobs that must have succeeded. `webkit` is advisory (continue-on-error in ci.yml) and deliberately absent.
const REQUIRED_JOBS = ['test', 'browser', 'node24', 'dr-drill'];

/**
 * Decide from CI runs for one commit (newest first, as the API lists them) and their jobs.
 * @param {Array} runs  workflow runs: { id, event, status, conclusion, head_sha, run_attempt, html_url }
 * @param {Object} jobsByRun  run id -> [{ name, conclusion }] (latest attempt)
 * @returns {{ decision: 'pass'|'fail'|'wait', reason: string, run?: object }}
 */
function evaluate(sha, runs, jobsByRun, required = REQUIRED_JOBS) {
  const mine = runs.filter((r) => r.head_sha === sha && r.event === 'push');
  if (!mine.length) return { decision: 'wait', reason: `no CI run on a push of ${sha} yet` };
  const done = mine.filter((r) => r.status === 'completed');
  const problems = [];
  for (const run of done) {
    if (run.conclusion !== 'success') { problems.push(`run ${run.id} concluded ${run.conclusion} (${run.html_url || ''})`); continue; }
    const jobs = jobsByRun[run.id] || [];
    const missing = required.filter((n) => !jobs.some((j) => j.name === n));
    const failed = required.filter((n) => jobs.some((j) => j.name === n && j.conclusion !== 'success'));
    if (!missing.length && !failed.length) return { decision: 'pass', reason: `CI run ${run.id} succeeded for ${sha}, with ${required.join(', ')} all green`, run };
    problems.push(`run ${run.id}: ${[missing.length ? `missing job(s) ${missing.join(', ')}` : '', failed.length ? `job(s) not successful: ${failed.join(', ')}` : ''].filter(Boolean).join('; ')}`);
  }
  if (mine.some((r) => r.status !== 'completed')) return { decision: 'wait', reason: `CI for ${sha} is still running${problems.length ? ` (earlier: ${problems.join(' | ')})` : ''}` };
  return { decision: 'fail', reason: `CI did not pass for ${sha}: ${problems.join(' | ')}` };
}

async function api(path) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
  if (!res.ok) throw new Error(`GitHub API ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function check(sha, repo) {
  const { workflow_runs: runs } = await api(`/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=50`);
  const jobsByRun = {};
  for (const r of runs) {
    if (r.status !== 'completed' || r.conclusion !== 'success' || r.event !== 'push') continue;
    jobsByRun[r.id] = (await api(`/repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`)).jobs;
  }
  return evaluate(sha, runs, jobsByRun);
}

async function main() {
  const sha = process.argv[2] || process.env.GITHUB_SHA;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!/^[0-9a-f]{40}$/.test(sha || '') || !repo) { console.error('usage: GH_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/release-gate.js <40-char sha>'); process.exit(2); }
  const deadline = Date.now() + Number(process.env.RELEASE_GATE_WAIT_MINUTES || 60) * 60_000;
  for (;;) {
    const out = await check(sha, repo);
    console.log(`[release-gate] ${out.decision}: ${out.reason}`);
    if (out.decision === 'pass') return;
    if (out.decision === 'fail' || Date.now() > deadline) {
      console.log(`::error::Release refused. ${out.reason}. Fix CI for this commit (or re-run it) and release again.`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

if (require.main === module) main().catch((e) => { console.log(`::error::Release gate could not check CI: ${e.message}`); process.exit(1); });
module.exports = { evaluate, REQUIRED_JOBS };
