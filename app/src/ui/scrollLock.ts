let count = 0;
let prev = "";

/**
 * One shared page-scroll lock. Every full-screen layer (create flow, Q-Day takeover, briefing, settings sheet) takes it
 * and gives it back, so two layers open at once never leave the page stuck or unlocked. Returns the release function.
 */
export function lockScroll(): () => void {
  const body = document.body;
  if (count++ === 0) {
    prev = body.style.overflow;
    body.style.overflow = "hidden";
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--count === 0) body.style.overflow = prev;
  };
}
