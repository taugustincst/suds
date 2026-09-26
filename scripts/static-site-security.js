'use strict';
// What makes the static build (SUDS on this device, scripts/build-static-site.js) as hard to attack as the
// office server's pages, which get their protection from response headers a static host does not send:
//  - the office server's Content-Security-Policy, as a <meta http-equiv> first thing in every page's <head>
//    (without frame-ancestors, which browsers ignore in a meta policy);
//  - a frame guard, because nothing else can stop another site framing the app (clickjacking) on a static
//    host: loaded as the first script of every page, it hides the page and sends the top window to it.
// A county hosting the build on its own web server should also send `frame-ancestors 'none'` (or
// X-Frame-Options: DENY) as a header; docs/WEB_APP.md says so.
const { CSP } = require('../server/csp');

const STATIC_CSP = CSP.split(';').map(x => x.trim()).filter(x => x && !x.startsWith('frame-ancestors')).join('; ');
const FRAME_GUARD_FILE = 'frame-guard.js';
const FRAME_GUARD_JS = [
  '// SUDS on this device must never be shown inside another site\'s frame (clickjacking): a static host',
  '// cannot send frame-ancestors, so the page hides itself and takes over the top window instead.',
  'if (window.top !== window.self) {',
  '  document.documentElement.style.display = \'none\';',
  '  try { window.top.location.replace(window.self.location.href); } catch (e) { /* a sandboxed frame stays blank */ }',
  '}',
  '',
].join('\n');

/** One page of the build with the policy and the guard added. Throws if the page has no <head> to put them in. */
function hardenPage(html, name = 'page') {
  const m = /<head>/i.exec(html);
  if (!m) throw new Error(`static-site-security: ${name} has no <head>`);
  const charset = /<meta charset="[^"]*">/i.exec(html.slice(m.index));
  // After <meta charset> (which must come first), before any stylesheet or script the policy governs.
  const at = charset ? m.index + charset.index + charset[0].length : m.index + m[0].length;
  const add = `<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}"><script src="${FRAME_GUARD_FILE}"></script>`;
  return html.slice(0, at) + add + html.slice(at);
}

module.exports = { STATIC_CSP, FRAME_GUARD_FILE, FRAME_GUARD_JS, hardenPage };
