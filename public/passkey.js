// Fingerprint sign-in, signing and approvals with passkeys (docs/FINGERPRINT.md). The browser's WebAuthn API asks
// the device's own authenticator (Touch ID, Windows Hello, an Android fingerprint, or the device's screen lock) to
// make or use a passkey; SUDS never sees the fingerprint, only a public key and signatures. Office server only:
// SUDS on this device never offers it (state.local). The server's options arrive as JSON with base64url strings;
// the WebAuthn API wants ArrayBuffers, and its answers are turned back into JSON for the server.
import { h, get, post, state, modal, form, toast, prefs } from './app.js';

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
/**
 * What went wrong with the device's prompt, in words (the browser's own messages are not written for staff). Three
 * different things, said differently: the check was cancelled or timed out (the browser cannot tell those apart, nor,
 * in some browsers, from a device with no fingerprint sign-in for SUDS: `signIn` adds that possibility); SUDS does
 * not know the passkey the device offered (the server's "No fingerprint sign-in for SUDS was found on this device"
 * message); and the device could not verify the person (the server's "did not verify you" message).
 */
export const NO_PASSKEY_HERE = 'No fingerprint sign-in for SUDS was found on this device. Sign in with your password, then add one under My profile.';
export function passkeyErrorMessage(e, { signIn = false } = {}) {
  const name = e && e.name;
  if (name === 'NotAllowedError') return signIn ? 'The fingerprint check was cancelled or timed out. If this device has no fingerprint sign-in for SUDS yet, sign in with your password and add one under My profile.' : 'The fingerprint check was cancelled or timed out. Try again when you are ready.';
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

/** A small fingerprint icon for the buttons: decorative (aria-hidden), drawn inline, with the button's own colour. */
export function fingerprintIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'fp-icon' })) svg.setAttribute(k, v);
  for (const d of ['M6.2 17.5c1-1.6 1.6-3.5 1.6-5.5a4.2 4.2 0 0 1 8.4 0c0 1-.1 2-.3 3', 'M12 12c0 3-1 5.8-2.8 8', 'M15.4 17.8c-.4 1.2-.9 2.3-1.6 3.3', 'M4.3 14.3c.3-.8.4-1.5.4-2.3a7.3 7.3 0 0 1 12.2-5.4', 'M19.2 9.2c.3.9.5 1.8.5 2.8 0 .9-.1 1.8-.2 2.6']) {
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}

/**
 * Run the device's prompt from `btn`, saying so in the live `status` line. While waiting the button is marked
 * aria-disabled (it keeps the focus; a second press is ignored) rather than disabled (which would drop the focus to the
 * page). On failure the button is enabled again FIRST and then focused, and the reason is written once to the status
 * line, which is itself a polite live region (so it is announced once, not twice). Resolves true on success.
 */
export async function withFingerprint(btn, status, run, { waiting = 'Waiting for your fingerprint (or your device’s screen lock)…', message = (e) => (e && e.name ? passkeyErrorMessage(e) : (e && e.message) || 'That did not work.') } = {}) {
  if (btn.getAttribute('aria-disabled') === 'true') return false;
  btn.setAttribute('aria-disabled', 'true'); status.textContent = waiting; delete status.dataset.error;
  try { await run(); btn.removeAttribute('aria-disabled'); status.textContent = ''; return true; }
  catch (e) {
    btn.removeAttribute('aria-disabled');
    status.textContent = message(e); status.dataset.error = '1';
    try { btn.focus(); } catch { /* the dialog was closed */ }
    return false;
  }
}

/**
 * The "Confirm with fingerprint" button a dialog shows, with a live status line: presses `run`, which gets the
 * fingerprint and sends it. Any failure is said in the status line and the focus comes back to the button.
 */
export function fingerprintButton(run, { label = 'Confirm with fingerprint', primary = true } = {}) {
  const status = h('div', { class: 'small', role: 'status', 'aria-live': 'polite', 'data-fingerprint-status': '1' });
  const btn = h('button', { type: 'button', class: `btn ${primary ? 'primary' : ''} fingerprint-btn`, 'data-fingerprint': '1', onClick: () => withFingerprint(btn, status, run) }, fingerprintIcon(), ' ', label);
  const box = h('div', { class: 'fingerprint-confirm', 'data-fingerprint-confirm': '1' }, btn,
    h('p', { class: 'small muted' }, 'Uses your fingerprint, or your device’s screen lock. SUDS never receives your fingerprint.'), status);
  box.button = btn;
  return box;
}

