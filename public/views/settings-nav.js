// Links to one setting, and finding it when the link is followed (1.27.0). Every setting on the Settings pages has a
// target: the `name` of its form field, or a `data-setting` on the card or row that holds it. A link to it is
// #/admin?tab=<tab>&field=<target>; when the tab is drawn, revealSetting opens the section the setting is folded
// into, scrolls it to the middle of the screen, puts focus on its control and marks it for a moment, so a message
// such as "no API key yet" can take an administrator straight to the box to type it in.
import { h } from '../app.js';

export const settingHref = (tab, target) => `#/admin?tab=${encodeURIComponent(tab)}${target ? `&field=${encodeURIComponent(target)}` : ''}`;

/** A link to a setting, for a sentence that tells the administrator what to change. */
export const settingLink = (tab, target, text, attrs = {}) => h('a', { href: settingHref(tab, target), 'data-setting-link': target || tab, ...attrs }, text);

const FOCUSABLE = 'input:not([type=hidden]), select, textarea, button, a[href], summary';

/** Find `target` under `root` (polled: a tab's cards draw one after another) and bring it into view. */
export function revealSetting(root, target, { tries = 100 } = {}) {
  if (!target) return;
  let n = 0;
  const find = () => root.querySelector(`[data-setting="${CSS.escape(target)}"]`) || root.querySelector(`[name="${CSS.escape(target)}"]`);
  const place = () => {
    const el = find();
    if (!el || !el.isConnected) { if (++n < tries) setTimeout(place, 50); return; }
    for (let d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    const box = el.matches('[data-setting]') ? el : el.closest('.field, [data-field], .setting-row') || el;
    box.scrollIntoView({ block: 'center' });
    // Its control, or (a setting with none here: one the server's environment sets) the row itself.
    let control = el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE);
    if (!control) { if (!box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1'); control = box; }
    try { control.focus({ preventScroll: true }); } catch { /* not focusable after all */ }
    box.classList.add('setting-flash');
    setTimeout(() => box.classList.remove('setting-flash'), 2600);
  };
  // After the router has put focus on the page heading in the same turn it attached the page.
  setTimeout(place, 0);
}
