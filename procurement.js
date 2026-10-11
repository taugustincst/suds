// The "Security and procurement" page (procurement.html; released in 1.24.0), for organizations evaluating SUDS. No
// session needed, and it works on both builds:
//  - the document links point at the SUDS repository's docs on its default branch (the static build does not ship
//    docs/, and the office server does not serve them), from the one repository_url in procurement.json;
//  - the software vendor's contact, legal entity, pricing and SLA come from procurement.json (the owner edits it);
//    on an office server, the programme's own facts (what an administrator published under Settings,
//    GET /api/procurement) are shown apart from them, under "This program".
//  - procurement.html carries procurement.json's published legal entity, pricing and support text as static HTML, so a
//    crawler, a print to PDF or a reader with JavaScript off sees the same words (test/procurement-hardening.test.js
//    keeps the two equal). When procurement.json cannot be read (offline), that text stands.
// External, not inline: the CSP forbids inline scripts. Every value is set as text, never as HTML.
(async () => {
  const BLANK = 'Not yet published by the maintainer';
  const FIELDS = ['legal_entity', 'contact_name', 'contact_email', 'contact_url', 'pricing', 'sla'];
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let cfg = null;
  try { const r = await fetch('procurement.json', { cache: 'no-store' }); if (r.ok) cfg = (await r.json()) || {}; } catch { /* offline: the text in the page stands */ }

  // Documents: <repository>/blob/<branch>/<path>. Only an https github-style address is used; anything else keeps the
  // addresses written into the page.
  const repo = text(cfg && cfg.repository_url);
  const branch = text(cfg && cfg.default_branch) || 'main';
  if (repo && /^https:\/\/[^\s/]+\/[^\s]+$/.test(repo) && /^[\w./-]+$/.test(branch)) {
    const base = repo.replace(/\/+$/, '').replace(/\.git$/, '');
    for (const a of document.querySelectorAll('a[data-doc]')) a.href = `${base}/blob/${branch}/${a.dataset.doc}`;
    for (const a of document.querySelectorAll('a[data-repo]')) a.href = base;
  }

  // Two parties, never mixed (1.25.2, BO9): on an office server, "This program" is the programme running it, with what
  // its administrator published (GET /api/procurement; blank: "Not yet published by this program"); "The software
  // vendor" is AugustInnovations LLC, with procurement.json's terms, on every copy. Up to 1.25.1 an office server's
  // blank fields showed the vendor's legal entity and pricing as if they were the programme's.
  let office = null;
  if (!window.SUDS_STATIC_HOST && location.protocol !== 'file:') {
    try { office = await fetch('/api/procurement', { headers: { 'X-Requested-With': 'suds' } }).then(r => (r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null)); } catch { /* no office server behind this copy */ }
  }
  const link = (href, label) => { const a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.textContent = label; return a; };
  const show = (dd, f, v, blank) => {
    dd.dataset.published = v ? '1' : '0';
    if (!v) { dd.textContent = blank; dd.classList.add('muted'); return; }
    dd.classList.remove('muted');
    if (f === 'contact_email' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v)) dd.replaceChildren(link(`mailto:${v}`, v));
    else if (f === 'contact_url' && /^https:\/\/[^\s<>"]+$/.test(v)) dd.replaceChildren(link(v, v));
    else dd.textContent = v;
  };
  const officeSection = document.querySelector('[data-office-section]');
  if (office && typeof office === 'object' && officeSection) {
    officeSection.hidden = false;
    for (const f of FIELDS) { const dd = document.querySelector(`[data-office-field="${f}"]`); if (dd) show(dd, f, text(office[f]), 'Not yet published by this program'); }
  }
  for (const f of FIELDS) {
    const dd = document.querySelector(`[data-field="${f}"]`);
    if (!dd) continue;
    // procurement.json could not be read (offline, or a file: copy): the page's own copy of it stands.
    const own = text(dd.textContent);
    show(dd, f, cfg ? text(cfg[f]) : (own !== BLANK ? own : null), BLANK);
  }

  try {
    const v = await fetch('version.json', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null));
    if (v && v.version) document.getElementById('version').textContent = ` for SUDS ${v.version}`;
  } catch { /* offline: the page reads fine without it */ }
})();
