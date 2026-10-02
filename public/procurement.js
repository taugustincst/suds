// The "Security and procurement" page (procurement.html; built for 1.24.0), for organizations evaluating SUDS. No
// session needed, and it works on both builds:
//  - the document links point at the SUDS repository's docs on its default branch (the static build does not ship
//    docs/, and the office server does not serve them), from the one repository_url in procurement.json;
//  - the contact, legal entity, pricing stance and SLA come from procurement.json (the owner edits it for SUDS on
//    this device) and, on an office server, from what an administrator published under Settings
//    (GET /api/procurement), which wins where it is set. Blank everywhere: "Not yet published by the maintainer".
// External, not inline: the CSP forbids inline scripts. Every value is set as text, never as HTML.
(async () => {
  const BLANK = 'Not yet published by the maintainer';
  const FIELDS = ['legal_entity', 'contact_name', 'contact_email', 'contact_url', 'pricing', 'sla'];
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let cfg = {};
  try { cfg = (await fetch('procurement.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : {}))) || {}; } catch { /* offline: the defaults in the page stand */ }

  // Documents: <repository>/blob/<branch>/<path>. Only an https github-style address is used; anything else keeps the
  // addresses written into the page.
  const repo = text(cfg.repository_url);
  const branch = text(cfg.default_branch) || 'main';
  if (repo && /^https:\/\/[^\s/]+\/[^\s]+$/.test(repo) && /^[\w./-]+$/.test(branch)) {
    const base = repo.replace(/\/+$/, '').replace(/\.git$/, '');
    for (const a of document.querySelectorAll('a[data-doc]')) a.href = `${base}/blob/${branch}/${a.dataset.doc}`;
    for (const a of document.querySelectorAll('a[data-repo]')) a.href = base;
  }

  // The published facts: the office server's settings first, then procurement.json.
  let office = {};
  if (!window.SUDS_STATIC_HOST && location.protocol !== 'file:') {
    try { office = (await fetch('/api/procurement', { headers: { 'X-Requested-With': 'suds' } }).then(r => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : {}))) || {}; } catch { /* no office server behind this copy */ }
  }
  const link = (href, label) => { const a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.textContent = label; return a; };
  for (const f of FIELDS) {
    const dd = document.querySelector(`[data-field="${f}"]`);
    if (!dd) continue;
    const v = text(office[f]) || text(cfg[f]);
    dd.dataset.published = v ? '1' : '0';
    if (!v) { dd.textContent = BLANK; dd.classList.add('muted'); continue; }
    if (f === 'contact_email' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) dd.replaceChildren(link(`mailto:${v}`, v));
    else if (f === 'contact_url' && /^https:\/\/[^\s<>"]+$/.test(v)) dd.replaceChildren(link(v, v));
    else dd.textContent = v;
  }

  try {
    const v = await fetch('version.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
    if (v && v.version) document.getElementById('version').textContent = ` for SUDS ${v.version}`;
  } catch { /* offline: the page reads fine without it */ }
})();
