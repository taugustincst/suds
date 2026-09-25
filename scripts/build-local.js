'use strict';
// Bundles the server logic + browser shims into public/local/kernel.js (used by local mode, the offline copy).
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
// The browser has no filesystem, so it reads the schema from a generated JS copy. Regenerate it here so a
// schema change can never ship to local-mode devices as a stale duplicate.
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
  alias: { fs: shim('fs.js'), path: shim('path.js'), crypto: shim('crypto.js'), 'node:crypto': shim('crypto.js'), 'node:sqlite': shim('sqlite.js'), 'node:zlib': shim('zlib.js'), 'node:fs': shim('fs.js'), 'node:path': shim('path.js'), 'node:os': shim('os.js'), 'node:url': shim('url.js'), 'node:http': shim('empty.js'), 'node:https': shim('empty.js'), 'node:dgram': shim('empty.js'), 'node:child_process': shim('empty.js'), 'node:worker_threads': shim('empty.js') },
  plugins: [{
    name: 'suds-local', setup(b) {
      b.onResolve({ filter: /(^|[\\/])config(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('config.js') } : undefined));
      b.onResolve({ filter: /(^|[\\/])listener(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('listener.js') } : undefined));
      b.onResolve({ filter: /(^|[\\/])(mdns|selfsigned)(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('empty.js') } : undefined));
      b.onResolve({ filter: /(^|[\\/])bootstrap(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('bootstrap.js') } : undefined));
      b.onResolve({ filter: /package\.json$/ }, () => ({ path: shim('package.js') }));
    },
  }],
});
for (const f of ['sql-wasm.wasm']) fs.copyFileSync(path.join(root, 'node_modules', 'sql.js', 'dist', f), path.join(out, f));
// Precompressed copies for server/http.js to serve with Content-Encoding (a phone on a slow connection
// downloads a quarter of the bytes). Both are deterministic for the same input — Node's gzip writes no
// mtime — so the committed files only change when the kernel does, and CI's drift check stays meaningful.
// Written only when the bytes differ, so an unchanged build leaves the files' mtimes alone.
const writeIfChanged = (file, bytes) => { if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) fs.writeFileSync(file, bytes); };
for (const f of ['kernel.js', 'sql-wasm.wasm']) {
  const src = fs.readFileSync(path.join(out, f));
  writeIfChanged(path.join(out, f + '.gz'), zlib.gzipSync(src, { level: 9 }));
  writeIfChanged(path.join(out, f + '.br'), zlib.brotliCompressSync(src, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: src.length } }));
}
// public/app.js requests the kernel as `local/kernel.js?v=<version>` (see startLocalKernel there): the
// version comes from package.json through this stamp, the same way scripts/gen-schema-text.js stamps sw.js.
{
  const appJs = path.join(root, 'public', 'app.js');
  const version = require(path.join(root, 'package.json')).version;
  const before = fs.readFileSync(appJs, 'utf8');
  const after = before.replace(/(const SUDS_VERSION = ')[^']*(')/, `$1${version}$2`);
  if (after !== before) { fs.writeFileSync(appJs, after); console.log(`[suds] stamped public/app.js with version ${version}`); }
  // What an open page compares its own SUDS_VERSION with (app.js checkVersion, fetched with no-store and
  // never cached by public/sw.js) to learn that a release has been published since it loaded.
  writeIfChanged(path.join(root, 'public', 'version.json'), Buffer.from(JSON.stringify({ version }) + '\n'));
}
const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log(`local kernel written to public/local/ (kernel.js ${kb('kernel.js')}, gzip ${kb('kernel.js.gz')}, brotli ${kb('kernel.js.br')}; sql-wasm.wasm ${kb('sql-wasm.wasm')}, gzip ${kb('sql-wasm.wasm.gz')}, brotli ${kb('sql-wasm.wasm.br')})`);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
