'use strict';
// OIDC Authorization Code + PKCE against a single configured identity provider. No JWT/OIDC library:
// discovery, JWKS and ID token verification are all done with node:crypto and fetch, in keeping with the
// project's zero-runtime-dependency rule (see CLAUDE.md).
const crypto = require('node:crypto');
const config = require('./config');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

// Discovery and JWKS change essentially never; refetching them on every login would make every sign-in
// depend on the identity provider being reachable at that exact instant. Cached for an hour.
const CACHE_MS = 3600_000;
let discoveryCache = null; // { at, doc }
let jwksCache = null; // { at, keys }

// Outbound requests (server/outbound.js is the shared SSRF guard). The issuer is the operator's own setting
// and may well be an identity provider on the county's network, so it is trusted as configured -- but only
// over https (plain http only to this machine outside production, for development). Every other address
// comes out of the discovery document, not from the operator: an endpoint on the issuer's own origin is
// the issuer's, and anything else must be https on the public internet (never 169.254.169.254, this
// machine or the county LAN). Redirects are never followed.
const outbound = require('./outbound');
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
function checkIssuer() {
  let iss; try { iss = new URL(config.oidc.issuer); } catch { throw new Error('OIDC_ISSUER is not a web address'); }
  if (iss.protocol === 'https:') return iss;
  if (iss.protocol === 'http:' && !config.isProd && LOOPBACK.test(iss.host.replace(/:\d+$/, ''))) return iss;
  throw new Error('OIDC_ISSUER must be an https address');
}
async function checkEndpoint(u) {
  const iss = checkIssuer();
  let url; try { url = new URL(u); } catch { throw new Error('The identity provider named an endpoint that is not a web address'); }
  if (url.origin === iss.origin) return url.href;
  try { const href = outbound.assertPublicHttps(url.href); await outbound.assertResolvesPublic(href); return href; }
  catch (e) { throw new Error(`The identity provider's discovery document names an endpoint SUDS will not contact (${url.host}): ${e.message}`); }
}
async function idpFetch(u, opts = {}) { return fetch(await checkEndpoint(u), { ...opts, redirect: 'error' }); }

