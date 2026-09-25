'use strict';
// Stored XSS in the browser: no raw-HTML sink in public/ or local/ outside the reviewed list, and the
// printable pages that build HTML escape every value (scripts/check-html-sinks.js).
const { test } = require('node:test');
const assert = require('node:assert');
const S = require('../scripts/check-html-sinks');

test('no unreviewed raw-HTML sinks in the browser code', () => {
  assert.deepEqual(S.check(), []);
});

test('the checker catches each kind of sink, and unescaped values in printable HTML', () => {
  const bad = {
    'public/views/x.js': ['el.innerHTML = note.content;', 'el.outerHTML = x;', "el.insertAdjacentHTML('beforeend', x);", 'document.write(x);', 'range.createContextualFragment(x);',
      "new DOMParser().parseFromString(x, 'text/html');", "frame.srcdoc = x;", 'eval(x);', "new Function('return 1');", "setTimeout('go()', 1);", "h('div', { html: x });",
      "h('a', { href: 'javascript:alert(1)' });"],
  };
  for (const line of bad['public/views/x.js']) assert.equal(S.scan('public/views/x.js', line).length, 1, line);
  assert.deepEqual(S.scan('public/views/x.js', "el.textContent = note.content; h('div', {}, note.content); // el.innerHTML = x"), []);
  assert.equal(S.scan('public/x.html', '<button onclick="go()">x</button>').length, 1);
  assert.equal(S.scan('public/x.html', '<script>alert(1)</script>').length, 1);
  assert.deepEqual(S.scan('public/x.html', '<script type="module" src="main.js"></script>'), []);
  // A printable page (allowlisted document.write) that forgets esc() on one value, or whose esc() misses '.
  const good = "const esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (ch) => ch);";
  const page = (row) => `${good}\nconst rows = xs.map(x => \`<tr><td>\${esc(x.a)}</td>${row}</tr>\`).join('');\nw.document.write(html);`;
  assert.deepEqual(S.scan('public/views/client.js', page('')), []);
  assert.match(S.scan('public/views/client.js', page('<td>${x.name}</td>')).join('\n'), /x\.name.*not escaped/);
  assert.match(S.scan('public/views/client.js', page('').replace(`"'`, '"')).join('\n'), /does not escape '/);
});
