# PowerDMS: policy links and staff sign-offs

**Status: built for 1.26.0, not yet released** (on the `feature/powerdms` branch). Office server only.

Many counties keep their policies in **PowerDMS** (NEOGOV), where staff read each policy and sign it, and every new
revision is signed again. SUDS works beside it:

- a policy in SUDS's library (**Policies & contracts**) can be the county's PowerDMS document: a link, with the revision
  staff must sign and the roles asked to sign it;
- **Policy sign-offs** shows each person the policies they must sign, and whether SUDS has a record of them signing the
  current revision;
- a supervisor imports the PowerDMS **signature report** (or a training completion report), exported as Excel or CSV,
  and SUDS records who signed what. Supervisors and administrators see every staff member's status, by policy and by
  person, and can record or remove a sign-off by hand.

## What SUDS does not do

- **It does not connect to PowerDMS.** PowerDMS publishes no API documentation. Its own pages describe an open API in
  beta, sold per use, with the customer responsible for the connection. So the report file is the integration. Once a
  county has API access and its documentation, a connector that fetches the same report can replace the upload; nothing
  else changes.
- **It does not replace PowerDMS.** People read and sign policies in PowerDMS. SUDS only shows the status and links
  each policy, so a worker sees it where they work.
- **It does not gate anything.** An unsigned policy does not stop anyone working in SUDS. It shows as *Needs your
  signature* on Policy sign-offs, and as outstanding in the supervisor's view.

## Setting it up

1. **In SUDS, link each policy** (Policies & contracts → *+ Add*, or *Edit* on an existing one):
   - **PowerDMS link**: the document's own `https://` address on `powerdms.com` (any `*.powerdms.com` host, such as
     `public.powerdms.com`). SUDS refuses any other address. With a link, a file in SUDS is optional.
   - **Revision staff must sign**: the revision as PowerDMS numbers it. When it changes, everyone asked to sign the policy
     owes a signature again.
   - **Who must sign it in PowerDMS**: one box per role (navigator, clinician, supervisor, finance, read-only,
     administrator). Leave them all unticked for a document nobody is asked to sign.
2. **In PowerDMS**, run the signature status report (or the training completion report) for those documents, and export
   it to Excel or CSV.
3. **In SUDS**, open Policy sign-offs → *Import from PowerDMS*, choose the file and check the preview, then choose
   *Record*. Import again after each round of signing. A sign-off SUDS already has is not recorded twice.

## How a report is read

SUDS finds the columns by their headings, ignoring case, spaces and punctuation, and takes the first that matches:

| SUDS needs | Headings it recognises (examples) |
| --- | --- |
| Who | *Email*; *User Name*, *Login*; *Name*, *User*, *Employee Name*; or *First Name* and *Last Name* |
| Which document | *Document ID*, *Doc ID*, *Course ID*; or *Document*, *Document Name*, *Title*, *Course Name* |
| When | *Signed Date*, *Date Signed*, *Signature Date*, *Completed*, *Completion Date*, *Date* |
| Revision (optional) | *Revision*, *Rev*, *Version* |
| Status (optional) | *Status*, *Signature Status*, *Completion Status* |

- **A staff member** is matched by email address, then by SUDS user name, then by name. "Rivera, Maria" and "Maria
  Rivera" read the same, ignoring accents and punctuation. If two active accounts share a name, the row is left out as
  ambiguous.
- **A policy** is matched by the document number in its PowerDMS link (…`/documents/12345`, …`/document/12345` or
  `?documentId=12345`), or else by its exact title.
- **Status:** when the report has a status column, only rows whose status says signed, completed, acknowledged or
  passed are recorded. Anything else (unsigned, pending, assigned, overdue) is left out.
- **Revision:** a sign-off counts as current only for the revision the policy names. A report without a revision column
  records sign-offs with no revision, and those count only for a policy that names none. To track revisions, include
  the column.
- **Dates** may be Excel dates, `YYYY-MM-DD` or `M/D/YYYY`, with or without a time. A row without a date is left out.
- **The preview** shows every row and what SUDS will do with it: record it, already recorded, not signed (by its status),
  no SUDS account matches, more than one account has this name, no policy matches, or no signed date. Nothing is
  recorded until you choose *Record*. A report may be up to 5 MB.

## Data, security and audit

- **No client data.** The report and the sign-offs name staff and policies only.
- **Office server only.** The sign-offs (`policy_acknowledgements`) and the record of each import (`policy_ack_imports`,
  the file's name, SHA-256 and counts, never its rows) never go to a device. A policy's link, revision and roles travel
  with the library to devices, where the link opens PowerDMS.
- **Who may do what.** Everyone sees their own sign-offs. **Manage policy sign-offs** (`policies:manage`, held by
  supervisors and administrators) sees everyone's, imports reports, and records or removes a sign-off by hand. Changing a
  policy's link, revision or roles is *Manage documents* (`documents:write`).
- **Audit.** These are audited: a report previewed or imported (its SHA-256 and the counts), the staff view opened, and
  each sign-off recorded or removed by hand. A policy's changes are audited as document changes, with the new revision.
  No name or email address from a report is written to the audit log
  ([../security/LOGGING-AND-AUDIT.md](../security/LOGGING-AND-AUDIT.md)).
- **Links** open in a new tab without an opener reference (`rel="noopener noreferrer"`). SUDS does not check a link's
  document number against PowerDMS.

## Schema

Migration 72 ([../security/DATA-INVENTORY.md](../security/DATA-INVENTORY.md), *Schema versions*) adds
`policy_documents.powerdms_url`, `revision` and `ack_roles`, and the tables `policy_acknowledgements` and
`policy_ack_imports`.
