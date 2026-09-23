'use strict';
// Serves a static-site build (scripts/build-static-site.js) the way a plain static host does — GitHub Pages,
// S3, a county web server: a file that exists is sent, `/` (or a directory) is its index.html, and anything
// else is a 404. Deliberately *not* the office server's serveStatic: that one rewrites /app to get-app.html
// and falls back to index.html for every extension-less path, which no static host does, and the browser
// suite has to fail on a link that only works because of such a rewrite.
// Usage: node scripts/serve-static.js <dir> [port]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { sendFile, parseRequestUrl, sendJson } = require('../server/http');


/** A request handler for a plain static host rooted at `root`. Exported for the browser suite. */
function plainStatic(root) {
  root = path.resolve(root);
  return (req, res) => {
    let url;
    try { url = parseRequestUrl(req.url, 'http://x'); } catch (e) { sendJson(res, e.status || 400, { error: e.message }); return true; }
    let file = path.resolve(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return true; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>404</title><h1>404 Not found</h1>'); return true; }
    sendFile(res, file, { req, url }); return true;
  };
}

if (require.main === module) {
  const dir = process.argv[2];
  const port = Number(process.argv[3] || 8877);
  if (!dir) { console.error('usage: node scripts/serve-static.js <dir> [port]'); process.exit(1); }
  const handle = plainStatic(dir);
  http.createServer((req, res) => handle(req, res)).listen(port, () => console.log(`[suds] static site served from ${dir} on http://127.0.0.1:${port}`));
}
module.exports = { plainStatic };
