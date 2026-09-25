# SUDS Accessibility Conformance Report — WCAG Edition

**(Based on VPAT® Version 2.5)**

## Name of Product/Version

SUDS — SUD Navigator Services Tracker, version 1.10.2 with the accessibility changes that accompany this
report (the next release), including the clinical documentation (problem list, care plan, ASAM and outcome
measures), CalOMS Tx state reporting, the FHIR interface settings, the security evidence pages and the
42 CFR Part 2 controls that release adds. Both ways SUDS is run are covered: the **office server** (the web application an
administrator installs for a programme) and **SUDS on this device** (the same web application published as a
static site, keeping its records in the browser).

## Report Date

25 September 2026

## Product Description

SUDS is a web application used by county and community substance-use-disorder (SUD) programmes to record
services, calls, notes, referrals, consents, tasks, funding and reports for the people they serve. Staff use it
in a browser on a desktop computer, tablet or phone; there is no native application. The user interface is
HTML, CSS and JavaScript (ES modules) with WAI-ARIA, and it is the only client of the SUDS server.

## Contact Information

SUDS project — accessibility reports: <https://github.com/taugustincst/suds/issues> (title the issue
"Accessibility:"; never include client information). Programmes: your SUDS administrator, and the programme
contact shown on the SUDS sign-in page. The public accessibility statement is `docs/accessibility/STATEMENT.md`,
shown in the application as **Accessibility** (`accessibility.html`).

## Notes

* **Scope.** Every page in the application's navigation (Home, My clients, Waitlist, To-do list, Supervision,
  Visits & services, Calls & texts, Forms, Notes, My time, Import, Overdose & reversals, Supplies, Referrals,
  Resource directory, Funding & spending, Policies & contracts, Reports, Privacy & Part 2 and each of its
  sections — overview, patient notice with its editor open, notice not given, complaints, incidents & breaches —
  Funder report, Settings), State reporting (CalOMS Tx and the county EHR hand-off), the profile, every section
  of a client record (Overview with its clinical summary, Timeline, Interventions, Calls, Notes, Problems, Care
  plan, Assessments, Referrals, Forms, Tasks, Episodes, Consents & ROI with the Part 2 notice and court orders,
  Requests, Time, Assistance $, Care team), a resource profile, every Settings section (including Lists with a
  list open, FHIR clients, System & backups with the recovery-drill card, Security status, and Users & roles
  with an access request waiting), the sign-in, sign-up, first-run, two-step-verification and "use SUDS on your
  phone" pages, the accessibility statement, and the dialogs used for daily work (+ Log and everything it
  records, new client, referral, consent with every §2.31 element, disclosure and the §2.32 notice shown after
  it, patient notice given, court order and vacating one, request, care-team assignment, client assistance, a
  problem and its history, a care-plan goal, step and review, an ASAM assessment (new and opened), each outcome
  measure (PHQ-9, GAD-7, AUDIT-C, DAST-10) new and opened, starting and discharging an episode with the CalOMS
  questions, an episode's CalOMS records and an annual update, the CalOMS extract confirmation, the identified
  export, a privacy complaint and an incident (new and opened), a FHIR client, approving an access request,
  resource, overdose event, expenditure, funding source and budget line, county form design and filling,
  document upload, supply item, new user, API key, a note and its electronic signature). The seed data has no
  clinical, CalOMS or Part 2 records, so the audit creates them first and every one of these views is tested
  with rows in it, not only empty.
* **Roles.** The audit signs in as each of the six roles (administrator, supervisor, clinician, navigator,
  finance, read-only oversight) on the office server in the light desktop configuration, and as the
  administrator, a supervisor and a navigator (who between them reach every page and dialog, the clinical
  assessments included) in the other four, and as a new account created through Sign up on SUDS on
  this device, because each role sees different pages and controls.
* **Content the programme supplies** — uploaded PDF and Word documents, scanned consents and signed forms,
  resource photos, and free text staff type — is outside what the software can make accessible. SUDS provides
  the means (captions for pictures, text fields for descriptions); remarks below say where this matters.
* **WCAG 2.2.** This report is for WCAG 2.1. SUDS sizes its shared controls to at least 44 × 44 CSS px on
  touch screens (`pointer: coarse`), but the criteria new in WCAG 2.2 have not been evaluated.

