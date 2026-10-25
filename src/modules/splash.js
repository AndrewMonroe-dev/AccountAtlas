// Launch splash: the Lottie intro plays in the middle of the screen, then the logo
// flies to the header slot (a navy square fades in behind the glyph on the way) and
// the overlay fades. Plays once per browser session.
// A plain script loaded at the top of index.html so it starts before the app modules
// download. The markup is in index.html, the look is in app.css (which also hides the
// overlay on its own if this file never runs), and this file plays the animation and
// does the flight.

(function () {
  const SEEN_KEY = 'aa-splash-seen';
  const HOLD_MS = 250;      // pause on the finished animation before it flies
  const FLY_MS = 650;       // matches the transitions on .splash-logo in app.css
  const GIVE_UP_MS = 6500;  // if the animation never reports it finished, fly anyway

  const root = document.documentElement;
  const splash = document.getElementById('splash');

  function finish() {
    root.classList.add('logo-ready');
    if (splash) splash.remove();
  }

  if (!splash) { root.classList.add('logo-ready'); return; }
  if (root.classList.contains('no-splash') || typeof lottie === 'undefined' || !window.AA_INTRO) { finish(); return; }
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* private mode: it may replay, harmless */ }

  const logo = document.getElementById('splash-logo');
  const anim = lottie.loadAnimation({
    container: document.getElementById('lottie-host'),
    renderer: 'svg',
    loop: false,
    autoplay: true,
    animationData: window.AA_INTRO,
    rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
  });
  let flown = false;

  function fly() {
    if (flown) return;
    flown = true;
    const slot = document.getElementById('header-logo');
    if (!slot) { finish(); return; }
    const from = logo.getBoundingClientRect();
    const to = slot.getBoundingClientRect();
    if (!from.width || !to.width) { finish(); return; }
    const dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    const dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    splash.classList.add('flying');
    logo.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(' + (to.width / from.width) + ')';
    setTimeout(finish, FLY_MS + 80);
  }

  anim.addEventListener('complete', () => setTimeout(fly, HOLD_MS));
  setTimeout(fly, GIVE_UP_MS);
})();
