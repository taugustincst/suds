# Native mobile apps — removed

The SUDS Android app and the iOS project were deprecated in 1.9.0 and **removed in 1.9.3**, together with
their workflows, `scripts/android-keystore.sh` and the desktop launchers. The code stays in git history
(any tag up to `v1.9.2`) so the decision is reversible, but nothing builds, ships or documents it. The web
application served by the office SUDS server is the only supported client and the system of record.

- **The policy, why it changed, and the removal roadmap:** [PLATFORM.md](PLATFORM.md).
- **Retiring a phone that still has the app** (final sync, erase, uninstall, administrator revoke/wipe):
  [PLATFORM.md — Retiring an existing phone-app install](PLATFORM.md#retiring-an-existing-phone-app-install).
- **Devices and local mode** — the rules the offline browser copy runs under, what is on a device, lost or
  stolen devices, offboarding and wipes: [PLATFORM.md — Rules for local mode](PLATFORM.md#rules-for-local-mode-the-offline-copy)
  and the sections that follow it.
- **Using SUDS on a phone or tablet** (browser, home screen): [USER_GUIDE.md](USER_GUIDE.md) and the `/app`
  page on any SUDS server.
- **What the browser kernel is built from** (the vendored libraries in `public/local/kernel.js`):
  [WEB_APP.md](WEB_APP.md#what-the-browser-kernel-is-built-from).
