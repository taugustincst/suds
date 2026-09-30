import { h, route, get, post, put, del, fmt, can, state, pageHead, table, kv, nav, toast, modal, form, confirmDialog, badge } from '../app.js';
import { monthsLabel } from '../county-periods.js';

// The county connection (server/county-connect.js, server/county-connect-client.js; docs/COUNTY-VIEW.md, "Connecting").
// Released in 1.18.0. Optional and off by default on both sides; office server only.
//   The county's side:  #/county-connect (settings, programmes' connection tokens, read tokens for the county's own
//                       systems), and programmeConnections(), the Connection tokens card on County view › Programmes.
//   The programme's side: countySendCard(), under Send to the county on Settlement outcomes: the county's address and
//                       token, Test connection, Send to the county now, and what was sent.
// A token is shown once, in a dialog whose first field holds it (focus lands there) with a Copy button that says
// what it did; it is never shown again.

const when = (s) => (s ? fmt.date(s) : '—');
const periodText = (s) => `${fmt.date(s.period_from || s.from)} – ${fmt.date(s.period_to || s.to)}`;
const STATE_WORDS = { live: ['Live', 'ok'], expired: ['Expired', 'warn'], revoked: ['Revoked', ''] };
const SEND_WORDS = { imported: ['Imported', 'ok'], superseded: ['Imported (replaced the earlier file)', 'ok'], older: ['Kept, a newer file counts', 'warn'], duplicate: ['Already had it', ''], refused: ['Refused', 'danger'], failed: ['Not sent', 'danger'] };

