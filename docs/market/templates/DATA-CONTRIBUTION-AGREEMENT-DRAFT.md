# Data contribution agreement: a CBO's aggregate figures for the county view (Tier 1)

> **DRAFT — for the county's and each CBO's counsel, not legal advice.** An outline of the terms under which a
> community-based organisation ("the Programme") sends a county ("the County") the aggregate figures of the
> county view ([../../COUNTY-VIEW.md](../../COUNTY-VIEW.md); Tier 1 of [../DATA-NETWORK.md](../DATA-NETWORK.md)).
> It has not been reviewed by counsel. Adapt it to the funding contract, which may already provide for some or all
> of it; where the two conflict, counsel decides which governs. Bracketed text is for the parties to complete.
> It is not an agreement for pooled benchmarks (Tier 2) or a research dataset (Tier 3), which need more
> ([../DATA-NETWORK.md](../DATA-NETWORK.md), *Design, in three tiers*).

**Parties:** `[County department]` ("the County") and `[CBO legal name]` ("the Programme").
**Funding contract(s):** `[contract numbers and the settlement funds they pay for]`.

## 1. Purpose

1.1 The Programme sends the County aggregate figures of its opioid settlement spending and the outcomes of the
work that spending paid for, so the County can oversee the funding it provides and combine its grantees' figures
for its own internal use.

1.2 The County uses the figures only for `[contract monitoring, programme planning, and its own reporting to the
State on its use of settlement funds]`, and for no other purpose without the Programme's written agreement.

## 2. What is sent

2.1 **Aggregate figures only.** For each period, a county submission file made by the Programme's SUDS server:
the Programme's name, the County's code and name, the period, when the file was made, and, for the settlement
funds the Programme chooses as paid for by the County: each fund's name, grant or agreement number, Exhibit E
allowable use and California High Impact Abatement Activity, its spending, its outcome counts and (from SUDS 1.21,
released in 1.21.0) its award or contract amount and award period as the Programme's fund record
holds them; the same by allowable use and in total. The fields are those listed in [../../COUNTY-VIEW.md](../../COUNTY-VIEW.md), *What the
file holds*.

2.2 **Never sent:** any client record, name, client code, participant code, date of birth, date of service,
address, note, referral, consent or single event; the figures of any fund the County does not pay for.

2.3 **Exact counts.** The figures are exact, small numbers included, as the Programme reports them under the
funding contract. They are **not for publication** (section 4).

2.4 **Counts of people** are the Programme's own counts. The County acknowledges that combining them with other
programmes' counts adds them up (a person served by two programmes is counted twice), and will not describe a
combined count as unduplicated.

2.5 **Cadence and transport.** `[Quarterly, within ___ days of the end of each calendar / fiscal quarter]`, by
`[email to ___ / the County's file drop at ___ / the SUDS county connection, if both parties switch it on]`.

## 3. No re-identification

3.1 The County will not attempt to identify, or to learn anything about, any individual from the figures, alone or
combined with any other information, including other programmes' figures or releases, and will not link the
figures with individual-level data about the Programme's participants.

3.2 The County will not ask the Programme for figures at a finer level (by day, by location, by demographic cell)
under this agreement. `[Any such request is a separate agreement reviewed by counsel.]`

3.3 If the County learns that anyone has identified or tried to identify an individual from the figures, it will
tell the Programme within `[5]` business days and cooperate to limit the harm.

## 4. Use, access and publication

4.1 **Access.** Only County staff with a need to know for the purpose in section 1, by role: `[the County's county
view administrator(s) and analysts, named in Schedule A]`. The County keeps its SUDS server's permissions to that
list (`county:view`, `county:manage`).

4.2 **Publication only with the Programme's written consent, and only screened.** The County will not publish, or
share outside the staff in 4.1, any figure received under this agreement, alone or combined, except in a
publication release made as follows:

- (a) **Consent.** The Programme has agreed in writing to the County publishing combined figures that name it
  `[by signing this agreement with the box below ticked / by a separate letter]`, and the County has recorded that
  agreement in SUDS (County view › Programs › Publication consent: the date of the agreement, its reference, and
  who recorded it). The Programme may withdraw its consent in writing at any time; the County then records the
  withdrawal the same day, and releases made after it do not name the Programme or count its figures. A release
  already published before the withdrawal stands.
- (b) **The method.** Only through SUDS's publication screen (County view › Publish; released in 1.21.0, the
  consent record released in 1.22.0): the combined figures of a whole period that has ended, money and counts that are
  not of people exact, and the totals of people and of events screened by SUDS's small-cell method, audited over the
  combined release and every programme's own release it could be compared against
  ([../DATA-NETWORK.md](../DATA-NETWORK.md), *The basis*), with a threshold of at least `[11]`. Never a programme's
  own column of figures.
- (c) **SUDS enforces (a).** A release that would name a programme with no current consent recorded is refused,
  naming the programmes; the County's preparer may instead leave those programmes out of the release whole (their
  figures too), and the release then states which programmes were left out for lack of consent.
