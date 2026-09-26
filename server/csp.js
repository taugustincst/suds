'use strict';
// The one Content-Security-Policy: sent as a header by the office server (server/http.js securityHeaders)
// and written as a <meta> into every page of the static build, SUDS on this device
// (scripts/static-site-security.js, which drops frame-ancestors: a meta policy cannot set it).
//
// connect-src is this origin only. Nothing in the browser needs another: the OneNote connector, single
// sign-on discovery, provider pictures and the release check are fetched by the server; a device in local
// mode syncs with the office that served it; the static build never syncs. An injected script therefore has
// no fetch()/XHR/WebSocket channel to another host. (Before 1.12.5 it was 'self' https:, any https host.)
// 'wasm-unsafe-eval': the device kernel's SQLite (sql.js) is WebAssembly. No inline script anywhere.
const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
module.exports = { CSP };
