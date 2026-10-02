// SUDS service worker: caches the application shell only. API responses (PHI) are NEVER cached.
const VERSION = 'suds-shell-1.23.6';
// The local-mode kernel and its WebAssembly are cached too, so a device set up for local mode boots with
// no connection at all (they are only ever *downloaded* when local mode is used; index.html never loads
// them). The versioned URL is what app.js requests, so the cache key matches without a second download.
const KERNEL_VERSION = VERSION.replace(/^suds-shell-/, '');
const SHELL = ['./', 'index.html', 'styles.css', 'main.js', 'app.js', 'nav.js', 'qr.js', 'passkey.js', 'get-app.html', 'get-app.js', 'accessibility.html', 'accessibility.js', 'county-periods.js', 'outreach-queue.js', 'favicon.svg', 'manifest.webmanifest', 'manifest-local.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  `local/kernel.js?v=${KERNEL_VERSION}`, `local/sql-wasm.wasm?v=${KERNEL_VERSION}`, `local/audit-worker.js?v=${KERNEL_VERSION}`,
  ...['login', 'dashboard', 'clients', 'client', 'interventions', 'calls', 'time', 'resources', 'referrals', 'tasks', 'budget', 'notes', 'imports', 'reports', 'admin', 'profile', 'setup', 'forms', 'documents', 'dataimport', 'local', 'supervision', 'episodes', 'overdose', 'funder', 'supplies', 'lists', 'caloms', 'clinical', 'security', 'compliance', 'part2', 'suprt', 'history', 'prevention', 'ai', 'outreach', 'settlement', 'county', 'countyconnect'].map(v => `views/${v}.js`)];
// Each shell file is fetched on its own: addAll() fails the whole install if one file is missing (a server
// with local mode switched off answers 404 for local/*), which used to leave nothing cached at all.
// `cache: 'reload'` fills the shell from the network, never from the browser's HTTP cache: a static host
// (GitHub Pages sends max-age=600) can otherwise hand a *new* worker the *previous* build's app.js, and the
// device then runs the old code from the new cache until the next release.
// Safari's engine has been seen to fill nothing with a reload-mode Cache.add() (an empty shell cache after an
// upgrade), so the worker fetches each file itself and puts it in by hand; a file that cannot be stored that
// way is fetched once more plainly (revalidated, not taken from the HTTP cache on trust).
// A file the server does not have (404) is not stored, and its answer is read to the end (cancelled): an
// unread response body keeps its HTTP/1.1 connection busy for as long as the worker lives. An office server
// with local mode off answers 404 for the three local/* files; Cache.add() left each of those answers unread,
// and so did the plain retry, which held all six of the browser's connections to the server — the install
// stopped at 19 of 62 files and every later fetch from the worker, /api/health included, waited for ever
// (evaluation of 1.23.0; scripts/ui/offline-office.mjs).
const take = (c, u, init) => fetch(new Request(u, init)).then((r) => {
  if (r.ok) return c.put(u, r);
  if (r.body) r.body.cancel().catch(() => {});
  return undefined;
});
const precache = (c, u) => take(c, u, { cache: 'reload' }).catch(() => take(c, u, { cache: 'no-cache' })).catch(() => {});
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => Promise.all(SHELL.map(u => precache(c, u)))).then(() => self.skipWaiting())); });
// Cache Storage belongs to the whole origin, and on a shared host (<owner>.github.io/<repo>/, where every
// Pages site of that owner is one origin) other sites' caches sit beside this one. So this worker reads only
// its own cache (VERSION), for addresses inside its own scope, and deletes only its own older shell caches
// (suds-shell-*), never another site's. docs/WEB_APP.md recommends a dedicated origin for SUDS on this device.
const OWN_CACHE = /^suds-shell-/;
const SCOPE = (self.registration && self.registration.scope) || (self.location && self.location.href ? new URL('./', self.location.href).href : '');
const inScope = (url) => !SCOPE || url.href.startsWith(SCOPE);
// A new VERSION drops every older SUDS shell cache and takes over the open pages at once; app.js reloads them
// once it sees the controller change, so nobody keeps running a build the server no longer serves.
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && OWN_CACHE.test(k)).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Network only, never cached: anything but a GET; every data route (the app's API, and FHIR and SCIM,
  // which a person may open in a tab); and any other origin -- the office server a device syncs with, or a
  // site a page links to. The shell is this origin's own files. (test/sw-phi.test.js)
  if (e.request.method !== 'GET' || /\/(api|fhir|scim)\//.test(url.pathname)) return;
  if (self.location && url.origin !== self.location.origin) return;
  // Another site on the same origin (outside this worker's scope) is never answered from here.
  if (!inScope(url)) return;
  // version.json is how an open page learns a release is out (app.js checkVersion): never from a cache.
  if (/\/version\.json$/.test(url.pathname)) return;
  const versioned = /^\/local\//.test(url.pathname) && url.searchParams.has('v');
  // Network-first for the shell so updates arrive promptly, revalidated with the server rather than served
  // from the HTTP cache (`no-cache`), so a release is picked up on the next load and not up to ten minutes
  // later; the versioned kernel assets are immutable and may come from any cache. Offline, fall back to the
  // shell cache. index.html stands in only for a *navigation* (the app's own routes are hash routes, so any
  // page-level request is the app); a script, image or fetch() for something not cached gets a real failure,
  // not an HTML document dressed up as a 200.
  // A static host's `max-age` is replaced with `Cache-Control: no-cache`: the renderer keeps what it was
  // handed in a memory cache that a plain reload reuses for as long as max-age says it is fresh — without
  // ever asking this worker — so a reload after a release would run the old build for that long (GitHub
  // Pages: ten minutes). Marked no-cache, the next reload comes back here. Only such responses are
  // re-headed (max-age, or no header at all, which a browser may cache heuristically): the office
  // server's `no-store` passes through as sent, never weakened to no-cache. The body handed on is already
  // decoded, so the original's Content-Encoding and Content-Length are not carried over to it.
  const fresh = (res) => {
    if (versioned || res.type === 'opaque' || res.type === 'opaqueredirect') return res;
    const cc = res.headers.get('Cache-Control') || '';
    if (/no-store/i.test(cc)) return res;
    const headers = new Headers(res.headers);
    headers.set('Cache-Control', 'no-cache'); headers.delete('Content-Encoding'); headers.delete('Content-Length');
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  // Building the revalidating request can throw in some engines; if it did here, respondWith would never be
  // called and an offline request would fail outright instead of reaching the cache below.
  let netReq = e.request;
  if (!versioned) { try { netReq = new Request(e.request, { cache: 'no-cache' }); } catch { netReq = e.request; } }
  // ignoreVary: the shell is one copy per URL; a Vary on the stored response must not make it unfindable offline.
  // Only this worker's own cache is read (never caches.match, which searches every cache on the origin: on a
  // shared host another site could have put a response there for this address).
  const fromCache = () => caches.open(VERSION).then(c => c.match(e.request, { ignoreSearch: true, ignoreVary: true })
    .then(r => r || c.match(e.request.url, { ignoreSearch: true, ignoreVary: true }))
    .then(r => r || (e.request.mode === 'navigate' ? c.match(SCOPE ? new URL('index.html', SCOPE).href : 'index.html', { ignoreVary: true }) : undefined))
    .then(r => r || Response.error()));
  e.respondWith(fetch(netReq).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return fresh(res); })
    .catch(fromCache));
});
