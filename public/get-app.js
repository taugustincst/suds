// The "use SUDS on this device" page: how to open the web app in a browser and add it to the home screen.
// The native apps are deprecated (docs/PLATFORM.md), so nothing here downloads an app; the only downloads
// are the office server's own certificate, for a browser that must trust a self-signed server.
(async () => {
  const j = await fetch('/api/app/info').then(r => r.json()).catch(() => null);
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
