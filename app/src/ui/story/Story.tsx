import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { lockScroll } from "../scrollLock";
import "./story.css";
import { ChapterI, ChapterII, ChapterIII, ChapterIV, Readout, I_LINES, II_LINES, III_LINES } from "./chapters";

export interface StoryProps { onDone: () => void; onSkip: () => void }

const CHAPTERS = [
  { n: "I", eyebrow: "Today", title: "Your keys guard everything.", body: "A wallet, a vault, a dead man's switch: each answers to one classical key." },
  { n: "II", eyebrow: "Q-Day", title: "Q-Day.", body: "A quantum computer solves the public key and derives the private one. A switch guarded by that key would pay the thief." },
  { n: "III", eyebrow: "The fix", title: "Seal it with a lattice.", body: "Every owner action carries a lattice signature. The stolen key moves nothing." },
  { n: "IV", eyebrow: "Your turn", title: "Build yours.", body: "Name your heirs, set a heartbeat, and seal a vault on the in-browser chain. Simulated, testnet-only demo. Nothing has value." },
];
const DURATION = [4500, 6500, 6500];
/** Frame shown when motion is reduced: the last meaningful state of each chapter. */
const POSTER = [1, 0.97, 0.8];
const TICK = 50;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
/** A press longer than this is a hold (pause), not a tap. */
const HOLD_MS = 250;

