import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActionResult, Adapter, DrillReport, DrillRow, Hex, VaultView } from "./chain/types";
import { createDemoAdapter } from "./chain/demo";
import { TestnetAdapter, addressFromHash } from "./chain/testnet";
import { LIVE_TESTNET } from "./chain/live";
import { Sheet } from "./ui/Sheet";
import { SettingsBody } from "./ui/Settings";
import { VaultTab, KeysTab, WithdrawTab, DrillTab, HeirsTab, AgentTab, type Settlement, type TabProps } from "./ui/tabs";
import { Ledger } from "./ui/Ledger";
import { Boot } from "./ui/Boot";
import { FullScreen } from "./ui/FullScreen";
import { Story } from "./ui/story/Story";
import { CreateFlow } from "./ui/create/CreateFlow";
import { SignatureLab } from "./ui/lab";
import { QDayMode } from "./ui/qday";
import type { Persona } from "./ui/heir";
import { Guide, type Act } from "./ui/Intro";
import { Icon, type IconName } from "./brand/icons";
import { LogoMark } from "./brand/Logo";
import { lsGet, lsSet } from "./ui/format";

type Mode = "demo" | "testnet";
/**
 * Five places on a phone: the vault, the lab where the signature is shown, the drill, the heirs, and More for the tools.
 * More holds Agent, Withdraw and Keys; on a wide screen they sit in the bar and More is not shown.
 */
const MAIN = [
  ["vault", "Vault"],
  ["lab", "Lab"],
  ["drill", "Q-Day drill"],
  ["heirs", "Heirs"],
] as const;
const MORE = [
  ["agent", "Agent"],
  ["withdraw", "Withdraw"],
  ["keys", "Keys"],
] as const;
const TAB_ICON: Record<string, IconName> = { vault: "vault", lab: "lab", keys: "key", withdraw: "withdraw", drill: "drill", heirs: "heirs", agent: "agent" };
type TabId = (typeof MAIN)[number][0] | (typeof MORE)[number][0];
const isMore = (t: TabId) => MORE.some(([id]) => id === t);
/** Remembered when the briefing was seen or skipped. */
const STORY_KEY = "qdmv.story";
type Overlay = null | "story" | "create";

export interface LogEntry extends ActionResult {
  n: number;
}

export interface AppProps {
  /** Leave for the landing page. Without it there is no back button (the app stands alone). */
  onBack?: () => void;
  /** A contract address from the link, read once by the host. When omitted the app reads the hash itself. */
  suggestedAddr?: Hex | null;
  /** Changes when the landing page asks for the no-wallet Demo mode. */
  demoRequest?: number;
  /** False while the host hides the app (the landing page is showing). Overlays close and stay closed. */
  active?: boolean;
  /** The landing page asks for one screen of the app (n changes with every ask). */
  openTo?: { screen: "lab"; n: number };
}

const readHash = () => {
  try {
    return window.location.hash;
  } catch {
    return ""; // sandboxed frame
  }
};