- (d) **Corrections.** A release is recorded and never changed. If it was wrong, the County withdraws it (with a
  reason) and may publish a corrected release of exactly the same period, which SUDS screens against everything the
  withdrawn release printed. No other release may overlap a period already published.

`[ ] The Programme consents to publication under 4.2 from the date of this agreement.`

Apart from such a release, the SUDS county view and its files are labelled internal and exact, and are not for
publication.

4.3 **Onward disclosure.** None, except as the law requires. If a public-records request or legal process seeks
the figures, the County will tell the Programme `[promptly, before release where the law allows]` so it can seek
protection, and will assert any exemption that applies. `[Counsel: the California Public Records Act and the
exemptions available for these figures.]`

## 5. Retention and deletion

5.1 The County keeps the figures for `[___ years after the end of the funding contract / as the County's records
retention schedule requires for grant monitoring records]`, then deletes them from its SUDS server and any copy
it made (exports, spreadsheets), and confirms the deletion in writing on request.

5.2 A file the Programme asks the County to withdraw (a file sent in error, or replaced by a correction) is
withdrawn in the County's SUDS server so it stops counting; SUDS keeps it, marked withdrawn, for the audit trail.
`[Counsel: whether a withdrawn file must also be deleted, and when.]`

## 6. Security

6.1 The County keeps the figures on its own SUDS server (or a successor system of equivalent protection),
encrypted at rest, reachable only over TLS, with two-step verification for every account, audit logging of every
view and export, encrypted backups and a tested restore ([../../security/](../../security/README.md)).

6.2 The County protects any export (Excel, CSV) as it protects the server, keeps it within the staff in 4.1, and
deletes it when no longer needed.

6.3 Each party tells the other within `[3]` business days of discovering unauthorised access to, or disclosure
of, the figures or the keys in section 7.

## 7. Key exchange and a lost key

7.1 At the start, the Programme gives the County the public key its SUDS server signs county files with, and reads
its fingerprint to a named County person, who confirms it matches before registering it. The County gives the
Programme its county code. Neither is a secret.

7.2 The County accepts only files signed by the Programme's currently registered key and made for the County's
code; SUDS refuses the rest.

7.3 **A lost or exposed key.** The Programme tells the County within `[2]` business days of learning that its
signing key (or the server holding it) may have been exposed, makes a new key, and reads the new fingerprint to
the County. The County replaces the key and, where the Programme asks or the County cannot rule out misuse, marks
the old key compromised, so files it signed stop counting until the Programme confirms or re-sends them.

7.4 **The county connection (optional).** If both parties switch it on, the County issues the Programme a
connection token; the Programme keeps it secret, and either party may revoke it at any time. The connection
carries only the file in section 2 and the County's receipt and status.

## 8. Figures entered by the County

8.1 `[Applies from SUDS 1.20.0; delete this section if not used.]` Only while
the Programme is registered with the County as **not on SUDS** (it does not run SUDS and has no signing key
registered) may the County enter the Programme's figures itself, from a document the Programme sent (a report, an
invoice backup, a spreadsheet), recording which document. SUDS marks them everywhere as **entered by the county — not
signed by the program**, counts them separately, and can leave them out of any view. Once the Programme runs SUDS
and its key is registered, the County enters no more of its figures: those already entered may be withdrawn or
reinstated but not changed, and a file the Programme signs for a period always counts over them.

8.2 The County enters only the fields in section 2.1, from the Programme's own document, and corrects or withdraws
an entry when the Programme shows it is wrong. Sections 3 to 6 apply to entered figures as to signed ones.

8.3 The County does not present entered figures as figures the Programme signed or verified.

## 9. Term and termination

9.1 This agreement runs from `[date]` for the term of the funding contract `[and any renewal]`.

9.2 Either party may end it on `[30]` days' written notice. Ending it stops new files; figures already received
remain under sections 3 to 6 until deleted under section 5, `[unless the Programme asks for earlier deletion and
the County's records obligations allow it]`.

9.3 On termination the County deactivates the Programme in its SUDS server (its new files are then refused) and
revokes any connection token.

## 10. Contacts

| | County | Programme |
| --- | --- | --- |
| Agreement owner | `[name, role]` | `[name, role]` |
| Key exchange and file questions | `[county view administrator]` | `[finance lead]` |
| Security and privacy notices | `[privacy officer]` | `[privacy officer]` |

**Schedule A.** County staff with access (section 4.1): `[names and roles, or roles only]`.

**For counsel.** Before signing, confirm at least: whether the funding contract already covers this; whether the
County's receipt of exact aggregates needs a basis beyond the contract (42 CFR Part 2, HIPAA, CMIA, Health and
Safety Code §11845.5: [../DATA-NETWORK.md](../DATA-NETWORK.md), *What counsel must review*, items 1, 4, 5 and 6);
the public-records position in 4.3; and the retention period in 5.1.
