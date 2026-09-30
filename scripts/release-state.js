'use strict';
// What the documents say about the state of the releases, compared with what is true (1.21.0). The review of
// 1.20.0 found the release documents disagreeing with each other and with the repository: a CHANGELOG section for
// 1.20.0 saying "1.19.x is the latest minor", an evidence index calling 1.19.0 live on GitHub Pages after 1.20.0 was
// published, a hand-off for "six" tags beside one for seven. Each was true when written and nothing checked it
// afterwards. This checks, and says where and how to fix each finding:
//
//   * docs/security/QUESTIONNAIRE.md "Checked against" and docs/evidence/README.md "Version." name a version on the
//     minor line of the newest stamped release (as test/doc-currency.test.js), and what they say about its tag;
//   * docs/RELEASE.md: the Supported versions rows (latest, previous, older minor) against the stamped versions, the
//     *Record: X.Y.Z* references and the exceptions ledger against the CHANGELOG, and the "tags owed" list;
//   * docs/evidence/RELEASE-HANDOFF.md: each row's CHANGELOG date; its commit exists, is on main, and is
//     "Release X.Y.Z" (or "SBOM of the X.Y.Z stamp", the commit after that stamp); its `git tag -a`, `for c in` and
//     `git push` lines name the same commits and tags; its title and counts match the table; and whether each tag
//     is pushed, which the page says none is;
//   * HANDOFF.md's *Release waiting* entry: the same tags, and gone once they are pushed;
//   * every "X.Y.Z is live" / "live on GitHub Pages" / "is what GitHub Pages serves" against gh-pages' version.json
//     (and, offline, against each other);
//   * a stamped version newer than the newest pushed tag that the hand-off does not list;
//   * CHANGELOG.md: inside a dated section "## X.Y.Z — date", a line calling another minor "the latest minor" or
//     "the previous", or saying "checked against", "describe(s)", "not yet released" or "fix release" of another
//     version. Legitimate history is in CHANGELOG_ALLOW below, each with its reason.
//
//   node scripts/release-state.js              # the repository, plus `git ls-remote --tags origin` and the local
//                                              # origin/main and origin/gh-pages refs, where they can be read
//   node scripts/release-state.js --fetch      # fetch origin's main and gh-pages first (what CI's job does)
//   node scripts/release-state.js --offline    # no network: local git only; says what it could not check
//   node scripts/release-state.js --docs-only  # the documents alone, no git at all (deterministic for a tree)
//   ... [--root <dir>] [--json]
//
// Exit status: 0 no problem found, 1 problems (each printed as file:line, with a fix), 2 usage error. What could not
// be checked (no network, a shallow clone without the commits, no gh-pages ref) is listed and is not a problem.
// Node built-ins and git only, so it runs from a bare checkout. The logic is tested with synthetic inputs in
// test/release-state.test.js; docs/RELEASE.md (stamp checklist) says when to run it.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ---------------------------------------------------------------------------------------------------- versions
const V = /\d+\.\d+\.\d+/;
function parseV(v) { const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim()); return m ? [+m[1], +m[2], +m[3]] : null; }
function cmp(a, b) { const x = parseV(a), y = parseV(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }
const minorOf = (v) => String(v).split('.').slice(0, 2).join('.');
const cmpMinor = (a, b) => cmp(`${a}.0`, `${b}.0`);
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** 1-based line of a character index. */
function lineAt(text, index) { let n = 1; for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++; return n; }
/** Markdown emphasis blanked out, same length, so indexes (and so line numbers) still hold. */
const unmark = (s) => s.replace(/[*_`]/g, ' ');

// ----------------------------------------------------------------------------------------------------- parsers
/** Dated CHANGELOG sections, newest first: [{ version, date, line }]. */
function stampedVersions(changelog) {
  const out = [];
  const re = /^## (\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})\s*$/gm;
  for (let m; (m = re.exec(changelog));) out.push({ version: m[1], date: m[2], line: lineAt(changelog, m.index) });
  return out.sort((a, b) => cmp(b.version, a.version));
}
/** The version the documents must describe: package.json's once stamped, else the newest stamped one. */
function targetVersion(pkgVersion, stamped) {
  return stamped.some((s) => s.version === pkgVersion) ? pkgVersion : (stamped[0] || {}).version || null;
}
/** Distinct stamped minor lines, newest first. */
function minorLines(stamped) { return [...new Set(stamped.map((s) => minorOf(s.version)))].sort((a, b) => cmpMinor(b, a)); }

const TAG_PENDING = /\b(?:tag is pending|has not tagged|not tagged|not pushed|untagged|none is tagged)\b/i;

/** A "**Label** X.Y.Z …" line: the version, its line and whether it calls that version's tag pending / live. */
function versionLine(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  const lineEnd = text.indexOf('\n', m.index);
  const body = text.slice(m.index, lineEnd < 0 ? undefined : lineEnd);
  return { version: m[1], line: lineAt(text, m.index), tagPending: TAG_PENDING.test(body) };
}
const parseQuestionnaire = (t) => versionLine(t, /^\*\*Checked against:\*\*\s*(\d+\.\d+\.\d+)/m);
const parseEvidence = (t) => versionLine(t, /^\*\*Version\.\*\*\s*It describes (\d+\.\d+\.\d+)/m);

/** docs/RELEASE.md: the Supported versions rows, the ledger and the tags it says are owed. */
function parseRelease(text) {
  const t = unmark(text);
  const row = (re) => { const m = re.exec(t); return m ? { minor: m[1], line: lineAt(t, m.index), m } : null; };
  const latest = row(/^\|\s*The latest minor\s*\(today (\d+\.\d+)\.x\)/m);
  const previous = row(/^\|\s*The previous minor\s*\(today (\d+\.\d+)\.x/m);
  if (previous) {
    const after = /until 30 days after (\d+\.\d+\.\d+)'s release date/.exec(previous.m.input.slice(previous.m.index, previous.m.input.indexOf('\n', previous.m.index)));
    previous.after = after ? after[1] : null;
  }
  const older = row(/^\|\s*Anything older\s*\(today (\d+\.\d+)\.x and before/m);
  for (const r of [latest, previous, older]) if (r) delete r.m;
  const notPushed = [...t.matchAll(/\s(v\d+\.\d+\.\d+)\s+is not pushed yet/g)].map((m) => ({ tag: m[1], line: lineAt(t, m.index) }));
  const records = [...text.matchAll(/^\*\*Record: (\d+\.\d+\.\d+)(?:[–-](\d+\.\d+\.\d+))?/gm)].map((m) => ({ version: m[1], to: m[2] || null, line: lineAt(text, m.index) }));
  const recordRefs = [...text.matchAll(/(?<!\*)\*Record: (\d+\.\d+\.\d+)\*/g)].map((m) => ({ version: m[1], line: lineAt(text, m.index) }));
  // The exceptions ledger: the table after "The exceptions in one place".
  const ledger = [];
  const at = text.indexOf('The exceptions in one place');
  if (at >= 0) {
    const lines = text.slice(at).split('\n');
    const first = lineAt(text, at);
    let inTable = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('|')) { inTable = true; } else if (inTable) break; else continue;
      const cell = (l.split('|')[1] || '').trim();
      const vs = cell.match(/\d+\.\d+\.\d+/g);
      if (vs && !/^-+$/.test(cell)) ledger.push({ versions: vs, range: /[–-]/.test(cell.replace(/\d+\.\d+\.\d+/g, '')), line: first + i });
    }
  }
  const owedM = /the tags owed are ((?:\s*,?\s*(?:and\s+)?v\d+\.\d+\.\d+)+)/.exec(t);
  const owed = owedM ? { tags: owedM[1].match(/v\d+\.\d+\.\d+/g), line: lineAt(t, owedM.index) } : null;
  const countM = /\bNow (\w+) tags\b/.exec(t);
  const count = countM ? { word: countM[1].toLowerCase(), line: lineAt(t, countM.index) } : null;
  return { latest, previous, older, notPushed, records, recordRefs, ledger, owed, count };
}

/** docs/evidence/RELEASE-HANDOFF.md: its table, commands, title and counts. */
function parseHandoff(text) {
  const rows = [];
  const re = /^\|\s*`(v(\d+\.\d+\.\d+))`\s*\|\s*`([0-9a-f]{40})`([^|]*)\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*`([0-9a-f]{64})`\s*\|/gm;
  for (let m; (m = re.exec(text));) {
    const after = /after the stamp `([0-9a-f]{7,40})`/.exec(m[4]);
    rows.push({ tag: m[1], version: m[2], commit: m[3], date: m[5], zip: m[6], afterStamp: after ? after[1] : null, line: lineAt(text, m.index) });
  }
  // A row the stamp itself cannot fill: the released commit is the SBOM commit after "Release X.Y.Z" (a commit cannot
  // hold its own hash), found by its subject; its zip's SHA-256 is recorded by a later commit on main.
  const pending = [];
  const pre = /^\|\s*`(v(\d+\.\d+\.\d+))`\s*\|\s*the commit after `Release (\d+\.\d+\.\d+)`[^|]*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm;
  for (let m; (m = pre.exec(text));) if (m[2] === m[3]) pending.push({ tag: m[1], version: m[2], commit: null, date: m[4], zip: null, afterStamp: null, pending: true, line: lineAt(text, m.index) });
  const tagCommands = [...text.matchAll(/^git tag -a (v\d+\.\d+\.\d+) (\S+) -m "SUDS (\d+\.\d+\.\d+)"/gm)]
    .map((m) => ({ tag: m[1], commit: m[2].replace(/^"|"$/g, ''), message: m[3], line: lineAt(text, m.index) }));
  const pushM = /^git push origin((?: v\d+\.\d+\.\d+)+)\s*$/m.exec(text);
  const push = pushM ? { tags: pushM[1].trim().split(/\s+/), line: lineAt(text, pushM.index) } : null;
  const loops = [...text.matchAll(/^for c in ([^;]+); do/gm)].map((m) => ({ shas: m[1].trim().split(/\s+/).filter((s) => /^[0-9a-f]{7,40}$/.test(s)), vars: m[1].trim().split(/\s+/).filter((s) => s.startsWith('$')).length, line: lineAt(text, m.index) }));
  const titleM = /^# .*\btags (v\d+\.\d+\.\d+) to (v\d+\.\d+\.\d+)/m.exec(text);
  const title = titleM ? { from: titleM[1], to: titleM[2], line: lineAt(text, titleM.index) } : null;
  const counts = [...text.matchAll(/\b(?:[Tt]he|all|All) (two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:releases|tags|untagged releases)\b|^(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|Eleven|Twelve) versions are on/gm)]
    .map((m) => ({ word: (m[1] || m[2]).toLowerCase(), line: lineAt(text, m.index) }));
  const noneTagged = /\bnone is tagged\b/.exec(text);
  return { rows, pending, tagCommands, push, loops, title, counts, noneTagged: noneTagged ? { line: lineAt(text, noneTagged.index) } : null };
}

/** HANDOFF.md: the *Release waiting* section, if any. */
function parseHandoffNotes(text) {
  const m = /^### Release waiting\s*$/m.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const end = rest.search(/^#{2,3} /m);
  const body = end < 0 ? rest : rest.slice(0, end);
  const start = m.index + m[0].length;
  const first = /\*\*([^*]*?) are on `main`/.exec(body);
  const versions = first ? (first[1].match(/\d+\.\d+\.\d+/g) || []) : [];
  const pushM = /git push origin((?: v\d+\.\d+\.\d+)+)/.exec(body);
  const countM = /\btags all (\w+)\b/.exec(body);
  return {
    line: lineAt(text, m.index),
    versions,
    versionsLine: first ? lineAt(text, start + first.index) : null,
    push: pushM ? { tags: pushM[1].trim().split(/\s+/), line: lineAt(text, start + pushM.index) } : null,
    count: countM ? { word: countM[1].toLowerCase(), line: lineAt(text, start + countM.index) } : null,
  };
}

/** Every claim that a version is live on GitHub Pages now: [{ version, line, text }]. */
function liveClaims(text) {
  const t = unmark(text);
  const out = [];
  for (const m of t.matchAll(/(\d+\.\d+\.\d+) is what GitHub Pages serves/g)) out.push({ version: m[1], line: lineAt(t, m.index) });
  for (const m of t.matchAll(/(\d+\.\d+\.\d+),? (?:and \S+ )?is live\b/g)) out.push({ version: m[1], line: lineAt(t, m.index) });
  for (const m of t.matchAll(/\blive on GitHub Pages\b/g)) {
    // The claim is about the nearest version before it in the same paragraph.
    const from = Math.max(0, t.lastIndexOf('\n\n', m.index), m.index - 200);
    const before = t.slice(from, m.index).match(/\d+\.\d+\.\d+/g);
    if (before) out.push({ version: before[before.length - 1], line: lineAt(t, m.index) });
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- CHANGELOG lint
/**
 * Legitimate mentions of another version in a dated section, each with its reason. Matched on the section and the
 * matched words (whitespace collapsed); keep it short, and never allow a line that says what is current.
 */
const CHANGELOG_ALLOW = [
  { section: '1.17.0', text: 'checked against 1.16.4', reason: '1.17.0 records that the questionnaire was first checked against 1.16.4, the release before it, as that work was done' },
];

/** Findings inside dated sections: [{ line, section, found, message }]. `allow`: CHANGELOG_ALLOW's shape. */
function lintChangelog(changelog, allow = CHANGELOG_ALLOW) {
  const text = unmark(changelog);
  const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => ({ title: m[1], index: m.index }));
  const stamped = stampedVersions(changelog);
  const lines = minorLines(stamped);
  const out = [];
  heads.forEach((h, i) => {
    const d = /^(\d+\.\d+\.\d+) — \d{4}-\d{2}-\d{2}\s*$/.exec(h.title);
    if (!d) return;
    const X = d[1];
    const section = text.slice(h.index, i + 1 < heads.length ? heads[i + 1].index : undefined);
    const prevMinor = lines[lines.indexOf(minorOf(X)) + 1] || null;
    const rules = [
      { re: /\b(\d+\.\d+)\.(?:x|\d+)\s+(?:is\s+|was\s+)?the\s+latest\s+minor\b/gi, bad: (v) => v !== minorOf(X), want: `${minorOf(X)}.x is the latest minor` },
      { re: /\bthe\s+latest\s+minor\s+\((?:today\s+)?(\d+\.\d+)\.(?:x|\d+)/gi, bad: (v) => v !== minorOf(X), want: `the latest minor (${minorOf(X)}.x)` },
      { re: /\b(\d+\.\d+)\.(?:x|\d+)\)?,?\s+(?:is\s+|was\s+)?the\s+previous\b/gi, bad: (v) => v !== prevMinor, want: prevMinor ? `${prevMinor}.x the previous` : 'no previous minor' },
      { re: /\bthe\s+previous\s+minor\s+\((?:today\s+)?(\d+\.\d+)\.(?:x|\d+)/gi, bad: (v) => v !== prevMinor, want: prevMinor ? `the previous minor (${prevMinor}.x)` : 'no previous minor' },
      { re: /\bchecked\s+against\s+(\d+\.\d+\.\d+)/gi, bad: (v) => v !== X, want: `checked against ${X}` },
      { re: /\bdescribes?\s+(\d+\.\d+\.\d+)/gi, bad: (v) => v !== X, want: `describe(s) ${X}` },
      { re: /\bbuilt\s+for\s+(\d+\.\d+\.\d+),?\s+not\s+yet\s+released/gi, bad: (v) => v !== X, want: `released in ${X}, or the later version it is built for said without "not yet released"` },
      { re: /\b(\d+\.\d+\.\d+),?\s+(?:is\s+|was\s+)?not\s+yet\s+released/gi, bad: (v) => v !== X, want: `what is true once ${X} is stamped` },
      { re: /\bfix\s+release\s+(\d+\.\d+\.\d+)/gi, bad: (v) => v !== X, want: `fix release ${X}` },
    ];
    const taken = []; // [start, end) of matches already reported: one finding per phrase
    for (const r of rules) {
      for (const m of section.matchAll(r.re)) {
        if (!r.bad(m[1])) continue;
        const end = m.index + m[0].length;
        if (taken.some(([a, b]) => m.index < b && end > a)) continue;
        taken.push([m.index, end]);
        const found = m[0].replace(/\s+/g, ' ');
        if (allow.some((a) => a.section === X && found.toLowerCase().includes(a.text.toLowerCase()))) continue;
        out.push({ line: lineAt(text, h.index + m.index), section: X, found, message: `the ${X} section says "${found}"`, want: r.want });
      }
    }
  });
  return out;
}

// -------------------------------------------------------------------------------------------------------- checks
const P = (file, line, message, fix, code) => ({ file, line: line || 1, message, fix, code });
const FILES = {
  pkg: 'package.json', changelog: 'CHANGELOG.md', questionnaire: 'docs/security/QUESTIONNAIRE.md', evidence: 'docs/evidence/README.md',
  release: 'docs/RELEASE.md', handoff: 'docs/evidence/RELEASE-HANDOFF.md', notes: 'HANDOFF.md',
};
const LIVE_DOCS = ['questionnaire', 'evidence', 'release', 'handoff', 'notes'];

/**
 * The checks. `docs`: { pkg, changelog, questionnaire, evidence, release, handoff, notes } texts (a missing file is
 * null). `git`: null (not read), or { shallow, mainRef, commits: { sha: { exists, subject, parent, parentSubject, onMain } } }
 * (onMain null when there is no main ref). `remote`: null, or { tags: { 'v1.2.3': '<peeled commit sha>' } }.
 * `pages`: null, or { version, source }. `mainPkg`: null, or { version, stamped: [...] } from origin/main.
 * Returns { problems, notChecked, info }.
 */
function evaluate({ docs, git = null, remote = null, pages = null, mainPkg = null }) {
  const problems = [];
  const notChecked = [];
  const info = [];
  const pkgVersion = docs.pkg ? JSON.parse(docs.pkg).version : null;
  const stamped = stampedVersions(docs.changelog || '');
  const stampedSet = new Map(stamped.map((s) => [s.version, s]));
  const target = targetVersion(pkgVersion, stamped);
  const lines = minorLines(stamped);
  info.push(`package.json ${pkgVersion}; newest stamped ${stamped[0] ? stamped[0].version : 'none'}; the documents must describe ${target}`);

  // 1. The questionnaire and the evidence index.
  const q = docs.questionnaire != null ? parseQuestionnaire(docs.questionnaire) : null;
  const e = docs.evidence != null ? parseEvidence(docs.evidence) : null;
  for (const [key, parsed, label] of [['questionnaire', q, '"Checked against"'], ['evidence', e, '"Version."']]) {
    if (!parsed) { problems.push(P(FILES[key], 1, `no ${label} line naming a version`, `restore the ${label} line (docs/RELEASE.md, stamp checklist)`, 'doc-version-missing')); continue; }
    if (target && (minorOf(parsed.version) !== minorOf(target) || cmp(parsed.version, target) > 0)) {
      problems.push(P(FILES[key], parsed.line, `${label} names ${parsed.version}, not the ${minorOf(target)} line of ${target}`, `move it to ${target} and re-read the answers for what ${target} changed`, 'doc-version-behind'));
    }
  }

  // 2. RELEASE.md: supported versions, records and the ledger.
  const rel = docs.release != null ? parseRelease(docs.release) : null;
  if (rel && target) {
    const wantLatest = minorOf(target);
    const wantPrev = lines[lines.indexOf(wantLatest) + 1] || null;
    const wantOlder = wantPrev ? lines[lines.indexOf(wantPrev) + 1] || null : null;
    const firstOfLatest = stamped.filter((s) => minorOf(s.version) === wantLatest).map((s) => s.version).sort(cmp)[0];
    if (!rel.latest) problems.push(P(FILES.release, 1, 'no "The latest minor (today X.Y.x)" row in *Supported versions*', 'restore the row', 'supported-missing'));
    else if (rel.latest.minor !== wantLatest) problems.push(P(FILES.release, rel.latest.line, `*Supported versions* calls ${rel.latest.minor}.x the latest minor; the newest stamped release is ${target}`, `today ${wantLatest}.x`, 'supported-latest'));
    if (wantPrev) {
      if (!rel.previous) problems.push(P(FILES.release, 1, 'no "The previous minor (today X.Y.x" row in *Supported versions*', 'restore the row', 'supported-missing'));
      else {
        if (rel.previous.minor !== wantPrev) problems.push(P(FILES.release, rel.previous.line, `*Supported versions* calls ${rel.previous.minor}.x the previous minor; it is ${wantPrev}.x`, `today ${wantPrev}.x, until 30 days after ${firstOfLatest}'s release date`, 'supported-previous'));
        if (rel.previous.after && rel.previous.after !== firstOfLatest) problems.push(P(FILES.release, rel.previous.line, `the previous minor's 30 days are counted from ${rel.previous.after}, not ${firstOfLatest} (the first release of the latest minor)`, `until 30 days after ${firstOfLatest}'s release date`, 'supported-previous-after'));
      }
    }
    if (wantOlder && rel.older && rel.older.minor !== wantOlder) problems.push(P(FILES.release, rel.older.line, `*Supported versions* calls ${rel.older.minor}.x and before "anything older"; that is ${wantOlder}.x and before`, `today ${wantOlder}.x and before`, 'supported-older'));
    for (const r of rel.records) {
      for (const v of [r.version, r.to].filter(Boolean)) if (!stampedSet.has(v)) problems.push(P(FILES.release, r.line, `*Record: ${v}* is about a version with no dated CHANGELOG section`, 'check the version, or stamp it first', 'record-unknown'));
    }
    const recordSet = new Set(rel.records.map((r) => r.version));
    for (const ref of rel.recordRefs) if (!recordSet.has(ref.version)) problems.push(P(FILES.release, ref.line, `*Record: ${ref.version}* is referred to, but there is no "**Record: ${ref.version}" paragraph`, `write the record, or refer to the one that exists`, 'record-missing'));
    for (const row of rel.ledger) for (const v of row.versions) if (!stampedSet.has(v)) problems.push(P(FILES.release, row.line, `the exceptions ledger has a row for ${v}, which has no dated CHANGELOG section`, 'check the version in the ledger', 'ledger-unknown'));
  }

  // 3. The hand-off page, against the CHANGELOG, its own commands and HANDOFF.md.
  const h = docs.handoff != null ? parseHandoff(docs.handoff) : null;
  const notes = docs.notes != null ? parseHandoffNotes(docs.notes) : null;
  // Rows with a commit, and rows whose commit the stamp cannot hold yet (checked for everything but the commit).
  const all = h ? [...h.rows, ...(h.pending || [])] : [];
  const owedTags = all.map((r) => r.tag);
  if (h) {
    for (const r of all) {
      const s = stampedSet.get(r.version);
      if (!s) problems.push(P(FILES.handoff, r.line, `${r.tag}: ${r.version} has no dated CHANGELOG section`, 'check the version', 'handoff-unknown'));
      else if (s.date !== r.date) problems.push(P(FILES.handoff, r.line, `${r.tag}: the table says its CHANGELOG date is ${r.date}; CHANGELOG.md:${s.line} says ${s.date}`, `use ${s.date}`, 'handoff-date'));
    }
    const byTag = new Map(all.map((r) => [r.tag, r]));
    for (const c of h.tagCommands) {
      const r = byTag.get(c.tag);
      if (!r) problems.push(P(FILES.handoff, c.line, `\`git tag -a ${c.tag}\` has no row in the table`, 'add the row or remove the command', 'handoff-command'));
      else {
        if (r.commit && /^[0-9a-f]{7,40}$/.test(c.commit) && !r.commit.startsWith(c.commit)) problems.push(P(FILES.handoff, c.line, `\`git tag -a ${c.tag} ${c.commit}\` names another commit than the table (${r.commit.slice(0, 12)})`, 'make the command and the table agree', 'handoff-command'));
        if (c.message !== r.version) problems.push(P(FILES.handoff, c.line, `\`git tag -a ${c.tag}\`'s message says SUDS ${c.message}`, `-m "SUDS ${r.version}"`, 'handoff-command'));
      }
    }
    for (const r of all) if (!h.tagCommands.some((c) => c.tag === r.tag)) problems.push(P(FILES.handoff, r.line, `${r.tag} has no \`git tag -a\` command`, 'add it to step 2', 'handoff-command'));
    if (h.push && !sameSet(h.push.tags, owedTags)) problems.push(P(FILES.handoff, h.push.line, `the push names ${h.push.tags.join(' ')}; the table ${owedTags.join(' ')}`, 'one push of exactly the tags in the table', 'handoff-push'));
    for (const l of h.loops) {
      const stray = l.shas.filter((s) => !h.rows.some((r) => r.commit.startsWith(s)));
      if (stray.length) problems.push(P(FILES.handoff, l.line, `the check loop names ${stray.join(', ')}, which is not a commit in the table`, 'list the table\'s commits', 'handoff-loop'));
      else if (l.shas.length + l.vars !== all.length) problems.push(P(FILES.handoff, l.line, `the check loop names ${l.shas.length + l.vars} commits; the table has ${all.length}`, 'list the table\'s commits', 'handoff-loop'));
    }
    if (all.length) {
      const sorted = [...all].sort((a, b) => cmp(a.version, b.version));
      const [lo, hi] = [sorted[0].tag, sorted[sorted.length - 1].tag];
      if (h.title && (h.title.from !== lo || h.title.to !== hi)) problems.push(P(FILES.handoff, h.title.line, `the title says ${h.title.from} to ${h.title.to}; the table has ${lo} to ${hi}`, `tags ${lo} to ${hi}`, 'handoff-title'));
      for (const c of h.counts) if (NUMBER_WORDS.indexOf(c.word) !== all.length) problems.push(P(FILES.handoff, c.line, `says ${c.word}; the table has ${all.length} (${NUMBER_WORDS[all.length] || all.length})`, 'make the count match the table', 'handoff-count'));
    }
    if (rel && rel.owed && !sameSet(rel.owed.tags, owedTags)) problems.push(P(FILES.release, rel.owed.line, `"the tags owed" are ${rel.owed.tags.join(', ')}; RELEASE-HANDOFF.md's table has ${owedTags.join(', ')}`, 'name the same tags as the hand-off', 'owed-mismatch'));
    if (rel && rel.count && NUMBER_WORDS.indexOf(rel.count.word) !== all.length) problems.push(P(FILES.release, rel.count.line, `"Now ${rel.count.word} tags"; RELEASE-HANDOFF.md's table has ${all.length}`, 'make the count match the hand-off', 'owed-count'));
    if (notes) {
      const tagsOfVersions = notes.versions.map((v) => `v${v}`);
      if (notes.versions.length && !sameSet(tagsOfVersions, owedTags)) problems.push(P(FILES.notes, notes.versionsLine, `*Release waiting* names ${notes.versions.join(', ')}; RELEASE-HANDOFF.md's table has ${all.map((r) => r.version).join(', ')}`, 'name the same versions', 'notes-mismatch'));
      if (notes.push && !sameSet(notes.push.tags, owedTags)) problems.push(P(FILES.notes, notes.push.line, `*Release waiting*'s push names ${notes.push.tags.join(' ')}; the hand-off ${owedTags.join(' ')}`, 'the same push as the hand-off', 'notes-mismatch'));
      if (notes.count && NUMBER_WORDS.indexOf(notes.count.word) !== all.length) problems.push(P(FILES.notes, notes.count.line, `"tags all ${notes.count.word}"; the hand-off has ${all.length}`, 'make the count match', 'notes-mismatch'));
    } else if (all.length) {
      problems.push(P(FILES.notes, 1, `RELEASE-HANDOFF.md lists ${all.length} tags owed, but HANDOFF.md has no *Release waiting* entry`, 'add the entry, pointing at the hand-off', 'notes-missing'));
    }
  }

  // 4. Live on GitHub Pages: the claims agree with each other, and with gh-pages when it can be read.
  const claims = [];
  for (const key of LIVE_DOCS) if (docs[key] != null) for (const c of liveClaims(docs[key])) claims.push({ ...c, file: FILES[key] });
  if (pages) {
    info.push(`gh-pages serves ${pages.version} (${pages.source})`);
    for (const c of claims) if (c.version !== pages.version) problems.push(P(c.file, c.line, `says ${c.version} is live on GitHub Pages; gh-pages' version.json says ${pages.version}`, `say ${pages.version}, or that ${c.version} was published then replaced`, 'pages-live'));
  } else {
    notChecked.push('what GitHub Pages serves (no origin/gh-pages ref: run with --fetch, or git fetch origin gh-pages)');
    const counts = new Map();
    for (const c of claims) counts.set(c.version, (counts.get(c.version) || 0) + 1);
    const top = Math.max(0, ...counts.values());
    const majority = [...counts].filter(([, n]) => n === top).map(([v]) => v);
    if (counts.size > 1) for (const c of claims) if (!(majority.length === 1 && majority[0] === c.version)) problems.push(P(c.file, c.line, `says ${c.version} is live on GitHub Pages; other documents say ${[...counts.keys()].filter((v) => v !== c.version).join(', ')}`, 'the documents must name one live version', 'pages-disagree'));
  }

  // 5. The hand-off's commits, when git can answer. A pending row names no commit yet: say so, never a problem.
  for (const r of (h && h.pending) || []) notChecked.push(`${r.tag}'s commit (the hand-off names it as the commit after "Release ${r.version}"; a later commit on main records it)`);
  if (h && h.rows.length) {
    if (!git) notChecked.push('the hand-off\'s commits (no git: --docs-only)');
    else {
      if (!git.mainRef) notChecked.push('whether the hand-off\'s commits are on main (no origin/main ref in this clone)');
      for (const r of h.rows) {
        const c = git.commits[r.commit];
        if (!c || !c.exists) {
          if (git.shallow) notChecked.push(`${r.tag}'s commit ${r.commit.slice(0, 12)} (not in this shallow clone)`);
          else problems.push(P(FILES.handoff, r.line, `${r.tag}: commit ${r.commit.slice(0, 12)} is not in this clone`, 'git fetch origin and run again; if it is still missing, the SHA in the table is wrong', 'handoff-commit-missing'));
          continue;
        }
        const stamp = `Release ${r.version}`;
        const sbom = `SBOM of the ${r.version} stamp`;
        if (c.subject === sbom) {
          if (c.parentSubject !== stamp) problems.push(P(FILES.handoff, r.line, `${r.tag}: ${r.commit.slice(0, 12)} is "${sbom}" but its parent is "${c.parentSubject}", not "${stamp}"`, 'the SBOM commit comes straight after its stamp', 'handoff-commit-message'));
          if (r.afterStamp && !(c.parent || '').startsWith(r.afterStamp)) problems.push(P(FILES.handoff, r.line, `${r.tag}: the table says it comes after the stamp ${r.afterStamp}; its parent is ${(c.parent || '').slice(0, 12)}`, 'name the parent commit', 'handoff-commit-message'));
        } else if (c.subject !== stamp) {
          problems.push(P(FILES.handoff, r.line, `${r.tag}: ${r.commit.slice(0, 12)} is "${c.subject}", not "${stamp}" (or "${sbom}" after it)`, 'tag the stamp commit (or the SBOM commit after it)', 'handoff-commit-message'));
        }
        if (c.onMain === false) problems.push(P(FILES.handoff, r.line, `${r.tag}: ${r.commit.slice(0, 12)} is not on ${git.mainRef}`, `only a commit on main is released; git fetch origin and run again, and if it is still not on main, find the commit that is`, 'handoff-commit-not-on-main'));
      }
    }
  }

  // 6. Tags: what the documents say is not pushed, against origin.
  if (!remote) notChecked.push('which tags are pushed (no `git ls-remote --tags origin`: --offline or --docs-only, or origin unreachable)');
  else {
    const pushed = (tag) => Object.prototype.hasOwnProperty.call(remote.tags, tag);
    for (const r of all) if (pushed(r.tag)) {
      problems.push(P(FILES.handoff, r.line, `${r.tag} is pushed (at ${remote.tags[r.tag].slice(0, 12)}), but the hand-off still lists it as owed`, 'remove it from the table and the commands (the hand-off is done once every tag is pushed), and follow step 5', 'handoff-tag-pushed'));
      if (r.commit && remote.tags[r.tag] !== r.commit) problems.push(P(FILES.handoff, r.line, `${r.tag} is pushed at ${remote.tags[r.tag].slice(0, 12)}, not at the table's ${r.commit.slice(0, 12)}`, 'find out which commit is released before anything else: the tag decides what release.yml builds', 'handoff-tag-elsewhere'));
    }
    const pendingClaims = [];
    if (q && q.tagPending) pendingClaims.push({ file: FILES.questionnaire, line: q.line, tag: `v${q.version}` });
    if (e && e.tagPending) pendingClaims.push({ file: FILES.evidence, line: e.line, tag: `v${e.version}` });
    if (rel) for (const n of rel.notPushed) pendingClaims.push({ file: FILES.release, line: n.line, tag: n.tag });
    if (notes && notes.push) for (const t of notes.push.tags) pendingClaims.push({ file: FILES.notes, line: notes.push.line, tag: t });
    for (const c of pendingClaims) if (pushed(c.tag)) problems.push(P(c.file, c.line, `says ${c.tag} is not pushed yet; origin has it`, 'say what is true now (the tag and its date), and drop the pending wording', 'tag-claim-stale'));
    // A stamped version newer than the newest pushed tag that nothing lists: a release nobody will tag.
    const pushedVersions = Object.keys(remote.tags).map((t) => t.replace(/^v/, '')).filter((v) => parseV(v));
    const newestPushed = pushedVersions.sort(cmp).pop() || '0.0.0';
    const known = new Map(stamped.map((s) => [s.version, s]));
    if (mainPkg) for (const s of mainPkg.stamped || []) if (!known.has(s.version)) known.set(s.version, s);
    for (const s of [...known.values()].sort((a, b) => cmp(a.version, b.version))) {
      if (cmp(s.version, newestPushed) <= 0 || pushed(`v${s.version}`) || owedTags.includes(`v${s.version}`)) continue;
      problems.push(P(FILES.handoff, all.length ? all[all.length - 1].line : 1, `${s.version} is stamped (CHANGELOG ${s.date}) and newer than the newest pushed tag (v${newestPushed}), but v${s.version} is neither pushed nor listed in the hand-off`, 'add its row, tag command and push (docs/RELEASE.md, *Handing a release to the owner*)', 'untagged-unlisted'));
    }
  }
  if (mainPkg) info.push(`origin/main's package.json says ${mainPkg.version}`);
  else if (git) notChecked.push('origin/main\'s package.json (no origin/main ref)');

  // 7. The CHANGELOG lint.
  for (const f of lintChangelog(docs.changelog || '')) problems.push(P(FILES.changelog, f.line, f.message, `say what was true of ${f.section} (${f.want}), or add the line to CHANGELOG_ALLOW in scripts/release-state.js with its reason if it is history`, 'changelog-version'));

  problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  return { problems, notChecked: [...new Set(notChecked)], info };
}
function sameSet(a, b) { const x = new Set(a), y = new Set(b); return x.size === y.size && [...x].every((v) => y.has(v)); }

