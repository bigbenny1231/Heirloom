import { useEffect, useMemo, useRef, useState } from "react";
import type { DrillRow } from "../../chain/types";
import { LatticeCore } from "../../brand/LatticeCore";
import { prefersReducedMotion } from "../format";
import { lockScroll } from "../scrollLock";
import type { TabProps } from "../tabs";
import "./qday.css";

export interface QDayModeProps {
  open: boolean;
  onClose: () => void;
  adapter: TabProps["adapter"];
  drill: TabProps["drill"];
  runDrill: TabProps["runDrill"];
}

/** One attempt appears this often, so the whole drill takes long enough to read. */
const ROW_MS = 220;
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function outcomeOf(r: DrillRow): { kind: "refused" | "noeffect" | "moved"; word: string } {
  if (r.blocked && r.harmless) return { kind: "noeffect", word: "NO EFFECT" };
  if (r.blocked) return { kind: "refused", word: "REFUSED" };
  return { kind: "moved", word: "MOVED VALUE" };
}

/** One terminal entry. Types its command line when it arrives, then prints the verdict. */
function Entry({ row, animate }: { row: DrillRow; animate: boolean }) {
  const text = `${row.name}`;
  const how = row.how;
  const total = text.length + how.length;
  const [typed, setN] = useState(animate ? 0 : total);
  // A row that is no longer the newest shows in full, whatever the typing had reached.
  const n = animate ? typed : total;
  useEffect(() => {
    if (!animate || typed >= total) return;
    const step = Math.max(2, Math.ceil(total / 6));
    const t = setTimeout(() => setN((c) => Math.min(total, c + step)), 25);
    return () => clearTimeout(t);
  }, [animate, typed, total]);
  const done = n >= total;
  const o = outcomeOf(row);
  return (
    <p className="qd-t">
      <span className="qd-t__name">{text.slice(0, n)}</span>
      <span className="qd-t__how">{how.slice(0, Math.max(0, n - text.length))}{!done && <span className="qd-caret" aria-hidden="true" />}</span>
      {done && (
        <span className={`qd-t__out ${o.kind}`}>
          → <b>{o.word}</b> <span>{row.revert}{o.kind === "moved" ? ` · moved ${row.valueMoved}` : ""}</span>
        </span>
      )}
    </p>
  );
}

/** Where a strike comes from: spread around the ring by attempt number, aimed at the core. */
function Strike({ n }: { n: number }) {
  const a = (n * 137.508 * Math.PI) / 180;
  const R = 150, r = 22;
  const x1 = 160 + Math.cos(a) * R, y1 = 160 + Math.sin(a) * R;
  const x2 = 160 + Math.cos(a) * r, y2 = 160 + Math.sin(a) * r;
  const bx = 160 + Math.cos(a) * 46, by = 160 + Math.sin(a) * 46;
  return (
    <g className="qd-hit" aria-hidden="true">
      <line x1={x1.toFixed(1)} y1={y1.toFixed(1)} x2={x2.toFixed(1)} y2={y2.toFixed(1)} />
      <circle cx={bx.toFixed(1)} cy={by.toFixed(1)} r={14} />
    </g>
  );
}

