'use strict';
// Scheduled check of the repository settings docs/RELEASE.md asks the owner to make ("Owner: repository settings",
// steps 1 to 7): until 1.17.0 they were written down and assumed, and three releases went out with none of them in
// force while CI said nothing (engineering reviews of 1.16.1 M2, 1.16.2 L5, 1.16.3 L6). This reads them through the
// REST API with a read-only token and fails when a setting is off, or cannot be read.
//
//   node scripts/repo-settings-check.js --repo owner/name            # GH_TOKEN (or GITHUB_TOKEN) in the environment
//   node scripts/repo-settings-check.js --repo owner/name --fixtures responses.json   # offline, from saved responses
//
// Every setting ends in one of five states:
//   ok          read, and as documented;
//   off         read, and not as documented (the job fails);
//   unverified  could not be read with this token: a 401 or 403, or an error (the job fails: "cannot verify" is not
//               a pass). The workflow's default token cannot read the admin-only settings (the Actions permissions,
//               deploy keys, secrets' names, immutable releases); a fine-grained token with read-only access, the
//               SETTINGS_READ_TOKEN secret of the `settings-check` environment, can (docs/RELEASE.md, step 9);
//   warn        until that token exists (the run uses the workflow's own token), a setting the default token is
//               refused (403) is "cannot verify (add SETTINGS_READ_TOKEN)": a warning, not a failure, so the weekly
//               run is red only for a setting it could read and found off (engineering review of the 1.17.0
//               candidate, M6: a job that is red every week until the owner acts gets ignored). With the token, the
//               same row is `unverified` and fails. Also a `settings-check` environment that is not yet limited to
//               `main` while it holds no token;
//   manual      no read-only token can read it (the bypass lists of rulesets, which GitHub shows only to a token that
//               may edit them): listed in the summary for the owner to look at, and not a failure.
//
// `collect` (the requests, through an injected `get`) and `evaluate` (the decision, pure) are tested with fixtures in
// test/repo-settings-check.test.js.

const fs = require('node:fs');
const path = require('node:path');

let REQUIRED_JOBS;
try { ({ REQUIRED_JOBS } = require('./release-gate')); } catch { REQUIRED_JOBS = ['test', 'thorough', 'thorough-sdc', 'browser', 'node24', 'dr-drill']; }

const ADMIN_ROLE_ID = 5; // actor_id of the "Repository admin" role in a ruleset's bypass list
const SAMPLE = { tag: 'refs/tags/v0.0.0', maint: 'refs/heads/maint/0.0' };

