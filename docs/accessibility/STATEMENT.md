# Accessibility statement for SUDS

*SUD Navigator Services Tracker, version 1.10.2 and later. Last reviewed 25 September 2026.*

SUDS is used by county and community programmes to record services, referrals and follow-ups for people in
substance-use-disorder care. Everyone who does that work should be able to use it, including staff who use a
screen reader, magnification, voice control, a keyboard instead of a mouse, high-contrast or dark settings,
or large text on a phone. The same statement is shown inside the application at **Accessibility**
(`accessibility.html`, linked from the sign-in page, the menu footer and the "use SUDS on your phone" page).

## Conformance status

SUDS aims to conform to the **Web Content Accessibility Guidelines (WCAG) 2.1, level AA** — the standard the
U.S. Department of Justice adopted for state and local government web content under Title II of the
Americans with Disabilities Act (28 CFR part 35, subpart H). Per the DOJ Title II rule as extended, public
entities with a population of 50,000 or more must meet it by **April 26, 2027**, and smaller public entities
and special district governments by **April 26, 2028** — confirm the current dates with county counsel or
ada.gov, as DOJ has changed them before.

SUDS is **partially conformant** with WCAG 2.1 AA: most of the application meets every level A and AA
criterion, and the parts that do not yet are listed below with what we are doing about them. The criterion
by criterion results are in the Accessibility Conformance Report, `docs/accessibility/ACR-WCAG21.md`
(ITI VPAT® 2.5, WCAG edition).

## What we have done

* Every page, every client-record section, the Settings sections and the dialogs used for day-to-day work are
  checked automatically on every release with axe-core against all WCAG 2.0/2.1 A and AA rules, for each staff
  role, in light and dark themes, on a desktop and a phone screen, and at 200% text. A release does not ship
  with a finding.
* The main tasks — creating a client, logging a visit, recording a consent and making a referral that relies
  on it, and writing and signing a note — are tested with the keyboard alone.
* Pages have a "Skip to content" link, a title of their own, one main landmark and headings in order. Dialogs
  keep keyboard focus inside them, close with Escape and return focus to where it was.
* Colour is never the only way something is shown: overdue and at-risk values carry a ⚠ symbol and words,
  and links in text are underlined.
* The text can be enlarged to 200% and the application used on a 320-pixel-wide screen without scrolling
  sideways (data tables scroll within their own frame).
* Before the automatic sign-out after inactivity, SUDS warns a minute ahead and offers **Stay signed in**.

## Known limitations

These are the remaining issues we know of. Each is tracked in the conformance report with the criterion it
affects and what we plan to do about it.

1. **The maximum session length** that an administrator sets (1 to 24 hours; 12 by default) ends a session
   without a warning. The inactivity sign-out does warn and can be extended, and anything typed into an open
   form is kept for after you sign in again. (WCAG 2.2.1)
2. **Pictures uploaded without a caption** are described only as "Picture 2 of 5", and **documents people
   upload** — scanned consents, signed forms, county policies — are only as accessible as the file itself.
   Add a caption to each picture, and upload tagged PDFs where you can. (WCAG 1.1.1)
3. **PDFs SUDS produces** — a consent printed for the client to sign, and county forms — are text in reading
   order but are not tagged, so a screen reader gets no headings or field labels in them. The same
   information is on the client's Consents tab and the Forms page. **Spreadsheet exports** for funders and
   supervisors have header rows but have not been assessed on their own. (WCAG 1.3.1)
4. **Date fields** use the browser's own date picker, whose accessibility depends on the browser; a date can
   always be typed instead.
5. **Screen reader testing has not been done yet.** The evidence so far is automated checks (in Chromium),
   scripted keyboard testing and review of the source. Those confirm that controls carry names, roles and
   states and that status messages are written to live regions, but not that NVDA, JAWS, VoiceOver and
   TalkBack present them as intended, so the conformance report lists Name, Role, Value and Status Messages as
   partially supported until that testing is done; it is planned before the next release. Speech-recognition
   (voice control) testing is pending too. (WCAG 4.1.2, 4.1.3)

## Compatibility

SUDS is a web application. It is designed for current versions of Chrome, Edge, Firefox and Safari on
Windows, macOS, iOS, Android and ChromeOS, with the assistive technologies those platforms support. It
relies on HTML, CSS, JavaScript and WAI-ARIA. It does not work with JavaScript turned off.

## Feedback and requests for help

If something in SUDS stops you from doing your work, or you need information from it in another format:

1. **Tell your programme first.** Your SUDS administrator can change settings and accounts straight away. The
   programme contact your county set up is shown at the bottom of the SUDS sign-in page and on the
   Accessibility page inside SUDS.
2. **Report it to the SUDS project** at <https://github.com/taugustincst/suds/issues> with the title
   "Accessibility:" and a description of the page, what you were trying to do, and the browser and assistive
   technology you use. **Do not include any client information.** If you cannot use that site, ask your
   administrator to file it for you.

We aim to acknowledge an accessibility report within **2 business days** and to give a fix or a workaround
within **10 business days**. A barrier that stops someone from doing their job is treated as a release-blocking
defect.

## Formal complaints

Counties and other public entities that use SUDS remain responsible for their own programmes under ADA Title
II and Section 504. If you are not satisfied with the response, contact your county's ADA coordinator, or
file a complaint with the U.S. Department of Justice, Civil Rights Division (<https://civilrights.justice.gov/>).

## How this statement was prepared

The assessment was made by the SUDS project using automated testing (axe-core 4.x with all WCAG 2.0/2.1 A and
AA rules, plus the checks in `scripts/ui/accessibility.mjs`) and scripted keyboard-only testing of the main
tasks, on the office-server build and the SUDS-on-this-device build, with manual review of the source for
what automated tools cannot judge. It has not yet included testing with screen readers or speech recognition;
the conformance report says, criterion by criterion, which of these methods each result rests on. It will be reviewed at every release and
at least once a year.
