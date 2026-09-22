(async () => {
  const j = await fetch('/api/app/info').then(r => r.json()).catch(() => null);
  if (!j) return;
  document.getElementById('org').textContent = j.name;
  const url = (j.listener && (j.listener.friendly || j.listener.urls[0])) || location.origin; document.getElementById('url').textContent = url.replace(/^https?:\/\//, '');
  const a = document.getElementById('android-text');
  // Without a session (and unless the server was started with PUBLIC_APP_INFO=1) the server says only
  // the programme's name: the download and the certificate fingerprint need a signed-in browser.
  if (!j.android) { a.textContent = 'Sign in to SUDS in this browser first, then come back to this page for the Android app and the certificate fingerprint.'; return; }
  if (j.android.available) { a.innerHTML = ''; const b = document.createElement('a'); b.className = 'btn primary'; b.href = '/api/app/android.apk'; b.textContent = 'Download SUDS for Android'; a.append(b); const s = document.createElement('div'); s.className = 'small muted mt'; s.textContent = `Version ${j.android.version} · ${(j.android.size / 1048576).toFixed(1)} MB. After downloading, open the file and allow installing from this source when Android asks. The app finds this SUDS automatically on the office Wi-Fi.`; a.append(s); }
  else a.textContent = 'The Android app is not available yet — ask your administrator (Settings → Network & devices → Native apps). Meanwhile, open this address in Chrome and choose ⋮ → Install app.';
  if (j.certificate) { document.getElementById('cert').classList.remove('hidden'); document.getElementById('fp').textContent = j.certificate.sha256; }
})();
