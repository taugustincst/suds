# Secure referral links — design and threat model

From 1.17.0 a referral to an organisation that does not use SUDS can be sent as a **one-time secure link**: the
provider opens it in a browser with no account, reads a minimal referral, and can tell the programme what
happened. Code: `server/referral-links.js`, `server/routes/referral-links.js`, `public/referral-link.html` and
`public/referral-link.js`. Tests: `test/referral-links.test.js`, `test/security-1170.test.js`, `scripts/ui/r10-part2.mjs`.

## Before switching it on

- **Off by default.** *Secure referral links* is a programme setting (Privacy & Part 2 → *Secure referral links*,
  `PUT /api/referral-links/settings { enabled }`, administrators only, audited). Off — on a new install and after an
  upgrade — the *Secure link* button is hidden, no link can be made (`409`), and links already sent stop opening.
- **Counsel reviews this design first.** The link departs from the sign-in design first sketched in
  [docs/market/DATA-NETWORK.md](../market/DATA-NETWORK.md): the recipient reads the client's name and the reason
  behind a six-digit code, with no account. Have counsel review it as built (that page, *What counsel must
  review*, item 7) before switching it on.
- **The office server must be reachable from the internet.** The provider's browser opens the link on this
  server. An office server reachable only on the office network cannot serve one; exposing it (a reverse proxy
  with TLS, `TRUST_PROXY` set correctly so the per-address limits see real addresses) is a decision for the
  programme's IT and its risk register ([docs/DEPLOYMENT.md](../DEPLOYMENT.md)).

## What is sent

