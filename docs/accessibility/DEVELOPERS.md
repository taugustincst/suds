# Accessibility rules for SUDS views

SUDS is held to **WCAG 2.1 level AA** (the ADA Title II rule for state and local government web content;
`docs/accessibility/ACR-WCAG21.md` is the conformance report a county asks for). `scripts/ui/accessibility.mjs`
checks every page and key dialog with axe-core and with checks of its own, and fails on any finding. These are
the rules a view has to follow to pass it. Most of them are already done for you by the shared helpers in
`public/app.js` — use the helpers and a new view inherits the fixes.

## Run the audit

```sh
npm i --no-save playwright axe-core && npx playwright install chromium   # test-only; never in package.json
scripts/ui/run-all.sh                     # the suite starts the servers the audit needs
# while iterating on one page (servers already running, see run-all.sh for the environment):
A11Y_SCOPE=quick SUDS_URL=http://127.0.0.1:8090 SUDS_STATIC_URL=http://127.0.0.1:8878 node scripts/ui/accessibility.mjs
```

Install `playwright` and `axe-core` in **one** `npm i --no-save` command: a second `--no-save` install prunes
the package the first one added. The audit visits every page listed in `NAV` (so a new navigation entry is
audited automatically, for every role that can open it), the client tabs, the Settings tabs and the dialogs
listed in the script — `DIALOGS` (opened through the function the button calls) and `BUTTON_DIALOGS` (a
page and the text of the button that opens it). **Add a new dialog to one of those lists.** `A11Y_REPORT=out.json` writes the findings as
JSON; the console report lists every finding by page, rule and element, then a summary by rule.

## The rules

1. **Build with the helpers.** `form()` for forms, `table()` for lists, `modal()`/`confirmDialog()` for
   dialogs, `pageHead()` for the page heading, `pageTabs()`/`tabStrip()` for section navigation, `stat()`,
   `bars()`, `sparkline()`, `flag()`, `badge()`, `emptyState()`, `toast()`/`announce()`. Each one carries
   the ARIA and keyboard behaviour below; hand-built equivalents usually miss some of it.
2. **Headings go down one level at a time.** One `h1` per page (from `pageHead()`; the sign-in and first-run
   screens have their own). A card's title is an `h2` (styled as a card title by `.card h2`), a group inside a
   card an `h3` (`class: 'eyebrow'` for the small uppercase look that `h4` used to give). A dialog's title is the
   `h2` that `modal()` makes; headings inside a dialog are `h2`/`h3`.
3. **Every control has a visible label that is its name.** Use `form()` (label, `for`, help and error tied with
   `aria-describedby`, `aria-required`, `aria-invalid`). In a filter bar, `h('div', { class: 'field' },
   h('label', {}, 'Status'), select)` is enough: app.js ties a `for`-less label to the control after it. Do not
   put an `aria-label` on something that shows text unless the label *starts with* that text (WCAG 2.5.3 —
   speech-input users say what they see). Icon-only buttons (✕, 📅, ?) need an `aria-label`.
4. **Never colour alone.** A red or amber value uses `flag(content, on, why)` (⚠ plus the reason, visibly and
   for a screen reader) or says it in words (" — overdue"). `stat()` adds ⚠ to a `danger`/`warn` figure. Badges
   must contain words. Charts carry their numbers as text (`bars()` prints each value; `sparkline(values,
   { label })` has a text alternative).
5. **Links in text are underlined** (styles.css does it for every `a`); do not turn it off for an inline link.
   Buttons, cards, navigation and list rows keep their own look.
6. **Keep the focus ring.** Never `outline: none` without a replacement; use `var(--focus)` (3:1 in both
   themes). Tab order follows the DOM: do not use a positive `tabindex`.
7. **Colours come from the tokens** in `:root` and the two dark-theme blocks. Text on `--panel`/`--bg` with
   `--text` or `--muted`, links with `--primary`, badges with their `-soft` background. A new token needs a dark
   value and 4.5:1 for text (3:1 for large text and UI parts); the audit runs both themes.