export function QDayMode({ open, onClose, drill, runDrill }: QDayModeProps) {
  const reduced = useMemo(() => prefersReducedMotion(), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const runningRef = useRef(false);
  const initial = useRef(0);
  const started = useRef(false);
  const [announce, setAnnounce] = useState("");
  // The terminal reveals one attempt at a time, whatever the speed the chain answers at. All at once under reduced motion.
  const [shown, setShown] = useState(0);

  const { rows, report, running, error } = drill;
  const n = Math.min(shown, rows.length);
  const done = !running && !!report && n === rows.length;
  const playing = running || (!!report && n < rows.length);
  const rowsLen = useRef(rows.length);
  rowsLen.current = rows.length;
  runningRef.current = playing;

  // Opening: remember which rows were already there (they appear at once), then start the drill if there is nothing to show.
  useEffect(() => {
    if (!open) { started.current = false; return; }
    initial.current = drill.rows.length;
    setShown(drill.report ? drill.rows.length : 0);
    if (!started.current && !drill.running && drill.rows.length === 0 && !drill.report) {
      started.current = true;
      setAnnounce("Q-Day drill started. Your classical key is treated as public.");
      void runDrill();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (reduced) { setShown(rows.length); return; }
    if (shown > rows.length) { setShown(rows.length); return; }
  }, [open, reduced, rows.length, shown]);
  useEffect(() => {
    if (!open || reduced) return;
    const id = setInterval(() => setShown((c) => (c < rowsLen.current ? c + 1 : c)), ROW_MS);
    return () => clearInterval(id);
  }, [open, reduced]);

  useEffect(() => { if (open && done) setAnnounce(report!.valueKeptPct === 100 ? `Drill finished. Value kept 100 percent. ${report!.blocked} of ${report!.tried} attempts refused.` : `Drill finished. Value kept ${report!.valueKeptPct} percent.`); }, [open, done, report]);

  // Focus trap, Escape (only when not running), scroll lock, focus return.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const unlock = lockScroll();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!runningRef.current) closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      unlock();
      try { opener?.focus?.(); } catch { /* opener may be gone */ }
    };
  }, [open]);

  useEffect(() => { const t = termRef.current; if (t) t.scrollTop = t.scrollHeight; }, [n]);

  if (!open) return null;

  const seen = rows.slice(0, n);
  const refused = seen.filter((r) => r.blocked).length;
  const hits = n;
  const moved = seen.filter((r) => !r.blocked).map((r) => r.valueMoved);
  const full = done && report!.valueKeptPct === 100;

  return (
    <div ref={ref} className={`qd${done ? " qd--done" : ""}`} role="dialog" aria-modal="true" aria-labelledby="qd-title" tabIndex={-1}>
      <div className="qd__inner">
        <div className="qd__eyebrow">{done ? "Drill complete" : error ? "Drill stopped" : "Q-Day · simulated"}</div>
        <h2 id="qd-title">{done ? "The lattice held." : "Q-Day: your classical key is public."}</h2>
        <p className="qd__lede">
          {done
            ? "Everything below was tried with the stolen key."
            : "An attacker has your old key. These are real attempts against the real contract bytecode, with real signatures, in your browser."}
        </p>
        <div className="qd__core">
          <LatticeCore state="ALIVE" tone="ice" size="100%" beat={hits} overlay={!reduced && hits > 0 ? <Strike key={`strike-${hits}`} n={hits} /> : null} />
        </div>
        <div className="qd__bar" aria-hidden="true">
          <span>attempts <b>{hits}</b></span>
          <span>refused <b>{refused}</b></span>
          <span>value moved <b>{moved.length ? moved.join(" + ") : "0"}</b></span>
        </div>
        {done && (
          <div className={`qd__verdict${full ? "" : " warnv"}`}>
            {full ? <strong>Value kept: 100%. The stolen key moved nothing.</strong> : <strong>Value kept: {report!.valueKeptPct}%.</strong>}
            <p>{report!.blocked} of {report!.tried} attempts were refused or did nothing. {report!.scope}</p>
            <div className="qd__stats"><span>{report!.distinctPaths} distinct paths</span><span>{report!.reachedVerifier} reached the verifier</span></div>
          </div>
        )}
        <div className="qd__term" ref={termRef} role="log" aria-label="Attacker terminal" aria-live="off">
          {n === 0 && !error && <p className="qd-t qd__wait">{playing ? "attacker> opening the channel…" : "attacker> waiting"}<span className="qd-caret" aria-hidden="true" /></p>}
          {seen.map((r, i) => <Entry key={`${i}-${r.name}`} row={r} animate={!reduced && i === n - 1 && i >= initial.current} />)}
          {error && <p className="qd-t qd__err">attacker&gt; the drill could not finish: {error}</p>}
        </div>
      </div>
      <div className="qd__foot">
        {(done || !!error) && <button className="q-btn q-btn--ghost" onClick={() => { initial.current = 0; setShown(0); setAnnounce("Q-Day drill started. Your classical key is treated as public."); void runDrill(); }}>Replay</button>}
        <button className={`q-btn ${done ? "" : "q-btn--ghost"}`} disabled={playing} onClick={() => closeRef.current()}>{playing ? "Running…" : "Close"}</button>
      </div>
      <div className="q-sr" role="status" aria-live="polite" aria-atomic="true">{announce}</div>
    </div>
  );
}
