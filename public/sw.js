// SUDS service worker: caches the application shell only. API responses (PHI) are NEVER cached.
const VERSION = 'suds-shell-1.9.0';
// The local-mode kernel and its WebAssembly are cached too, so a device set up for local mode boots with
// no connection at all (they are only ever *downloaded* when local mode is used; index.html never loads
// them). The versioned URL is what app.js requests, so the cache key matches without a second download.
const KERNEL_VERSION = VERSION.replace(/^suds-shell-/, '');
const SHELL = ['./', 'index.html', 'styles.css', 'main.js', 'app.js', 'qr.js', 'favicon.svg', 'manifest.webmanifest', 'manifest-local.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  `local/kernel.js?v=${KERNEL_VERSION}`, `local/sql-wasm.wasm?v=${KERNEL_VERSION}`,
  ...['login', 'dashboard', 'clients', 'client', 'interventions', 'calls', 'time', 'resources', 'referrals', 'tasks', 'budget', 'notes', 'imports', 'reports', 'admin', 'profile', 'setup', 'forms', 'documents', 'dataimport', 'local', 'supervision', 'episodes', 'overdose', 'funder', 'supplies'].map(v => `views/${v}.js`)];
// Each shell file is fetched on its own: addAll() fails the whole install if one file is missing (a server
// with local mode switched off answers 404 for local/*), which used to leave nothing cached at all.
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return; // network only, never cached
  // network-first for the shell so updates arrive promptly; fall back to cache when offline
  e.respondWith(fetch(e.request).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