/** The token, once: a read-only field (focus lands on it, its text selected), a Copy button, and what it is for. */
function showToken(title, t, facts, onClose) {
  const input = h('input', { type: 'text', id: 'cc-token-value', class: 'mono', readOnly: true, value: t.token, spellcheck: false, autocomplete: 'off', 'aria-describedby': 'cc-token-help', 'data-cc-token': '1', onFocus: (e) => e.target.select() });
  const said = h('p', { class: 'small', role: 'status', 'data-cc-copied': '1' });
  const copy = h('button', { class: 'btn', type: 'button', 'data-cc-copy': '1', onClick: async () => {
    try { await navigator.clipboard.writeText(t.token); said.textContent = 'Copied the token to the clipboard.'; }
    catch { input.focus(); input.select(); said.textContent = 'The token is selected: press Ctrl+C (⌘C on a Mac) to copy it.'; }
  } }, 'Copy the token');
  const m = modal(title, h('div', { 'data-cc-shown-once': '1' },
    h('div', { class: 'field' }, h('label', { for: 'cc-token-value' }, 'Token'), input,
      h('div', { class: 'help', id: 'cc-token-help' }, 'Copy it now: it is not shown again. SUDS keeps only a fingerprint of it (its SHA-256). Give it to whoever needs it over a secure channel, never in the same email as anything else about it.')),
    h('div', { class: 'btn-row' }, copy), said,
    kv(facts),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', type: 'button', 'data-cc-done': '1', onClick: () => m.close() }, 'I have copied it'))), { onClose });
  return m;
}

// ---------------------------------------------------------------- the county's side
/** Connection tokens, one row per registered programme: for County view › Programmes (county:manage). */
export async function programmeConnections(programmes) {
  if (!can('county:manage')) return null;
  const box = h('div', { 'data-cc-programmes': '1' });
  const refresh = async () => {
    const d = await get('/api/county-connect/tokens', { quiet: true });
    const conn = d.rows.filter(t => t.kind === 'connection');
    const rows = programmes.map(p => ({ ...p, tokens: conn.filter(t => t.programme_id === p.id && t.state === 'live') }));
    box.replaceChildren(
      ...(d.enabled ? [] : [h('p', { class: 'banner info small', 'data-cc-off': '1' }, 'The county connection is switched off, so no program can send over it yet, whatever tokens are issued. Switch it on under ', h('a', { href: '#/county-connect' }, 'County connections'), '.')]),
      table([{ label: 'Program', render: p => p.name },
        { label: 'Connection token', render: p => (p.tokens.length ? p.tokens.map(t => h('div', {}, h('code', { class: 'small' }, `${t.prefix}…`), t.expires_at ? ` · expires ${when(t.expires_at)}` : ' · no expiry')) : h('span', { class: 'muted' }, 'None')) },
        { label: 'Last used', render: p => (p.tokens.length ? p.tokens.map(t => h('div', {}, t.last_used_at ? `${when(t.last_used_at)} from ${t.last_used_ip || 'an unknown address'}` : 'Not yet')) : '—') },
        { label: '', srLabel: 'Actions', render: p => h('div', { class: 'btn-row' },
          p.active ? h('button', { class: 'btn sm', type: 'button', 'data-cc-issue': p.id, 'aria-label': `Issue token for ${p.name}`, onClick: () => issueConnection(p, refresh) }, 'Issue token') : h('span', { class: 'small muted' }, 'Inactive'),
          ...p.tokens.map(t => h('button', { class: 'btn sm ghost', type: 'button', 'data-cc-revoke': t.id, 'aria-label': `Revoke ${p.name}'s token ${t.prefix}`, onClick: () => revokeToken(t, `${p.name}'s connection token`, refresh) }, 'Revoke'))) }],
      rows, { empty: 'No programs registered yet.' }));
  };
  await refresh();
  return h('section', { class: 'card mb', 'aria-labelledby': 'cc-prog-h', 'data-cc-programmes-card': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cc-prog-h' }, 'Connection tokens')),
    h('p', { class: 'small' }, 'A program whose SUDS connects to the county sends its county file here over the internet instead of by email, with the token you issue it. The file must still be signed with the program\'s registered key: the token only says which program is calling. ',
      h('a', { href: '#/county-connect', 'data-cc-page-link': '1' }, 'County connections and API access')),
    box);
}

function issueConnection(p, refresh) {
  const f = form([{ name: 'expires', label: 'Expires', type: 'select', noBlank: true, value: '365', options: [{ value: '90', label: 'After 90 days' }, { value: '365', label: 'After a year' }, { value: '730', label: 'After two years' }, { value: 'never', label: 'Never (revoke it by hand)' }], span: true,
    help: 'When it expires the program\'s sends are refused until you issue a new one.' }], {
    submitText: 'Issue token', onCancel: () => m.close(),
    onSubmit: async (d) => {
      const t = await post('/api/county-connect/tokens', { scope: 'county.submit', programme_id: p.id, ...(d.expires === 'never' ? {} : { expires_days: Number(d.expires) }) });
      m.close();
      showToken(`Connection token for ${p.name}`, t, [['Program', p.name], ['County SUDS address', location.origin], ['Expires', t.expires_at ? fmt.date(t.expires_at) : 'Never']], refresh);
    } });
  const m = modal(`Issue a connection token for ${p.name}`, h('div', {}, h('p', { class: 'small' }, `Give ${p.name} this server's address and the token. Its administrator saves them under Settlement outcomes › Send to the county › Connect to the county.`), f));
}
async function revokeToken(t, what, refresh) {
  if (!await confirmDialog('Revoke this token?', `${what} (${t.prefix}…) stops working at once. Anything using it is refused until it is given a new one.`, { danger: true, okText: 'Revoke' })) return;
  try { await post(`/api/county-connect/tokens/${t.id}/revoke`, {}); toast('Revoked.', 'ok'); await refresh(); }
  catch (e) { toast(e.message, 'error'); }
}

route('county-connect', async () => {
  if (state.local || !can('county:view')) return h('div', {}, pageHead('County connections'), h('p', {}, 'You do not have access to this page.'));
  const s = await get('/api/county-connect/settings');
  const manage = can('county:manage'); const configure = manage && can('settings:manage');
  const settingsCard = h('section', { class: 'card mb', 'aria-labelledby': 'cc-set-h', 'data-cc-settings': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cc-set-h' }, 'The connection')),
    h('p', { class: 'small' }, 'Off by default. Switched on, programs the county has issued a connection token to can send their signed county file to this server over the internet, and see which periods the county still expects. The address must be reachable from the programs\' servers: through the county\'s TLS proxy, or a VPN (docs/DEPLOYMENT.md).'),
    s.proxy_warning ? h('p', { class: 'banner warn small', role: 'note', 'data-cc-proxy-warning': '1' }, s.proxy_warning) : null,
    kv([['Status', s.enabled ? badge('On: accepting connections', 'ok') : badge('Off', '')], ['County code', s.county_code_display || s.county_code || '—'], ['Files due', `${s.due_days} days after each period ends`],
      ['Send address', h('code', { class: 'small' }, `${location.origin}${s.endpoints.submissions}`)], ['Status address', h('code', { class: 'small' }, `${location.origin}${s.endpoints.status}`)]]),
    configure ? form([
      { name: 'enabled', label: 'Accept connections from programs', type: 'checkbox', value: s.enabled, span: true },
      { name: 'cadence', label: 'Periods the county expects', type: 'select', noBlank: true, value: s.cadence, options: s.cadences, span: true, help: 'What a program\'s Test connection shows as expected and outstanding (the last year of them).' },
      { name: 'start', label: 'Expect no period that starts before (optional)', type: 'date', value: s.start || '', span: true },
      { name: 'due_days', label: 'Days after a period ends that its file is due', type: 'number', value: String(s.due_days), span: true, help: `1 to ${s.due_days_max}. Programs connected to this server are told it, and their SUDS reminds them when a file is due.` },
    ], { submitText: 'Save', onSubmit: async (d) => {
      await put('/api/county-connect/settings', { enabled: !!d.enabled, cadence: d.cadence, start: d.start || null, due_days: d.due_days === '' || d.due_days === undefined ? undefined : Number(d.due_days) });
      toast('Saved.', 'ok'); nav(`county-connect?t=${Date.now()}`);
    } }) : h('p', { class: 'small muted' }, 'An administrator (county management and settings) switches the connection on and chooses the periods.'));

  let readBox = null;
  if (manage) {
    const readRows = h('div', { 'data-cc-read-rows': '1' });
    const refresh = async () => {
      const rows = (await get('/api/county-connect/tokens', { quiet: true })).rows.filter(t => t.kind === 'read');
      readRows.replaceChildren(table([{ label: 'Name', render: t => t.name }, { label: 'Token', render: t => h('code', { class: 'small' }, `${t.prefix}…`) },
        { label: 'State', render: t => badge(...STATE_WORDS[t.state]) }, { label: 'Expires', render: t => when(t.expires_at) },
        { label: 'Last used', render: t => (t.last_used_at ? `${when(t.last_used_at)} from ${t.last_used_ip || 'an unknown address'}` : 'Not yet') },
        { label: '', srLabel: 'Actions', render: t => (t.state === 'live' ? h('button', { class: 'btn sm ghost', type: 'button', 'data-cc-revoke': t.id, 'aria-label': `Revoke ${t.name}`, onClick: () => revokeToken(t, `The read token "${t.name}"`, refresh) }, 'Revoke') : null) }],
      rows, { empty: 'No read tokens issued.' }));
    };
    await refresh();
    const issueRead = () => {
      const f = form([{ name: 'name', label: 'Name (the system that will use it)', required: true, span: true },
        { name: 'expires_days', label: 'Expires after (days)', type: 'number', value: String(s.limits.read_default_days), span: true, help: `At most ${s.limits.read_max_days} days.` }], {
        submitText: 'Issue read token', onCancel: () => m.close(),
        onSubmit: async (d) => {
          const t = await post('/api/county-connect/tokens', { scope: 'county.read', name: d.name, expires_days: Number(d.expires_days) || undefined });
          m.close();
          showToken(`Read token: ${t.name}`, t, [['Combined view', `${location.origin}${s.endpoints.combined}?from=YYYY-MM-DD&to=YYYY-MM-DD`], ['Programs', `${location.origin}${s.endpoints.programs}`], ['Expires', fmt.date(t.expires_at)]], refresh);
        } });
      const m = modal('Issue a read token', h('div', {}, h('p', { class: 'small' }, 'For the county\'s own systems (a data warehouse, a dashboard): it reads the combined view and the list of programs, as JSON or tidy CSV, and nothing else. Exact figures, internal, not for publication.'), f));
    };
    readBox = h('section', { class: 'card mb', 'aria-labelledby': 'cc-read-h', 'data-cc-read': '1' },
      h('div', { class: 'card-head' }, h('h2', { id: 'cc-read-h' }, 'API access: read tokens')),
      h('p', { class: 'small' }, 'A read token lets one of the county\'s systems read the combined view (the same figures, rules and caveats as on screen: summed, not unduplicated; exact, internal, not for publication). It cannot send a file, sign anyone in or read anything else. Every read is recorded in the audit log.'),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-cc-issue-read': '1', onClick: issueRead }, 'Issue a read token')), readRows);
  }
  const progs = manage ? await programmeConnections((await get('/api/county/programmes')).rows) : null;
  return h('div', { 'data-county-connect': '1' }, pageHead('County connections'),
    h('p', { class: 'small' }, h('a', { href: '#/county?tab=programmes' }, 'County view › Programs'), ' · Released in 1.18.0.'),
    settingsCard, progs, readBox);
});

// ---------------------------------------------------------------- the programme's side
/**
 * The county connection, under Send to the county on Settlement outcomes: for whoever may make the county file (to
 * test and send) and administrators (to connect). Office server only. `choice` is the Send to the county card's
 * (views/settlement.js countyForm): its period, county code and name and ticked funds, checked as its Make the county
 * file checks them, so Send now sends exactly the file Download makes.
 */
export function countySendCard(choice = {}) {
  if (state.local || !(can('settings:manage') || (can('reports:funder') && can('budget:read')))) return null;
  const body = h('div', { 'data-cc-connection': '1' }, h('p', { class: 'small muted' }, 'Loading the county connection…'));
  // What the last Test or Send did: said where the person is (focus moves to it), left until the next.
  const result = h('div', { class: 'hidden', tabindex: '-1', 'data-cc-result': '1' });
  const say = (content, ok) => {
    result.setAttribute('role', ok ? 'status' : 'alert');
    result.className = `banner ${ok ? 'info' : 'danger'}`;
    result.setAttribute('data-cc-outcome', ok ? 'ok' : 'failed');
    result.replaceChildren(...[].concat(content).filter(Boolean));
    result.focus();
  };
  const refresh = async () => {
    let c;
    try { c = await get('/api/county-connect/connection', { quiet: true }); } catch (e) { body.replaceChildren(h('p', { class: 'small' }, e.message)); return; }
    const configureBtn = c.can_configure ? h('button', { class: c.connected ? 'btn' : 'btn primary', type: 'button', 'data-cc-configure': '1', onClick: () => configure(c, refresh) }, c.connected ? 'Change the connection' : 'Connect to the county') : null;
    if (!c.connected) {
      body.replaceChildren(h('p', { class: 'small' }, 'If the county runs SUDS and has switched its county connection on, this server can send the county file straight to it, instead of your downloading it and emailing it. The county issues a connection token for your program.'),
        c.can_configure ? h('div', { class: 'btn-row' }, configureBtn) : h('p', { class: 'small muted' }, 'An administrator connects this server to the county.'));
      return;
    }
    const test = async (btn) => {
      btn.disabled = true;
      try {
        const r = await post('/api/county-connect/connection/test', {}, { quiet: true });
        if (r.ok && r.code_changed) {
          say([h('p', {}, h('b', {}, 'The county code changed. '), `The county's server now gives county code ${r.connection.pending_county_code ? r.connection.pending_county_code.code_display : r.code_changed.code}, not the code this server was connected to. Nothing is sent, and automatic sending is off, until an administrator checks with the county and confirms the new code.`)], false);
        } else if (r.ok) {
          const st = r.status;
          say([h('p', {}, h('b', {}, 'Connected. '), `${st.county.name || 'The county'} expects ${st.cadence_label ? st.cadence_label.toLowerCase() : 'periodic'} files from ${st.programme.name}.`),
            st.outstanding.length ? h('p', {}, `Outstanding: ${st.outstanding.map(p => p.label || periodText(p)).join('; ')}.`) : h('p', {}, 'Nothing outstanding: the county has a file for every period it expects.')], true);
        } else say(`Not connected. ${r.error}`, false);
      } catch (e) { say(e.message, false); }
      finally { btn.disabled = false; await refresh(); if (choice.onMade) choice.onMade(); }
    };
    const send = async (btn) => {
      if (!choice.checked) { say('The Send to the county card above has not finished loading. Try again in a moment.', false); return; }
      const c2 = choice.checked(); // says what is missing on that card, and puts the focus there
      if (!c2) return;
      btn.disabled = true;
      try {
        const r = await post('/api/county-connect/send', c2, { quiet: true });
        const ok = !['refused', 'failed'].includes(r.status);
        say([h('p', {}, h('b', {}, ok ? 'Sent. ' : 'Not accepted. '), r.message), r.receipt && r.receipt.sha256 ? h('p', { class: 'small' }, `County's receipt: file ${r.receipt.sha256.slice(0, 16)}…, received ${r.receipt.received_at ? fmt.date(r.receipt.received_at) : ''}.`) : null], ok);
      } catch (e) { say(e.message, false); }
      // The reporting schedule on the same page (views/settlement.js) says the period is sent now.
      finally { btn.disabled = false; await refresh(); if (choice.onMade) choice.onMade(); }
    };
    const testBtn = h('button', { class: 'btn', type: 'button', 'data-cc-test': '1', onClick: (e) => test(e.currentTarget) }, 'Test connection');
    const sendBtn = c.can_send ? h('button', { class: 'btn primary', type: 'button', 'data-cc-send': '1', onClick: (e) => send(e.currentTarget) }) : null;
    // The button names the period chosen on the Send to the county card, and follows it when it changes.
    const label = () => { if (!sendBtn) return; const p = choice.period ? choice.period() : null; sendBtn.textContent = p ? `Send ${monthsLabel(p.from, p.to)} to the county now` : 'Send to the county now'; };
    choice.onChange = label; label();
    const disconnect = c.can_configure ? h('button', { class: 'btn ghost', type: 'button', 'data-cc-disconnect': '1', onClick: async () => {
      if (!await confirmDialog('Disconnect from the county?', 'The county\'s address and token are removed from this server. The county keeps what it received; the send log stays here.', { danger: true, okText: 'Disconnect' })) return;
      try { await del('/api/county-connect/connection'); toast('Disconnected.', 'ok'); await refresh(); } catch (e) { toast(e.message, 'error'); }
    } }, 'Disconnect') : null;
    const pend = c.pending_county_code;
    const pendingBox = pend ? h('div', { class: 'banner warn', role: 'note', 'data-cc-code-changed': '1' },
      h('p', {}, h('b', {}, 'The county\'s server now gives a different county code. '), `It gave ${pend.previous_display}; it now gives ${pend.code_display}${pend.name ? ` (${pend.name})` : ''}. A county's code does not normally change, so nothing is sent to it, and automatic sending is off, until an administrator checks with the county (by phone, not by email from the same server) and confirms the new code.`),
      c.can_configure ? h('div', { class: 'btn-row' }, h('button', { class: 'btn', type: 'button', 'data-cc-confirm-code': '1', onClick: async (e) => {
        const btn = e.currentTarget;
        if (!await confirmDialog('Confirm the new county code?', `Files will be made for county code ${pend.code_display} and sent to ${c.base_url}. Confirm only once the county has told you this is its code.`, { okText: 'Confirm the new code' })) { btn.focus(); return; }
        try { await put('/api/county-connect/connection', { confirm_county_code: true }); toast('Confirmed. Switch automatic sending on again under Change the connection if you want it.', 'ok'); await refresh(); }
        catch (err) { toast(err.message, 'error'); }
      } }, `Confirm ${pend.code_display} as the county's code`)) : h('p', { class: 'small' }, 'An administrator confirms it.')) : null;
    // The county's SUDS reads only an older file version (1.20 or earlier): what is sent leaves the award out.
    const olderBox = c.county_older ? h('p', { class: 'banner warn small', role: 'note', 'data-cc-county-older': '1' }, c.county_older_note) : null;
    body.replaceChildren(
      ...(pendingBox ? [pendingBox] : []), ...(olderBox ? [olderBox] : []),
      kv([['County SUDS address', h('code', { class: 'small', 'data-cc-url': '1' }, c.base_url)], ['Token', h('code', { class: 'small' }, `${c.token_hint}… (saved, not shown)`)],
        ['County', c.county_name ? `${c.county_name}${c.county_code ? ` (code ${c.county_code})` : ''}` : '—'],
        ['Last tested', c.last_checked_at ? `${fmt.date(c.last_checked_at)}: ${c.last_check_ok ? 'connected' : `not connected (${c.last_check_error || 'unknown'})`}` : 'Not yet'],
        ['Automatic sending', c.auto_send ? `On: once a day, each period the county says is outstanding${c.last_auto_at ? ` (last run ${fmt.date(c.last_auto_at)})` : ''}` : 'Off']]),
      h('div', { class: 'btn-row' }, testBtn, sendBtn, configureBtn, disconnect),
      h('h3', { class: 'eyebrow', id: 'cc-log-h' }, 'Sent to the county'),
      table([{ label: 'Period', render: periodText }, { label: 'Sent', render: s => when(s.sent_at) }, { label: 'By', render: s => (s.automatic ? 'Automatic' : s.sent_by_name || '—') },
        { label: 'County\'s answer', render: s => badge(...(SEND_WORDS[s.status] || [s.status, ''])) }, { label: 'File (SHA-256)', render: s => (s.sha256 ? h('code', { class: 'small' }, `${s.sha256.slice(0, 16)}…`) : '—') }],
      c.sends, { empty: 'Nothing sent over the connection yet.' }));
  };
  refresh();
  return h('section', { class: 'card mb', 'aria-labelledby': 'cc-send-h', 'data-cc-send-card': '1' },
    h('div', { class: 'card-head' }, h('h2', { id: 'cc-send-h' }, 'Send to the county over the connection')),
    h('p', { class: 'small' }, 'The same signed file as Make the county file, for the period, county and funds chosen on the Send to the county card above, sent over an encrypted connection to the county\'s SUDS, which checks the signature against the key it registered for your program and answers with a receipt. Sending is recorded in the audit log; the log below keeps each receipt, never the figures.'),
    result, body);
}

function configure(c, refresh) {
  const f = form([
    { name: 'base_url', label: 'County SUDS address', required: true, span: true, value: c.base_url || '', help: 'The address the county gave you, starting https://.' },
    { name: 'token', label: c.connected ? 'New connection token (leave blank to keep the saved one)' : 'Connection token', type: 'password', autocomplete: 'off', required: !c.connected, span: true, help: 'Starts sudscc_. Saved encrypted, and never shown again.' },
    { name: 'auto_send', label: 'Send automatically: once a day, each period the county says is outstanding', type: 'checkbox', value: c.auto_send, span: true },
  ], { submitText: 'Save', onCancel: () => m.close(), onSubmit: async (d) => {
    await put('/api/county-connect/connection', { base_url: d.base_url, ...(d.token ? { token: d.token } : {}), auto_send: !!d.auto_send });
    m.close(); toast('Saved. Test the connection to see what the county expects.', 'ok'); await refresh();
  } });
  const m = modal(c.connected ? 'Change the county connection' : 'Connect to the county', f);
}
