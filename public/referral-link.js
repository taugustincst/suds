// The recipient's page for a secure referral link (referral-link.html; server/referral-links.js).
// The token arrives in the address's fragment (#…), which the browser never sends to a server, in a log or in a
// Referer header. It is kept in this tab's sessionStorage and taken out of the address bar at once, so a
// screenshot, a bookmark or a copied address does not carry it. Everything shown is set as text, never HTML.
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'suds-referral-link';
  let saved = {};
  try { saved = JSON.parse(sessionStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const fromHash = location.hash.replace(/^#/, '').trim();
  if (fromHash) { saved = saved.token === fromHash ? saved : { token: fromHash }; try { history.replaceState(null, '', location.pathname); } catch { /* keep going */ } }
  const store = () => { try { sessionStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private window: works for this page view */ } };
  store();

  const status = (text, kind) => { const s = $('status'); s.textContent = ''; const p = document.createElement('p'); p.textContent = text; if (kind) p.className = kind; s.append(p); };
  const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
  async function call(path, body) {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'suds' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store' });
    let data = {}; try { data = await r.json(); } catch { data = {}; }
    return { status: r.status, data };
  }
  const LABEL = { received: 'We received this referral', accepted: 'We accepted the client', scheduled: 'We scheduled an appointment', declined: 'We cannot take this referral', unable_to_reach: 'We could not reach the client' };
  function row(dl, term, value) { if (!value) return; const dt = document.createElement('dt'); dt.textContent = term; const dd = document.createElement('dd'); dd.textContent = value; dl.append(dt, dd); }
  // A day and time as people write them ("Sep 3, 2026, 10:15 AM"), not the browser's default with seconds (r10 L6).
  const day = (v) => { if (!v) return ''; const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
  const URGENCY = { routine: 'Routine', urgent: 'Urgent', emergent: 'Emergent (same day)' };
  const urgency = (u) => (u ? URGENCY[u] || (u.charAt(0).toUpperCase() + u.slice(1)).replace(/_/g, ' ') : '');

  function render(d) {
    $('title').textContent = d.kind === 'packet' && !d.withheld ? 'Secure referral' : 'Please contact us about a referral';
    const dl = $('details'); dl.textContent = '';
    if (d.kind === 'packet' && d.packet) {
      status(`${d.programme} has referred a client to ${d.recipient || 'you'}. Reference ${d.reference}.`);
      const p = d.packet;
      row(dl, 'Client', p.client.name); row(dl, 'Goes by', p.client.preferred_name); row(dl, 'Date of birth', p.client.dob); row(dl, 'Phone', p.client.phone);
      row(dl, 'Urgency', urgency(p.urgency)); row(dl, 'Referred', day(p.referred_at)); row(dl, 'Referred by', p.referred_by);
      row(dl, 'Program', d.programme); row(dl, 'Program contact', d.contact); row(dl, 'Reference', d.reference); row(dl, 'This link expires', day(d.expires_at));
      if (p.reason) { $('reason').textContent = p.reason; show('reason-wrap'); }
      show('content');
      if (d.notice) { $('notice').textContent = d.notice; show('notice-wrap'); }
    } else {
      status(d.withheld ? `The information in this referral is no longer available. Please contact ${d.programme} and quote reference ${d.reference}.`
        : `${d.programme} would like to talk to you about a referral. Please contact them and quote reference ${d.reference}. No client information is included in this message.`);
      row(dl, 'Program', d.programme); row(dl, 'Program contact', d.contact); row(dl, 'Reference', d.reference); row(dl, 'This link expires', day(d.expires_at));
      show('content');
    }
    const sel = $('ack-status'); sel.textContent = '';
    for (const s of (d.withheld ? ['received', 'unable_to_reach'] : d.ack_statuses || [])) { const o = document.createElement('option'); o.value = s; o.textContent = LABEL[s] || s; sel.append(o); }
    show('ack-note-field', d.kind === 'packet' && !d.withheld);
    if (d.ack_status) { status(`Thank you — the program has your answer (${(LABEL[d.ack_status] || d.ack_status).toLowerCase()}). You can send an update below.`); }
    show('ack-form', !(d.kind === 'packet' && d.withheld));
    const inv = d.invite || {};
    if (inv.url) { const a = $('invite-link'); a.href = inv.url; show('invite-link-wrap'); }
    if (inv.contact) { $('invite-contact').textContent = inv.contact; show('invite-contact-wrap'); } else if (!inv.url) { $('invite-contact').textContent = d.programme; show('invite-contact-wrap'); }
    show('invite');
  }

  async function open(code) {
    if (!saved.token) { status('This page needs the full link you were sent. Open the link from the message again.', 'err'); return; }
    let r;
    try { r = await call('/api/referral-links/open', { token: saved.token, code: code || undefined, claim: saved.claim || undefined }); }
    catch { status('The referral could not be reached. Check your connection and reload the page.', 'err'); return; }
    if (r.status === 200 && r.data.code_required) { status('Enter the access code to open the referral.'); show('code-form'); $('code').focus(); return; }
    if (r.status === 200) {
      if (r.data.claim) { saved.claim = r.data.claim; store(); }
      saved.kind = r.data.kind; saved.withheld = !!r.data.withheld; store();
      show('code-form', false); render(r.data); return;
    }
    if (r.status === 401 || (r.status === 400 && r.data.code_required)) { $('code-error').textContent = r.data.error || 'That code is not right.'; $('code').setAttribute('aria-invalid', 'true'); $('code').focus(); return; }
    show('code-form', false);
    status(r.data.error || 'This link is not valid.', 'err');
  }

  // Checked here first: a code that is not six digits is a slip, and is never sent (it would not use up a try at
  // the server either, but saying so at once is kinder).
  $('code-form').addEventListener('submit', (e) => {
    e.preventDefault(); $('code-error').textContent = ''; $('code').removeAttribute('aria-invalid');
    const code = $('code').value.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) { $('code-error').textContent = code ? 'An access code is 6 digits. Check the code and enter it again.' : 'Enter the 6-digit access code.'; $('code').setAttribute('aria-invalid', 'true'); $('code').focus(); return; }
    open(code);
  });
  $('ack-form').addEventListener('submit', async (e) => {
    e.preventDefault(); $('ack-error').textContent = '';
    const by = $('ack-by').value.trim();
    if (!by) { $('ack-error').textContent = 'Enter your name and organization.'; $('ack-by').setAttribute('aria-invalid', 'true'); $('ack-by').focus(); return; }
    let r;
    try { r = await call('/api/referral-links/ack', { token: saved.token, claim: saved.claim || undefined, status: $('ack-status').value, by, note: $('ack-note').value.trim() || undefined }); }
    catch { $('ack-error').textContent = 'Could not send. Check your connection and try again.'; return; }
    if (r.status !== 200) { $('ack-error').textContent = r.data.error || 'Could not send.'; return; }
    status(`Thank you — the program has your answer (${(LABEL[r.data.ack_status] || '').toLowerCase()}).`);
  });
  open();
})();