async function discover() {
  if (discoveryCache && Date.now() - discoveryCache.at < CACHE_MS) return discoveryCache.doc;
  const res = await idpFetch(`${config.oidc.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`Could not reach the identity provider's discovery document (HTTP ${res.status})`);
  const doc = await res.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw new Error('The identity provider\'s discovery document is missing required fields');
  // OpenID Connect Discovery 1.0 §4.3: the document must name the issuer it was fetched from.
  if (doc.issuer !== undefined && String(doc.issuer).replace(/\/$/, '') !== config.oidc.issuer) throw new Error('The identity provider\'s discovery document names a different issuer');
  for (const k of ['token_endpoint', 'jwks_uri']) if (doc[k]) await checkEndpoint(doc[k]);
  discoveryCache = { at: Date.now(), doc };
  return doc;
}

async function jwks() {
  if (jwksCache && Date.now() - jwksCache.at < CACHE_MS) return jwksCache.keys;
  const doc = await discover();
  const res = await idpFetch(doc.jwks_uri);
  if (!res.ok) throw new Error(`Could not fetch the identity provider's signing keys (HTTP ${res.status})`);
  const { keys } = await res.json();
  jwksCache = { at: Date.now(), keys };
  return keys;
}

/** PKCE S256 challenge for a freshly generated verifier. */
function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// The state/nonce/PKCE-verifier travelling between /start and /callback has nowhere server-side to live
// (a bare Authorization Code flow has no session yet) — it rides in a short-lived, HMAC-signed cookie
// instead, keyed off config.indexKey the same way the audit chain is, so it cannot be forged or replayed
// past its own expiry.
const COOKIE = 'suds_oidc';
function signState(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', config.indexKey).update(body).digest());
  return `${body}.${sig}`;
}
function verifyState(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', config.indexKey).update(body).digest());
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try { payload = JSON.parse(fromB64url(body).toString('utf8')); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}
function stateCookie(token, { clear = false } = {}) {
  const secure = config.tls.cert || config.isProd ? '; Secure' : '';
  // Lax, not Strict: this cookie has to survive the top-level GET redirect back from the identity
  // provider, which is a cross-site navigation as far as the browser is concerned.
  if (clear) return `${COOKIE}=; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `${COOKIE}=${token}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600${secure}`;
}

/** Build the authorize redirect URL and the signed cookie that goes with it. `acrValues`: ask the provider
 *  for these authentication context classes (a step-up to multi-factor, where the administrator named one). */
async function startAuth({ acrValues = [] } = {}) {
  const doc = await discover();
  const { verifier, challenge } = pkcePair();
  const state = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const url = new URL(doc.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.oidc.clientId);
  url.searchParams.set('redirect_uri', config.oidc.redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (acrValues.length) url.searchParams.set('acr_values', acrValues.join(' '));
  const cookie = stateCookie(signState({ state, nonce, verifier, exp: Date.now() + 600_000 }));
  return { url: url.toString(), cookie };
}

/**
 * Exchange the callback's code for tokens and return the verified claims of the ID token. Throws on any
 * mismatch (state, nonce, issuer, audience, expiry, signature) — every one of those is a forged or replayed
 * attempt, not a recoverable condition.
 */
async function completeAuth({ code, state, cookieToken }) {
  const saved = verifyState(cookieToken);
  if (!saved) throw new Error('The sign-in request expired or was tampered with. Try again.');
  if (saved.state !== state) throw new Error('The sign-in request did not match. Try again.');
  const doc = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: config.oidc.redirectUri,
    client_id: config.oidc.clientId, client_secret: config.oidc.clientSecret, code_verifier: saved.verifier,
  });
  const res = await idpFetch(doc.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.id_token) throw new Error(tok.error_description || tok.error || 'The identity provider refused the sign-in');
  const claims = await verifyIdToken(tok.id_token, doc);
  if (claims.nonce !== saved.nonce) throw new Error('The identity provider\'s response did not match this sign-in attempt.');
  return claims;
}

/** Verify an RS256-signed ID token against the provider's published keys, issuer and this client's ID. */
async function verifyIdToken(idToken, doc) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('The identity provider returned a malformed token');
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(fromB64url(headerB64).toString('utf8'));
  // 'none' and symmetric (HS*) algorithms are refused outright: 'none' has no signature to check at all,
  // and HS* is keyed with the client secret, which this server itself sent to the provider — accepting it
  // would let anyone who can guess or leak that secret mint their own tokens.
  if (header.alg !== 'RS256') throw new Error(`Unsupported token signing algorithm: ${header.alg}`);
  const keys = await jwks();
  const jwk = keys.find((k) => k.kid === header.kid && (k.use === undefined || k.use === 'sig'));
  if (!jwk) throw new Error('The identity provider signed this token with a key SUDS does not recognise');
  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${headerB64}.${payloadB64}`), publicKey, fromB64url(sigB64));
  if (!ok) throw new Error('The identity provider\'s token signature did not verify');
  const claims = JSON.parse(fromB64url(payloadB64).toString('utf8'));
  if (claims.iss !== doc.issuer) throw new Error('The token was issued by an unexpected issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.oidc.clientId)) throw new Error('The token was not issued for this application');
  if (!claims.exp || Date.now() >= claims.exp * 1000) throw new Error('The token has expired');
  if (!claims.sub) throw new Error('The token has no subject');
  return claims;
}

// Authentication method references (RFC 8176). `mfa` says outright that more than one factor was used
// (Entra ID sends ["pwd","mfa"], Okta "mfa" with the factors). Any other single value — a one-time password,
// a hardware- or software-secured key, an SMS — can be the only factor on its own (a passwordless key, an
// emailed code), so it counts only beside a factor of a different kind: something known, something held,
// something the person is. Two values of the same kind (otp+sms, fpt+face) are still one kind of factor.
const MFA_AMR = ['mfa'];
const AMR_FACTOR_KIND = {
  pwd: 'knowledge', pin: 'knowledge', kba: 'knowledge',
  otp: 'possession', sms: 'possession', tel: 'possession', hwk: 'possession', swk: 'possession', sc: 'possession',
  fpt: 'inherence', face: 'inherence', iris: 'inherence', retina: 'inherence', vbm: 'inherence',
};
/**
 * Did the identity provider say this sign-in used multi-factor authentication? Only consulted when the
 * administrator has chosen to trust it (sso_trust_idp_mfa). Yes when amr holds `mfa`, when amr names two
 * factors of different RFC 8176 kinds (pwd+otp, hwk+pin, fpt+swk), or when `acr` equals one of the configured
 * values (sso_mfa_acr_values), for providers that express MFA as an authentication context class.
 * Returns { ok, via, amr, acr }.
 */
function idpMfa(claims, { acrValues = [] } = {}) {
  const amr = Array.isArray(claims.amr) ? claims.amr.map(String) : typeof claims.amr === 'string' ? [claims.amr] : [];
  const acr = claims.acr === undefined || claims.acr === null ? null : String(claims.acr);
  const lower = amr.map((a) => a.toLowerCase());
  const amrHit = lower.find((a) => MFA_AMR.includes(a));
  if (amrHit) return { ok: true, via: `amr:${amrHit}`, amr, acr };
  const byKind = new Map();
  for (const a of lower) { const k = AMR_FACTOR_KIND[a]; if (k && !byKind.has(k)) byKind.set(k, a); }
  if (byKind.size >= 2) return { ok: true, via: `amr:${[...byKind.values()].slice(0, 2).join('+')}`, amr, acr };
  if (acr && acrValues.includes(acr)) return { ok: true, via: `acr:${acr}`, amr, acr };
  return { ok: false, via: null, amr, acr };
}

module.exports = { checkEndpoint, discover, startAuth, completeAuth, stateCookie, COOKIE, idpMfa, MFA_AMR, AMR_FACTOR_KIND, _resetCacheForTests: () => { discoveryCache = null; jwksCache = null; } };