// ------------------------------------------------------------------------------------------------------------ IO
function readDocs(root) {
  const out = {};
  for (const [k, f] of Object.entries(FILES)) { const p = path.join(root, f); out[k] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }
  return out;
}
function gitOut(root, args, opts = {}) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout || 30000 }).trim(); } catch { return null; }
}
function gitOk(root, args) {
  try { execFileSync('git', args, { cwd: root, stdio: 'ignore', timeout: 30000 }); return true; } catch { return false; }
}
/** Everything git can say locally: the hand-off's commits, origin/main, the gh-pages version. */
function readGit(root, commits) {
  if (gitOut(root, ['rev-parse', '--git-dir']) == null) return null;
  const shallow = gitOut(root, ['rev-parse', '--is-shallow-repository']) === 'true';
  const mainRef = gitOk(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']) ? 'origin/main' : null;
  const facts = {};
  for (const sha of commits) {
    const exists = gitOk(root, ['cat-file', '-e', `${sha}^{commit}`]);
    if (!exists) { facts[sha] = { exists: false }; continue; }
    const subject = gitOut(root, ['log', '-1', '--format=%s', sha]);
    const parent = gitOut(root, ['rev-parse', '--verify', '--quiet', `${sha}^`]);
    const parentSubject = parent ? gitOut(root, ['log', '-1', '--format=%s', parent]) : null;
    const onMain = mainRef ? gitOk(root, ['merge-base', '--is-ancestor', sha, mainRef]) : null;
    facts[sha] = { exists, subject, parent, parentSubject, onMain };
  }
  return { shallow, mainRef, commits: facts };
}
function readPages(root, fetched) {
  const text = gitOut(root, ['show', 'refs/remotes/origin/gh-pages:version.json']);
  if (text == null) return null;
  let version = null;
  try { version = JSON.parse(text).version; } catch { version = null; }
  return parseV(version) ? { version, source: fetched ? 'origin/gh-pages, just fetched' : 'this clone\'s origin/gh-pages ref, as last fetched' } : null;
}
function readMainPkg(root) {
  const pkg = gitOut(root, ['show', 'refs/remotes/origin/main:package.json']);
  if (pkg == null) return null;
  let version = null;
  try { version = JSON.parse(pkg).version; } catch { return null; }
  const log = gitOut(root, ['show', 'refs/remotes/origin/main:CHANGELOG.md']) || '';
  return { version, stamped: stampedVersions(log) };
}
/** `git ls-remote --tags origin`, peeled: { 'v1.2.3': sha }; null when origin cannot be reached. */
function readRemoteTags(root) {
  const out = gitOut(root, ['ls-remote', '--tags', 'origin'], { timeout: 30000 });
  if (out == null) return null;
  const tags = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    const m = /^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(ref || '');
    if (!m) continue;
    if (m[2] || !tags[m[1]]) tags[m[1]] = sha; // the peeled commit wins over an annotated tag object
  }
  return { tags };
}

