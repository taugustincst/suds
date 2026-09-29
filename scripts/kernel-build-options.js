'use strict';
// How the browser kernel (local/kernel.js + the server modules + local/shims) is bundled. One definition, used
// by scripts/build-local.js (public/local/kernel.js) and by test/kernel-parity.test.js, which bundles the
// current sources the same way and runs them in Node against sql.js to check they answer as the server does.
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
      },
    }],
  };
}

module.exports = { kernelBuildOptions };
