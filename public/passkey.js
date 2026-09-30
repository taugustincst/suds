// Fingerprint sign-in, signing and approvals with passkeys (docs/FINGERPRINT.md). The browser's WebAuthn API asks
// the device's own authenticator (Touch ID, Windows Hello, an Android fingerprint, or the device's screen lock) to
// make or use a passkey; SUDS never sees the fingerprint, only a public key and signatures. Office server only:
// SUDS on this device never offers it (state.local). The server's options arrive as JSON with base64url strings;
// the WebAuthn API wants ArrayBuffers, and its answers are turned back into JSON for the server.
import { h, get, post, state, modal, form, announce, toast } from './app.js';

const fromB64url = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (String(s).length % 4)) % 4)); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; };
const toB64url = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

/** Whether this page could use a passkey at all: an office server page, a secure context, a browser with WebAuthn. */
// A passkey belongs to a host name: an address typed as an IP (https://192.168.1.10) cannot have one.
const ipHost = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
export function passkeysPossible() {
  try { return !state.local && !window.SUDS_STATIC_HOST && typeof window.PublicKeyCredential === 'function' && window.isSecureContext && !!navigator.credentials && !ipHost(location.hostname); } catch { return false; }
}
/** Whether this device has a built-in authenticator that verifies its user (a fingerprint reader, a face, a PIN). */
export async function platformAvailable() {
  if (!passkeysPossible()) return false;
  try { return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
/** Whether the browser can offer this site's passkeys in the username field's suggestions (conditional UI). */
export async function conditionalAvailable() {
  if (!passkeysPossible() || typeof window.PublicKeyCredential.isConditionalMediationAvailable !== 'function') return false;
  try { return await window.PublicKeyCredential.isConditionalMediationAvailable(); } catch { return false; }
}

const descriptors = (list) => (list || []).map(d => ({ ...d, id: fromB64url(d.id) }));
function credentialJSON(c) {
  const r = c.response; const out = { id: c.id, rawId: toB64url(c.rawId), type: c.type, authenticatorAttachment: c.authenticatorAttachment || null, response: { clientDataJSON: toB64url(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = toB64url(r.attestationObject); if (typeof r.getTransports === 'function') { try { out.response.transports = r.getTransports(); } catch { /* optional */ } } }
  if (r.authenticatorData) { out.response.authenticatorData = toB64url(r.authenticatorData); out.response.signature = toB64url(r.signature); if (r.userHandle) out.response.userHandle = toB64url(r.userHandle); }
  return out;
}
/** Make a passkey from the server's creation options. Returns the credential as JSON for POST /api/auth/passkeys/register. */
export async function createPasskey(pk) {
  const c = await navigator.credentials.create({ publicKey: { ...pk, challenge: fromB64url(pk.challenge), user: { ...pk.user, id: fromB64url(pk.user.id) }, excludeCredentials: descriptors(pk.excludeCredentials) } });
  return credentialJSON(c);
}
/** Use a passkey with the server's request options. `mediation: 'conditional'` for the username field's suggestions. */
export async function getPasskey(pk, { mediation, signal } = {}) {
  const c = await navigator.credentials.get({ publicKey: { ...pk, challenge: fromB64url(pk.challenge), allowCredentials: descriptors(pk.allowCredentials) }, ...(mediation ? { mediation } : {}), ...(signal ? { signal } : {}) });
  return credentialJSON(c);
}
/** What went wrong with the device's prompt, in words (the browser's own messages are not written for staff). */
export function passkeyErrorMessage(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return 'The fingerprint check was cancelled or timed out. Try again when you are ready.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  if (name === 'SecurityError') return 'This address cannot use passkeys. SUDS must be opened over HTTPS at the address your administrator set up.';
  if (name === 'NotSupportedError') return 'This device or browser cannot make the kind of passkey SUDS needs.';
  if (name === 'AbortError') return 'The fingerprint check was stopped.';
  return (e && e.message) || 'The fingerprint check did not work.';
}

/**
 * "Confirm with fingerprint" for a signature or an approval: a challenge bound to exactly what is being signed
 * (POST /api/auth/passkeys/challenge with the purpose and the record ids), answered by the device. Returns the
 * assertion JSON for the route's `passkey` field.
 */
export async function fingerprintFor(purpose, params = {}) {
  const o = await post('/api/auth/passkeys/challenge', { purpose, ...params }, { quiet: true });
  return getPasskey(o.publicKey);
}

/**
 * The "Confirm with fingerprint" button a dialog shows, with a live status line: presses `run`, which gets the
 * fingerprint and sends it. Any failure is said in the status line (and announced), and focus stays on the button.
 */
export function fingerprintButton(run, { label = 'Confirm with fingerprint', primary = true } = {}) {
  const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite', 'data-fingerprint-status': '1' });
  const btn = h('button', { type: 'button', class: `btn ${primary ? 'primary' : ''} fingerprint-btn`, 'data-fingerprint': '1', onClick: async () => {
    btn.disabled = true; status.textContent = 'Waiting for your fingerprint (or your device’s screen lock)…';
    try { await run(); status.textContent = ''; }
    catch (e) { const msg = e && e.name ? passkeyErrorMessage(e) : (e && e.message) || 'That did not work.'; status.textContent = msg; status.dataset.error = '1'; announce(msg); btn.focus(); }
    finally { btn.disabled = false; }
  } }, h('span', { 'aria-hidden': 'true' }, '☝ '), label);
  const box = h('div', { class: 'fingerprint-confirm', 'data-fingerprint-confirm': '1' }, btn,
    h('p', { class: 'small muted' }, 'Uses your fingerprint, or your device’s screen lock. SUDS never receives your fingerprint.'), status);
  box.button = btn;
  return box;
}

/**
 * The proof an approval (time, spending) goes with (auth.verifyApprover). Nothing is asked unless it can be given
 * or is required: with a passkey on this device, "Confirm with fingerprint" is offered, and the approval can still
 * go ahead without it unless the programme requires a fingerprint or an authenticator code. Resolves to the fields
 * to add to the request ({}, { passkey }, { code } or { confirm: true }) and whether a dialog was shown, or null when
 * the person cancels. `message` is what is being approved, in words; `bind` the purpose and its record ids.
 */
// `preview`: open with this /api/auth/reauth state instead of asking, and as if this device could use a passkey (the
// accessibility audit, which runs at an IP address where none can be made; the server decides what is accepted).
export async function approvalProof({ title, message, okText, bind, preview = null }) {
  let st = preview; if (!st) { try { st = await get('/api/auth/reauth', { quiet: true }); } catch { st = null; } }
  const fp = !!(st && st.passkey && (preview || passkeysPossible()));
  const strong = !!(st && st.strong_required);
  if (!fp && !strong) return { body: {}, asked: false };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
    const parts = [h('p', {}, message)];
    if (fp) parts.push(fingerprintButton(async () => { const passkey = await fingerprintFor(bind.purpose, bind.params); finish({ body: { passkey }, asked: true }); }, { label: `Confirm with fingerprint and ${okText.toLowerCase()}` }));
    if (strong && st.recent) parts.push(h('p', { class: 'small muted' }, 'You confirmed it is you with a fingerprint or code a few minutes ago.'));
    let f = null;
    if (strong && !st.recent && st.totp) {
      f = form([{ name: 'code', label: 'Or the code from your authenticator app', required: true, autocomplete: 'one-time-code', pattern: '[0-9]{6}' }], { submitText: okText, onCancel: () => finish(null), onSubmit: async (d) => finish({ body: { code: d.code }, asked: true }) });
      parts.push(f);
    } else if (strong && !st.recent && !fp) {
      parts.push(h('div', { class: 'banner warn', role: 'status' }, 'Your programme requires a fingerprint or an authenticator code for approvals. Set one up under My profile first.'));
    }
    if (!f) parts.push(h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, 'Cancel'),
      !strong ? h('button', { type: 'button', class: 'btn', 'data-approve-without-fingerprint': '1', onClick: () => finish({ body: {}, asked: true }) }, `${okText} without fingerprint`)
        : st.recent ? h('button', { type: 'button', class: 'btn', onClick: () => finish({ body: { confirm: true }, asked: true }) }, okText) : null));
    const m = modal(title, h('div', { 'data-approval-proof': '1' }, ...parts), { onClose: () => { if (!settled) { settled = true; resolve(null); } } });
  });
}

/** Sign in with a passkey (POST /api/auth/passkeys/login). `username` narrows it to that account's passkeys. */
export async function signInWithPasskey({ username = '', mediation, signal } = {}) {
  const o = await post('/api/auth/passkeys/login/options', username ? { username } : {}, { quiet: true });
  const credential = await getPasskey(o.publicKey, { mediation, signal });
  return post('/api/auth/passkeys/login', { credential }, { quiet: true });
}

/** A short note for a toast after something about passkeys changed. */
export const passkeyToast = (text) => toast(text, 'ok');
