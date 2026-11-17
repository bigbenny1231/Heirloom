import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { LatticeState } from "../brand/LatticeCore";
import { HeroCanvas } from "./scene/HeroCanvas";
import { T } from "./scene/frame";
import { Logo } from "../brand/Logo";
import { Icon } from "../brand/icons";
import "./landing.css";
import sigCompare from "./art/sig_compare.webp";
import step1 from "./art/step1_heirs.webp";
import step2 from "./art/step2_checkin.webp";
import step3 from "./art/step3_silence.webp";
import step4 from "./art/step4_settle.webp";
import drillArt from "./art/drill_keyart.webp";
import labIntact from "./art/lab_intact.webp";
import labFlipped from "./art/lab_flipped.webp";
import securityMap from "./art/security_map.webp";
import horizon from "./art/cta_horizon.webp";

/* ---------- helpers ---------- */

function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Scroll reveal. Content is visible by default; only elements below the fold are hidden once the observer is armed. */
function Reveal({ children, className = "", as: Tag = "div", delay = 0 }: { children: ReactNode; className?: string; as?: "div" | "section" | "li"; delay?: number }) {
  const ref = useRef<HTMLElement | null>(null);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined" || prefersReducedMotion()) return;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight * 0.95) return;
    setHidden(true);
    const io = new IntersectionObserver(
      (es) => {
        if (es.some((e) => e.isIntersecting)) {
          setHidden(false);
          io.disconnect();
        }
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const T = Tag as "div";
  return (
    <T ref={ref as React.RefObject<HTMLDivElement>} className={`ld-rv ${hidden ? "is-hidden" : ""} ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </T>
  );
}

/* ---------- hero: Run Q-Day ---------- */

interface Stage { state: LatticeState; badge: string; progress: number; title: string; body: string }
const STAGES: Stage[] = [
  { state: "ALIVE", badge: "Alive", progress: 0.82, title: "Alive", body: "Each check-in is a lattice signature. The vault is quiet and sealed." },
  { state: "WARNING", badge: "Warning", progress: 0.28, title: "Warning", body: "Check-ins stopped. The clock is running. Nothing has moved." },
  { state: "OVERDUE", badge: "Overdue", progress: 0.02, title: "Overdue", body: "Warning and grace have passed. Anyone may trigger it." },
  { state: "TRIGGERED", badge: "Triggered", progress: 0, title: "Triggered", body: "A keeper pays the gas. The vault begins to settle." },
  { state: "SETTLED", badge: "Settled", progress: 0, title: "Settled", body: "Heirs paid by fixed shares. A stolen key moved nothing." },
];
const STEP_MS = 1100;

const ATTACK_STEPS = [
  { title: "Ready", body: "A quantum computer can derive a classical key. Run Q-Day and watch the vault." },
  { title: "Q-Day", body: "The attacker derives your ECDSA private key from its public key." },
  { title: "Forging", body: "Signed withdrawals and check-ins hit the vault." },
  { title: "Refused", body: "A classical signature authorises nothing here." },
  { title: "Sealed", body: "Value kept: 100%. The stolen key moved nothing." },
];
/** Timeline (ms from the click) lives in scene/frame.ts; the caption and status line follow it. */
const T_FORGE = T.bolt[0], T_SHATTER = T.shatter, T_SEAL = T.caption, T_DONE = T.done;

/** Keep the whole hero core (scene, caption, actions) framed under the sticky header on small screens. */
function frameCore(el: HTMLElement | null, smooth: boolean) {
  if (!el || typeof window === "undefined" || typeof window.scrollTo !== "function") return;
  const nav = document.querySelector(".ld-nav") as HTMLElement | null;
  const top = (nav ? nav.getBoundingClientRect().height : 0) + 8;
  const r = el.getBoundingClientRect();
  if (!r.height) return;
  /* the visitor scrolled away to read something else: leave them there */
  if (r.bottom < top || r.top > window.innerHeight) return;
  const room = window.innerHeight - top - 8;
  let dy = 0;
  if (r.top < top) dy = r.top - top;
  else if (r.bottom > window.innerHeight - 8) dy = Math.min(r.bottom - (window.innerHeight - 8), r.top - top);
  if (r.height > room) dy = r.top - top;
  if (Math.abs(dy) < 2) return;
  window.scrollTo({ top: window.scrollY + dy, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}

function HeroCore({ onOpenApp, onRunChange }: { onOpenApp?: () => void; onRunChange?: (r: "idle" | "running" | "done") => void }) {
  const [run, setRun] = useState<"idle" | "running" | "done">("idle");
  const coreRef = useRef<HTMLDivElement>(null);
  const [runId, setRunId] = useState(0);
  const [step, setStep] = useState(0);
  const [stage, setStage] = useState(0);
  const [lapsing, setLapsing] = useState(false);
  const [hits, setHits] = useState(0);
  const [live, setLive] = useState("");
  const reduced = useRef(prefersReducedMotion()).current;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const liveT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const at = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };

  useEffect(() => () => { clear(); if (liveT.current) clearTimeout(liveT.current); }, []);
  useEffect(() => {
    onRunChange?.(run);
    if (run === "idle") return;
    /* wait one frame so the done-state layout (ladder, actions) exists before measuring */
    const id = requestAnimationFrame(() => frameCore(coreRef.current, true));
    return () => cancelAnimationFrame(id);
  }, [run, onRunChange]);
  /* clear, then set: screen readers re-announce identical text on replay */
  const say = (t: string) => {
    if (liveT.current) clearTimeout(liveT.current);
    setLive("");
    liveT.current = setTimeout(() => setLive(t), 80);
  };

  const FINAL = "Sealed. Value kept: 100%. The stolen key moved nothing.";
  const runQDay = useCallback(() => {
    if (run === "running" || lapsing) return;
    clear();
    setStage(0);
    setHits(0);
    setRunId((n) => n + 1);
    say("Q-Day simulation started.");
    if (prefersReducedMotion()) { setRun("done"); setStep(4); setHits(3); say(FINAL); return; }
    setRun("running");
    setStep(1);
    at(T_FORGE, () => setStep(2));
    T.hit.forEach((d, i) => at(d, () => setHits(i + 1)));
    at(T_SHATTER, () => setStep(3));
    at(T_SEAL, () => { setStep(4); say(FINAL); });
    at(T_DONE, () => setRun("done"));
  }, [run, lapsing]);

  const lapse = useCallback(() => {
    if (lapsing || run !== "done" || stage > 0) return;
    if (prefersReducedMotion()) { setStage(STAGES.length - 1); say("Settled. Heirs paid by fixed shares."); return; }
    setLapsing(true);
    STAGES.slice(1).forEach((_, i) => at(STEP_MS * (i + 1), () => {
      setStage(i + 1);
      if (i === STAGES.length - 2) { setLapsing(false); say("Settled. Heirs paid by fixed shares."); }
    }));
  }, [lapsing, run, stage]);

  const st = STAGES[stage];
  const cap = stage > 0 ? st : ATTACK_STEPS[step];
  const busy = run === "running" || lapsing;
  const label = stage > 0
    ? `Vault lattice, ${st.title.toLowerCase()}. ${st.body}`
    : run === "idle"
      ? "A rotating lattice crystal inside a countdown ring, and a small orange classical key below it. Run Q-Day to simulate an attack."
      : run === "running"
        ? `Q-Day simulation running. The attacker derives the classical key and forges signatures at the lattice${hits ? `, hit ${hits} of 3` : ""}.`
        : "Vault sealed. The classical key is shattered. ML-DSA-87 verified on chain. Value kept: 100%.";
  return (
    <>
    <div ref={coreRef} className="ld-hero-core" data-run={run} data-stage={st.state.toLowerCase()} aria-busy={busy}>
      <div className="ld-core-wrap">
        <div className="hc-box">
          <HeroCanvas run={run} runId={runId} stage={stage} progress={st.progress} reduced={reduced} label={label} />
        </div>
      </div>
      <ol className="ld-ladder" aria-label="Vault states">
        {STAGES.map((s, i) => (
          <li key={s.state} className={i === stage ? "is-cur" : i < stage ? "is-past" : ""} data-s={s.state.toLowerCase()}>
            <span className="ld-dot" />
            <span>{s.badge}</span>
          </li>
        ))}
      </ol>
      <div className="ld-caption" aria-hidden={busy}>
        <span className="ld-cap-h">{cap.title}</span>
        <span className="ld-cap-b">{cap.body}</span>
      </div>
      <div className="ld-actions">
        {run === "done" && onOpenApp && (
          <button type="button" className="q-btn ld-open-now" onClick={onOpenApp}>Open the vault, no wallet <Icon name="arrow-right" size={18} /></button>
        )}
        <div className={`ld-act-row ${run === "done" ? "is-done" : ""}`}>
          <button type="button" className={`ld-run ${run === "done" ? "is-replay" : ""}`} aria-disabled={busy} onClick={runQDay}
            data-sub={run === "done" ? "the attack" : undefined} aria-label={run === "done" ? "Replay the Q-Day attack" : undefined}>
            <span className="ld-run-glyph" aria-hidden="true" />
            {run === "running" ? "Q-Day in progress" : run === "done" ? "Replay" : "Run Q-Day"}
          </button>
          {run === "done" && stage < STAGES.length - 1 && (
            <button type="button" className="ld-run ld-run--quiet" aria-disabled={lapsing} onClick={lapse}
              data-sub={lapsing ? "heirs get paid" : "see heirs get paid"}
              aria-label={lapsing ? "Check-ins stopped, heirs get paid" : "Stop checking in and see your heirs get paid"}>
              {lapsing ? "Check-ins stopped" : "Stop checking in"}
            </button>
          )}
        </div>
      </div>
    </div>
    <p className="q-sr" role="status">{live}</p>
    </>
  );
}

/* ---------- section head: spec-sheet number, hairline, eyebrow ---------- */

const TOTAL = "07";
function SecHead({ no, title }: { no: string; title: string }) {
  return (
    <div className="ld-sh">
      <span className="q-mono ld-sh-no">{no} / {TOTAL}</span>
      <span className="ld-sh-rule" aria-hidden="true" />
      <span className="q-eyebrow">{title}</span>
    </div>
  );
}

/* ---------- Q-Day in one minute ---------- */

function SigBars() {
  return (
    <figure className="ld-art ld-art--sig">
      <figcaption className="q-eyebrow">Signature size, to scale. One cell is one byte.</figcaption>
      <img
        src={sigCompare} width={400} height={690} loading="lazy" decoding="async"
        alt="Byte grids drawn to scale, one cell per byte. An ECDSA signature is 64 cells in orange, a single row. The ML-DSA-87 signature is 4,627 cells in ice blue, 53 rows, 72 times larger. The ML-DSA-87 public key is 2,592 cells in violet."
      />
      <div className="ld-bar-foot q-mono">Public key 2,592 B · bigger on purpose · the size is the cost of the lattice</div>
    </figure>
  );
}

/* ---------- how it works ---------- */

const ILL: Record<"heirs" | "beat" | "silence" | "settle", { src: string; alt: string }> = {
  heirs: { src: step1, alt: "A vault whose seal ring is split 60 and 40 percent, sending shares along two paths to heirs Maya at 60 percent and Leo at 40 percent." },
  beat: { src: step2, alt: "A 4,627-byte lattice signature passes through the pqcVerify gate on chain. A green heartbeat follows and the vault is Alive with its timer reset." },
  silence: { src: step3, alt: "A timeline from the last check-in through warning, grace and overdue. Above it the lattice core dims from ice blue to amber as the silence grows." },
  settle: { src: step4, alt: "The vault opens and pays Maya 60 percent and Leo 40 percent. A small green droplet marks the keeper bounty for whoever triggered it." },
};
function Ill({ kind }: { kind: "heirs" | "beat" | "silence" | "settle" }) {
  const it = ILL[kind];
  return <img src={it.src} width={400} height={250} loading="lazy" decoding="async" alt={it.alt} />;
}

const STEPS: { k: "heirs" | "beat" | "silence" | "settle"; h: string; p: string }[] = [
  { k: "heirs", h: "Set heirs and a heartbeat", p: "Choose who is paid, in fixed shares, and how often you will check in." },
  { k: "beat", h: "Check in with a post-quantum signature", p: "Each check-in is signed with ML-DSA-87 and verified on chain by the pqcVerify precompile." },
  { k: "silence", h: "Silence starts warning, then grace", p: "Miss the schedule and the vault moves from Alive to Warning to Overdue. A check-in before then resets it." },
  { k: "settle", h: "Anyone triggers, heirs are paid", p: "Past warning plus grace, anyone may trigger. Settlement pays heirs by their shares." },
];

/* ---------- the drill replay ---------- */

/* Only attacks that exist in sim/drill.ts. */
const ATTACKS = [
  { a: "Check in to stall the heirs", why: "A check-in is only valid when signed by the lattice key. A forged heartbeat is void." },
  { a: "Withdraw all funds to the attacker", why: "No valid ML-DSA-87 signature, so the vault does not release anything." },
  { a: "Make the attacker the sole heir", why: "Changing heirs needs the post-quantum key. A classical signature is not accepted." },
  { a: "Install the attacker as an unlimited agent", why: "Allowances, caps and payees are set by the post-quantum key. The attacker cannot raise them." },
  { a: "Trigger the inheritance early", why: "Trigger opens only after warning plus grace have passed without a check-in." },
];

/** A small, honest picture of the Signature lab: one bit of a signature flips and the contract's verdict changes. */
function LabTease({ onOpenLab }: { onOpenLab: () => void }) {
  const [flipped, setFlipped] = useState(false);
  return (
    <div className="ld-lab">
      <div className="ld-lab-bar"><span className="q-eyebrow">Illustration of the Signature lab</span><span className="q-mono">4,627 B</span></div>
      <img
        className="ld-lab-grid" src={flipped ? labFlipped : labIntact} width={400} height={330} loading="lazy" decoding="async"
        alt={flipped ? "The 4,627-byte signature as a heat grid. Byte 2,313 is flipped by one bit and glows orange, and the verdict reads PQSignatureInvalid." : "The 4,627-byte signature as a heat grid, 88 bytes per row. Byte 2,313 is marked and untouched, and the verdict reads accepted."}
      />
      <p className={`ld-lab-verdict q-mono ${flipped ? "is-refused" : "is-ok"}`} role="status">
        {flipped ? "Refused by the contract: PQSignatureInvalid. Nothing moved." : "Signed as the key made it. Accepted."}
      </p>
      <div className="ld-drill-cta">
        <button type="button" className="q-btn q-btn--ghost" onClick={() => setFlipped((f) => !f)} aria-pressed={flipped}>{flipped ? "Put the bit back" : "Flip one bit"}</button>
        <button type="button" className="q-btn" onClick={onOpenLab}>Try it on the real chain <Icon name="arrow-right" size={18} /></button>
      </div>
      <p className="ld-fine">An illustration. In the app the signature is a real ML-DSA-87 signature from your key and the verdict comes from the contract.</p>
    </div>
  );
}

function DrillReplay({ onOpenApp }: { onOpenApp: () => void }) {
  const [n, setN] = useState(0); // number of resolved attacks
  const [running, setRunning] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const wrap = useRef<HTMLDivElement | null>(null);
  const auto = useRef(false);

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  useEffect(() => clear, []);

  const run = useCallback(() => {
    clear();
    if (prefersReducedMotion()) { setN(ATTACKS.length); setRunning(false); return; }
    setN(0);
    setRunning(true);
    ATTACKS.forEach((_, i) => {
      timers.current.push(setTimeout(() => {
        setN(i + 1);
        if (i === ATTACKS.length - 1) setRunning(false);
      }, 900 * (i + 1)));
    });
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (typeof IntersectionObserver === "undefined" || !el) { setN(ATTACKS.length); return; }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting) && !auto.current) { auto.current = true; run(); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [run]);

  const finished = n >= ATTACKS.length;
  return (
    <div className="ld-drill" ref={wrap}>
      <div className="ld-drill-bar">
        <span className="q-eyebrow">Illustration, not a live chain</span>
        <span className="q-mono ld-drill-who">attacker holds the classical key</span>
      </div>
      <ol className="ld-attacks">
        {ATTACKS.map((x, i) => {
          const state = i < n ? "done" : i === n && running ? "run" : "wait";
          return (
            <li key={x.a} className={`ld-atk is-${state}`}>
              <div className="ld-atk-row">
                <span className="ld-atk-a">{x.a}</span>
                <span className={`ld-verdict q-mono ${state === "done" ? "is-refused" : ""}`}>{state === "done" ? "REFUSED" : state === "run" ? "TRYING" : "QUEUED"}</span>
              </div>
              {state === "done" && <p className="ld-atk-why">{x.why}</p>}
            </li>
          );
        })}
      </ol>
      <div className={`ld-kept ${finished ? "is-on" : ""}`}>
        <Icon name="check" size={18} />
        <span><b>Value kept: 100%.</b> Every attempt refused, funds untouched.</span>
      </div>
      <div className="ld-drill-cta">
        <button type="button" className="q-btn" onClick={onOpenApp}>Run it for real in the app <Icon name="arrow-right" size={18} /></button>
        <button type="button" className="q-btn q-btn--ghost" onClick={run} disabled={running}>{running ? "Replaying…" : "Replay"}</button>
      </div>
      <p className="ld-fine">An illustration. The in-app drill runs dozens of real attempts against the real contract bytecode, with real signatures, in your browser.</p><p className="q-sr" role="status">{finished ? "Every attempt was refused. Value kept: 100%." : ""}</p>
    </div>
  );
}

/* ---------- security table ---------- */

const ROWS = [
  { who: "Post-quantum key (ML-DSA-87)", can: "Authorise every owner action: check in, change heirs, withdraw, set the agent allowance.", cannot: "Be replaced by a classical key. Each action needs its own valid signature." },
  { who: "Stolen classical key (ECDSA)", can: "Nothing in the vault on its own.", cannot: "Withdraw, change heirs, check in, trigger early or drain via the agent." },
  { who: "Relayer", can: "Submit a signed transaction and pay the gas.", cannot: "Authorise anything, or alter what was signed." },
  { who: "Keeper (anyone)", can: "Trigger once warning plus grace have passed with no check-in.", cannot: "Trigger early, choose heirs or change shares." },
  { who: "Agent", can: "Pay allowlisted payees within per-payment and daily caps, before expiry, while Alive.", cannot: "Pay anyone else, exceed a cap, or act after expiry or once not Alive." },
  { who: "The builders", can: "Publish open source code under MIT.", cannot: "Authorise owner actions. Every owner action still needs the owner’s signature." },
];

/* ---------- FAQ ---------- */

const FAQ: { q: string; a: string }[] = [
  { q: "Is this a will?", a: "No. It is software that pays addresses you chose by fixed shares when check-ins stop. It is not a will and not legal advice, and it does not detect death. Talk to a lawyer about your estate." },
  { q: "What if I am offline?", a: "Silence moves the vault from Alive to Warning, then through grace. If check-ins stay stopped past warning plus grace, anyone can trigger it. Pick a schedule longer than any absence you expect, and check in before the deadline to reset it." },
  { q: "What if I lose the device?", a: "There are two key modes. ACCOUNT uses the account’s registered post-quantum key. DEVICE uses a pinned key held by this device. The app has key backup, import and rotate, so back up before you rely on it. We do not claim recovery beyond that." },
  { q: "Why QoreChain?", a: "QoreChain’s pqcVerify precompile verifies ML-DSA-87 signatures on chain. That lets the contract itself check a lattice signature for every owner action. This project was built for the Build Before Q-Day event." },
  { q: "What does it cost?", a: "The demo in the app is free and needs no wallet. Once it is deployed to the QoreChain testnet (chain id 9800) you will pay testnet gas, which has no value. It is not deployed yet, and mainnet is not planned, so we cannot quote a real cost." },
  { q: "Can heirs see the balance?", a: "Assume yes. Vault state lives on a public chain and this project makes no privacy claim." },
];

/* ---------- page ---------- */

export function Landing({ onOpenApp, onOpenLab }: { onOpenApp: () => void; onOpenLab?: () => void }) {
  const [menu, setMenu] = useState(false);
  const burger = useRef<HTMLButtonElement | null>(null);
  const go = (id: string) => {
    setMenu(false);
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.scrollIntoView) el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      const h = el.querySelector("h1, h2") as HTMLElement | null;
      if (h) { h.tabIndex = -1; try { h.focus({ preventScroll: true }); } catch { /* ignore */ } }
    });
  };
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMenu(false); burger.current?.focus(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);
  const [heroDone, setHeroDone] = useState(false);
  const onHeroRun = useCallback((r: "idle" | "running" | "done") => setHeroDone(r === "done"), []);
  const nav = [["how", "How it works"], ["drill", "Drill"], ["lab", "Signature lab"], ["security", "Security"], ["faq", "FAQ"]] as const;

  return (
    <div className="ld">
      <header className="ld-nav">
        <div className="ld-nav-in">
          <a className="ld-logo" href="#/" aria-label="Heirloom home" onClick={(e) => { e.preventDefault(); window.scrollTo(0, 0); }}><Logo size={26} /></a>
          <nav className="ld-links" aria-label="Sections">
            {nav.map(([id, t]) => (<a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); go(id); }}>{t}</a>))}
          </nav>
          <button type="button" className="q-btn q-btn--sm q-btn--ghost ld-nav-cta" onClick={onOpenApp}>Open the vault</button>
          <button ref={burger} type="button" className="ld-burger" aria-expanded={menu} aria-controls="ld-menu" aria-label="Menu" onClick={() => setMenu((m) => !m)}>
            <span /><span />
          </button>
        </div>
        {menu && (
          <div id="ld-menu" className="ld-menu">
            {nav.map(([id, t]) => (<a key={id} href={`#${id}`} onClick={(e) => { e.preventDefault(); go(id); }}>{t}</a>))}
            <button type="button" className="q-btn q-btn--block ld-menu-cta" onClick={() => { setMenu(false); onOpenApp(); }}>Open the vault</button>
          </div>
        )}
      </header>

      <main>
        <section className="ld-hero">
          <div className="ld-wrap ld-hero-grid">
            <p className="q-eyebrow ld-eyebrow">Quantum Dead Man’s Vault</p>
            <h1 className="q-display ld-h1">Built to outlive Q-Day.</h1>
            <p className="ld-sub">Every owner action needs a lattice signature. Stop checking in, and your heirs are paid.</p>
            <HeroCore onOpenApp={onOpenApp} onRunChange={onHeroRun} />
            <div className={`ld-cta ${heroDone ? "is-done" : ""}`}>
              {!heroDone && <button type="button" className="q-btn" onClick={onOpenApp}>Open the vault, no wallet <Icon name="arrow-right" size={18} /></button>}
              <a className="q-link ld-cta-link" href="#drill" onClick={(e) => { e.preventDefault(); go("drill"); }}>Watch the drill</a>
            </div>
            <p className={`ld-chips q-mono ${heroDone ? "is-done" : ""}`}>20-second briefing · build your own vault · no wallet</p>
          </div>
          <div className="ld-ruler" aria-hidden="true" />
        </section>

        <section className="ld-sec" id="qday">
          <div className="ld-wrap">
            <Reveal><SecHead no="01" title="Q-Day in one minute" />
              <h2 className="q-display ld-h2">The switch is only as strong as its signature.</h2></Reveal>
            <ol className="ld-beats">
              <Reveal as="li" className="ld-beat"><span className="q-mono ld-n">1.1</span><h3>Quantum computers break ECDSA.</h3><p>Every classical wallet key can in principle be derived from its public key once a large enough machine exists. That day is called Q-Day.</p></Reveal>
              <Reveal as="li" className="ld-beat" delay={80}><span className="q-mono ld-n">1.2</span><h3>A forgeable switch is worthless.</h3><p>A dead man’s switch trusts check-ins. If an attacker can forge the owner’s signature, they can postpone forever, or empty it.</p></Reveal>
              <Reveal as="li" className="ld-beat" delay={160}><span className="q-mono ld-n">1.3</span><h3>This vault answers to a lattice.</h3><p>Every owner action is authorised by an ML-DSA-87 signature, checked on chain. Trigger, settle and claim are open to anyone, and the agent uses an ordinary key under caps. A stolen classical key alone moves nothing.</p></Reveal>
            </ol>
            <Reveal><SigBars /></Reveal>
          </div>
        </section>

        <section className="ld-sec" id="how">
          <div className="ld-wrap">
            <Reveal><SecHead no="02" title="How it works" />
              <h2 className="q-display ld-h2">Four steps. One state machine.</h2></Reveal>
            <ol className="ld-steps">
              {STEPS.map((s, i) => (
                <Reveal as="li" key={s.h} className="ld-step" delay={i * 70}>
                  <div className="ld-ill"><Ill kind={s.k} /></div>
                  <span className="q-mono ld-n">2.{i + 1}</span>
                  <h3>{s.h}</h3>
                  <p>{s.p}</p>
                </Reveal>
              ))}
            </ol>
            <Reveal className="ld-states">
              <span className="q-eyebrow">States</span>
              <span className="ld-st-list">
                {["Alive", "Warning", "Overdue", "Triggered", "Settled", "Closed"].map((s, i) => (
                  <span key={s}>{i > 0 && <span className="ld-st-sep" aria-hidden="true"> · </span>}<span className="ld-st" data-s={s.toLowerCase()}>{s}</span></span>
                ))}
              </span>
            </Reveal>
            <Reveal><p className="ld-note">Settlement pays heirs with gas-capped pushes. An heir that cannot receive gets a claimable fallback, so one bad address cannot block the rest.</p></Reveal>
          </div>
        </section>

        <section className="ld-sec" id="drill">
          <div className="ld-wrap ld-two">
            <Reveal className="ld-drill-copy">
              <SecHead no="03" title="The Q-Day drill" />
              <h2 className="q-display ld-h2">Attack it. Watch it refuse.</h2>
              <p className="ld-lead">The organisers’ drill simulates an attacker who has the account’s classical key. Ours shows every attack refused while the vault keeps its funds.</p>
              <figure className="ld-art ld-art--drill">
                <img src={drillArt} width={400} height={396} loading="lazy" decoding="async" alt="An orange stolen classical key fires five attacks at a sealed ice-blue lattice shield. Each impact ripples out on the ring and is marked refused, and no bytes move." />
              </figure>
            </Reveal>
            <Reveal><DrillReplay onOpenApp={onOpenApp} /></Reveal>
          </div>
        </section>

        <section className="ld-sec" id="lab">
          <div className="ld-wrap ld-two">
            <Reveal className="ld-drill-copy">
              <SecHead no="04" title="The Signature lab" />
              <h2 className="q-display ld-h2">Break a real signature.</h2>
              <p className="ld-lead">Flip one bit of a real ML-DSA-87 signature and watch the contract refuse it. Then try a wrong key, a replay and an expired signature. Each refusal shows the contract’s own error name and its gas.</p>
            </Reveal>
            <Reveal><LabTease onOpenLab={onOpenLab ?? onOpenApp} /></Reveal>
          </div>
        </section>

        <section className="ld-sec" id="security">
          <div className="ld-wrap">
            <div className="ld-split">
              <Reveal><SecHead no="05" title="Security model" />
                <h2 className="q-display ld-h2">Signatures are the authority.</h2>
                <p className="ld-lead">Because the signature is the authority, anyone may relay a transaction and pay gas. Who you are does not matter. What was signed does.</p></Reveal>
              <Reveal>
                <figure className="ld-art ld-art--sec">
                  <img src={securityMap} width={400} height={508} loading="lazy" decoding="async" alt="A schematic of who holds what. The post-quantum key signs every owner action into the vault. A stolen classical key is blocked and moves nothing. The relayer pays gas and the keeper, shown as a clock, triggers only after grace. The agent spends only through a cap." />
                </figure>
              </Reveal>
            </div>
            <Reveal>
              <table className="ld-table" role="table">
                <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Who</th><th scope="col" role="columnheader">Can</th><th scope="col" role="columnheader">Cannot</th></tr></thead>
                <tbody role="rowgroup">
                  {ROWS.map((r) => (
                    <tr key={r.who} role="row">
                      <th scope="row" role="rowheader">{r.who}</th>
                      <td data-label="Can" role="cell">{r.can}</td>
                      <td data-label="Cannot" role="cell">{r.cannot}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Reveal>
          </div>
        </section>

        <section className="ld-sec" id="proof">
          <div className="ld-wrap">
            <Reveal><SecHead no="06" title="What is tested" /></Reveal>
            <Reveal>
              <dl className="ld-proof">
                {[["2,592 B", "ML-DSA-87 public key"], ["4,627 B", "ML-DSA-87 signature"], ["192", "contract tests, incl. fuzz and invariant"], ["342", "tests in total (192 contract, 53 sim, 48 scripts, 49 app)"], ["MIT", "licence"], ["9800", "target testnet chain id (not deployed yet)"]].map(([v, l]) => (
                  <div key={l}><dt className="q-display">{v}</dt><dd>{l}</dd></div>
                ))}
              </dl>
            </Reveal>
            <Reveal>
              <p className="ld-status"><b>Honest status.</b> Built for the QoreChain testnet and not deployed yet, not even to testnet. Not audited by a third party. Nothing here has value, so do not put real funds near it.</p>
            </Reveal>
          </div>
        </section>

        <section className="ld-sec" id="faq">
          <div className="ld-wrap ld-faq-wrap">
            <Reveal><SecHead no="07" title="FAQ" /><h2 className="q-display ld-h2">Straight answers.</h2></Reveal>
            <Reveal>
              <div className="ld-faq">
                {FAQ.map((f) => (
                  <details key={f.q}>
                    <summary>{f.q}</summary>
                    <p>{f.a}</p>
                  </details>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section className="ld-final" style={{ "--horizon": `url(${horizon})` } as React.CSSProperties}>
          <div className="ld-wrap">
            <Reveal><h2 className="q-display ld-h2">See it hold.</h2>
              <p className="ld-lead">The demo runs the real contract bytecode and real ML-DSA-87 signatures in your browser. No wallet.</p>
              <button type="button" className="q-btn" onClick={onOpenApp}>Open the vault, no wallet <Icon name="arrow-right" size={18} /></button></Reveal>
          </div>
        </section>
      </main>

      <footer className="ld-foot">
        <div className="ld-wrap">
          <Logo size={22} />
          <p className="ld-disc">Not a will. Not legal advice. Not deployed yet, not audited.</p>
          <p className="q-muted">Built for QoreChain Build Before Q-Day, November 2026</p>
        </div>
      </footer>
    </div>
  );
}
