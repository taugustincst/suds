// The "use SUDS on this device" page: how to open the web app in a browser and add it to the home screen.
// The native apps are deprecated (docs/PLATFORM.md), so nothing here downloads an app; the only downloads
// are the office server's own certificate, for a browser that must trust a self-signed server.
(async () => {
  // The published static build (scripts/build-static-site.js) sets window.SUDS_STATIC_HOST before this runs.
  // There is no office server behind it: no certificate to download, no office address to show, and the
  // records live in the browser that opens the site itself (SUDS on this device).
  if (window.SUDS_STATIC_HOST) {
    document.querySelectorAll('[data-office]').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('[data-static]').forEach(el => el.classList.remove('hidden'));
    document.getElementById('static-url').textContent = location.href.replace(/^https?:\/\//, '').replace(/get-app\.html.*$/, '');
    return;
  }
  const j = await fetch('/api/app/info').then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!j) return;
  document.getElementById('org').textContent = j.name;
  const url = (j.listener && (j.listener.friendly || j.listener.urls[0])) || location.origin;
  document.getElementById('url').textContent = url.replace(/^https?:\/\//, '');
  // The offline copy is mentioned only when this server hands it out at all (LOCAL_MODE_ENABLED).
  if (j.local_mode) document.getElementById('local').classList.remove('hidden');
  // Without a session (and unless the server was started with PUBLIC_APP_INFO=1) the server says only
  // the programme's name: the addresses and the certificate fingerprint need a signed-in browser.
  if (!j.public) { document.getElementById('signin-note').classList.remove('hidden'); return; }
  if (j.certificate) { document.getElementById('cert').classList.remove('hidden'); document.getElementById('fp').textContent = j.certificate.sha256; }
})();
