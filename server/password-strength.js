'use strict';
// What makes a password that passes the character-class rule (auth.passwordPolicy) still a poor one: it contains
// the account's username or the person's name, it is a very common word or keyboard pattern dressed up with a
// capital letter, digits and a symbol ("Password2026!", "Summer2026!!", "P@ssw0rd1234"), or it is a few
// characters over and over ("Aa1!Aa1!Aa1!"). Pen test of 1.23.6, L1. A short list kept here on purpose: no
// package, no download, nothing to update. It is not a substitute for length, only a floor under it.

// Lower-case letters only. A password is refused when, once its leading and trailing digits and symbols (and up to
// two other letters) are set aside, what is left is one of these (once or repeated), allowing the usual look-alikes.
const COMMON = [
  'password', 'passwort', 'passwd', 'pass', 'welcome', 'letmein', 'changeme', 'secret', 'login', 'default', 'temp',
  'temporary', 'test', 'testing', 'guest', 'user', 'admin', 'administrator', 'root', 'master', 'hello', 'helloworld',
  'qwerty', 'qwertyuiop', 'qwertz', 'azerty', 'asdf', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'qazwsx',
  'abc', 'abcd', 'abcdef', 'abcdefg', 'abcdefgh', 'iloveyou', 'trustno', 'monkey', 'dragon', 'shadow', 'sunshine',
  'princess', 'football', 'baseball', 'soccer', 'superman', 'batman', 'starwars', 'whatever', 'freedom', 'jesus',
  'summer', 'winter', 'spring', 'autumn', 'fall', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december', 'california', 'suds',
];
// Characters commonly typed in place of a letter.
const LOOKALIKE = { a: 'a@4', b: 'b8', e: 'e3', g: 'g9', i: 'i1!|', l: 'l1|', o: 'o0', s: 's5$', t: 't7+', z: 'z2' };
const esc = (c) => c.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&');
const wordPattern = (w) => [...w].map(c => `[${[...(LOOKALIKE[c] || c)].map(esc).join('')}]`).join('');
// The word may also have up to two other letters before or after it, in all ("Summer2026!!x", "xWelcome2026!"):
// one extra letter is not what makes a password hard to guess (eval of 1.24.0, D3).
const W = `(?:${COMMON.map(w => `(?:${wordPattern(w)})+`).join('|')})`, X = '[^a-z]*', L = '[a-z][^a-z]*';
const COMMON_RE = new RegExp(`^${X}(?:(?:${L}){0,2}${W}|${W}(?:${X}[a-z]){1,2}|${L}${W}${X}[a-z])${X}$`);
// For "does it contain the name": the look-alikes read back as letters.
const UNLEET = { '@': 'a', 4: 'a', 8: 'b', 3: 'e', 9: 'g', 1: 'i', '!': 'i', '|': 'i', 0: 'o', 5: 's', $: 's', 7: 't', '+': 't' };
const unleet = (s) => s.replace(/[@483916!|05$7+]/g, c => UNLEET[c]);

/** The names a password must not contain: the username (and its part before an @), and each part of the display name, of 3+ characters. */
function namesOf({ username, display_name } = {}) {
  const user = [], name = [];
  if (typeof username === 'string' && username.trim()) {
    const u = username.trim().toLowerCase();
    user.push(u);
    const local = u.split('@')[0];
    if (local !== u) user.push(local);
  }
  if (typeof display_name === 'string') for (const p of display_name.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (p) name.push(p);
  return { user: user.filter(x => x.length >= 3), name: name.filter(x => x.length >= 3) };
}

/**
 * A plain-language reason this password is too easy to guess, or null. `who` is the account it is for
 * ({ username, display_name }), either may be missing. Character classes and length are auth.passwordPolicy's.
 */
function weakness(pw, who) {
  if (typeof pw !== 'string') return null;
  const lower = pw.toLowerCase();
  const read = unleet(lower);
  // A part of 4 or more characters anywhere; one of 3 ("Ann", "nav") only as a word of its own, or "Planning" and
  // "Navigator" would be refused for an Ann or a nav.
  const word = (s, part) => { for (let i = s.indexOf(part); i >= 0; i = s.indexOf(part, i + 1)) if (!/[a-z]/.test(s[i - 1] || '') && !/[a-z]/.test(s[i + part.length] || '')) return true; return false; };
  const has = (part) => part.length >= 4 ? lower.includes(part) || read.includes(part) : word(lower, part) || word(read, part);
  const { user, name } = namesOf(who);
  if (user.some(has)) return 'A password must not contain the username. Choose one that does not include it.';
  if (name.some(has)) return 'A password must not contain the person’s name. Choose one that does not include it.';
  if (COMMON_RE.test(lower)) return 'That password is too common: it is a well-known word or keyboard pattern with numbers or symbols added. Choose something less predictable — a few unrelated words together work well.';
  if (new Set(lower).size < 5) return 'That password uses too few different characters. Choose something less predictable — a few unrelated words together work well.';
  return null;
}

module.exports = { weakness, COMMON };
