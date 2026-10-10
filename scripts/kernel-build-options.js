'use strict';
// How the browser kernel (local/kernel.js + the server modules + local/shims) is bundled. One definition, used
// by scripts/build-local.js (public/local/kernel.js) and by test/kernel-parity.test.js, which bundles the
// current sources the same way and runs them in Node against sql.js to check they answer as the server does.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const shim = (n) => path.join(root, 'local', 'shims', n);

/** esbuild options that write the kernel to `outfile`. */
function kernelBuildOptions(outfile) {
  return {
    entryPoints: [path.join(root, 'local', 'kernel.js')],
    inject: [shim('globals-inject.js')],
    bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], outfile, sourcemap: false, minify: false, logLevel: 'warning',
    // The same bytes wherever and however it is built (1.16.1): esbuild writes each module's path, relative to
    // the working directory, as a comment. Relative to the repository, whatever the shell's directory, and through
    // a symlinked node_modules (a worktree's) as if it were real: 1.16.0's release commit had to be rebuilt.
    absWorkingDir: root, preserveSymlinks: true,
    define: { __dirname: '"/"', SUDS_VERSION: JSON.stringify(require(path.join(root, 'package.json')).version) },
    alias: { fs: shim('fs.js'), path: shim('path.js'), crypto: shim('crypto.js'), 'node:crypto': shim('crypto.js'), 'node:sqlite': shim('sqlite.js'), 'node:zlib': shim('zlib.js'), 'node:fs': shim('fs.js'), 'node:path': shim('path.js'), 'node:os': shim('os.js'), 'node:url': shim('url.js'), 'node:http': shim('empty.js'), 'node:https': shim('empty.js'), 'node:dgram': shim('empty.js'), 'node:child_process': shim('empty.js'), 'node:worker_threads': shim('empty.js'), 'node:async_hooks': shim('empty.js') },
    plugins: [{
      name: 'suds-local', setup(b) {
        b.onResolve({ filter: /(^|[\\/])config(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('config.js') } : undefined));
        b.onResolve({ filter: /(^|[\\/])listener(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('listener.js') } : undefined));
        b.onResolve({ filter: /(^|[\\/])(mdns|selfsigned)(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('empty.js') } : undefined));
        b.onResolve({ filter: /(^|[\\/])bootstrap(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('bootstrap.js') } : undefined));
        b.onResolve({ filter: /package\.json$/ }, () => ({ path: shim('package.js') }));
        // Fingerprint sign-in and signing are office-server only (docs/FINGERPRINT.md): the kernel gets a stand-in
        // that says so, and none of the WebAuthn code (server/passkeys.js, server/webauthn.js, the passkey routes).
        b.onResolve({ filter: /(^|[\\/])(passkeys|webauthn)(\.js)?$/ }, (a) => (a.importer.includes(path.join('server')) ? { path: shim('passkeys.js') } : undefined));
        // A second SQLite engine on demand (local/shims/sqlite.js freshEngine, 1.25.5): sql.js keeps the instance it
        // makes in a variable of its module, so the module is wrapped in a function that `fresh` runs again, each
        // time a new WebAssembly instance with a heap of its own. The file's own text is not changed.
        b.onLoad({ filter: /[\\/]node_modules[\\/]sql\.js[\\/]dist[\\/]sql-wasm\.js$/ }, async (a) => ({ loader: 'js',
          contents: `function load() { var module = { exports: {} }; var exports = module.exports;\n${await fs.promises.readFile(a.path, 'utf8')}\nreturn module.exports; }\nmodule.exports = load();\nmodule.exports.fresh = load;\n` }));
        b.onLoad({ filter: /[\\/]server[\\/]routes[\\/]passkeys\.js$/ }, () => ({ contents: "'use strict';\n// Not on a device: fingerprint sign-in is office-server only (local/shims/passkeys.js).\nmodule.exports = () => {};\n", loader: 'js' }));
      },
    }],
  };
}

/**
 * esbuild options that write the publication audit's Web Worker (local/audit-worker.js) to `outfile`: the audit
 * alone (server/release-audit.js, server/sdc.js and what they read, no database), as a classic worker script,
 * which every browser the web app supports can start (local/audit-runner.js).
 */
function auditWorkerBuildOptions(outfile) {
  return {
    entryPoints: [path.join(root, 'local', 'audit-worker.js')],
    bundle: true, format: 'iife', platform: 'browser', target: ['es2022'], outfile, sourcemap: false, minify: false, logLevel: 'warning',
    absWorkingDir: root, preserveSymlinks: true,
  };
}

module.exports = { kernelBuildOptions, auditWorkerBuildOptions };
