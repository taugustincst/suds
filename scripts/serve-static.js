'use strict';
// Serves a static-site build (scripts/build-static-site.js) with the same static-file logic the office
// server itself uses, so what the browser suite tests matches what any real static host would return.
// Usage: node scripts/serve-static.js <dir> [port]
const http = require('node:http');
const { serveStatic } = require('../server/http');

const dir = process.argv[2];
const port = Number(process.argv[3] || 8877);
if (!dir) { console.error('usage: node scripts/serve-static.js <dir> [port]'); process.exit(1); }

const handle = serveStatic(dir);
http.createServer((req, res) => handle(req, res)).listen(port, () => console.log(`[suds] static site served from ${dir} on http://127.0.0.1:${port}`));