/** "Your programme requires a fingerprint or an authenticator code … set one up": the words, with a link to My profile. */
export function strongSetupNotice(verb) {
  return h('div', { class: 'banner warn', role: 'status', 'data-strong-required': '1' },
    h('span', {}, `Your programme requires your fingerprint or a code from an authenticator app to ${verb}, and you have neither set up yet. `,
      h('a', { href: '#/profile', 'data-strong-setup-link': '1' }, 'Set one up under My profile'), ', then come back.'));
}

/** Whether this person asked to confirm every approval with their fingerprint (My profile). */
export const approveWithFingerprintPref = () => !!prefs.get('approve_with_fingerprint', false);

/**
 * The proof an approval (time, spending) goes with (auth.verifyApprover). Nothing is asked unless it must be or the
 * person asked for it: under "Require fingerprint or authenticator for signing" a fingerprint or a code, unless they
 * confirmed one in the last few minutes (the quick-signing window, st.recent: then the approval goes with a
 * confirmation alone); otherwise only when they chose "Confirm my approvals with my fingerprint" on My profile, again
 * outside the window. Resolves to the fields to add to the request ({}, { passkey }, { code } or { confirm: true })
 * and whether a dialog was shown, or null when the person cancels. `message` is what is being approved, in words;
 * `bind` the purpose and its record ids.
 */
// `preview`: open with this /api/auth/reauth state instead of asking, and as if this device could use a passkey (the
// accessibility audit, which runs at an IP address where none can be made; the server decides what is accepted).
// `optedIn`: the preference, for the preview.
export async function approvalProof({ title, message, okText, bind, preview = null, optedIn = null }) {
  let st = preview; if (!st) { try { st = await get('/api/auth/reauth', { quiet: true }); } catch { st = null; } }
  const fp = !!(st && st.passkey && (preview || passkeysPossible()));
  const strong = !!(st && st.strong_required);
  const recent = !!(st && st.recent);
  const wanted = optedIn === null ? approveWithFingerprintPref() : optedIn;
  if (recent) return { body: strong ? { confirm: true } : {}, asked: false };
  if (!strong && !(wanted && fp)) return { body: {}, asked: false };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; m.close(); resolve(v); };
    const parts = [h('p', {}, message)];
    const button = fp ? fingerprintButton(async () => { const passkey = await fingerprintFor(bind.purpose, bind.params); finish({ body: { passkey }, asked: true }); }, { label: `Confirm with fingerprint and ${okText.toLowerCase()}` }) : null;
    if (button) parts.push(button);
    if (!strong) parts.push(h('p', { class: 'small muted', 'data-approve-opted-in': '1' }, 'You asked to confirm your approvals with your fingerprint (My profile).'));
    let f = null;
    if (strong && st.totp) {
      f = form([{ name: 'code', label: fp ? 'Or the code from your authenticator app' : 'Code from your authenticator app', required: true, autocomplete: 'one-time-code', pattern: '[0-9]{6}' }], { submitText: okText, onCancel: () => finish(null), onSubmit: async (d) => finish({ body: { code: d.code }, asked: true }) });
      // One primary action: the fingerprint's, where there is one.
      if (fp) { const sb = f.querySelector('button[type=submit]'); if (sb) sb.classList.remove('primary'); }
      parts.push(f);
    } else if (strong && !fp) parts.push(strongSetupNotice(okText.toLowerCase()));
    if (!f) parts.push(h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onClick: () => finish(null) }, strong && !fp ? 'Close' : 'Cancel')));
    const m = modal(title, h('div', { 'data-approval-proof': '1' }, ...parts), { onClose: () => { if (!settled) { settled = true; resolve(null); } } });
    if (button) button.button.focus();
  });
}

/** Sign in with a passkey (POST /api/auth/passkeys/login): the device offers its passkeys for SUDS (discoverable). */
export async function signInWithPasskey({ mediation, signal } = {}) {
  const o = await post('/api/auth/passkeys/login/options', {}, { quiet: true });
  const credential = await getPasskey(o.publicKey, { mediation, signal });
  return post('/api/auth/passkeys/login', { credential }, { quiet: true });
}

/** A short note for a toast after something about passkeys changed. */
export const passkeyToast = (text) => toast(text, 'ok');
