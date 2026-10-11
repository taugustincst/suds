// SUDS on this device must never be shown inside another site's frame (clickjacking): a static host
// cannot send frame-ancestors, so the page hides itself and takes over the top window instead.
if (window.top !== window.self) {
  document.documentElement.style.display = 'none';
  try { window.top.location.replace(window.self.location.href); } catch (e) { /* a sandboxed frame stays blank */ }
}
