'use strict';
// A parser for the YAML the workflows in .github/workflows are written in, so their tests can read them as data
// (which job has which environment, permissions, triggers and steps) rather than by regular expressions over the
// text (engineering reviews of 1.16.1 L6 and 1.16.3 L7). SUDS has no YAML dependency and adds none for this (the
// small supply chain is a security feature, CLAUDE.md): the workflows use a small part of YAML, and this reads that
// part and refuses the rest with the line number, so a construct it does not know fails the tests instead of being
// read wrong.
//
// Read: block mappings and sequences (a `- key: value` item starts a mapping), plain, 'single' and "double"
// quoted scalars, flow sequences ([push, pull_request], ['v*']), the empty flow mapping {}, and literal (|, |-, |+)
// and folded (>, >-) block scalars; comments. Plain scalars true/false, null/~ and numbers are typed; everything
// else is a string, `on` included (GitHub reads workflows so, not as YAML 1.1's boolean).
// Refused: anchors and aliases, tags, several documents, tabs in indentation, multi-line plain or quoted scalars,
// flow mappings with content, duplicate keys.
//
// Checked against PyYAML on the four workflows when it was written (the same data, `on` aside); tested in
// test/workflow-yaml.test.js.

function fail(line, msg) { throw new Error(`workflow YAML line ${line + 1}: ${msg}`); }

/** The text of a line up to a comment (a # at the start or after whitespace, outside quotes). */
function stripComment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') { i++; continue; }
      if (c === "'" && q === "'" && s[i + 1] === "'") { i++; continue; } // '' is a quote inside '...'
      if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,:-]/.test(s[i - 1]))) { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

function scalar(raw, line) {
  const s = raw.trim();
  if (s === '') return null;
  if (s[0] === '&' || s[0] === '*' || s[0] === '!') fail(line, `anchors, aliases and tags are not read (${s})`);
  if (s[0] === "'") {
    if (!/^'(?:[^']|'')*'$/.test(s)) fail(line, `unterminated or multi-line single-quoted scalar: ${s}`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s[0] === '"') {
    if (!/^"(?:[^"\\]|\\.)*"$/.test(s)) fail(line, `unterminated or multi-line double-quoted scalar: ${s}`);
    const esc = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', r: '\r', 0: '\0' };
    return s.slice(1, -1).replace(/\\(.)/g, (m, c) => { if (!(c in esc)) fail(line, `escape \\${c} is not read`); return esc[c]; });
  }
  if (s[0] === '[') {
    if (s[s.length - 1] !== ']') fail(line, `a flow sequence must end on its line: ${s}`);
    const body = s.slice(1, -1).trim();
    if (!body) return [];
    const items = []; let q = null; let cur = '';
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q) { cur += c; if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '[' || c === '{') fail(line, 'nested flow collections are not read');
      if (c === ',') { items.push(cur); cur = ''; continue; }
      cur += c;
    }
    items.push(cur);
    return items.map((x) => scalar(x, line));
  }
  if (s[0] === '{') { if (s.replace(/\s/g, '') === '{}') return {}; fail(line, `flow mappings are not read: ${s}`); }
  if (s[0] === '|' || s[0] === '>') fail(line, 'a block scalar indicator here is not read');
  if (/^(true|false)$/.test(s)) return s === 'true';
  if (/^(null|~)$/.test(s)) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** The workflow's data (mappings as plain objects, sequences as arrays). */