export function App({ onBack, suggestedAddr, demoRequest = 0, active = true, openTo }: AppProps = {}) {
  // A request from the landing page for the no-wallet Demo mode wins over a stored Testnet choice, even on the first mount.
  const [mode, setMode] = useState<Mode>(() => (demoRequest > 0 ? "demo" : lsGet("qdmv.mode") === "testnet" ? "testnet" : "demo"));
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [bootMsg, setBootMsg] = useState("Starting the chain");
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [bootSteps, setBootSteps] = useState<string[]>([]);
  const [guideOpen, setGuideOpen] = useState(() => (demoRequest > 0 || lsGet("qdmv.mode") !== "testnet") && lsGet("qdmv.intro") !== "1" && !(openTo && openTo.n > 0));
  const [act, setAct] = useState<Act>(1);
  const [vault, setVault] = useState<VaultView | null>(null);
  const [tab, setTab] = useState<TabId>(() => (openTo && openTo.n > 0 ? openTo.screen : "vault"));
  const [moreOpen, setMoreOpen] = useState(false);
  // The briefing opens only for a visit that came from the landing page, and only until it has been seen or skipped.
  const [overlay, setOverlay] = useState<Overlay>(() => (demoRequest > 0 && !(openTo && openTo.n > 0) && lsGet(STORY_KEY) !== "1" ? "story" : null));
  const [qday, setQday] = useState(false);
  const [persona, setPersona] = useState<Persona>("owner");
  const seenOpenTo = useRef(openTo?.n ?? 0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const createBusy = useRef(false);
  const [pendingLabel, setPendingLabel] = useState("");
  const [settings, setSettings] = useState(false);
  const [drill, setDrill] = useState<{ rows: DrillRow[]; report: DrillReport | null; running: boolean; error?: string }>({ rows: [], report: null, running: false });
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [suggested, setSuggested] = useState<Hex | null>(null);
  const [epoch, setEpoch] = useState(0);
  /** Bumped by every reset. A result that was started before the reset is stale and is dropped. */
  const epochRef = useRef(0);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const counter = useRef(0);
  const testnet = useRef<TestnetAdapter | null>(null);
  const seenDemoReq = useRef(demoRequest);
  const starting = useRef(false);
  const drillDone = useRef(false);
  const stateRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async (a: Adapter) => {
    try {
      setVault(await a.snapshot());
    } catch {
      setVault(null);
    }
  }, []);

  // Boot the adapter for the chosen mode.
  useEffect(() => {
    let dead = false;
    setAdapter(null);
    setBootErr(null);
    setBootSteps([]);
    setVault(null);
    setLog([]);
    setSettlement(null);
    setAct(1);
    setQday(false);
    setPersona("owner");
    drillDone.current = false;
    setDrill({ rows: [], report: null, running: false });
    const onBoot = (m: string) => {
      if (dead) return;
      setBootMsg(m);
      setBootSteps((st) => (st[st.length - 1] === m ? st : [...st, m]));
    };
    (async () => {
      try {
        let a: Adapter;
        if (mode === "demo") {
          a = await createDemoAdapter(onBoot);
        } else {
          const t = (testnet.current ??= new TestnetAdapter());
          await t.boot(onBoot);
          setSuggested(suggestedAddr !== undefined ? suggestedAddr : addressFromHash(readHash()));
          a = t;
        }
        if (dead) return;
        setAdapter(a);
        await refresh(a);
      } catch (e) {
        if (!dead) setBootErr(e instanceof Error ? e.message : "Could not start.");
      }
    })();
    return () => {
      dead = true;
    };
  }, [mode, refresh, suggestedAddr]);

  const push = useCallback((r: ActionResult) => {
    setLog((l) => [{ ...r, n: ++counter.current }, ...l].slice(0, 60));
  }, []);

  const run = useCallback(
    async (fn: () => Promise<ActionResult>, label = "Working…"): Promise<ActionResult> => {
      if (!adapter) throw new Error("not ready");
      setBusy(true);
      setPendingLabel(adapter.kind === "testnet" ? "Confirm in your wallet, then waiting for the block…" : label);
      const ep = epochRef.current;
      try {
        const r = await fn();
        if (ep !== epochRef.current) return r; // the vault was rebuilt while this ran: its result belongs to the old one
        push(r);
        // Act I ends on the first real check-in (or the lab's "Send it as signed", which is one). If the drill already ran, Act II is behind them too.
        if (r.ok && (r.title === "Check in" || r.title === "Send it as signed")) setAct((a) => (a === 1 ? (drillDone.current ? 3 : 2) : a));
        await refresh(adapter);
        return r;
      } catch (e) {
        const r: ActionResult = { ok: false, title: "Action", detail: e instanceof Error ? e.message : "Failed.", at: Date.now() };
        if (ep === epochRef.current) push(r);
        return r;
      } finally {
        setBusy(false);
        setPendingLabel("");
      }
    },
    [adapter, push, refresh],
  );

  const runDrillRaw = useCallback(async () => {
    if (!adapter) return;
    setBusy(true);
    const ep = epochRef.current;
    setDrill({ rows: [], report: null, running: true });
    try {
      const report = await adapter.drill((row) => { if (ep === epochRef.current) setDrill((d) => ({ ...d, rows: [...d.rows, row] })); });
      if (ep !== epochRef.current) return;
      setDrill({ rows: report.rows, report, running: false });
      drillDone.current = true;
      push({ ok: true, title: "Q-Day drill", detail: `${report.blocked} of ${report.tried} attacks blocked. Value kept: ${report.valueKept}.`, at: Date.now() });
    } catch (e) {
      if (ep !== epochRef.current) return;
      const detail = e instanceof Error ? e.message : "Failed.";
      setDrill({ rows: [], report: null, running: false, error: detail });
      push({ ok: false, title: "Q-Day drill", detail, at: Date.now() });
    } finally {
      setBusy(false);
      if (ep === epochRef.current) await refresh(adapter);
    }
  }, [adapter, push, refresh]);

  /** The drill screen's run button: the drill plays as the full-screen Q-Day takeover. */
  const startDrill = useCallback(async () => {
    setQday(true);
    await runDrillRaw();
  }, [runDrillRaw]);

  // Act II ends when the drill has run (only if Act II is the current act: a drill run during Act I does not finish Act I).
  useEffect(() => {
    if (drill.report) setAct((a) => (a === 2 ? 3 : a));
  }, [drill.report]);
  // Never leave the guide on an act the vault can no longer reach.
  useEffect(() => {
    const st = vault?.state;
    stateRef.current = st;
    if (!st) return;
    if (st === "SETTLED" || st === "CLOSED") setAct(4);
    else if (st !== "ALIVE" && st !== "WARNING" && st !== "OVERDUE") setAct((a) => (a < 3 ? 3 : a));
  }, [vault?.state]);

  const switchMode = useCallback((m: Mode) => {
    lsSet("qdmv.mode", m);
    setMode(m);
    if (m === "testnet") {
      setGuideOpen(false);
      setOverlay(null);
    }
  }, []);


  // The landing page's "no wallet" buttons always open Demo mode, even if the app was left on Testnet.
  // The first visit also opens the briefing; asking for the Lab goes straight to it.
  useEffect(() => {
    const toLab = !!openTo && openTo.n !== seenOpenTo.current;
    if (openTo) seenOpenTo.current = openTo.n;
    if (demoRequest !== seenDemoReq.current) {
      seenDemoReq.current = demoRequest;
      if (mode !== "demo") switchMode("demo");
      if (toLab) {
        setOverlay(null);
        setGuideOpen(false);
        setTab("lab");
      } else if (lsGet(STORY_KEY) !== "1") setOverlay("story");
    }
  }, [demoRequest, openTo, mode, switchMode]);

  // The host hides the app behind the landing page: a settings sheet must not stay open (and trap focus) there.
  useEffect(() => {
    if (!active) setSettings(false);
  }, [active]);

  // After the first successful Check in, Act II is the next thing to do: bring it into view (it may sit below the fold).
  const prevAct = useRef<Act>(act);
  useEffect(() => {
    const was = prevAct.current;
    prevAct.current = act;
    if (was !== 1 || act < 2) return;
    const id = requestAnimationFrame(() => {
      const el = document.querySelector(".vault-guide");
      if (!el || typeof el.scrollIntoView !== "function") return;
      let reduce = false;
      try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { /* default to smooth */ }
      try { el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" }); } catch { /* old browsers */ }
    });
    return () => cancelAnimationFrame(id);
  }, [act]);

  const closeGuide = useCallback(() => {
    setGuideOpen(false);
    lsSet("qdmv.intro", "1");
  }, []);
  const openGuide = useCallback(() => {
    setSettings(false);
    setTab("vault");
    // On a settled or closed vault the run is over: show its ending. On a live one, a finished run starts again.
    setAct((a) => (a === 4 && stateRef.current !== "SETTLED" && stateRef.current !== "CLOSED" ? 1 : a));
    setGuideOpen(true);
  }, []);

  /** Testnet only: points the read-only view at the live sample vault and loads it. */
  const loadLive = useCallback(async () => {
    const t = testnet.current;
    if (!t || !adapter || adapter.kind !== "testnet") return;
    setBusy(true);
    setPendingLabel("Reading the live vault…");
    try {
      t.setContract(LIVE_TESTNET.contract);
      t.setVaultId(LIVE_TESTNET.vaultId);
      const c = await t.checkContract();
      if (c !== "ok") throw new Error("The live contract could not be checked. Try again in a moment.");
      await refresh(adapter);
    } catch (e) {
      push({ ok: false, title: "Could not load the live vault", detail: e instanceof Error ? e.message : "Try again in a moment.", at: Date.now() });
    } finally {
      setBusy(false);
    }
  }, [adapter, refresh, push]);

  /** Rebuilds the sample vault and drops every screen's local state (old toasts, a shown backup string). */
  const startOver = useCallback(async () => {
    if (!adapter || starting.current) return;
    starting.current = true;
    setBusy(true);
    setPendingLabel("Building a fresh vault…");
    try {
      epochRef.current += 1;
      await adapter.reset();
      drillDone.current = false;
      setPersona("owner");
      setQday(false);
      setLog([]);
      setDrill({ rows: [], report: null, running: false });
      setSettlement(null);
      setAct(1);
      setEpoch((n) => n + 1);
      setTab("vault");
      await refresh(adapter);
    } catch (e) {
      push({ ok: false, title: "Start over", detail: e instanceof Error ? e.message : "Could not build a fresh vault.", at: Date.now() });
    } finally {
      starting.current = false;
      setBusy(false);
      setPendingLabel("");
    }
  }, [adapter, push, refresh]);

  const finishStory = useCallback((then: Overlay) => {
    lsSet(STORY_KEY, "1");
    setOverlay(then);
  }, []);
  const qdayRef = useRef(false);
  qdayRef.current = qday;
  const openStory = useCallback(() => {
    if (qdayRef.current) return; // the takeover is on screen: nothing opens over it
    setSettings(false);
    setOverlay("story");
  }, []);
  const openCreate = useCallback(() => {
    if (qdayRef.current) return;
    setSettings(false);
    setOverlay("create");
  }, []);
  /** Closes the create flow and puts focus on the app heading. */
  const closeCreate = useCallback(() => {
    setOverlay(null);
    requestAnimationFrame(() => {
      try {
        const h = document.querySelector<HTMLElement>(".app h1");
        if (h) { if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
      } catch { /* focus is a convenience */ }
    });
  }, []);
  /** A vault just sealed on the in-browser chain: the console starts fresh around it, behind the create flow. */
  const created = useCallback(
    (r: ActionResult) => {
      epochRef.current += 1;
      push(r);
      drillDone.current = false;
      setDrill({ rows: [], report: null, running: false });
      setSettlement(null);
      setAct(1);
      setPersona("owner");
      setEpoch((n) => n + 1);
      setTab("vault");
      if (adapter) void refresh(adapter);
    },
    [adapter, push, refresh],
  );
  const goTab = useCallback((t: TabId) => {
    setTab(t);
    setMoreOpen(false);
  }, []);
  /** A pick from the More list: the list closes and focus goes back to the More button. */
  const pickMore = useCallback((t: TabId) => {
    setTab(t);
    setMoreOpen(false);
    try { moreBtn.current?.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
  }, []);

  // Arriving from the landing page's Lab teaser with no signature yet: make one real one, so there is something to break.
  const seeded = useRef(false);
  useEffect(() => {
    if (tab !== "lab" || !adapter || !vault || seeded.current || !active) return;
    if (adapter.kind !== "demo" || !adapter.lastSignature || adapter.lastSignature()) return;
    if (vault.state !== "ALIVE" && vault.state !== "WARNING") return;
    seeded.current = true;
    void run(() => adapter.checkIn(), "Making a real signature…");
  }, [tab, adapter, vault, active, run]);

  const demoGuide = mode === "demo" && guideOpen && !!adapter;

  const props: TabProps | null = useMemo(
    () =>
      adapter
        ? {
            adapter, vault, busy, run, refresh: () => refresh(adapter), drill, runDrill: startDrill, push, qdayOpen: qday && active,
            introSlot: demoGuide ? (
              <Guide act={act} tab="vault" onAttack={() => goTab("drill")} onLapse={() => goTab("heirs")} onVault={() => goTab("vault")} onStartOver={() => void startOver()} onSkip={closeGuide} busy={busy} />
            ) : null,
            ledgerSlot: <Ledger key={epoch} log={log} />,
            onIntro: mode === "demo" ? openGuide : undefined,
            openSettings: () => setSettings(true),
            mode,
            onSwitchMode: switchMode,
            onStartOver: startOver,
            settlement,
            setSettlement,
            onOpenLab: () => goTab("lab"),
            onStory: mode === "demo" ? openStory : undefined,
            onCreate: mode === "demo" ? openCreate : undefined,
            onLoadLive: mode === "testnet" ? loadLive : undefined,
            persona,
            setPersona,
          }
        : null,
    [adapter, vault, busy, run, refresh, drill, startDrill, push, demoGuide, act, closeGuide, openGuide, startOver, mode, switchMode, settlement, epoch, log, goTab, openStory, openCreate, loadLive, persona, qday, active],
  );

  // Each screen starts at the top.
  useEffect(() => {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* no scrolling here */
    }
  }, [tab]);

  // Arrow keys walk the tabs that are on screen (the More tabs only while they show). Focus follows the selection.
  const navRef = useRef<HTMLElement>(null);
  const onTabKey = (e: React.KeyboardEvent) => {
    const all = [...(navRef.current?.querySelectorAll<HTMLElement>('[role="tab"], .tab-more') ?? [])];
    const list = all.filter((el) => el.getClientRects().length > 0);
    const items = list.length ? list : all;
    const i = items.findIndex((el) => el === document.activeElement);
    if (i < 0) return;
    const next = e.key === "ArrowRight" ? (i + 1) % items.length : e.key === "ArrowLeft" ? (i + items.length - 1) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const el = items[next];
    try {
      el.focus();
      el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } catch {
      /* focus is a convenience */
    }
    const id = el.dataset.tab as TabId | undefined;
    if (id) setTab(id);
  };

  // The More list closes on Escape and on a press anywhere else.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setMoreOpen(false); try { moreBtn.current?.focus({ preventScroll: true }); } catch { /* focus is a convenience */ } } };
    const onDown = (e: Event) => { if (!(e.target as HTMLElement | null)?.closest?.(".tabs")) setMoreOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("pointerdown", onDown); };
  }, [moreOpen]);

  // Opening More puts focus on its first item, so a keyboard or screen-reader user lands inside the list.
  const moreWas = useRef(false);
  useEffect(() => {
    if (moreOpen && !moreWas.current) {
      const first = navRef.current?.querySelector<HTMLElement>(".tabs-more .tab");
      try { first?.focus({ preventScroll: true }); } catch { /* focus is a convenience */ }
    }
    moreWas.current = moreOpen;
  }, [moreOpen]);

  const pending = busy && !drill.running ? pendingLabel || "Working…" : "";
  const noWallet = mode === "testnet" && !testnet.current?.connectedAccount;

  return (
    <div className="app">
      <header className="top">
        <div className="top-l">
          {onBack && (
            <button type="button" className="back" onClick={onBack} aria-label="Back to site">
              <Icon name="arrow-right" size={18} />
              <span className="back-t">Back to site</span>
            </button>
          )}
        </div>
        <div className="brand">
          <LogoMark size={26} />
          <h1 tabIndex={-1}>Heirloom</h1>
        </div>
        <div className="top-r">
          <button className="chip" data-mode={mode} onClick={() => setSettings(true)} aria-label={`${mode === "demo" ? "Demo" : "Testnet"} mode. Open settings`}>
            <span className="dot" aria-hidden="true" />
            {mode === "demo" ? "Demo" : "Testnet"}
          </button>
        </div>
      </header>
      <p className={`strip${mode === "demo" ? " strip--one" : ""}`}>
        {mode === "demo" ? (
          <>Simulated chain · <b>real bytecode + ML-DSA-87</b></>
        ) : noWallet ? (
          <>Live <b>QoreChain testnet</b> · no wallet connected · read only</>
        ) : (
          <>Live <b>QoreChain testnet</b> · your wallet pays gas · the post-quantum key in this page signs</>
        )}
      </p>

      {props && (
        <nav className="tabs" ref={navRef} aria-label="Main navigation" onKeyDown={onTabKey}>
          <div className="tabs-main">
            <div className="tabs-list" role="tablist" aria-label="Screens">
              {MAIN.map(([id, label]) => (
                <button key={id} role="tab" id={`t-${id}`} data-tab={id} aria-selected={tab === id} aria-controls={`p-${id}`} tabIndex={tab === id || (id === "vault" && isMore(tab)) ? 0 : -1} className="tab" onClick={() => goTab(id)}>
                  <Icon name={TAB_ICON[id]} size={22} />
                  <span className="tab-t">{label}</span>
                </button>
              ))}
            </div>
            <button type="button" id="t-more" ref={moreBtn} aria-haspopup="true" aria-expanded={moreOpen} aria-controls="more-tabs" data-current={isMore(tab) ? "true" : "false"} className="tab tab-more" onClick={() => setMoreOpen((o) => !o)}>
              <Icon name="more" size={22} />
              <span className="tab-t">More</span>
              {isMore(tab) && <span className="q-sr"> (current screen is in this list)</span>}
            </button>
          </div>
          <div className={`tabs-more${moreOpen ? " is-open" : ""}`} id="more-tabs" role="tablist" aria-label="More screens">
            {MORE.map(([id, label]) => (
              <button key={id} role="tab" id={`t-${id}`} data-tab={id} aria-selected={tab === id} aria-controls={`p-${id}`} tabIndex={tab === id || moreOpen ? 0 : -1} className="tab" onClick={() => pickMore(id)}>
                <Icon name={TAB_ICON[id]} size={22} />
                <span className="tab-t">{label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      <main>
        {!adapter && !bootErr && <Boot steps={bootSteps.length ? bootSteps : [bootMsg]} mode={mode} />}
        {bootErr && (
          <div className="fail" role="alert">
            <div className="q-eyebrow" style={{ color: "var(--dead)" }}>Start failed</div>
            <h2 className="q-display">Could not start</h2>
            <p className="q-muted" style={{ margin: "12px 0 0" }}>{bootErr}</p>
            <p className="small">You can try the other mode. Nothing here holds real value.</p>
            <button className="q-btn q-btn--block" style={{ marginTop: 20 }} onClick={() => switchMode(mode === "demo" ? "testnet" : "demo")}>Switch to {mode === "demo" ? "Testnet" : "Demo"} mode</button>
          </div>
        )}
        {props && demoGuide && tab !== "vault" && tab !== "lab" && (
          <Guide compact act={act} tab={tab} onAttack={() => goTab("drill")} onLapse={() => goTab("heirs")} onVault={() => goTab("vault")} onStartOver={() => void startOver()} onSkip={closeGuide} busy={busy} />
        )}
        {props && (
          <section role="tabpanel" id={`p-${tab}`} aria-labelledby={`t-${tab}`} key={`${tab}-${epoch}`}>
            {tab === "vault" && <VaultTab {...props} />}
            {tab === "lab" && <LabScreen {...props} />}
            {tab === "drill" && <DrillTab {...props} />}
            {tab === "heirs" && <HeirsTab {...props} />}
            {tab === "agent" && <AgentTab {...props} />}
            {tab === "withdraw" && <WithdrawTab {...props} />}
            {tab === "keys" && <KeysTab {...props} />}
          </section>
        )}
      </main>

      {props && tab !== "vault" && <Ledger key={epoch} log={log} />}

      <div className="pending" role="status">{pending && <><span className="spin" aria-hidden="true" />{pending}</>}</div>

      {adapter && <QDayMode open={qday && active} onClose={() => setQday(false)} adapter={adapter} drill={drill} runDrill={runDrillRaw} />}

      {overlay === "story" && active && <Story onDone={() => finishStory("create")} onSkip={() => finishStory(null)} />}
      {overlay === "create" && active && (
        <FullScreen label="Create your vault" className="fs--create" onEscape={() => { if (!createBusy.current) closeCreate(); }}>
          <div className="fs-brand"><LogoMark size={22} /><span>Heirloom</span></div>
          {adapter ? <CreateFlow adapter={adapter} onCreated={closeCreate} onCancel={closeCreate} onSealed={created} onBusyChange={(b) => { createBusy.current = b; }} /> : <div className="fs-wait"><p className="q-mono"><span className="spin" aria-hidden="true" /> Preparing the in-browser chain…</p></div>}
        </FullScreen>
      )}

      {settings && active && (
        <Sheet title="Settings" onClose={() => setSettings(false)}>
          <SettingsBody
            mode={mode}
            setMode={switchMode}
            testnet={testnet.current ?? (testnet.current = new TestnetAdapter())}
            busy={busy}
            onChanged={() => adapter && void refresh(adapter)}
            onReset={startOver}
            demoReady={mode === "demo" && !!adapter}
            suggested={suggested}
            onIntro={mode === "demo" ? openGuide : undefined}
            onStory={mode === "demo" ? openStory : undefined}
            onCreate={mode === "demo" ? openCreate : undefined}
          />
        </Sheet>
      )}
    </div>
  );
}

/** The Lab screen: the signature under glass, with one way to make a signature when there is none yet. */
function LabScreen(p: TabProps) {
  const { adapter, busy, run, refresh, vault } = p;
  const has = !!adapter.lastSignature?.();
  const live = !!vault && (vault.state === "ALIVE" || vault.state === "WARNING" || vault.state === "OVERDUE");
  const canSign = adapter.kind === "demo" && !!adapter.labAttempt && !has && !!vault && (vault.state === "ALIVE" || vault.state === "WARNING");
  const locked = adapter.kind === "demo" && !!adapter.labAttempt && !live;
  // The lab itself words it: "This vault is {reason}. Start over to try the lab."
  const lockedReason = vault && vault.state !== "NONE" ? vault.state.toLowerCase() : "missing";
  return (
    <>
      <SignatureLab adapter={adapter} busy={busy} run={run} refresh={refresh} locked={locked} lockedReason={lockedReason} />
      {canSign && (
        <div className="labseed">
          <button className="q-btn q-btn--block" disabled={busy} onClick={() => void run(() => adapter.checkIn(), "Signing with ML-DSA-87…")}>Sign a heartbeat to begin</button>
        </div>
      )}
      {locked && p.onStartOver && (
        <div className="labseed">
          <button className="q-btn q-btn--block" disabled={busy} onClick={() => void p.onStartOver!()}>Start over</button>
        </div>
      )}
    </>
  );
}