/** A ruleset ref pattern (fnmatch: `*` within one path segment, `**` across) as a RegExp. */
function refPattern(p) {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') { re += '.*'; i++; } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
/** Whether a ruleset's ref_name condition covers `ref` (`defaultBranch`: the name `~DEFAULT_BRANCH` stands for). */
function rulesetCovers(rs, ref, defaultBranch) {
  const cond = (rs && rs.conditions && rs.conditions.ref_name) || {};
  const expand = (p) => (p === '~DEFAULT_BRANCH' ? `refs/heads/${defaultBranch}` : p);
  const hit = (list) => (list || []).some((p) => p === '~ALL' || refPattern(expand(p)).test(ref));
  return hit(cond.include) && !hit(cond.exclude);
}

/** Every request the check makes, as `get(path)` -> { status, body } (paths relative to repos/<repo>/). */
async function collect(get) {
  const data = {};
  const read = async (p) => { if (!(p in data)) { try { data[p] = await get(p); } catch (e) { data[p] = { status: 0, body: { message: String(e && e.message || e) } }; } } return data[p]; };
  const repo = await read('');
  const def = (repo.status === 200 && repo.body && repo.body.default_branch) || 'main';
  const list = await read('rulesets?includes_parents=true&per_page=100');
  if (list.status === 200 && Array.isArray(list.body)) for (const r of list.body) await read(`rulesets/${r.id}`);
  const main = await read(`rules/branches/${def}`);
  if (!(main.status === 200 && Array.isArray(main.body) && main.body.length)) {
    const b = await read(`branches/${def}`);
    if (b.status === 200 && b.body && b.body.protected) await read(`branches/${def}/protection`);
  }
  for (const p of ['rules/branches/gh-pages', 'environments/release', 'environments/release/deployment-branch-policies',
    'environments/settings-check', 'environments/settings-check/deployment-branch-policies',
    'environments/release/secrets?per_page=100', 'actions/secrets?per_page=100', 'actions/permissions', 'actions/permissions/workflow',
    'immutable-releases', 'releases/latest', 'keys?per_page=100', 'git/matching-refs/heads/maint/', 'git/matching-refs/heads/release/v']) await read(p);
  const perms = data['actions/permissions'];
  if (perms.status === 200 && perms.body && perms.body.allowed_actions === 'selected') await read('actions/permissions/selected-actions');
  return data;
}

const WHY = {
  admin: 'Administration: read',
  secrets: 'Secrets: read',
  env: 'Environments: read',
};
/** The detail of a response that could not be read. `needs`: the fine-grained permission that reads it. */
function unreadable(r, needs) {
  if (!r || !r.status) return `could not be read (${(r && r.body && r.body.message) || 'no response'})`;
  if (r.status === 401) return 'the token was refused (401: expired or revoked?)';
  if (r.status === 403) return `not readable with this token (403)${needs ? `: needs a token with ${needs}` : ''}`;
  return `could not be read (HTTP ${r.status})`;
}

/**
 * The decision, from `collect`'s responses. `ctx`: { repo: 'owner/name', owner?: login of the release reviewer,
 * readToken?: false when the run has only the workflow's own token (no SETTINGS_READ_TOKEN yet; default true) }.
 * @returns {Array<{ step: string, setting: string, state: 'ok'|'off'|'unverified'|'warn'|'manual', detail: string }>}
 */
function evaluate(data, ctx) {
  const checks = evaluateAll(data, ctx);
  return ctx.readToken === false ? checks.map(withoutReadToken) : checks;
}
/** Without SETTINGS_READ_TOKEN, a row the default token was refused (403, or not shown to it) is a warning. */
function withoutReadToken(c) {
  if (c.state !== 'unverified' || !/\(403\)|not shown to this token/.test(c.detail)) return c;
  return { ...c, state: 'warn', detail: `cannot verify (add SETTINGS_READ_TOKEN): ${c.detail}` };
}
function evaluateAll(data, ctx) {
  const out = [];
  const add = (step, setting, state, detail = '') => out.push({ step, setting, state, detail });
  const r = (p) => data[p] || { status: 0, body: { message: 'not requested' } };
  const ok200 = (x) => x.status === 200;
  const owner = (ctx.owner || String(ctx.repo || '').split('/')[0] || '').toLowerCase();
  const repo = r('');
  const def = (ok200(repo) && repo.body.default_branch) || 'main';

  // Rulesets: the list, and each one's details (conditions and rules are readable with read access; the bypass list
  // only with a token that may edit rulesets).
  const list = r('rulesets?includes_parents=true&per_page=100');
  const rulesets = ok200(list) && Array.isArray(list.body) ? list.body.map((s) => r(`rulesets/${s.id}`)) : [];
  const rulesetsReadable = ok200(list) && rulesets.every(ok200);
  const details = rulesets.filter(ok200).map((x) => x.body).filter((s) => s.enforcement === 'active');
  const byId = new Map(details.map((s) => [s.id, s]));
  const covering = (target, ref) => details.filter((s) => s.target === target && rulesetCovers(s, ref, def));
  const ruleTypes = (sets) => new Set(sets.flatMap((s) => (s.rules || []).map((x) => x.type)));
  // The bypass list of the rulesets in `sets`: `allowed(actor)` says whether an entry is as documented.
  const bypass = (step, setting, sets, allowed, need) => {
    if (!sets.length) return;
    if (sets.some((s) => !Array.isArray(s.bypass_actors))) { add(step, setting, 'manual', `GitHub shows a ruleset's bypass list only to a token that may edit it: open ${sets.map((s) => `"${s.name}"`).join(', ')} and check it (${need})`); return; }
    const actors = sets.flatMap((s) => s.bypass_actors);
    const bad = actors.filter((a) => !allowed(a));
    add(step, setting, bad.length ? 'off' : 'ok', bad.length ? `bypass list has ${bad.map((a) => `${a.actor_type}${a.actor_id ? ` ${a.actor_id}` : ''}`).join(', ')} (${need})` : actors.length ? actors.map((a) => a.actor_type).join(', ') : 'empty');
  };

  // ---- Step 1: the release environment ----
  const env = r('environments/release');
  if (env.status === 404) add('1', 'The `release` environment exists', 'off', 'there is no `release` environment: no release waits for approval');
  else if (!ok200(env)) add('1', 'The `release` environment exists', 'unverified', unreadable(env, WHY.env));
  else {
    add('1', 'The `release` environment exists', 'ok');
    const rules = env.body.protection_rules || [];
    const rev = rules.find((x) => x.type === 'required_reviewers');
    const who = rev ? (rev.reviewers || []).map((x) => (x.reviewer && (x.reviewer.login || x.reviewer.slug || x.reviewer.name)) || '?') : [];
    if (!who.length) add('1', 'Required reviewers on `release`', 'off', 'no required reviewer: a release does not wait for anyone');
    else if (owner && !who.some((w) => String(w).toLowerCase() === owner)) add('1', 'Required reviewers on `release`', 'off', `reviewers ${who.join(', ')} do not include ${owner}`);
    else add('1', 'Required reviewers on `release`', 'ok', who.join(', '));
    if (rev && who.length === 1 && rev.prevent_self_review) add('1', '"Prevent self-review" off while there is one reviewer', 'off', 'on, with one reviewer: the owner cannot approve the release of a tag they pushed');
    else if (rev) add('1', '"Prevent self-review" off while there is one reviewer', 'ok', rev.prevent_self_review ? `on, with ${who.length} reviewers` : 'off');
    const dbp = env.body.deployment_branch_policy;
    if (!dbp) add('1', 'Deployment refs of `release`: the `v*` tags only', 'off', 'any branch or tag may deploy');
    else if (dbp.protected_branches || !dbp.custom_branch_policies) add('1', 'Deployment refs of `release`: the `v*` tags only', 'off', 'set to protected branches, not "Selected branches and tags"');
    else {
      const pol = r('environments/release/deployment-branch-policies');
      if (!ok200(pol)) add('1', 'Deployment refs of `release`: the `v*` tags only', 'unverified', unreadable(pol, WHY.env));
      else {
        const ps = (pol.body.branch_policies || []).map((p) => `${p.name} (${p.type || 'branch'})`);
        add('1', 'Deployment refs of `release`: the `v*` tags only', ps.length === 1 && ps[0] === 'v* (tag)' ? 'ok' : 'off', ps.join(', ') || 'none listed');
      }
    }
  }

  // ---- Step 2: main, and the maintenance branches ----
  const mainRules = r(`rules/branches/${def}`);
  let rules = null; let source = '';
  if (ok200(mainRules) && Array.isArray(mainRules.body) && mainRules.body.length) { rules = mainRules.body; source = 'ruleset'; } else if (ok200(mainRules)) {
    const b = r(`branches/${def}`);
    if (ok200(b) && b.body.protected) {
      const cp = r(`branches/${def}/protection`);
      if (ok200(cp)) { rules = classicRules(cp.body); source = 'classic rule'; } else add('2', `\`${def}\` is protected`, 'unverified', `a classic protection rule is on; its settings are ${unreadable(cp, WHY.admin)}`);
    } else if (ok200(b) || b.status === 404) rules = [];
    else add('2', `\`${def}\` is protected`, 'unverified', unreadable(b));
  } else add('2', `\`${def}\` is protected`, 'unverified', unreadable(mainRules));
  if (rules) {
    for (const c of branchChecks(rules)) add('2', `\`${def}\`: ${c.setting}`, c.ok ? 'ok' : 'off', c.detail + (c.ok && source === 'classic rule' ? ' (classic rule)' : ''));
    if (source === 'ruleset') {
      const sets = [...new Set(rules.map((x) => x.ruleset_id))].map((id) => byId.get(id)).filter(Boolean);
      bypass('2', `\`${def}\`: bypass list empty (or Repository admin only)`, sets, (a) => a.actor_type === 'RepositoryRole' && a.actor_id === ADMIN_ROLE_ID, 'no deploy key, app or team');
    } else if (source === 'classic rule') {
      const cp = r(`branches/${def}/protection`).body;
      add('2', `\`${def}\`: administrators cannot bypass`, cp.enforce_admins && cp.enforce_admins.enabled ? 'ok' : 'manual', cp.enforce_admins && cp.enforce_admins.enabled ? '' : 'administrators may bypass: acceptable only if the owner chose it (RELEASE.md step 2)');
    }
  }
  if (!rulesetsReadable) add('2', '`maint/*` has main\'s rules, and only an admin creates one', 'unverified', unreadable(ok200(list) ? rulesets.find((x) => !ok200(x)) : list));
  else {
    const m = covering('branch', SAMPLE.maint);
    for (const c of branchChecks(m.flatMap((s) => s.rules || []))) add('2', `\`maint/*\`: ${c.setting}`, c.ok ? 'ok' : 'off', c.detail);
    const creators = m.filter((s) => (s.rules || []).some((x) => x.type === 'creation'));
    add('2', '`maint/*`: only an administrator creates one', creators.length ? 'ok' : 'off', creators.length ? creators.map((s) => `"${s.name}"`).join(', ') : 'no ruleset restricts creating a maint/* branch');
    bypass('2', '`maint/*`: bypass list Repository admin only', m, (a) => a.actor_type === 'RepositoryRole' && a.actor_id === ADMIN_ROLE_ID, 'no deploy key, app or team');
    const refs = r('git/matching-refs/heads/maint/');
    if (ok200(refs)) add('2', 'Maintenance branches', 'ok', (refs.body || []).map((x) => x.ref.replace('refs/heads/', '')).join(', ') || 'none yet');
  }

  // ---- Step 3: the v* tag ruleset ----
  if (!rulesetsReadable) add('3', '`v*` tags: creation, update and deletion restricted', 'unverified', unreadable(ok200(list) ? rulesets.find((x) => !ok200(x)) : list));
  else {
    const t = covering('tag', SAMPLE.tag); const types = ruleTypes(t);
    const miss = ['creation', 'update', 'deletion'].filter((x) => !types.has(x));
    add('3', '`v*` tags: creation, update and deletion restricted', t.length && !miss.length ? 'ok' : 'off', !t.length ? 'no active tag ruleset covers v* tags' : miss.length ? `not restricted: ${miss.join(', ')}` : t.map((s) => `"${s.name}"`).join(', '));
    bypass('3', '`v*` tags: bypass list Repository admin only', t, (a) => a.actor_type === 'RepositoryRole' && a.actor_id === ADMIN_ROLE_ID, 'not deploy keys, not the GitHub Actions app');
  }

  // ---- Step 4: the Actions token and the actions allowed ----
  const wf = r('actions/permissions/workflow');
  if (!ok200(wf)) add('4', 'Default workflow token read-only', 'unverified', unreadable(wf, WHY.admin));
  else {
    add('4', 'Default workflow token read-only', wf.body.default_workflow_permissions === 'read' ? 'ok' : 'off', `default_workflow_permissions: ${wf.body.default_workflow_permissions}`);
    add('4', 'Actions cannot create or approve pull requests', wf.body.can_approve_pull_request_reviews ? 'off' : 'ok', `can_approve_pull_request_reviews: ${!!wf.body.can_approve_pull_request_reviews}`);
  }
  const ap = r('actions/permissions');
  if (!ok200(ap)) add('4', 'Only actions created by GitHub may run', 'unverified', unreadable(ap, WHY.admin));
  else if (ap.body.allowed_actions !== 'selected') add('4', 'Only actions created by GitHub may run', 'off', `allowed_actions: ${ap.body.allowed_actions}`);
  else {
    const sel = r('actions/permissions/selected-actions');
    if (!ok200(sel)) add('4', 'Only actions created by GitHub may run', 'unverified', unreadable(sel, WHY.admin));
    else {
      const b = sel.body; const pats = b.patterns_allowed || [];
      const good = b.github_owned_allowed && !b.verified_allowed && !pats.length;
      add('4', 'Only actions created by GitHub may run', good ? 'ok' : 'off', `github_owned_allowed: ${!!b.github_owned_allowed}, verified_allowed: ${!!b.verified_allowed}, patterns: ${pats.join(' ') || 'none'}`);
    }
    if ('sha_pinning_required' in ap.body) add('4', 'Actions pinned to a full commit SHA', ap.body.sha_pinning_required ? 'ok' : 'off', `sha_pinning_required: ${!!ap.body.sha_pinning_required}`);
  }

  // ---- Step 5: immutable releases ----
  const im = r('immutable-releases'); const latest = r('releases/latest');
  const adminRead = ok200(wf);
  if (ok200(im)) add('5', 'Immutable releases', im.body.enabled ? 'ok' : 'off', `enabled: ${!!im.body.enabled}`);
  else if (im.status === 404 && adminRead) add('5', 'Immutable releases', 'off', 'not enabled');
  else if (ok200(latest) && latest.body.immutable === true) add('5', 'Immutable releases', 'ok', `the setting is ${unreadable(im, WHY.admin)}; the newest release, ${latest.body.tag_name}, is immutable`);
  else add('5', 'Immutable releases', 'unverified', `the setting is ${unreadable(im, WHY.admin)}${ok200(latest) ? `; the newest release, ${latest.body.tag_name}, is not immutable (the setting is off, or was turned on after it)` : ''}`);

  // ---- Step 6: gh-pages, the deploy key and its secret ----
  const gp = r('rules/branches/gh-pages');
  if (!ok200(gp)) add('6', '`gh-pages`: updates, deletion and force pushes restricted', 'unverified', unreadable(gp));
  else {
    const types = new Set((gp.body || []).map((x) => x.type));
    const miss = ['update', 'deletion', 'non_fast_forward'].filter((x) => !types.has(x));
    add('6', '`gh-pages`: updates, deletion and force pushes restricted', miss.length ? 'off' : 'ok', miss.length ? `not restricted: ${miss.join(', ')}` : '');
    const sets = [...new Set((gp.body || []).map((x) => x.ruleset_id))].map((id) => byId.get(id)).filter(Boolean);
    bypass('6', '`gh-pages`: bypass list Deploy keys (not the Actions app)', sets, (a) => a.actor_type === 'DeployKey' || (a.actor_type === 'RepositoryRole' && a.actor_id === ADMIN_ROLE_ID), 'Deploy keys, and Repository admin at most');
  }
  const keys = r('keys?per_page=100');
  if (!ok200(keys)) add('6', 'One deploy key with write access', 'unverified', unreadable(keys, WHY.admin));
  else {
    const w = (keys.body || []).filter((k) => !k.read_only);
    add('6', 'One deploy key with write access', w.length === 1 ? 'ok' : 'off', `${(keys.body || []).length} deploy key(s), ${w.length} with write access${w.length ? `: ${w.map((k) => k.title).join(', ')}` : ''}`);
  }
  const es = r('environments/release/secrets?per_page=100');
  if (env.status === 404) add('6', '`PAGES_PUBLISH_KEY` is a secret of `release`', 'off', 'there is no `release` environment');
  else if (!ok200(es)) add('6', '`PAGES_PUBLISH_KEY` is a secret of `release`', 'unverified', unreadable(es, `${WHY.secrets} and ${WHY.env}`));
  else {
    const names = (es.body.secrets || []).map((s) => s.name);
    add('6', '`PAGES_PUBLISH_KEY` is a secret of `release`', names.includes('PAGES_PUBLISH_KEY') ? 'ok' : 'off', names.includes('PAGES_PUBLISH_KEY') ? '' : 'missing');
    if (names.includes('PAGES_DEPLOY_KEY')) add('6', 'No `PAGES_DEPLOY_KEY` secret (the name older workflows read)', 'off', 'a `PAGES_DEPLOY_KEY` secret is in the `release` environment');
  }
  const rs = r('actions/secrets?per_page=100');
  if (!ok200(rs)) add('6', 'No deploy key among the repository secrets', 'unverified', unreadable(rs, WHY.secrets));
  else {
    const bad = (rs.body.secrets || []).map((s) => s.name).filter((n) => n === 'PAGES_PUBLISH_KEY' || n === 'PAGES_DEPLOY_KEY');
    add('6', 'No deploy key among the repository secrets', bad.length ? 'off' : 'ok', bad.length ? `repository secret(s) ${bad.join(', ')}: every workflow on every branch can read them` : '');
  }

  // ---- Step 7: stale branches ----
  const rel = r('git/matching-refs/heads/release/v');
  if (!ok200(rel)) add('7', 'No `release/v*` branches', 'unverified', unreadable(rel));
  else add('7', 'No `release/v*` branches', (rel.body || []).length ? 'off' : 'ok', (rel.body || []).length ? `${rel.body.length} left (each carries the workflow files of its day)` : '');
  if (ok200(repo) && typeof repo.body.delete_branch_on_merge === 'boolean') add('7', 'Automatically delete head branches', repo.body.delete_branch_on_merge ? 'ok' : 'off', '');
  else add('7', 'Automatically delete head branches', 'unverified', ok200(repo) ? `not shown to this token: needs a token with ${WHY.admin}` : unreadable(repo));
  // ---- Step 9: the settings-check environment, limited to main before it holds the token ----
  // The workflow's `environment: settings-check` makes the environment on its first run, open to every branch: a
  // secret added to it then would reach a branch's edited copy of the workflow. Limited to `main` first (RELEASE.md
  // step 9: create it, restrict it to main, then add the secret). Open with no token in it: a warning; open with
  // the token (this run has it): off.
  const sc = r('environments/settings-check');
  const scSetting = 'The `settings-check` environment: deployments from `main` only';
  const open = (detail) => add('9', scSetting, ctx.readToken === false ? 'warn' : 'off', `${detail}${ctx.readToken === false ? ': limit it to main before adding SETTINGS_READ_TOKEN' : ': SETTINGS_READ_TOKEN is readable from any branch\'s copy of the workflow'}`);
  if (sc.status === 404) add('9', scSetting, ctx.readToken === false ? 'warn' : 'off', 'there is no `settings-check` environment yet: create it, limited to main, before adding SETTINGS_READ_TOKEN');
  else if (!ok200(sc)) add('9', scSetting, 'unverified', unreadable(sc, WHY.env));
  else {
    const dbp = sc.body.deployment_branch_policy;
    if (!dbp) open('any branch may deploy');
    else if (dbp.protected_branches || !dbp.custom_branch_policies) open('set to protected branches, not "Selected branches and tags"');
    else {
      const pol = r('environments/settings-check/deployment-branch-policies');
      if (!ok200(pol)) add('9', scSetting, 'unverified', unreadable(pol, WHY.env));
      else {
        const ps = (pol.body.branch_policies || []).map((p) => `${p.name} (${p.type || 'branch'})`);
        if (ps.length === 1 && ps[0] === `${def} (branch)`) add('9', scSetting, 'ok', ps[0]);
        else open(ps.join(', ') || 'none listed');
      }
    }
  }
  return out;
}

/** A classic branch protection (GET …/branches/<b>/protection) as the rule list GET …/rules/branches/<b> gives. */
function classicRules(p) {
  const out = [];
  if (!(p.allow_deletions && p.allow_deletions.enabled)) out.push({ type: 'deletion' });
  if (!(p.allow_force_pushes && p.allow_force_pushes.enabled)) out.push({ type: 'non_fast_forward' });
  const pr = p.required_pull_request_reviews;
  if (pr) out.push({ type: 'pull_request', parameters: { required_approving_review_count: pr.required_approving_review_count || 0, require_code_owner_review: !!pr.require_code_owner_reviews, dismiss_stale_reviews_on_push: !!pr.dismiss_stale_reviews } });
  const sc = p.required_status_checks;
  if (sc) out.push({ type: 'required_status_checks', parameters: { strict_required_status_checks_policy: !!sc.strict, required_status_checks: (sc.checks || (sc.contexts || []).map((context) => ({ context }))).map((c) => ({ context: c.context })) } });
  return out;
}
/** RELEASE.md step 2's boxes, over a branch's rules. */
function branchChecks(rules) {
  const of = (t) => rules.filter((x) => x.type === t);
  const pr = of('pull_request').map((x) => x.parameters || {});
  const sc = of('required_status_checks').map((x) => x.parameters || {});
  const contexts = new Set(sc.flatMap((p) => (p.required_status_checks || []).map((c) => c.context)));
  const missing = REQUIRED_JOBS.filter((j) => !contexts.has(j));
  const review = pr.some((p) => p.required_approving_review_count >= 1 && p.require_code_owner_review && p.dismiss_stale_reviews_on_push);
  return [
    { setting: 'deletion restricted', ok: of('deletion').length > 0, detail: '' },
    { setting: 'force pushes blocked', ok: of('non_fast_forward').length > 0, detail: '' },
    { setting: 'pull request with a code owner\'s approval, stale approvals dismissed', ok: review, detail: pr.length ? (review ? '' : `pull request rule: ${pr.map((p) => `${p.required_approving_review_count || 0} approval(s), code owners ${!!p.require_code_owner_review}, dismiss stale ${!!p.dismiss_stale_reviews_on_push}`).join('; ')}`) : 'no pull request rule' },
    { setting: `required checks ${REQUIRED_JOBS.join(', ')}, branch up to date`, ok: sc.length > 0 && !missing.length && sc.some((p) => p.strict_required_status_checks_policy), detail: !sc.length ? 'no status check rule' : missing.length ? `missing: ${missing.join(', ')}` : sc.some((p) => p.strict_required_status_checks_policy) ? '' : '"Require branches to be up to date" is off' },
  ];
}

const MARK = { ok: 'ok', off: '**OFF**', unverified: '**cannot verify**', warn: 'warning', manual: 'check by hand' };
/** The run summary: one row per setting, then what to do. */
function summary(checks, { repo, tokenKind }) {
  const n = (s) => checks.filter((c) => c.state === s).length;
  const failing = n('off') + n('unverified');
  const lines = [`### Repository settings (${repo})`, '',
    failing ? `**${n('off')} off, ${n('unverified')} cannot be verified** with the ${tokenKind} token; ${n('ok')} as documented.` : `Every setting that can be read is as documented (${n('ok')}).`,
    n('warn') ? `${n('warn')} warning${n('warn') === 1 ? '' : 's'}: settings the ${tokenKind} token cannot read, which are not failures until SETTINGS_READ_TOKEN is added (docs/RELEASE.md step 9), and the \`settings-check\` environment's limit.` : '',
    n('manual') ? `${n('manual')} to check by hand (no read-only token can see them).` : '', '',
    '| Step | Setting | State | Detail |', '| --- | --- | --- | --- |',
    ...checks.map((c) => `| ${c.step} | ${c.setting} | ${MARK[c.state]} | ${String(c.detail || '').replace(/\|/g, '\\|')} |`), ''];
  if (failing) lines.push('The steps are those of docs/RELEASE.md, *Owner: repository settings*. A setting that cannot be verified is not a pass: give the check a token that can read it (step 9) or look at it yourself.', '');
  return lines.filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n') + '\n';
}

async function apiGet(p, { repo, token, base = process.env.GITHUB_API_URL || 'https://api.github.com' }) {
  const url = `${base}/repos/${repo}${p ? `/${p}` : ''}`;
  const res = await fetch(url, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'suds-settings-check', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  let body = null; try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

async function main() {
  const repo = arg('--repo') || process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('--repo owner/name (or GITHUB_REPOSITORY) is required');
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  const tokenKind = process.env.SETTINGS_TOKEN_KIND || (token ? 'given' : 'no');
  let get;
  if (arg('--fixtures')) {
    const fx = JSON.parse(fs.readFileSync(path.resolve(arg('--fixtures')), 'utf8'));
    get = async (p) => fx[p] || { status: 404, body: { message: 'Not Found' } };
  } else get = (p) => apiGet(p, { repo, token });
  // The workflow says which token it passed: without SETTINGS_READ_TOKEN, what the default token cannot read warns.
  const readToken = tokenKind === 'SETTINGS_READ_TOKEN' || process.argv.includes('--strict');
  const checks = evaluate(await collect(get), { repo, owner: arg('--owner'), readToken });
  for (const c of checks) {
    const line = `${c.step} ${c.setting}: ${c.state}${c.detail ? ` (${c.detail})` : ''}`;
    if (c.state === 'off') console.log(`::error::Setting off (docs/RELEASE.md step ${c.step}): ${line}`);
    else if (c.state === 'unverified') console.log(`::error::Cannot verify (docs/RELEASE.md step ${c.step}): ${line}`);
    else if (c.state === 'warn') console.log(`::warning::(docs/RELEASE.md step ${c.step}): ${line}`);
    else console.log(line);
  }
  const md = summary(checks, { repo, tokenKind });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  return checks.some((c) => c.state === 'off' || c.state === 'unverified') ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.log(`::error::The settings check could not run: ${e.message}`); process.exitCode = 1; });
}
module.exports = { refPattern, rulesetCovers, collect, evaluate, withoutReadToken, classicRules, branchChecks, summary, unreadable, REQUIRED_JOBS };