function parse(text) {
  const raw = String(text).replace(/\r\n/g, '\n').split('\n');
  const lines = raw.map((r, i) => {
    if (/^\t| \t|^ *\t/.test(r)) fail(i, 'tabs in indentation are not read');
    const t = stripComment(r);
    return { i, indent: t.length - t.trimStart().length, text: t.trim() };
  });
  lines.forEach((l) => { if (l.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(l.text) && l.i > 0) fail(l.i, 'several documents are not read'); });
  let p = 0;
  const next = () => { while (p < lines.length && (lines[p].text === '' || lines[p].text === '---')) p++; return p < lines.length ? lines[p] : null; };
  const keyRe = /^((?:[^\s'"#:[\]{},&*!|>-][^:]*?)|'[^']*'|"[^"]*"|-[^\s:][^:]*?):(?:\s+(.*))?$/;

  function blockScalar(ind, parentIndent, line) {
    const m = /^([|>])([+-]?)$/.exec(ind);
    if (!m) fail(line, `block scalar indicator ${ind} is not read`);
    const body = []; let contentIndent = null;
    while (p < lines.length) {
      const r = raw[p];
      if (r.trim() === '') { body.push(''); p++; continue; }
      const n = r.length - r.trimStart().length;
      if (n <= parentIndent) break;
      if (contentIndent === null) contentIndent = n;
      if (n < contentIndent) fail(p, 'a block scalar line is indented less than its first line');
      body.push(r.slice(contentIndent)); p++;
    }
    while (body.length && body[body.length - 1] === '') { if (m[2] === '+') break; body.pop(); }
    let s = m[1] === '|' ? body.join('\n') : body.reduce((acc, l, i) => (i === 0 ? l : acc + (l === '' || body[i - 1] === '' ? '\n' : ' ') + l), '').replace(/\n /g, '\n');
    if (m[2] !== '-' && body.length) s += '\n';
    return s;
  }

  function value(rest, indent, line) {
    if (rest === undefined || rest === '') {
      p++;
      const n = next();
      if (n && n.indent > indent) return block(n.indent);
      if (n && n.indent === indent && /^-(\s|$)/.test(n.text)) return sequence(indent);
      return null;
    }
    if (/^[|>]/.test(rest)) { p++; return blockScalar(rest, indent, line); }
    p++;
    const n = next();
    if (n && n.indent > indent) fail(n.i, 'a multi-line plain scalar (or a value both inline and below its key) is not read');
    return scalar(rest, line);
  }

  function mapping(indent) {
    const out = {};
    for (let n = next(); n && n.indent === indent && !/^-(\s|$)/.test(n.text); n = next()) {
      const m = keyRe.exec(n.text);
      if (!m) fail(n.i, `expected "key: value": ${n.text}`);
      const key = String(scalar(m[1], n.i));
      if (Object.prototype.hasOwnProperty.call(out, key)) fail(n.i, `duplicate key ${key}`);
      out[key] = value(m[2], indent, n.i);
    }
    const n = next();
    if (n && n.indent > indent) fail(n.i, `unexpected indentation: ${n.text}`);
    return out;
  }

  function sequence(indent) {
    const out = [];
    for (let n = next(); n && n.indent === indent && /^-(\s|$)/.test(n.text); n = next()) {
      const rest = n.text.slice(1).trimStart();
      if (rest === '') { p++; const c = next(); out.push(c && c.indent > indent ? block(c.indent) : null); continue; }
      const inner = indent + (n.text.length - rest.length);
      if (keyRe.test(rest) && !/^['"[{]/.test(rest)) {
        // "- key: value": a mapping whose first key sits on the dash's line.
        lines[p] = { i: n.i, indent: inner, text: rest };
        out.push(mapping(inner));
      } else out.push(value(rest, indent, n.i));
    }
    return out;
  }

  function block(indent) {
    const n = next();
    return /^-(\s|$)/.test(n.text) ? sequence(indent) : mapping(indent);
  }

  const first = next();
  if (!first) return null;
  if (first.indent !== 0) fail(first.i, 'the document must start at column 0');
  const doc = block(0);
  const rest = next();
  if (rest) fail(rest.i, `unexpected: ${rest.text}`);
  return doc;
}

/** Every step of every job, as [jobName, step]. */
function steps(workflow) {
  return Object.entries((workflow && workflow.jobs) || {}).flatMap(([name, job]) => (job.steps || []).map((s) => [name, s]));
}

module.exports = { parse, steps, stripComment, scalar };
