// Launch splash: the logo glyph spins inside its square in the middle of the
// screen, then the whole logo flies to the header slot and the overlay fades.
// Plays once per browser session. The markup is in index.html, the look and the
// spin are in app.css (which also hides the overlay on its own if this file
// never runs), and this file only measures the header slot and does the flight.

const SEEN_KEY = 'aa-splash-seen';
const SPIN_MS = 1700;   // the aa-spin animation in app.css (1.6 s) plus a short hold
const FLY_MS = 650;     // matches the transition on .splash-logo in app.css

function finish(splash) {
  document.documentElement.classList.add('logo-ready');
  splash.remove();
}

function run() {
  const root = document.documentElement;
  const splash = document.getElementById('splash');
  if (!splash) return;
  if (root.classList.contains('no-splash')) { splash.remove(); return; }
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: it may replay, harmless */ }

  const logo = splash.querySelector('.splash-logo');
  const slot = document.getElementById('header-logo');
  if (!logo || !slot) { finish(splash); return; }

  // Time already spent loading counts toward the spin, so a slow start does not add a second wait.
  const wait = Math.max(0, SPIN_MS - performance.now());
  setTimeout(() => {
    const from = logo.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    if (!to.width || !from.width) { finish(splash); return; }
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    const scale = to.width / from.width;
    splash.classList.add('flying');
    logo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
    setTimeout(() => finish(splash), FLY_MS + 80);
  }, wait);
}

run();
