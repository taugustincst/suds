// SUDS service worker: caches the application shell only. API responses (PHI) are NEVER cached.
const VERSION = 'suds-shell-1.5.0';
const SHELL = ['./', 'index.html', 'styles.css', 'main.js', 'app.js', 'qr.js', 'favicon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  ...['login', 'dashboard', 'clients', 'client', 'interventions', 'calls', 'time', 'resources', 'referrals', 'tasks', 'budget', 'notes', 'imports', 'reports', 'admin', 'profile', 'setup'].map(v => `views/${v}.js`)];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.includes('/api/')) return; // network only, never cached
  // network-first for the shell so updates arrive promptly; fall back to cache when offline
  e.respondWith(fetch(e.request).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); } return res; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