function prefersReduced(): boolean {
  try { return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
  catch { return false; }
}

export function Story({ onDone, onSkip }: StoryProps) {
  const [ch, setCh] = useState(0);
  const [p, setP] = useState(0);
  const [reduced] = useState(prefersReduced);
  const held = useRef(false);
  const swipe = useRef<number | null>(null);
  const downAt = useRef(0);
  /** Set when a press was a hold or a swipe: the click that follows it must not turn the page. */
  const ignoreClick = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const last = ch === CHAPTERS.length - 1;

  const go = useCallback((to: number) => {
    setCh((c) => { const n = Math.max(0, Math.min(CHAPTERS.length - 1, to)); return n === c ? c : n; });
  }, []);
  const next = useCallback(() => setCh((c) => Math.min(CHAPTERS.length - 1, c + 1)), []);
  const prev = useCallback(() => setCh((c) => Math.max(0, c - 1)), []);

  // chapter clock
  useEffect(() => {
    if (reduced) { setP(POSTER[ch] ?? 1); return; }
    setP(0);
    if (last) return;
    let el = 0;
    let adv: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      if (held.current) return;
      el += TICK;
      const v = Math.min(1, el / DURATION[ch]);
      setP(v);
      if (v >= 1) { clearInterval(id); adv = setTimeout(() => setCh((c) => (c === ch ? c + 1 : c)), 350); }
    }, TICK);
    return () => { clearInterval(id); if (adv) clearTimeout(adv); };
  }, [ch, reduced, last]);

  // last chapter: gentle heartbeat
  const [pulse, setPulse] = useState(1);
  useEffect(() => {
    if (!last || reduced) return;
    const id = setInterval(() => setPulse((n) => n + 1), 4200);
    return () => clearInterval(id);
  }, [last, reduced]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") { e.preventDefault(); prev(); }
      else if (e.key === "Escape") { e.preventDefault(); onSkip(); }
      else if (e.key === "Tab") {
        // Focus stays inside the briefing.
        const el = root.current;
        if (!el) return;
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) { e.preventDefault(); el.focus(); return; }
        const first = items[0], lastEl = items[items.length - 1], active = document.activeElement;
        if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && (active === lastEl || !el.contains(active))) { e.preventDefault(); first.focus(); }
      }
      else if ((e.key === " " || e.key === "Enter") && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); if (last) onDone(); else next(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [next, prev, onSkip, onDone, last]);

  // Focus moves in, the page behind stops scrolling, and focus goes back to whatever opened the briefing.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    root.current?.focus({ preventScroll: true });
    return () => {
      unlock();
      try { opener?.focus?.({ preventScroll: true }); } catch { /* the opener may be gone */ }
    };
  }, []);

  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (ignoreClick.current) { ignoreClick.current = false; return; }
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0 && e.clientX - r.left < r.width * 0.3) prev(); else if (!last) next();
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => { held.current = true; swipe.current = e.clientX; downAt.current = Date.now(); ignoreClick.current = false; };
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    held.current = false;
    const x0 = swipe.current; swipe.current = null;
    if (x0 !== null) {
      const dx = e.clientX - x0;
      const long = Date.now() - downAt.current > HOLD_MS;
      if (dx < -48) next(); else if (dx > 48) prev();
      // A hold only pauses, and a swipe has already turned the page: the click that follows is not a tap.
      ignoreClick.current = long || Math.abs(dx) > 10;
    }
  };

  const c = CHAPTERS[ch];
  return (
    <div
      className={`st${reduced ? " st--still" : ""}`}
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Q-Day briefing"
      data-chapter={ch + 1}
    >
      <header className="st-top">
        <ol className="st-bars" aria-label="Briefing progress">
          {CHAPTERS.map((x, i) => (
            <li key={x.n} className={`st-bar${i < ch ? " is-done" : ""}${i === ch ? " is-now" : ""}`} aria-current={i === ch ? "step" : undefined}>
              <span className="st-bar-fill" style={{ width: i < ch ? "100%" : i === ch ? `${(last || reduced ? 1 : p) * 100}%` : "0%" }} />
              <span className="q-sr">Chapter {x.n}{i === ch ? ", current" : i < ch ? ", seen" : ""}</span>
            </li>
          ))}
        </ol>
        <div className="st-meta">
          <span className="st-count q-mono">0{ch + 1} / 0{CHAPTERS.length}</span>
          <button type="button" className="st-skip" onClick={onSkip}>Skip briefing</button>
        </div>
      </header>

      <div className="st-stage" onClick={onStageClick} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { held.current = false; swipe.current = null; ignoreClick.current = false; }}>
        <div key={ch} className={`st-chapter st-chapter--${ch + 1}`}>
          {ch === 0 && <ChapterI p={p} />}
          {ch === 1 && <ChapterII p={p} />}
          {ch === 2 && <ChapterIII p={p} />}
          {ch === 3 && <ChapterIV pulse={pulse} />}
        </div>
      </div>

      <section className="st-cap" aria-live="polite" aria-atomic="true">
        <p className="st-eyebrow q-eyebrow">Chapter {c.n} · {c.eyebrow}</p>
        <h2 className="st-title" key={`t${ch}`}>{c.title}</h2>
        <p className="st-body">{c.body}</p>
      </section>
      {ch === 0 && <Readout lines={I_LINES} p={p} label="Classical key facts" />}
      {ch === 1 && <Readout lines={II_LINES} p={p} label="Attack readout" />}
      {ch === 2 && <Readout lines={III_LINES} p={p} label="Lattice signature facts" />}
      {ch === 3 && <ul className="st-readout" aria-label="What you will do"><li className="st-ro is-on st-ro--ice"><span className="st-ro-dot" aria-hidden="true" />ML-DSA-87 · FIPS 204 · testnet only · not a will</li></ul>}

      <footer className="st-foot">
        {last ? (
          <button type="button" className="q-btn q-btn--block" onClick={onDone}>Build my vault</button>
        ) : (
          <button type="button" className="q-btn q-btn--ghost q-btn--block" onClick={next}>Next<span className="q-sr"> chapter</span></button>
        )}
        <p className="st-hint">{last ? "Replay it any time from the vault screen." : reduced ? "Press Next, or the right arrow key" : "Tap, swipe or press the right arrow to move on. Hold to pause."}</p>
      </footer>
    </div>
  );
}

export default Story;