8. **Reflow.** Nothing may need sideways scrolling at 320 CSS px or 200% text, except a data table inside
   `table()`'s wrapper. No fixed widths over 320px, `min-width: 0` on flex/grid children that hold text, wrap
   long words (`overflow-wrap: anywhere`), no `white-space: nowrap` on sentences, no `overflow: hidden` that cuts
   off text (it must survive the WCAG text-spacing overrides).
9. **Clickable rows only through `table({ onRow })`.** The row opens on a click anywhere; for the keyboard the
   first cell with plain content becomes a `<button class="row-open">` (the row stays a table row, so screen
   readers keep the column headings). Put links and buttons of a row's own in later columns. `rowLabel` is
   accepted but no longer applied: a row's name is its own visible text. Phone "compact" rows are buttons
   unless they hold a control, in which case they get an "Open" button.
10. **Section tabs are navigation.** Use `pageTabs(items, active, onPick, { label })` or `tabStrip()`: a
    labelled `<nav>` with `aria-current="page"` on the current section. Do not use `role="tab"` unless you
    build a real tab widget (arrow keys, `tabpanel`), as the sign-in page's Log in / Sign up does.
11. **Dialogs only through `modal()`.** It names the dialog by its title, moves focus in, keeps Tab inside,
    closes on Escape and Back, makes the page behind it `inert`, and returns focus to what opened it. Put the
    most useful first field first: that is where focus lands.
12. **Say what happened.** Saved/done messages go through `toast()` (a polite live region; errors are
    alerts). A form's errors come from `form()`: thrown field errors (`err.data.fields`) are shown under each
    field, announced, and focus goes to the first. A message that must stay (a device that stopped saving)
    uses `banner()`. Never rely on a colour change or an icon appearing.
13. **Page titles.** `document.title` is set on every navigation from the `NAV` label (or `TITLES` in app.js
    for pages outside the navigation) plus the current section. Never put a client's name in a title: it
    ends up in browser history. A new page outside `NAV` needs a `TITLES` entry.
14. **Hidden file inputs.** A file input opened by a visible button is `tabindex: '-1', 'aria-hidden': 'true'`
    (the button is the control); or lay it over its label with `.file-btn`, which shows the ring on the label.
15. **Images.** Informative pictures have `alt` text (a caption, or "Picture 2 of 5" at least); decorative ones
    `alt: ''`. A clickable picture is a `<button>` around the image.
16. **Time limits.** The only one is the idle sign-out, which warns a minute ahead with a "Stay signed in"
    button (WCAG 2.2.1). Do not add others; a toast that disappears must not be the only place something is said
    that the person has to act on.
17. **Touch targets.** Controls are at least 44×44 CSS px on a touch screen (`@media (pointer: coarse)` in
    styles.css covers the shared classes); a new small control class belongs in that list.

## Where the fixes live

| What | Where |
| --- | --- |
| Label/control association, scroll-region focus, placeholder-only names | `a11yPass()`, `scrollRegions()` in `public/app.js` (a MutationObserver runs them on everything added) |
| Skip link, page titles, focus on navigation | `skipLink()`, `setPageTitle()`, `renderPage()` in `public/app.js` |
| Dialog focus, inert background | `modal()`, `syncInertBehindDialogs()` |
| Section navigation | `pageTabs()`, `tabStrip()` |
| Colour-independent emphasis, chart text | `flag()`, `stat()`, `sparkline()`, `bars()` |
| Idle warning | `startIdleWatch()` |
| Focus ring, link underline, card heading sizes, reflow | the "WCAG 2.1 AA" section at the end of `public/styles.css` |
| Accessibility statement | `public/accessibility.html` (+ `accessibility.js`), `docs/accessibility/STATEMENT.md` |
