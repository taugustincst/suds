// The accessibility statement page (accessibility.html): shows the programme contact the county set up
// (Settings → Program contact) and the version, when an office server is behind the page. External, not
// inline, because the CSP forbids inline scripts. Nothing here needs a session.
(async () => {
  try {
    const v = await fetch('version.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
    if (v && v.version) document.getElementById('version').textContent = ` for SUDS ${v.version}`;
  } catch { /* offline: the page reads fine without it */ }
  if (window.SUDS_STATIC_HOST || location.protocol === 'file:') return;
  try {
    const s = await fetch('/api/auth/signup/status', { headers: { 'X-Requested-With': 'suds' } }).then(r => (r.ok ? r.json() : null));
    if (s && s.program_contact) { document.getElementById('contact-text').textContent = s.program_contact; document.getElementById('contact').classList.remove('hidden'); }
  } catch { /* no office server behind this copy */ }
})();