function run(root, { mode = 'online', fetch = false } = {}) {
  const docs = readDocs(root);
  if (mode === 'docs-only') return evaluate({ docs });
  let fetched = false;
  if (fetch && mode === 'online') fetched = gitOk(root, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main', '+refs/heads/gh-pages:refs/remotes/origin/gh-pages']);
  const h = docs.handoff ? parseHandoff(docs.handoff) : { rows: [] };
  const git = readGit(root, h.rows.map((r) => r.commit));
  const remote = mode === 'online' ? readRemoteTags(root) : null;
  const result = evaluate({ docs, git, remote, pages: git ? readPages(root, fetched) : null, mainPkg: git ? readMainPkg(root) : null });
  if (fetch && mode === 'online' && !fetched) result.notChecked.unshift('a fresh fetch of origin main and gh-pages (the fetch failed; the local refs were used)');
  if (mode === 'offline') result.notChecked.unshift('anything on origin (--offline)');
  return result;
}

function format(result) {
  const lines = [];
  for (const i of result.info) lines.push(`[release-state] ${i}`);
  for (const n of result.notChecked) lines.push(`[release-state] not checked: ${n}`);
  for (const p of result.problems) lines.push(`${p.file}:${p.line}: ${p.message}\n    fix: ${p.fix}`);
  lines.push(result.problems.length ? `[release-state] ${result.problems.length} problem(s)` : '[release-state] the documents agree with what could be checked');
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let root = path.join(__dirname, '..');
  let mode = 'online'; let fetch = false; let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--offline') mode = 'offline';
    else if (a === '--docs-only') mode = 'docs-only';
    else if (a === '--fetch') fetch = true;
    else if (a === '--json') json = true;
    else if (a === '--root') root = path.resolve(args[++i] || '.');
    else { console.error(`usage: node scripts/release-state.js [--offline | --docs-only] [--fetch] [--root <dir>] [--json] (unknown: ${a})`); process.exit(2); }
  }
  const result = run(root, { mode, fetch });
  console.log(json ? JSON.stringify(result, null, 2) : format(result));
  process.exitCode = result.problems.length ? 1 : 0;
}

module.exports = {
  parseV, cmp, stampedVersions, targetVersion, parseQuestionnaire, parseEvidence, parseRelease, parseHandoff,
  parseHandoffNotes, liveClaims, lintChangelog, evaluate, run, format, CHANGELOG_ALLOW, FILES,
};