## Evaluation Methods Used

* **Automated testing** with axe-core 4.13 (Deque) in Chromium through Playwright 1.56, running every rule
  tagged `wcag2a`, `wcag2aa`, `wcag21a` or `wcag21aa`, plus the axe structural rules behind 1.3.1, 2.4.1 and
  2.4.6 (`landmark-one-main`, `landmark-no-duplicate-main`, `landmark-unique`, `page-has-heading-one`,
  `heading-order`, `empty-heading`, `empty-table-header`, `aria-dialog-name`). Every page and dialog in the
  scope above is tested in five configurations: desktop 1280 CSS px light theme (all six roles), phone 390 CSS
  px light and dark, desktop dark, and desktop with the text size doubled (200%) — on both builds.
  Script: `scripts/ui/accessibility.mjs`; it fails on any finding, and it is part of the browser suite that
  runs in continuous integration on every change (several thousand checks).
* **Scripted checks for what axe cannot judge**, in the same script and on the same pages: a descriptive title
  per page that never names a client (2.4.2); no sideways scrolling or clipped content at 320 CSS px and at 200%
  text (1.4.10, 1.4.4); no clipped text with the WCAG 1.4.12 text-spacing overrides; Tab through each page with
  a visible focus indicator at every stop and no focus stop that cannot be seen (2.4.7, 2.4.3).
* **Keyboard-only task testing** (Playwright keyboard only — no clicks or form filling): the skip link; focus
  placement after moving between pages; a dialog that keeps focus inside it through 70 Tab presses, closes with
  Escape and returns focus to its opener; a form error that is announced, identified by name, tied to its field
  and focused; creating a client; logging a visit from + Log (choosing the client from the search with the
  arrow keys); recording a Part 2 consent and making a referral that relies on it; writing a note and signing
  it with the password prompt; and extending the idle sign-out warning.
* **Manual review** of the source and the rendered pages for criteria that need judgement (text alternatives,
  sensory characteristics, consistent navigation and identification, error suggestion and prevention, input
  purpose, content on hover or focus, non-text contrast of form fields and focus rings, which were measured
  from the colour tokens in both themes).
* Not yet done: testing with screen readers (NVDA, JAWS, VoiceOver, TalkBack) and with speech recognition by
  their users. That is planned before the next release; findings will be added to this report.

## Applicable Standards/Guidelines

