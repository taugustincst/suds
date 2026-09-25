# Identity and access

## Authentication options

| Method | Status | Code |
| --- | --- | --- |
| Username + password | Always available unless SSO is required; scrypt hashes; 12+ characters with upper, lower, digit, symbol; expiry after 90 days by default (`password_max_age_days`); temporary passwords must be changed at first sign-in | `server/auth.js` `login`, `passwordPolicy`; `server/routes/auth.js` |
| Single sign-on (OIDC) | Optional; Authorization Code + PKCE with one county identity provider (Entra ID, Okta, Keycloak, ADFS with OIDC…). Accounts are linked by an administrator (`oidc_subject`); a sign-in never creates or promotes an account | `server/oidc.js`, `server/routes/oidc.js` |
| **SSO required** | Settings → Security policy → *Require single sign-on* (`sso_required`). Password sign-in is refused (HTTP 403, audited `auth.login.sso_required`) for every account except the named **emergency (break-glass) administrator accounts** (`sso_emergency_accounts`). Refused unless OIDC is configured and each named account is an active administrator. Emergency sign-ins are audited with `emergency_account: true` and logged as warnings | `server/auth.js` `ssoPolicy`, `login`; `server/security-status.js` `validateSettings`; `test/security-evidence.test.js` |
| TOTP two-step verification (RFC 6238) | Required for every role by default (`MFA_REQUIRED_ROLES`), with a grace period for new accounts (14 days, `mfa_grace_days`, 0 = immediately), after which the account can reach nothing but enrolment. Settings → *Require two-step verification for every role* (`mfa_require_all`) makes it an explicit switch that overrides the role list. The MFA secret is stored encrypted | `server/auth.js` `requireAuth`, `mfaDeadline`, `policy` |
| API keys | Write-only intake keys (hashed), named, revocable; cannot read data | `server/routes/admin.js`, `server/routes/intake.js` |
| Metrics token | Bearer token for `/api/metrics` only; no PHI | `server/metrics.js` |

**Break-glass accounts for an IdP outage.** Name at least one (preferably two) administrator accounts in `sso_emergency_accounts`. They keep a password (and TOTP): seal the credentials (sealed envelope in a safe, or the county's privileged-access vault), review every use (Audit log → filter `auth.login`, look for `emergency_account`), and rotate the password after each use.

**SSO and MFA together.** An SSO sign-in still passes SUDS's own TOTP step for roles that require it. SUDS does not currently accept the identity provider's MFA assertion (`amr`/`acr`) in its place; a county that enforces MFA at the IdP will see a second prompt. This is a known gap.

## Sessions

* Server-side sessions; the cookie carries a random 256-bit token, only its SHA-256 is stored (`server/auth.js`).
* Idle timeout 15 minutes by default (`session_idle_minutes`, capped at 60), absolute limit 12 hours (`session_absolute_hours`); the browser warns a minute before sign-out; background polling does not count as activity.
* Password change revokes the account's other sessions; a user can revoke their own other sessions; deactivating an account ends its access.
* `HttpOnly; SameSite=Strict; Secure` cookie; state-changing requests need the `X-Requested-With: suds` header (CSRF).

These are visible in Settings → Security policy and on Settings → Security status.

## Brute force and enumeration

Account lockout after 5 failures for 15 minutes; 20 failed sign-ins per source address per 15 minutes (`LOGIN_RATE_LIMIT`); 10 MFA attempts per user per 10 minutes; API 600 requests/min per address; unknown usernames pay the same hashing cost and get the same answer; the audit log records unknown usernames only truncated and hashed (`server/auth.js` `auditUsername`).

## Authorisation

Role-based, least privilege (`server/auth.js` `PERMS`): admin, supervisor, clinician, navigator, finance, readonly. Navigators and clinicians see only their caseload (`caseloadFilter`, `canAccessClient`). Finance and readonly see de-identified client codes only. Administrators are system administrators, not treating staff: opening a clinical note requires a written break-glass reason, is audited and queued for a supervisor's acknowledgement (`../HIPAA.md`). Every denial is audited (`authz.denied`).

## Account lifecycle

* Creation by an administrator, or a self-service *request* on the sign-in page that an administrator must approve and assign a role to (`POST /api/auth/signup`, can be switched off).
* Deactivation revokes sessions and queues a remote wipe of the person's local-mode devices (`server/devices.js`).
* **Accounts without two-step verification** — role, whether it is required, deadline, overdue, SSO-linked, last sign-in — are listed on Settings → Security status and at `GET /api/admin/security/mfa-report` (users:manage, audited).
* Access reviews: the Users & roles tab lists every account with role, MFA and last sign-in; a periodic review is a county procedure (see [SOC2-READINESS.md](SOC2-READINESS.md), CC6.2/6.3).

## Directory integration

SUDS has no SCIM or LDAP provisioning. With SSO required, disabling a person at the IdP stops new sign-ins immediately; their SUDS account should still be deactivated (to end local-mode sync and existing sessions within the idle timeout). Group-to-role mapping is manual.
