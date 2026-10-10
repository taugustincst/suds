# Code signing for the Windows server: the owner's steps

> **DRAFT — owner's checklist, to be completed by the owner.** It names no provider and recommends none; prices,
> providers and the publisher identity are the owner's decision (`[BRACKETS]`). Item 4 of
> [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md). The technical reference is [../../RELEASE.md](../../RELEASE.md),
> *Signing the Windows server*.

## 1. What is signed today, and what the workflow expects

- The Windows server zip (`suds-<version>-windows-x64.zip`) carries `suds.exe` and `suds-service.exe`. Both are
  **unsigned** in every release so far, so Windows SmartScreen warns about an unknown publisher and county IT cannot
  tie the binary to the publisher.
- `.github/workflows/release.yml`, job `windows-sign`, signs both **when the repository has two Actions secrets**:

  | Secret | Holds |
  | --- | --- |
  | `WINDOWS_CERT_PFX_BASE64` | The code-signing certificate **and its private key** as a `.pfx` file, base64-encoded |
  | `WINDOWS_CERT_PASSWORD` | The `.pfx` password |

  It then runs `signtool sign /fd SHA256 /f <pfx> /p <password> /tr http://timestamp.digicert.com /td SHA256 /d SUDS`
  on both files and `signtool verify /pa /all`, and deletes the `.pfx`. Only that step sees the secrets; CI builds on
  ordinary pushes are never signed. Without the secrets the zip is published unsigned with a notice.

## 2. The options (decide one; no provider is recommended here)

| | A. Code-signing certificate from a certificate authority | B. A cloud signing service |
| --- | --- | --- |
| What it is | An **OV** (organisation-validated) or **EV** code-signing certificate issued to the publisher by a publicly trusted CA | A service that holds the signing key in its own hardware and signs files sent to it, with the publisher's identity validated by the service |
| Prerequisites | The publisher is a registered organisation the CA can verify (name, address, phone listing, often a business registry and a call-back); for EV, more checks | An account with the provider, identity validation of the organisation (some services require a minimum business history), and a way to call it from GitHub Actions |
| Where the key lives | Under current industry rules for code signing, the private key must be generated and kept in **hardware** (a USB token or a cloud HSM), for OV as well as EV. Ask the CA whether any delivery gives a `.pfx` the workflow can use; usually it does not | In the provider's HSM; the publisher never holds it |
| Fits the workflow as it is? | Only if a `.pfx` with its key can be delivered. Otherwise `windows-sign` must call the CA's or HSM's signing tool | No: `windows-sign` must call the service's tool or action instead of `signtool /f` |
| Owner's cost and effort | `[PRICE PER YEAR]`; validation takes days to weeks; a token must be kept safe | `[PRICE PER MONTH]`; validation; account management |

**DECISION FOR TJ:** option A or B, the provider, and the publisher name. The publisher name is the entity of
[../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md) item 0, so the entity question is settled first. Whichever is
chosen, the private key never goes into the repository, a chat, an email or an assistant's environment.

## 3. Steps

1. **Apply** (Tj): with the chosen CA or service, as the publisher `[ENTITY NAME]`; answer the validation checks.
2. **If a `.pfx` is delivered** (option A with an exportable key):
   1. On the owner's own Windows machine, encode it:
      `[Convert]::ToBase64String([IO.File]::ReadAllBytes('suds-signing.pfx')) | Set-Clipboard`.
   2. GitHub → the repository → Settings → Secrets and variables → Actions → **New repository secret**:
      `WINDOWS_CERT_PFX_BASE64` (paste), then `WINDOWS_CERT_PASSWORD`.
   3. Clear the clipboard, keep the `.pfx` in the owner's own protected storage, and record the certificate's
      expiry date (renewal comes before it).
3. **If no `.pfx` can be had** (a token, a cloud HSM, or option B): give the maintainers the provider's name and its
   documented signing tool or GitHub Action, and the names of any secrets it needs (an account id, a certificate
   profile name, credentials for a federated identity). The maintainers change `windows-sign` in a release (an
   engineering change; the `windows-sign` job and RELEASE.md say what it does today). Tj adds the secrets they name.
4. **The next release** is signed by `release.yml` on its tag. (Re-running the workflow on an already-published tag is
   the maintainers' decision: [../../RELEASE.md](../../RELEASE.md), on *Run workflow*.)

## 4. Verify a signed `suds.exe`

On any Windows machine, after downloading the zip and checking its `.sha256`:

```powershell
# Signature, publisher and timestamp
Get-AuthenticodeSignature .\suds.exe, .\suds-service.exe | Format-List Path, Status, StatusMessage, SignerCertificate, TimeStamperCertificate
# Status must be "Valid"; SignerCertificate.Subject must name [ENTITY NAME]

# With the Windows SDK's signtool (verifies the chain and the timestamp)
signtool verify /pa /all /v .\suds.exe
signtool verify /pa /all /v .\suds-service.exe
```

Also: right-click `suds.exe` → Properties → *Digital Signatures* shows the publisher; and on a Windows Server machine
like a county's, starting the install from the downloaded zip shows no SmartScreen "unknown publisher" block.

## 5. Record it

- [../../RELEASE.md](../../RELEASE.md) *Signing the Windows server*: signing is in use from `[VERSION]`, the publisher
  name, the certificate's issuer and expiry month (no secret, serial or key material).
- QUESTIONNAIRE #39 ("Release artefacts are not signed either") and [../../WINDOWS-SERVER.md](../../WINDOWS-SERVER.md)
  (the SmartScreen note) updated to say releases are signed and how to check.
- A Windows run on a county-like machine, with the `Get-AuthenticodeSignature` output, stored in `docs/evidence/`.
- [../BUSINESS-WORKPLAN.md](../BUSINESS-WORKPLAN.md) item 4: done, with the date. A calendar reminder 60 days before
  the certificate's expiry (outside the repository).
