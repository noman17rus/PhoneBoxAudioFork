// One demand-driven clock for panel motion. Data acquisition never runs from this clock.
const animations = new Set();
const period = 1000 / 60;
let raf = 0, nextAt = 0, paused = false;

function eligible(a) {
  return a.pending && a.visible();
}

export function refreshAnimations() {
  for (const a of animations) if (paused || document.hidden || !a.pending || !a.visible()) a.last = null;
  const wanted = !paused && !document.hidden && [...animations].some(eligible);
  if (!wanted) {
    cancelAnimationFrame(raf); raf = 0; nextAt = 0;
  } else if (!raf) raf = requestAnimationFrame(frame);
}

export function pauseAnimations(value) {
  paused = !!value;
  document.body.classList.toggle('motion-paused', paused);
  refreshAnimations();
}

function frame(now) {
  raf = 0;
  if (paused || document.hidden) return refreshAnimations();
  // Allow timestamp rounding at 60 Hz without accidentally falling back to 30 Hz.
  if (nextAt && now + .5 < nextAt) { raf = requestAnimationFrame(frame); return; }
  nextAt = nextAt ? nextAt + period : now + period;
  if (nextAt < now) nextAt = now + period;
  for (const a of [...animations]) {
    if (!animations.has(a) || !eligible(a)) { a.last = null; continue; }
    const dt = a.last === null ? 0 : Math.min(.1, (now - a.last) / 1000);
    a.last = now;
    a.pending = false;
    try { if (a.draw(now, dt) === true) a.pending = true; }
    catch (error) { console.warn('animation', error); }
  }
  refreshAnimations();
}

/** draw(timeMs, deltaSeconds) returns true while motion needs another frame. */
export function createAnimation(draw, visible = () => true) {
  const a = { draw, visible, pending: false, last: null };
  animations.add(a);
  return {
    request() { if (animations.has(a)) { a.pending = true; refreshAnimations(); } },
    cancel() { a.pending = false; a.last = null; refreshAnimations(); },
    destroy() { animations.delete(a); refreshAnimations(); },
  };
}

document.addEventListener('visibilitychange', refreshAnimations);