| Standard/Guideline | Included In Report |
| --- | --- |
| [Web Content Accessibility Guidelines 2.0](https://www.w3.org/TR/2008/REC-WCAG20-20081211/) | Level A (Yes) · Level AA (Yes) · Level AAA (No) — covered by the WCAG 2.1 tables, which include every 2.0 criterion |
| [Web Content Accessibility Guidelines 2.1](https://www.w3.org/TR/WCAG21/) | Level A (Yes) · Level AA (Yes) · Level AAA (No) |
| [Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) | No |

## Terms

* **Supports**: The functionality of the product has at least one method that meets the criterion without
  known defects or meets with equivalent facilitation.
* **Partially Supports**: Some functionality of the product does not meet the criterion.
* **Does Not Support**: The majority of product functionality does not meet the criterion.
* **Not Applicable**: The criterion is not relevant to the product.
* **Not Evaluated**: The product has not been evaluated against the criterion (used only for WCAG 2.x Level AAA).

## WCAG 2.x Report

### Table 1: Success Criteria, Level A

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| [1.1.1 Non-text Content](https://www.w3.org/TR/WCAG21/#non-text-content) (Level A) | Partially Supports | Icons that carry meaning have text (icon buttons have spoken names: "Close", "Choose the date from a calendar", "What is this?", "Menu", "Reminders due"); decorative icons and logos are hidden (`alt=""`, `aria-hidden`). The Home trend chart and the outcome-measure trends have a text alternative listing their values; bar charts print each value as text. Every resource photo has alternative text, but a photo uploaded **without a caption** is described only as "Picture 2 of 5" (or the resource's name): SUDS cannot describe a picture nobody has captioned. Uploaded documents (PDFs, scans) are only as accessible as the file. |
| [1.2.1 Audio-only and Video-only (Prerecorded)](https://www.w3.org/TR/WCAG21/#audio-only-and-video-only-prerecorded) (Level A) | Not Applicable | SUDS has no audio or video content. |
| [1.2.2 Captions (Prerecorded)](https://www.w3.org/TR/WCAG21/#captions-prerecorded) (Level A) | Not Applicable | No synchronized media. |
| [1.2.3 Audio Description or Media Alternative (Prerecorded)](https://www.w3.org/TR/WCAG21/#audio-description-or-media-alternative-prerecorded) (Level A) | Not Applicable | No synchronized media. |
| [1.3.1 Info and Relationships](https://www.w3.org/TR/WCAG21/#info-and-relationships) (Level A) | Partially Supports | Pages have one `main` landmark, a navigation landmark, one `h1` and headings that step down one level at a time; every form control has a programmatic label (tied by `for`, including the filter bars, through a shared pass in `app.js`), required fields are marked `aria-required`, help and error text is tied with `aria-describedby`; data tables have column headers with `scope`, including a hidden "Actions" header over button columns; client-header flags are a list; section navigation is a labelled `nav` with `aria-current`. A list row that opens a record keeps its table semantics: the keyboard control is a button made of the row's first cell (a name or a date), so the other cells are still read with their column headings. Print windows (care plan, patient notice, accounting of disclosures) are HTML with headings, table headers and a language. **Remaining:** the PDFs SUDS itself generates — a consent to print for the client's signature, and completed or blank county forms — are real text in reading order but are **not tagged** (no structure tree, headings or document language). The consent's details are on its client's Consents tab and every form's answers on its Forms page, both of which conform. |
| [1.3.2 Meaningful Sequence](https://www.w3.org/TR/WCAG21/#meaningful-sequence) (Level A) | Supports | DOM order is reading order; layout is CSS grid/flex without reordering. While a dialog is open the page behind it is `inert`, so the reading order is the dialog's. |
| [1.3.3 Sensory Characteristics](https://www.w3.org/TR/WCAG21/#sensory-characteristics) (Level A) | Supports | Instructions name controls by their text ("+ Log", "Sign & lock"); the welcome tour's mention of where + Log sits is accompanied by its name. |
| [1.4.1 Use of Color](https://www.w3.org/TR/WCAG21/#use-of-color) (Level A) | Supports | Links in text are underlined. Overdue, at-risk and over-budget values carry ⚠ and a reason (visible, and read out), or words such as "— overdue", "— needs verification", "— ahead of the period" — including ASAM dimension ratings of 3 or more ("high risk"), overdue care-plan steps and reviews, expired consents, a client with no Part 2 notice, and an outcome score's change, which says "better" or "worse"; red and amber summary figures carry ⚠; status badges contain words; the timeline's coloured dots repeat what each entry's title says. |
| [1.4.2 Audio Control](https://www.w3.org/TR/WCAG21/#audio-control) (Level A) | Not Applicable | SUDS plays no audio. |
| [2.1.1 Keyboard](https://www.w3.org/TR/WCAG21/#keyboard) (Level A) | Supports | All functionality is operable by keyboard: buttons and links are native; clickable list rows take Tab, Enter and Space; the client search is a combobox (arrow keys, Enter, Escape); the section "More" menu uses arrow keys; file drop zones open the file picker with Enter/Space; a picture opens its viewer from a button; tables that scroll get keyboard focus. Verified by the keyboard-only task scripts listed above. A list row opens from the button in its first cell. Phone rows that contain their own control (a to-do's done box on a phone) have a separate "Open" button. |
| [2.1.2 No Keyboard Trap](https://www.w3.org/TR/WCAG21/#no-keyboard-trap) (Level A) | Supports | Dialogs keep Tab inside them by design and always close with Escape (and the Back button), returning focus to the control that opened them; the phone menu closes with Escape. Tested with 70 Tab presses inside a dialog. |
| [2.1.4 Character Key Shortcuts](https://www.w3.org/TR/WCAG21/#character-key-shortcuts) (Level A 2.1 only) | Not Applicable | SUDS has no single-character keyboard shortcuts. |
| [2.2.1 Timing Adjustable](https://www.w3.org/TR/WCAG21/#timing-adjustable) (Level A) | Partially Supports | The inactivity sign-out (1–60 minutes, set by the administrator; default 15) warns one minute ahead in an announced alert with a **Stay signed in** button, and any key press, tap or mouse movement also extends it; what was typed into an open form is kept and restored after signing in again. **Remaining:** the maximum session length (an administrator setting, 1–24 hours, default 12) ends the session at that time without a warning or a way to extend it, as a security control; typed form contents are kept, but the person must sign in again. |
| [2.2.2 Pause, Stop, Hide](https://www.w3.org/TR/WCAG21/#pause-stop-hide) (Level A) | Supports | Nothing moves, blinks or scrolls. Home refreshes its figures every 90 seconds; a checkbox on Home ("Update this page every 90 seconds") turns that off, and the refresh never runs while focus is on a control in the page or a dialog is open. The reminders count in the header updates every five minutes and does not move or take focus. |
| [2.3.1 Three Flashes or Below Threshold](https://www.w3.org/TR/WCAG21/#three-flashes-or-below-threshold) (Level A) | Supports | No flashing content. |
| [2.4.1 Bypass Blocks](https://www.w3.org/TR/WCAG21/#bypass-blocks) (Level A) | Supports | "Skip to content" is the first focusable element on every screen (ahead of any banner) and moves focus to the `main` landmark; landmarks and headings are present on every page. |
| [2.4.2 Page Titled](https://www.w3.org/TR/WCAG21/#page-titled) (Level A) | Supports | Each address sets its own title, e.g. "To-do list — SUDS", "Notes · Client record — SUDS", "Log in — SUDS". Titles never include a client's name (it would be kept in browser history). |
| [2.4.3 Focus Order](https://www.w3.org/TR/WCAG21/#focus-order) (Level A) | Supports | Focus order follows the DOM; no positive `tabindex`. Opening a dialog moves focus into it; closing returns it. Moving to another page puts focus on the new page's heading; redrawing the same page (a filter changed, a record saved, Home's refresh) returns focus to the same control. Invisible or duplicate focus stops (hidden file inputs) were removed. |
| [2.4.4 Link Purpose (In Context)](https://www.w3.org/TR/WCAG21/#link-purpose-in-context) (Level A) | Supports | Link text names its destination or is determined by its row or card (a client code in a client row, "Edit this list" beside the list's field). |
| [2.5.1 Pointer Gestures](https://www.w3.org/TR/WCAG21/#pointer-gestures) (Level A 2.1 only) | Supports | No path-based or multipoint gestures. Drag-and-drop (files, pictures) always has a button alternative; list order is changed with ↑/↓ buttons. |
| [2.5.2 Pointer Cancellation](https://www.w3.org/TR/WCAG21/#pointer-cancellation) (Level A 2.1 only) | Supports | Actions run on the click (up) event of native controls; no down-event activation. |
| [2.5.3 Label in Name](https://www.w3.org/TR/WCAG21/#label-in-name) (Level A 2.1 only) | Supports | Controls with visible text are named by that text (the row `aria-label`s that replaced it, the "More tabs" and drop-zone labels were removed). Icon-only controls have names that describe them ("Close", "Choose the date from a calendar"). |
| [2.5.4 Motion Actuation](https://www.w3.org/TR/WCAG21/#motion-actuation) (Level A 2.1 only) | Not Applicable | No device-motion input. |
| [3.1.1 Language of Page](https://www.w3.org/TR/WCAG21/#language-of-page) (Level A) | Supports | `lang="en"` on every page. |
| [3.2.1 On Focus](https://www.w3.org/TR/WCAG21/#on-focus) (Level A) | Supports | Focus never changes context. Focusing the client search shows its list of matches below it (content, not context) and Escape closes it. |
| [3.2.2 On Input](https://www.w3.org/TR/WCAG21/#on-input) (Level A) | Supports | Changing a filter redraws the list on the same page (a change of content) and returns focus to the filter; no input submits a form or opens a new window by itself. |
| [3.3.1 Error Identification](https://www.w3.org/TR/WCAG21/#error-identification) (Level A) | Supports | A form with a problem shows a summary in an alert ("Fill in First name and Last name below."), writes the message under each field naming it ("First name is required"), sets `aria-invalid`, ties the message with `aria-describedby`, announces it, and moves focus to the first field in error. Server-side errors are shown the same way. |
| [3.3.2 Labels or Instructions](https://www.w3.org/TR/WCAG21/#labels-or-instructions) (Level A) | Supports | Every field has a visible label; required fields are marked `*`; format help sits under the field (passwords, dates, client search). |
| [4.1.1 Parsing](https://www.w3.org/TR/WCAG21/#parsing) (Level A) | Supports | The DOM is built programmatically (no hand-written markup errors) and axe finds no duplicate IDs or invalid nesting. (Per the WCAG 2.1 errata, 4.1.1 is always satisfied for HTML.) |
| [4.1.2 Name, Role, Value](https://www.w3.org/TR/WCAG21/#name-role-value) (Level A) | Supports | Native controls are used throughout; custom widgets expose their role and state: the client search (`combobox`/`listbox`/`option`, `aria-expanded`, `aria-activedescendant`), the Log in / Sign up tabs (`tablist`/`tab`/`tabpanel`, `aria-selected`), section navigation (`aria-current="page"`), the "More" and help buttons (`aria-expanded`, `aria-controls`), dialogs (`role="dialog"`, `aria-modal`, named by their title), status messages. No interactive control is nested inside another. |

### Table 2: Success Criteria, Level AA

| Criteria | Conformance Level | Remarks and Explanations |
| --- | --- | --- |
| [1.2.4 Captions (Live)](https://www.w3.org/TR/WCAG21/#captions-live) (Level AA) | Not Applicable | No live media. |
| [1.2.5 Audio Description (Prerecorded)](https://www.w3.org/TR/WCAG21/#audio-description-prerecorded) (Level AA) | Not Applicable | No synchronized media. |
| [1.3.4 Orientation](https://www.w3.org/TR/WCAG21/#orientation) (Level AA 2.1 only) | Supports | Works in portrait and landscape; the web app manifest sets `"orientation": "any"`. |
| [1.3.5 Identify Input Purpose](https://www.w3.org/TR/WCAG21/#identify-input-purpose) (Level AA 2.1 only) | Supports | Fields about the person using SUDS carry `autocomplete` (`username`, `current-password`, `new-password`, `name`, `email`, `one-time-code`). Fields about clients describe someone else and are deliberately `autocomplete="off"`. |
| [1.4.3 Contrast (Minimum)](https://www.w3.org/TR/WCAG21/#contrast-minimum) (Level AA) | Supports | Text is at least 4.5:1 (large text 3:1) in the light and the dark theme, tested on every page and dialog. Dark-theme filled buttons and badges use dark text; banners take their colours from theme tokens; links inside banners take the banner's text colour. |
| [1.4.4 Resize text](https://www.w3.org/TR/WCAG21/#resize-text) (Level AA) | Supports | All sizes are in `rem`, the sidebar width included; tested at 200% text on every page with no clipped or overlapping content and no sideways scrolling (data tables scroll within their frame). |
| [1.4.5 Images of Text](https://www.w3.org/TR/WCAG21/#images-of-text) (Level AA) | Supports | No images of text; the logo is decorative. |
| [1.4.10 Reflow](https://www.w3.org/TR/WCAG21/#reflow) (Level AA 2.1 only) | Supports | Tested at 320 CSS px on every page and dialog: card grids fall to one column, tables become one card per record on phones, long words and badges wrap. Wide data tables (reports, budget lines) scroll inside their own focusable frame — two-dimensional content, which 1.4.10 exempts. |
| [1.4.11 Non-text Contrast](https://www.w3.org/TR/WCAG21/#non-text-contrast) (Level AA 2.1 only) | Supports | Text-field and select borders are at least 3:1 against the page and cards (#7d8a99 light, 3.25:1 or more; #66788c dark, 3.42:1 or more); the focus ring is 3:1 or more in both themes; the current section's underline is the primary colour (6.8:1). Chart bars are paired with their values as text. |
| [1.4.12 Text Spacing](https://www.w3.org/TR/WCAG21/#text-spacing) (Level AA 2.1 only) | Supports | Tested with line height 1.5, paragraph spacing 2, letter spacing 0.12 and word spacing 0.16 on every page: nothing is clipped. A resource card's summary is shortened to three lines by design; the full text is on the resource's page, one activation away. |
| [1.4.13 Content on Hover or Focus](https://www.w3.org/TR/WCAG21/#content-on-hover-or-focus) (Level AA 2.1 only) | Supports | The only content shown on focus is the client search's match list, which is in the page flow (covers nothing), stays until focus leaves, and closes with Escape. Help ("?") text opens on activation, not hover, and closes with Escape or the same button. Native `title` tooltips are browser-controlled. |
| [2.4.5 Multiple Ways](https://www.w3.org/TR/WCAG21/#multiple-ways) (Level AA) | Supports | Navigation menu, global client search, links from Home and between related records, and the reminders bell. |
| [2.4.6 Headings and Labels](https://www.w3.org/TR/WCAG21/#headings-and-labels) (Level AA) | Supports | Headings name each page, card and dialog; labels describe each field. |
| [2.4.7 Focus Visible](https://www.w3.org/TR/WCAG21/#focus-visible) (Level AA) | Supports | A 2–3 px focus ring (`--focus`, 3:1 or more in both themes) on every control, including form fields (which previously showed only a faint ring), table rows, scrolling regions and the file button; checked by tabbing through every page. Date fields' internal calendar button uses the browser's own ring. |
| [3.1.2 Language of Parts](https://www.w3.org/TR/WCAG21/#language-of-parts) (Level AA) | Supports | The interface is in English only. Text staff enter in another language is their content. |
| [3.2.3 Consistent Navigation](https://www.w3.org/TR/WCAG21/#consistent-navigation) (Level AA) | Supports | The same sidebar (a menu on phones), search, reminders bell and + Log appear in the same order on every page; items a role may not open are left out, never reordered. |
| [3.2.4 Consistent Identification](https://www.w3.org/TR/WCAG21/#consistent-identification) (Level AA) | Supports | Shared helpers give the same function the same name and look everywhere (+ Log, Close ✕, Edit, the calendar button, Load more). |
| [3.3.3 Error Suggestion](https://www.w3.org/TR/WCAG21/#error-suggestion) (Level AA) | Supports | Messages say how to fix the problem: which field, the valid date range ("the year must be four digits, between 1900 and 2100"), the password rule, the reason length, how to search for a client, what a Part 2 consent must contain; a CalOMS record lists each edit-check problem by field and says whether it is fatal. |
| [3.3.4 Error Prevention (Legal, Financial, Data)](https://www.w3.org/TR/WCAG21/#error-prevention-legal-financial-data) (Level AA) | Supports | Signing a note (a legal attestation) needs the password and states that signed notes cannot be changed; deleting, revoking, erasing a device and restoring a backup ask for confirmation (a typed word for the irreversible ones); records are not truly deleted and every change is in the audit log; a record changed by someone else since it was opened is not overwritten silently. Disclosures are checked before they happen: a Part 2 consent must have every §2.31 element, a disclosure needs its lawful basis (a court order is checked for the findings subpart E requires), an agreed restriction on the record is shown for confirmation, and the CalOMS extract, county EHR hand-off and identified export each state that they identify clients and ask for confirmation. |
| [4.1.3 Status Messages](https://www.w3.org/TR/WCAG21/#status-messages) (Level AA 2.1 only) | Supports | Saved/done messages are in a polite live region (`role="status"`), errors in `role="alert"`; search results ("3 matching clients"), autosave state, a screening's running score while it is filled in, and the idle warning are announced without moving focus. |

### Table 3: Success Criteria, Level AAA

Not evaluated.

## Remediation plan for the partially supported criteria

| Criterion | Remaining issue | Plan |
| --- | --- | --- |
| 1.3.1 | PDFs SUDS generates (a consent to print for signature, county forms) are untagged. | Write a structure tree (headings, paragraphs, form-field labels), the document language and title into the PDFs `server/pdf.js` produces, and check them with PAC or veraPDF (PDF/UA). Until then the same information is on screen in conforming pages. |
| 1.1.1 | Photos uploaded without a caption get a generic description. | Ask for a short description when a picture is added (required for new uploads), and list captionless pictures on the resource page for editing. |
| 2.2.1 | The maximum session length ends a session without warning or extension. | Warn five minutes before the maximum session length and offer to sign in again in place without losing the page, or document the security exception with the county. |

## Legal Disclaimer (SUDS project)

This report describes the accessibility of SUDS as tested on the date above, by the methods listed. It is
provided for information and does not create warranties. Accessibility can change with each release; the
automated audit runs on every release and this report is updated when the result changes.
