# Importing notes from Pocket AI and Microsoft OneNote

Navigators often capture field notes on a phone (Pocket AI voice notes) or in OneNote. SUDS imports those notes through a **staging area**: nothing becomes part of a client record until a staff member reviews it, matches it to a client, chooses *administrative* or *clinical*, and commits it. Staged text is encrypted at rest and can be discarded or purged.

Workflow: **Import Notes → upload / paste / sync → Review → Commit as note → (note is a draft) → Sign.**

Client matching is automatic when the text contains a client code (`C26-0012`) or a phrase like `Client: Doe, Jane`, `with Jane Doe`, `re: Doe, Jane`. Otherwise pick the client from the search box.

## Pocket AI

### Option A — export files
1. In Pocket AI open the note or recording → **Share / Export** → choose **JSON**, **Markdown** or **Text** (JSON preserves the most detail: title, summary, action items, transcript, timestamps, tags).
2. Send the file to your county workstation using an approved channel (not personal email).
3. SUDS → **Import Notes** → Source = *Pocket AI export* → drop the file(s).

The parser accepts: a JSON array or `{notes:[…]}` / `{recordings:[…]}` with any of `title/name`, `transcript/text/content`, `summary`, `notes`, `action_items`, `created_at/date/timestamp`, `tags`, `duration`; or Markdown/text where notes are separated by `---` lines or `#` headings, with an optional `Date:` line.

### Option B — automatic intake (API key)
1. Administration → **API keys** → *New API key*. Copy the key.
2. Configure Pocket AI (or an iOS Shortcut / Android automation / Zapier-style tool) to **POST the note JSON** to:

```
POST https://<your-suds-host>/api/intake/notes
Authorization: Bearer suds_xxxxxxxx
Content-Type: application/json

{ "title": "Field visit with Doe, Jane", "transcript": "...", "summary": "...", "created_at": "2026-09-10T15:04:00Z" }
```

The response is `202 {"import_id": "...", "staged": 1}`. The note appears under Import Notes for review. Keys are write-only (they cannot read anything), rate-limited, and revocable.

`GET /api/intake/ping` with the same header verifies a key.

> **Privacy note:** Pocket AI processes audio and text on its servers. Only use it for PHI if your organization has a Business Associate Agreement with the vendor and the device is encrypted and managed. Prefer recording notes without full names (use client codes) where practical.

## Microsoft OneNote

### Option A — export files
* **OneNote for Windows (desktop):** File → **Export** → choose *Page* or *Section* → format **Single File Web Page (*.mht)** (best) or **Word Document (*.docx)**.
* **OneNote for Mac:** File → Export as PDF is *not* supported; instead copy the page text and use *Paste text* in SUDS, or use Option B.
* SUDS → Import Notes → Source = *OneNote export* → drop the `.mht` / `.docx` / `.html` / `.txt` files. Each OneNote page becomes one staged note; the page title and creation date are detected.

### Option B — direct sync via Microsoft Graph
An administrator registers an app in Microsoft Entra ID (Azure AD):

1. Entra ID → App registrations → **New registration** (single tenant).
2. API permissions → Microsoft Graph → **Application permissions** → `Notes.Read.All` → *Grant admin consent*.
3. Certificates & secrets → new client secret.
4. Set in `.env`:
   ```
   MS_TENANT_ID=<tenant guid>
   MS_CLIENT_ID=<application (client) id>
   MS_CLIENT_SECRET=<secret value>
   MS_ONENOTE_USER=navigator@county.gov     # the account whose notebooks are imported
   ```
5. Restart SUDS. Import Notes → *OneNote (Microsoft Graph)* → **Browse notebooks** → open a section → select pages → **Import selected**.

Pages are fetched as HTML, converted to text, and staged like file imports. Only pages you select are transferred; SUDS never writes to OneNote. If you prefer delegated (per-user) access, the endpoints also accept a user-supplied Graph access token in the `X-MS-Access-Token` header.

> Ensure your Microsoft 365 tenant is covered by Microsoft's HIPAA BAA (included in the Online Services Terms for Government / Enterprise plans) before storing PHI in OneNote.

## Review screen

For each staged note you can:
* confirm or change the **client** (search by last name, phone, DOB or code);
* choose **Administrative / contact** or **Clinical** (clinical requires a clinical role);
* set the **format** (contact, narrative, SOAP…), **title**, **date of service** (pre-filled from the note's timestamp);
* edit the text before committing;
* optionally **log an intervention** at the same time (type + minutes), which also appears on the client timeline;
* **Discard** notes that are not client-related.

Committed notes are created as **drafts** with source `pocket_ai` or `onenote` and a reference to the original item; sign them from the Notes page. Purging a batch deletes any uncommitted staged text.

## Generic text
Any text/markdown can be imported with Source = *Other*. Use `---` between notes.