| Kind | Needs | Contains | Accounting |
| --- | --- | --- | --- |
| **Referral** (`packet`) | A live Part 2 consent that names the provider (or its organisation), with every §2.31 element — `disclosure.requireBasis(…, { basis: 'consent', allowed: ['consent'] })`, the same recipient match as every other disclosure. Checked when the link is made **and again when it is opened**. An agreed restriction must be confirmed when it is made; one agreed afterwards withholds it. | The client's name (and preferred name), the reason for the referral as the worker wrote it, urgency, the referral date, who referred and how to reach the programme; the client's phone and date of birth **only if the worker ticks them**. The §2.32 notice is shown with it. | Written to the client's accounting of disclosures **when the provider first opens it** (that is when the information leaves), as the worker's disclosure, source `referral_link`. A link never opened is never accounted, because nothing was disclosed. |
| **Contact notice** (`contact_notice`) | Nothing: it names nobody. | "*Programme* would like to talk to you about a referral; contact them and quote reference R-XXXXXX." No client detail, no free text (a worker's words could name the person), no urgency tied to a person. | None: nothing identifying leaves. The link is still audited. |

Medical-emergency, court-order and supervisor-override bases are **not** available for a link: a link is read
later, by someone SUDS cannot see, which is not what those bases are for. Those disclosures are made directly and
recorded on the Consents tab.

The recipient's page offers **"Receive referrals through SUDS"**: an invitation link an administrator sets
(`PUT /api/referral-links/settings`, https only), or, without one, the programme's contact.

## How it works

1. The worker opens a referral → **Secure link**, chooses what to send and for how long (1, 3 or 7 days), and
   gets the link and — for a referral — a six-digit **access code**, both shown once.
2. The worker sends the link by email or text and **gives the code another way** (by phone).
3. The provider opens the link. The page (`/referral-link.html`) reads the token from the address's **fragment**
   (`#…`), keeps it in the tab's `sessionStorage`, removes it from the address bar, and posts it in a request
   body to `POST /api/referral-links/open`. For a referral it asks for the code; the first browser that gives the
   right code **claims** the link and receives a random claim secret it keeps for the tab.
4. The provider answers — received / accepted / scheduled / declined / could not reach — with their name and an
   optional note (`POST /api/referral-links/ack`). The worker gets a to-do on the referral ("… scheduled the
   client — confirm and record the outcome") and sees the answer in the link list. SUDS does not change the
   referral's status itself: the worker confirms and records the outcome, which is the referral's own gate.
5. The worker (or a supervisor) can **withdraw** a link at any time; it stops working at once.

## Threat model

Assets: the client's identity as a person in SUD treatment (Part 2), the referral's content, the integrity of the
accounting of disclosures. Adversaries: someone who receives a forwarded or intercepted link; someone guessing
links; someone who reads logs, browser history or a shared screen; a malicious or careless recipient; an insider.

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| **Enumeration / guessing** a valid link | Tokens are 256 bits from `crypto.randomBytes` (43 base64url characters). Unknown, expired, withdrawn and locked links all get the same 404 and message (no oracle). The public routes are rate limited per address (30 per 10 minutes) and for all addresses together (600 per 10 minutes) on top of the global API limit. | None practical. |
| **Database read** (a stolen backup, an insider with SQL) | Only `SHA-256` of the token, the code (salted with the link id) and the claim secret are stored; the packet is AES-256-GCM encrypted like all PHI (`packet_enc`, `ack_by_enc`, `ack_note_enc`). | Someone with the database *and* the encryption key can read packets, as they can read every record; the six-digit code's hash can be brute-forced offline, but gives nothing without the token, which is not stored. |
| **The token in logs, history, Referer, proxies** | The token is in the URL **fragment**, which browsers never send to a server, so it is in no server or proxy log and no `Referer` (`Referrer-Policy: no-referrer` as well). The page removes it from the address bar at once, so the history entry, a bookmark or a screenshot of the address holds no token. The page is `noindex`. Nothing identifying is ever in a URL. | A copy of the original email or text still holds the link (below). |
| **Link forwarding** (an email forwarded to a colleague, a shared inbox, interception) | A referral needs the **access code**, given separately (by phone): the link alone opens nothing. The first browser to give the code **claims** the link; any other browser — even with the code — is refused, the refusal is audited (`referral_link.open`, `claimed_elsewhere`, through the same per-link hourly throttle as the other refusals) and the worker can see it and withdraw the link. Five wrong codes lock the link. | Someone who has both the link and the code *and* opens it first reads the packet; the intended recipient is then refused and calls the programme, which withdraws it and sends a new one. That disclosure is accounted to the recipient named on the consent; the programme records it as an incident if it was not them. |
| **Expiry and staleness** | Links last 1, 3 or 7 days at most (`TTL_HOURS`). The consent is **re-checked at open**: a consent revoked, expired or no longer naming the provider, or a restriction agreed after the link was made, withholds the packet — the page shows only the contact notice. So does a client record since removed or merged into another, a referral since closed, completed, declined or marked no-show, and (since 1.17.1) a worker who made the link and has since been deactivated or can no longer reach the client; deactivating a worker also withdraws the links they made that could still be opened. The packet is a snapshot: later edits to the record do not reach it. | The consent is re-checked on every open, the claiming browser's included, so a reload after a revocation shows only the contact notice; what is already on the provider's screen stays there (as a fax already sent stays sent). |
| **Over-disclosure** | Minimal by default (name, reason, urgency); phone and date of birth are opt-in per link; never notes, diagnoses, substance, episode data or counseling notes. The worker's reason is limited to 1,000 characters and the form says to write only what the provider needs. | The free-text reason is the worker's judgement, as in any referral letter. |
| **Wrong recipient** | The gate is the same recipient match as every disclosure: the consent must name the provider or its organisation (or a registered alias). The provider's names are kept with the packet when the link is made: the consent is re-checked against them at open, and the accounting names that recipient, so renaming the directory entry later changes neither. | A link sent to the wrong email address: the code and first-browser claim limit it; record an incident. |
| **Cross-site request forgery / script injection** on the recipient page | No cookies or sessions are involved (`credentials: 'omit'`); the page renders every value with `textContent`, never HTML; the CSP forbids inline scripts; the invitation link must be `https://`. | — |
| **Abuse of the acknowledgement** (spam, false answers) | Only a holder of the token (and, for a referral, the claim secret) can answer; answers are length-limited, encrypted and audited. Each link has one to-do for the worker, updated with the latest answer, never one per answer; an answer never changes the referral or the record. | A recipient can give a false answer; the worker confirms the outcome. |
| **Denial of service**, including growing the audit log | Per-address and all-address rate limits; the body limit for unauthenticated requests (64 KB); the lookup is one indexed query. Refused opens are audited without letting a flood grow the hash-chained log: per link (and for all unknown tokens together) the first 10 in an hour are written one by one, then one entry saying the rest are counted, then one summary per hour with the count and the busiest addresses. | Shared with every public endpoint. The summary is also written when the server shuts down; one not yet written is lost if the process is killed. |
| **Insider misuse** (a worker sending links to themselves) | Making a referral link needs `referrals:write` and access to the client; the consent gate applies; every link, open, refusal and acknowledgement is in the hash-chained audit log; the accounting row names the worker. | As for any disclosure a worker is allowed to make. |

Not in scope: the security of the recipient's own mailbox and computer; phishing that imitates a SUDS link (the
page never asks for a password, and says so by asking only for the six-digit code).

## Office server only

The routes are left out of the device kernel (`LOCAL_ROUTE_MODULES` in `server/app.js`) and `referral_links` is
never synchronised (`server_only` in `server/sync-tables.js`): a device has no address a provider could reach,
and single-use needs the tokens in one place. On SUDS on this device (the GitHub Pages build) the *Secure link*
button is not shown.

## Retention

A link belongs to the client's record: it is purged with it (`DELETE_TABLES`), and its dates count as activity on
the record. The accounting row it wrote stays for as long as the accounting does.
