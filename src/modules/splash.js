// Launch splash: the logo glyph spins inside its square in the middle of the
// screen, then the whole logo flies to the header slot and the overlay fades.
// Plays once per browser session. The markup is in index.html, the look and the
// spin are in app.css (which also hides the overlay on its own if this file
// never runs), and this file decodes the images, starts the spin, measures the
// header slot and does the flight.
//
// The app's own startup (map, data, first render) waits for splashDone so the
// animation is the only thing using the phone's main thread while it plays.

const SEEN_KEY = 'aa-splash-seen';
const SPIN_MS = 1700;   // the aa-spin animation in app.css (1.6 s) plus a short hold
const FLY_MS = 650;     // matches the transition on .splash-logo in app.css
const DECODE_MAX_MS = 1500; // never hold the splash longer than this for the images

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function finish(splash) {
  document.documentElement.classList.add('logo-ready');
  splash.remove();
}

// Spin only starts once both logo images are decoded, so the first frames do not stall on PNG decoding.
function imagesReady(splash) {
  const imgs = Array.from(splash.querySelectorAll('img'));
  const decoded = Promise.all(imgs.map((img) => (img.decode ? img.decode() : Promise.resolve()).catch(() => {})));
  return Promise.race([decoded, delay(DECODE_MAX_MS)]);
}

async function play() {
  const root = document.documentElement;
  const splash = document.getElementById('splash');
  if (!splash) return;
  if (root.classList.contains('no-splash')) { splash.remove(); return; }
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: it may replay, harmless */ }

  const logo = splash.querySelector('.splash-logo');
  const slot = document.getElementById('header-logo');
  if (!logo || !slot) { finish(splash); return; }

  await imagesReady(splash);
  splash.classList.add('go');   // releases the paused spin in app.css
  await delay(SPIN_MS);

  const from = logo.getBoundingClientRect();
  const to = slot.getBoundingClientRect();
  if (!to.width || !from.width) { finish(splash); return; }
  const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
  const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
  const scale = to.width / from.width;
  splash.classList.add('flying');
  logo.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  await delay(FLY_MS + 80);
  finish(splash);
}

export const splashDone = play().catch(() => {
  const splash = document.getElementById('splash');
  if (splash) finish(splash);
});
