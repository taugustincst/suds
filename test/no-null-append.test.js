'use strict';
// The DOM's own append(), prepend(), before(), after() and replaceChildren() write a null or undefined as the
// text "null"; the app's h() leaves one out. 1.17.0 showed "nullnull" under My shift, "null" in every AI panel and
// in the Secure link dialog (r10 H1) from calls such as el.append(a, cond ? b : null). This finds that shape in the
// browser code: an argument of one of those calls that can be null by a ternary or an &&. Pass the children
// through h() or .filter(Boolean) instead. (The browser suite's STRAY_TEXT_PROBE, scripts/ui/assert.mjs, checks
// the rendered pages for the same thing.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'public');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === 'local' ? [] : files(p); // the generated kernel is not hand-written view code
    return d.name.endsWith('.js') ? [p] : [];
  });
}

/** The top-level text of each DOM-insertion call's arguments (strings and nested brackets left out). */
function nullableCalls(src) {
  const out = []; const re = /\.(append|prepend|before|after|replaceChildren)\(/g; let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1, str = null, top = '';
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (str) { if (c === '\\') { i++; continue; } if (c === str) str = null; continue; }
      if (c === '"' || c === '\'' || c === '`') { str = c; continue; }
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
      if (depth === 1) top += c;
    }
    if (/[?:]\s*(null|undefined)\b|&&/.test(top)) out.push({ line: src.slice(0, m.index).split('\n').length, call: m[1], args: top.replace(/\s+/g, ' ').slice(0, 120) });
  }
  return out;
}

test('no DOM insertion call in the browser code is handed a child that can be null', () => {
  const found = files(ROOT).flatMap(f => nullableCalls(fs.readFileSync(f, 'utf8')).map(x => `${path.relative(ROOT, f)}:${x.line} .${x.call}(${x.args})`));
  assert.deepEqual(found, [], `pass these children through h() or .filter(Boolean):\n${found.join('\n')}`);
});

test('the check finds the shape it is for', () => {
  assert.equal(nullableCalls('box.append(h("p"), cond ? h("b") : null);').length, 1);
  assert.equal(nullableCalls('box.replaceChildren(a, ok && b);').length, 1);
  assert.equal(nullableCalls('box.append(h("p", {}, cond ? "x" : null));').length, 0, 'inside h() it is left out');
  assert.equal(nullableCalls('box.append(...[a, cond ? b : null].filter(Boolean));').length, 0);
});
