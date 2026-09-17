'use strict';
// Bundles the server logic + browser shims into public/local/kernel.js (used by the phone app / local mode).
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
// The browser has no filesystem, so it reads the schema from a generated JS copy. Regenerate it here so a
// schema change can never ship to phones as a stale duplicate.
require('./gen-schema-text.js');
const out = path.join(root, 'public', 'local');
fs.mkdirSync(out, { recursive: true });
const shim = (n) => path.join(root, 'local', 'shims', n);
(async () => {
await esbuild.build({
  entryPoints: [path.join(root, 'local', 'kernel.js')],
  inject: [shim('globals-inject.js')],
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], outfile: path.join(out, 'kernel.js'), sourcemap: false, minify: false, logLevel: 'warning',
  define: { __dirname: '"/"', SUDS_VERSION: JSON.stringify(require(path.join(root, 'package.json')).version) },
  alias: { fs: shim('fs.js'), path: shim('path.js'), crypto: shim('crypto.js'), 'node:crypto': shim('crypto.js'), 'node:sqlite': shim('sqlite.js'), 'node:zlib': shim('zlib.js'), 'node:fs': shim('fs.js'), 'node:path': shim('path.js'), 'node:os': shim('os.js'), 'node:url': shim('url.js'), 'node:http': shim('empty.js'), 'node:https': shim('empty.js'), 'node:dgram': shim('empty.js'), 'node:child_process': shim('empty.js') },
  plugins: [{
    name: 'suds-local', setup(b) {
      b.onResolve({ filter: /(^|[\\/])config(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('config.js') } : undefined));
      b.onResolve({ filter: /(^|[\\/])listener(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('listener.js') } : undefined));
      b.onResolve({ filter: /(^|[\\/])(mdns|selfsigned|bootstrap)(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('empty.js') } : undefined));
      b.onResolve({ filter: /package\.json$/ }, () => ({ path: shim('package.js') }));
    },
  }],
});
for (const f of ['sql-wasm.wasm']) fs.copyFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', f), path.join(out, f));
console.log('local kernel written to public/local/ (' + (fs.statSync(path.join(out, 'kernel.js')).size / 1024).toFixed(0) + ' KB)');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
