import { useEffect, useState, type ReactNode } from "react";
import type { ActionResult, Adapter, DrillReport, DrillRow, Hex, SignatureInspect, VaultView } from "../chain/types";
import { LatticeCore, type LatticeState } from "../brand/LatticeCore";
import { Icon } from "../brand/icons";
import { Fact, Facts, Result, ScreenHead, Sec, Why } from "./kit";
import { SignVisual } from "./SignVisual";
import { HeirView, PersonaSwitch, type Persona } from "./heir";
import { bytesLabel, copyText, fmtAmount, fmtDate, fmtDuration, parseAmount, prefersReducedMotion, short, tokenOf } from "./format";

export interface TabProps {
  adapter: Adapter;
  vault: VaultView | null;
  busy: boolean;
  /** `label` is the pending line shown while it runs (default "Working…"). */
  run: (fn: () => Promise<ActionResult>, label?: string) => Promise<ActionResult>;
  refresh: () => Promise<void>;
  drill: { rows: DrillRow[]; report: DrillReport | null; running: boolean; error?: string };
  /** True while the Q-Day takeover covers the screen: this screen then stays silent so nothing is announced twice. */
  qdayOpen?: boolean;
  runDrill: () => Promise<void>;
  push: (r: ActionResult) => void;
  /** Inline first-run stepper, rendered on the Vault screen when open. */
  introSlot?: ReactNode;
  /** The activity ledger, shown inside the Vault screen (right column on desktop). */
  ledgerSlot?: ReactNode;
  onIntro?: () => void;
  openSettings?: () => void;
  mode?: "demo" | "testnet";
  onSwitchMode?: (m: "demo" | "testnet") => void;
  /** Resets the sample vault (demo only). Never labelled "Reset the demo": that is the Settings button. */
  onStartOver?: () => void | Promise<void>;
  /** What each heir received at settlement, kept above the tabs so it survives a tab change. */
  settlement?: Settlement | null;
  setSettlement?: (s: Settlement | null) => void;
  /** Opens the Signature lab screen. */
  onOpenLab?: () => void;
  /** Replays the Q-Day briefing (demo only). */
  onStory?: () => void;
  /** Opens the create flow (demo only). */
  onCreate?: () => void;
  /** Who is looking at the Heirs screen. Kept above the tabs so it survives a tab change. */
  persona?: Persona;
  setPersona?: (p: Persona) => void;
}

export type Settlement = { label: string; amounts: string }[];

const NATIVE: Hex = "0x0000000000000000000000000000000000000000";
const DAY = 86400;
/** The testnet adapter uses "0x" for an address it does not know yet. */
const pa = (a: string) => (a === "0x" ? "" : a);
const isOwnerActive = (v: VaultView) => v.state === "ALIVE" || v.state === "WARNING" || v.state === "OVERDUE";
/** Pending line for actions signed with the ML-DSA-87 key (the owner's, or an heir's). */
const SIGN = "Signing with ML-DSA-87…";
const addrProps = { spellCheck: false, autoComplete: "off", autoCorrect: "off", autoCapitalize: "none" } as const;

/** Runs an action and keeps its result for an inline result line on the current screen. */
function useAct(p: TabProps) {
  const [r, setR] = useState<ActionResult | null>(null);
  const act = async (fn: () => Promise<ActionResult>, label?: string) => {
    const res = await p.run(fn, label);
    setR(res);
    return res;
  };
  return [r, act] as const;
}

/** "Start over to get a fresh vault." with its button. Demo only: the sample vault can be rebuilt, a testnet vault cannot. */
function Fresh({ p }: { p: TabProps }) {
  if (p.adapter.kind !== "demo" || !p.onStartOver) return null;
  // Only an empty, settled or closed vault is a dead end. A live or triggered one is mid-story.
  if (p.vault && p.vault.state !== "SETTLED" && p.vault.state !== "CLOSED" && p.vault.state !== "NONE") return null;
  return (
    <div className="fresh">
      <p className="small">Start over to get a fresh vault.</p>
      <div className="pair">
        <button className="q-btn q-btn--ghost q-btn--sm" disabled={p.busy} onClick={() => void p.onStartOver!()}>Start over</button>
        {p.onCreate && <button className="q-btn q-btn--ghost q-btn--sm" disabled={p.busy} onClick={p.onCreate}>Build a new vault</button>}
      </div>
    </div>
  );
}

function Empty({ p, eyebrow, title }: { p: TabProps; eyebrow: string; title: string }) {
  const testnet = p.adapter.kind === "testnet";
  return (
    <div className="screen">
      <ScreenHead eyebrow={eyebrow} title={title} />
      <div className="empty">
        <LatticeCore state="NONE" size={140} />
        <h3>No vault yet</h3>
        {testnet ? (
          <>
            <p>The vault contract is not deployed to testnet yet, so there is nothing to load today. A sample vault will be readable here once it is. QoreX is a wallet browser: open this page in it to sign. Demo mode needs nothing.</p>
            <ol className="nsteps">
              <li><span>01</span>Connect your wallet in QoreX, or skip this to read only.</li>
              <li><span>02</span>Enter the vault contract address and the vault id.</li>
              <li><span>03</span>Load the vault, or create one pinned to this page's key.</li>
            </ol>
            <div className="pair">
              {p.openSettings && <button className="q-btn q-btn--sm" onClick={p.openSettings}>Open settings</button>}
              {p.onSwitchMode && <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => p.onSwitchMode!("demo")}>Switch to Demo mode</button>}
            </div>
          </>
        ) : (
          <>
            <p>The sample vault is gone. A fresh one takes a few seconds.</p>
            {p.onStartOver ? <button className="q-btn q-btn--sm" style={{ marginTop: 16 }} disabled={p.busy} onClick={() => void p.onStartOver!()}>Start over</button> : p.openSettings && <button className="q-btn q-btn--ghost q-btn--sm" style={{ marginTop: 16 }} onClick={p.openSettings}>Open settings</button>}
          </>
        )}
      </div>
    </div>
  );
}

const MEANING: Record<string, string> = {
  ALIVE: "Checked in on time. Your heirs cannot claim anything.",
  WARNING: "A check-in is late. Check in now and the vault stays yours.",
  OVERDUE: "Warning and grace have passed with no check-in. Anyone can trigger the vault now.",
  TRIGGERED: "Triggered, ready to settle. Anyone can settle it and pay your heirs.",
  SETTLED: "The vault is settled and your heirs have been paid.",
  CLOSED: "The vault is closed. Nothing is left to protect.",
  NONE: "There is no vault here yet.",
};

export function VaultTab(p: TabProps) {
  const { vault: v, adapter, busy } = p;
  const [r, act] = useAct(p);
  const [beat, setBeat] = useState(0);
  const [sign, setSign] = useState<{ sig: SignatureInspect; res: ActionResult; k: number } | null>(null);
  if (!v) return <Empty p={p} eyebrow="Vault" title="Nothing sealed yet" />;
  const native = v.balances.find((b) => b.token === NATIVE)?.amount ?? 0n;
  const others = v.balances.filter((b) => b.token !== NATIVE);
  const alive = isOwnerActive(v);
  const left = v.deadline - v.now;
  const span = Math.max(1, v.deadline - v.lastCheckin);
  const progress = Math.max(0, Math.min(1, left / span));
  const sub = alive ? (left > 0 ? `next deadline in ${fmtDuration(left)}` : `overdue by ${fmtDuration(-left)}`) : undefined;
  const keyLine = v.keyMode === "DEVICE" ? "Device key, ML-DSA-87" : "Account key";
  return (
    <div className="screen screen--vault">
      <h2 className="q-sr">Your vault</h2>
      <div className="vault-grid">
        <div className="hero">
          <div className="hero-core">
            <LatticeCore state={v.state as LatticeState} size="100%" tone="ice" progress={progress} label={v.state.toLowerCase()} sublabel={sub} beat={beat} />
          </div>
          <div className="hero-id">
            <span className="q-mono">{adapter.kind === "demo" ? (v.heirs.length ? v.heirs.map((h) => `${h.label} ${(h.bps / 100).toFixed(h.bps % 100 ? 1 : 0)}%`).join(" · ") : "Your vault") : `vault ${short(`0x${v.id.toString(16)}`, 8, 4)}`}</span>
          </div>
          <p className="hero-spec q-mono">ML-DSA-87 · FIPS 204 · pk {bytesLabel(2592)} · sig {bytesLabel(4627)}</p>
          <p className="hero-mean">{MEANING[v.state]}</p>
          <div className="hero-act">
            <button className="q-btn q-btn--lg q-btn--primary-glow" disabled={busy || !alive} onClick={async () => {
              setSign(null);
              const res = await act(() => adapter.checkIn(), SIGN);
              if (!res.ok) return;
              // The adapter keeps the signature it just made: typeset it. Without one (testnet) the lattice just beats.
              const sig = adapter.lastSignature?.() ?? null;
              if (sig) setSign({ sig, res, k: Date.now() });
              else setBeat((n) => n + 1);
            }}>
              <Icon name="check" size={20} /> Check in
            </button>
            {sign && alive ? <SignVisual key={sign.k} sig={sign.sig} res={sign.res} onBeat={() => setBeat((n) => n + 1)} onLab={p.onOpenLab} />
              : alive ? <p className="small" style={{ margin: 0 }}>Signs with ML-DSA-87 and resets the deadline.{p.onOpenLab && adapter.lastSignature?.() ? <> <button type="button" className="textbtn sv-link" onClick={p.onOpenLab}>See the signature</button></> : null}</p>
              : <Why>Check-in is closed. This vault is {v.state.toLowerCase()}.</Why>}
            {!alive && <Fresh p={p} />}
            <Result r={r} />
          </div>
        </div>

        {p.introSlot && <div className="vault-guide">{p.introSlot}</div>}

        <div className="vault-rest">
          <div className="balance">
            <div className="q-eyebrow">Balance</div>
            <div className="amt" style={{ marginTop: 10 }}>{fmtAmount(native, 18, 2)}<small>QOR</small></div>
          </div>
          <Facts>
            {others.map((b) => {
              const t = tokenOf(adapter.tokens, b.token);
              return <Fact key={b.token} k={t.symbol} v={fmtAmount(b.amount, t.decimals, 2)} />;
            })}
            <Fact k="Check-in every" v={`${fmtDuration(v.interval)}`} />
            <Fact k="Warning from" v={fmtDate(v.warningAt)} />
            <Fact k="Grace" v={`${v.grace} missed check-ins`} />
            <Fact k="Anyone can trigger after" v={fmtDate(v.deadline)} tone={left > 0 ? undefined : "dead"} />
            <Fact k="Heirs" v={`${v.heirs.length}`} />
            {v.bounty > 0n && <Fact k="Keeper bounty" v={`${fmtAmount(v.bounty, 18, 2)} QOR, paid to whoever triggers`} />}
            <Fact k="Key" v={keyLine} tone="ice" />
            <Fact k="Last check-in" v={fmtDate(v.lastCheckin)} />
          </Facts>

          {adapter.kind === "demo" && (
            <Sec eyebrow="Demo clock" lede="Skip time to watch the vault move from alive to warning to overdue.">
              <div className="pair">
                <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy} onClick={() => act(() => adapter.advance(DAY))}>Skip 1 day</button>
                <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy} onClick={() => act(() => adapter.advance(7 * DAY))}>Skip 7 days</button>
              </div>
            </Sec>
          )}
          <p className="small">Every action you sign counts as a check-in. A vault left alone past its deadline can be triggered by anyone and pays your heirs.</p>
          <div className="replay">
            {p.onStory && <button className="q-link howlink" onClick={p.onStory}>Replay the briefing</button>}
            {p.onIntro && <button className="q-link howlink" onClick={p.onIntro}>Replay the guided run</button>}
          </div>
          {p.ledgerSlot}
        </div>
      </div>
    </div>
  );
}

export function KeysTab(p: TabProps) {
  const { adapter, busy, vault } = p;
  const info = adapter.deviceKey();
  const [rRot, actRot] = useAct(p);
  const [rImp, actImp] = useAct(p);
  const [shownFor, setShownFor] = useState<{ text: string; key: string } | null>(null);
  // A backup string belongs to one key: after an import or a rotation it must not stay on screen as if current.
  const shown = shownFor && shownFor.key === info.pubkeyHash ? shownFor.text : null;
  const setShown = (text: string | null) => setShownFor(text === null ? null : { text, key: info.pubkeyHash });
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  const [imp, setImp] = useState("");
  const [confirmRot, setConfirmRot] = useState(false);
  const [ask, setAsk] = useState<ActionResult | null>(null);
  const [rotBackup, setRotBackup] = useState<string | null>(null);
  const [rotSaved, setRotSaved] = useState(false);
  const twoStep = !!adapter.prepareRotation;
  const pinned = vault ? (vault.pubkeyHash.toLowerCase() === info.pubkeyHash.toLowerCase() ? "this key" : vault.keyMode === "ACCOUNT" ? "account key" : "another key") : "no vault";
  const canRotate = !!vault && vault.keyMode === "DEVICE";
  return (
    <div className="screen">
      <ScreenHead eyebrow="Keys" title="Your post-quantum key">This key lives only in this page. The vault stores only its hash, and every action carries a fresh 4,627-byte signature from it.</ScreenHead>
      <Sec>
        <Facts>
          <Fact k="Scheme" v="ML-DSA-87" tone="ice" />
          <Fact k="Fingerprint" v={short(info.pubkeyHash, 10, 8)} tone="ice" />
          <Fact k="Public key size" v={bytesLabel(info.pubkeyBytes)} />
          <Fact k="Signature size" v={bytesLabel(info.sigBytes)} />
          <Fact k="Pinned in vault" v={pinned} />
        </Facts>
      </Sec>

      <Sec eyebrow="Backup" title="Back up the key" lede="The key lives in this page's memory. Without a backup it is gone when you close the page.">
        {shown === null ? (
          <button className="q-btn q-btn--ghost q-btn--block" onClick={() => setShown(adapter.exportKey())}>Show backup string</button>
        ) : (
          <>
            <label className="f">Backup string. Keep it private.
              <textarea className="q-field" readOnly value={shown} {...addrProps} autoCapitalize="off" onFocus={(e) => e.currentTarget.select()} />
            </label>
            <div className="pair stack">
              <button className="q-btn q-btn--ghost q-btn--sm" onClick={async () => setCopied((await copyText(shown)) ? "yes" : "no")}><Icon name="copy" size={16} /> Copy</button>
              <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => { setShown(null); setCopied(null); }}>Hide</button>
            </div>
            {copied === "yes" && <Why role="status">Copied. The backup string stays on your clipboard until you copy something else.</Why>}
            {copied === "no" && <Why tone="warn" role="status">Copy was blocked. Select the text above and copy it by hand.</Why>}
          </>
        )}
      </Sec>

      <Sec eyebrow="Restore" title="Restore from a backup" lede="Paste a backup string to use that key in this page.">
        <label className="f">Backup string
          <textarea className="q-field" value={imp} {...addrProps} autoCapitalize="off" onChange={(e) => { setImp(e.target.value); setAsk(null); }} placeholder="qdmv1:…" />
        </label>
        <div className="stack">
          <button className="q-btn q-btn--ghost q-btn--block" disabled={busy || imp.trim() === ""} onClick={() => actImp(async () => { const res = await adapter.importKey(imp); if (res.needsConfirm) setAsk(res); else if (res.ok) setImp(""); return res; })}>Import key</button>
        </div>
        {imp.trim() === "" && <Why>Paste a backup string above to enable import.</Why>}
        <Result r={rImp} />
        {ask && (
          <div className="res bad" role="alert">
            <b>Import this key?</b>
            <span>{ask.detail}</span>
            <div className="pair stack">
              <button className="q-btn q-btn--danger q-btn--sm" disabled={busy} onClick={() => actImp(async () => { const res = await adapter.importKey(imp, true); setAsk(null); if (res.ok) setImp(""); return res; })}>Import anyway</button>
              <button className="q-btn q-btn--ghost q-btn--sm" onClick={() => setAsk(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Sec>

      <Sec eyebrow="Rotate" title="Rotate the key" lede="Make a new key, sign the switch with the old one, and prove you hold the new one. The old key stops working.">
        {twoStep ? (
          rotBackup === null ? (
            <button className="q-btn q-btn--ghost q-btn--block" disabled={busy || !canRotate} onClick={() => { setRotBackup(adapter.prepareRotation!()); setRotSaved(false); }}>Make a new key</button>
          ) : (
            <>
              <label className="f">Backup string of the NEW key. Save it before you rotate.
                <textarea className="q-field" readOnly value={rotBackup} {...addrProps} autoCapitalize="off" onFocus={(e) => e.currentTarget.select()} />
              </label>
              <div className="stack">
                {!rotSaved ? (
                  <button className="q-btn q-btn--ghost q-btn--block" onClick={() => { adapter.confirmRotationBackup!(); setRotSaved(true); }}>I saved the new backup string</button>
                ) : (
                  <button className="q-btn q-btn--danger q-btn--block" disabled={busy} onClick={() => void actRot(async () => { const res = await adapter.rotateKey(); if (res.ok) { setRotBackup(null); setRotSaved(false); } return res; }, SIGN)}>Rotate now</button>
                )}
              </div>
            </>
          )
        ) : !confirmRot ? (
          <button className="q-btn q-btn--ghost q-btn--block" disabled={busy || !canRotate} onClick={() => setConfirmRot(true)}>Rotate device key</button>
        ) : (
          <div className="pair">
            <button className="q-btn q-btn--danger" disabled={busy} onClick={() => { setConfirmRot(false); void actRot(() => adapter.rotateKey(), SIGN); }}>Rotate now</button>
            <button className="q-btn q-btn--ghost" onClick={() => setConfirmRot(false)}>Cancel</button>
          </div>
        )}
        {vault && vault.keyMode !== "DEVICE" && <Why>Only device-key vaults rotate here.</Why>}
        {!vault && <Why>Rotation needs a vault. Open Settings to load or create one.</Why>}
        <Result r={rRot} />
      </Sec>
    </div>
  );
}

export function WithdrawTab(p: TabProps) {
  const { adapter, busy, vault } = p;
  const [r, act] = useAct(p);
  const [token, setToken] = useState<Hex>(NATIVE);
  const [amount, setAmount] = useState("25");
  const [to, setTo] = useState<string>(pa(adapter.parties.you.address));
  const [pq, setPq] = useState(true);
  if (!vault) return <Empty p={p} eyebrow="Withdraw" title="Move value out" />;
  const t = tokenOf(adapter.tokens, token);
  const amt = parseAmount(amount, t.decimals);
  const toOk = /^0x[0-9a-fA-F]{40}$/.test(to);
  const chips: [string, Hex][] = [["You", adapter.parties.you.address], ["Payee", adapter.parties.payee.address], ["New address", adapter.parties.stranger.address]];
  const locked = !isOwnerActive(vault);
  const reason = amt === null || amt === 0n ? "Enter an amount above zero." : !toOk ? "Enter a full 0x address to send to." : null;
  return (
    <div className="screen">
      <ScreenHead eyebrow="Withdraw" title="Move value out">Only your post-quantum signature can send money where you choose. The agent's capped allowance and your heirs' payouts follow rules you signed.</ScreenHead>
      <Sec>
        <label className="f" style={{ marginTop: 0 }}>Asset
          <select className="q-field" value={token} onChange={(e) => setToken(e.target.value as Hex)}>
            {vault.balances.map((b) => <option key={b.token} value={b.token}>{tokenOf(adapter.tokens, b.token).symbol}</option>)}
          </select>
        </label>
        <label className="f">Amount
          <input className="q-field mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="f">Send to
          <input className="q-field mono" value={to} onChange={(e) => setTo(e.target.value.trim())} {...addrProps} placeholder="0x…" aria-invalid={to !== "" && !toOk} />
        </label>
        {adapter.kind === "demo" && (
          <div className="chips">
            {chips.map(([l, a]) => <button key={l} className="pillbtn" aria-pressed={to.toLowerCase() === a.toLowerCase()} onClick={() => setTo(a)}>{l}</button>)}
          </div>
        )}
        <label className="switch">
          <span>Sign with ML-DSA-87{!pq && <span className="errname"> (the vault will refuse this)</span>}</span>
          <input type="checkbox" checked={pq} onChange={(e) => setPq(e.target.checked)} />
        </label>
        <div className="stack">
          <button className="q-btn q-btn--lg q-btn--block" disabled={busy || amt === null || amt === 0n || !toOk} onClick={() => act(() => adapter.withdraw({ token, amount: amt!, to: to as Hex, pq }), pq ? SIGN : "Sending without a signature…")}>
            {pq ? "Withdraw" : "Try without a signature"}
          </button>
        </div>
        {reason && <Why>{reason}</Why>}
        <Result r={r} />
        {locked && <Why tone="warn" role="status">This vault is {vault.state.toLowerCase()}. Owner actions are locked, so the contract will refuse a withdrawal.</Why>}
        {locked && <Fresh p={p} />}
      </Sec>
    </div>
  );
}

const ATTACKS_SHOWN = 6;

export function DrillTab(p: TabProps) {
  const { drill, runDrill, busy, adapter } = p;
  const rows = drill.rows;
  const [showAll, setShowAll] = useState(false);
  // Rows are revealed one by one for the eye only. The result is already in `drill`; reduced motion shows it at once.
  const [revealed, setRevealed] = useState(() => (drill.report ? drill.rows.length : 0));
  const target = showAll ? rows.length : Math.min(rows.length, ATTACKS_SHOWN);
  useEffect(() => {
    if (revealed > rows.length) {
      setRevealed(rows.length);
      return;
    }
    if (revealed >= target) return;
    if (prefersReducedMotion()) {
      setRevealed(target);
      return;
    }
    const t = setTimeout(() => setRevealed((n) => Math.min(n + 1, target)), 350);
    return () => clearTimeout(t);
  }, [revealed, rows.length, target]);

  if (adapter.kind !== "demo") {
    return (
      <div className="screen">
        <ScreenHead eyebrow="Q-Day drill" title="Attack the vault">A bot steals your classical key and tries to drain the vault.</ScreenHead>
        <Sec>
          <Why>The drill runs in Demo mode. The live Q-Day drill is a separate event on the testnet.</Why>
          {p.onSwitchMode && <button className="q-btn q-btn--sm" style={{ marginTop: 16 }} onClick={() => p.onSwitchMode!("demo")}>Switch to Demo mode</button>}
        </Sec>
      </div>
    );
  }
  const rep = drill.report;
  const v = p.vault;
  const active = !!v && isOwnerActive(v);
  const funded = !!v && v.balances.some((b) => b.amount > 0n);
  const canRun = active && funded;
  const tried = rep?.tried ?? rows.length;
  const blocked = rep?.blocked ?? rows.filter((r) => r.blocked).length;
  const breached = rep ? rep.blocked < rep.tried : rows.some((r) => !r.blocked);
  const latState: LatticeState = drill.running ? "WARNING" : rep ? (breached ? "TRIGGERED" : "ALIVE") : "NONE";
  const shownRows = rows.slice(0, Math.min(revealed, target));
  const verdictReady = !!rep && revealed >= Math.min(rows.length, ATTACKS_SHOWN);
  const finalLine = rep ? (breached ? `${rep.tried - rep.blocked} attempts got through. Value kept: ${rep.valueKept || "unknown"}.` : `Value kept: ${Math.round(rep.valueKeptPct)}%. The stolen key moved nothing.`) : "";
  return (
    <div className="screen">
      <ScreenHead eyebrow="Q-Day drill" title="Attack the vault">A bot steals your classical key, the one a quantum computer can break, and tries to drain the vault. It never has your post-quantum key.</ScreenHead>

      <div className="stack">
        <button className="q-btn q-btn--signal q-btn--lg q-btn--block" disabled={busy || drill.running || !canRun} onClick={() => { setShowAll(false); setRevealed(0); void runDrill(); }}>
          {drill.running ? "Attacking…" : rows.length ? "Run the Q-Day drill again" : "Run the Q-Day drill"}
        </button>
      </div>
      {!canRun && <Why role="status">Vault is empty or no longer active.</Why>}
      {!canRun && <Fresh p={p} />}

      {/* Announced once, when the drill is over. Nothing here speaks while attempts arrive. */}
      <div className="q-sr" role="status">{verdictReady && !p.qdayOpen ? `${finalLine} ${rep!.blocked} of ${rep!.tried} attacks blocked.` : ""}</div>

      {(rep || rows.length > 0) && (
        <div className={`verdict${breached ? " bad" : ""}`}>
          {verdictReady && rep ? (
            <>
              <div className="big">{finalLine}</div>
              <div className="sub"><em>{rep.blocked} of {rep.tried}</em> attacks blocked</div>
              <div className="run">{rep.distinctPaths} distinct attack paths, {rep.reachedVerifier} reached the ML-DSA-87 verifier, {rep.blocked} blocked, value kept {rep.valueKept || "–"}.</div>
            </>
          ) : (
            <div className="sub"><em>{blocked} of {tried}</em> blocked so far</div>
          )}
        </div>
      )}
      {verdictReady && rep && <Why>{rep.scope}</Why>}

      <div className="drill-lattice"><LatticeCore state={latState} size={150} tone="ice" /></div>
      <div className="versus">
        <div><span className="q-eyebrow sig">Attacker</span><b>Stolen classical key</b>Signs as you. Not post-quantum.</div>
        <div><span className="q-eyebrow">Vault</span><b>ML-DSA-87 verifier</b>Checks every call on chain.</div>
      </div>

      {(rows.length > 0 || drill.running) && (
        <Sec eyebrow="Attack log" title="Every attempt">
          <ol className="attacks" aria-busy={drill.running}>
            {shownRows.map((r, i) => (
              <li className="atk" key={i}>
                <div className="atk-h">
                  <strong>{r.name}</strong>
                  <span className={`mark ${r.harmless ? "noeffect" : r.blocked ? "blocked" : "failed"}`}>{r.harmless ? "no effect" : r.blocked ? "refused" : "got through"}</span>
                </div>
                <p className="how">{r.how}</p>
                <p className="vl">Vault answered <span className="errname">{r.revert}</span> · moved {r.valueMoved}</p>
              </li>
            ))}
            {drill.running && <li className="atk pending"><div className="atk-h"><strong className="dots">Next attack</strong></div></li>}
          </ol>
          {!showAll && rows.length > ATTACKS_SHOWN && (
            <button className="textbtn showall" onClick={() => { setShowAll(true); setRevealed(rows.length); }}>Show all {rows.length} attempts</button>
          )}
        </Sec>
      )}
    </div>
  );
}

export function HeirsTab(p: TabProps) {
  const { adapter, busy, vault } = p;
  const [r, act] = useAct(p);
  const [split, setSplit] = useState<number | null>(null);
  const [payout, setPayout] = useState<Record<number, string>>({});
  const [localPersona, setLocalPersona] = useState<Persona>("owner");
  const persona = p.persona ?? localPersona;
  const setPersona = p.setPersona ?? setLocalPersona;
  if (!vault) return <Empty p={p} eyebrow="Heirs" title="Who inherits" />;
  const bpsA = split ?? vault.heirs[0]?.bps ?? 6000;
  const nameA = vault.heirs[0]?.label ?? "Maya";
  const nameB = vault.heirs[1]?.label ?? "Leo";
  const canTrigger = vault.state === "OVERDUE";
  const canSettle = vault.state === "TRIGGERED";
  const active = isOwnerActive(vault);
  const demo = adapter.kind === "demo";
  const canSkip = demo && active && vault.state !== "OVERDUE";
  const opts: [string, Hex][] = [[nameA, adapter.parties.heirA.address], [nameB, adapter.parties.heirB.address], ["New wallet", adapter.parties.stranger.address]];
  const payNote =
    vault.state === "OVERDUE" ? "Warning and grace have passed with no check-in. Anyone can trigger the vault now."
    : vault.state === "TRIGGERED" ? "Triggered, ready to settle. Anyone can settle and pay the heirs."
    : vault.state === "SETTLED" ? "Settled. Heirs have been paid."
    : demo ? "The vault is not overdue. Skip to overdue to see it lapse, or wait."
    : "On testnet the clock is real, so this waits for the deadline.";
  // Only the next step is the solid button.
  const next = canSettle ? "settle" : canTrigger ? "trigger" : canSkip ? "skip" : null;
  const settle = async () => {
    // Pre-settle balances times shares. The last heir takes the remainder, so the shares add up to the whole balance.
    const pre = vault.balances.filter((b) => b.amount > 0n);
    const heirs = vault.heirs.map((h) => ({ label: h.label, bps: BigInt(h.bps) }));
    const res = await act(() => adapter.settle());
    if (res.ok) {
      const given = pre.map(() => 0n);
      p.setSettlement?.(
        heirs.map((h, hi) => {
          const last = hi === heirs.length - 1;
          const parts = pre.map((b, bi) => {
            const share = last ? b.amount - given[bi] : (b.amount * h.bps) / 10000n;
            given[bi] += share;
            const t = tokenOf(adapter.tokens, b.token);
            return share > 0n ? `${fmtAmount(share, t.decimals)} ${t.symbol}` : "";
          }).filter(Boolean);
          return { label: h.label, amounts: parts.join(", ") || "nothing" };
        }),
      );
    }
  };
  const st = p.settlement;
  const payoff = vault.state === "SETTLED" && st && st.length > 0 && (
    <div className="res ok payoff" role="status">
      <b>Settled. {st.map((l, i) => {
        // A payout that is still waiting to be claimed is owed, not received.
        const owed = (vault.heirs[i]?.claimable ?? []).filter((c) => c.amount > 0n).map((c) => { const t = tokenOf(adapter.tokens, c.token); return `${fmtAmount(c.amount, t.decimals)} ${t.symbol}`; });
        const got = l.amounts !== "nothing";
        if (owed.length && got) return `${l.label} received ${l.amounts}, and is owed ${owed.join(", ")} (claim below)`;
        return owed.length ? `${l.label} is owed ${owed.join(", ")} (claim below)` : `${l.label} received ${l.amounts}`;
      }).join(". ")}.</b>
      <span>{vault.bounty > 0n ? `${fmtAmount(vault.bounty, 18, 2)} QOR` : "The keeper bounty"} went to the keeper who triggered it. Fixed shares of the rest, paid by the contract.</span>
    </div>
  );
  return (
    <div className="screen">
      <ScreenHead eyebrow="Heirs" title="Who inherits">If you stop checking in, the vault pays the people named here, in the shares you set. Nobody can claim while you keep checking in.</ScreenHead>
      <div className="persona-bar">
        <PersonaSwitch value={persona} onChange={setPersona} />
        <p className="persona-state">Vault state <span className={`q-badge q-badge--${vault.state.toLowerCase()}`}>{vault.state.toLowerCase()}</span></p>
      </div>

      {persona === "owner" && (
        <>
          <Sec eyebrow="Dead man's switch" title="When you stop checking in" lede={payNote}>
            <div className="clockrow">
              <div className="clockrow-core">
                <LatticeCore state={vault.state as LatticeState} size={120} tone="ice" progress={active ? Math.max(0, Math.min(1, (vault.deadline - vault.now) / Math.max(1, vault.deadline - vault.lastCheckin))) : undefined} />
              </div>
              {demo && active && (
                <div className="clockbar">
                  <span className="q-eyebrow">Time control</span>
                  <div className="pair">
                    <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy} onClick={() => act(() => adapter.advance(DAY))}>Skip 1 day</button>
                    <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy} onClick={() => act(() => adapter.advance(7 * DAY))}>Skip 7 days</button>
                  </div>
                </div>
              )}
            </div>
            <div className="stack">
              {demo && active && vault.state !== "OVERDUE" && (
                <button className={`q-btn q-btn--block${next === "skip" ? "" : " q-btn--ghost"}`} disabled={busy} onClick={() => act(() => adapter.advance(Math.max(1, Math.ceil((vault.deadline - vault.now + 1) / DAY)) * DAY))}>Skip to overdue</button>
              )}
              {(canTrigger || canSettle) && (
                <button className="q-btn q-btn--block" disabled={busy} onClick={() => setPersona("stranger")}>Continue as a stranger</button>
              )}
            </div>
            {!canTrigger && !canSettle && vault.state !== "SETTLED" && <Why>Nobody can trigger the vault until it is overdue. Then a stranger can trigger it and pay your heirs.</Why>}
            <Result r={r} />
            {payoff}
            {(vault.state === "SETTLED" || vault.state === "CLOSED") && <Fresh p={p} />}
          </Sec>

          <Sec eyebrow="Beneficiaries" title="Named heirs" lede="Shares are fixed by the contract. Each heir is paid to the address shown.">
            {vault.heirs.length === 0 && <Why>No heirs are set on this vault.</Why>}
            {vault.heirs.map((h, i) => (
              <div className="heir" key={i}>
                <div className="heir-h"><strong>{h.label}</strong><span className="pct">{(h.bps / 100).toFixed(0)}%</span></div>
                <div className="meta">pays to {short(h.payoutTo, 8, 6)}</div>
                {h.claimable.filter((c) => c.amount > 0n).map((c) => {
                  const t = tokenOf(adapter.tokens, c.token);
                  return <button key={c.token} className="q-btn q-btn--sm q-btn--block" disabled={busy} onClick={() => act(() => adapter.claim(i, c.token))}>Claim {fmtAmount(c.amount, t.decimals)} {t.symbol}</button>;
                })}
                {vault.state !== "CLOSED" && demo && (
                  <details className="payout">
                    <summary>Change where {h.label} gets paid</summary>
                    <label className="f">Signed with {h.label}'s key
                      <select className="q-field" value={payout[i] ?? ""} onChange={(e) => setPayout({ ...payout, [i]: e.target.value })}>
                        <option value="">Choose a wallet</option>
                        {opts.map(([l, a]) => <option key={l} value={a}>{l} · {short(a, 6, 4)}</option>)}
                      </select>
                    </label>
                    <button className="q-btn q-btn--ghost q-btn--sm q-btn--block" style={{ marginTop: 10 }} disabled={busy || !payout[i]} onClick={() => act(() => adapter.heirSetPayout(i, payout[i] as Hex), SIGN)}>Sign and change payout</button>
                  </details>
                )}
              </div>
            ))}
          </Sec>

          {active && vault.heirs.length >= 2 && (
            <Sec eyebrow="Split" title="Set the shares" lede="Drag to change who gets more. Saving signs with your post-quantum key.">
              <Facts>
                <Fact k={nameA} v={`${(bpsA / 100).toFixed(0)}%`} tone="ice" />
                <Fact k={nameB} v={`${((10000 - bpsA) / 100).toFixed(0)}%`} />
              </Facts>
              <div className="split-bar" aria-hidden="true"><i style={{ width: `${bpsA / 100}%` }} /><i style={{ width: `${100 - bpsA / 100}%` }} /></div>
              <input type="range" min={500} max={9500} step={500} value={bpsA} onChange={(e) => setSplit(Number(e.target.value))} aria-label={`${nameA} share`} aria-valuetext={`${nameA} ${(bpsA / 100).toFixed(0)}%, ${nameB} ${((10000 - bpsA) / 100).toFixed(0)}%`} />
              <div className="stack">
                <button className="q-btn q-btn--ghost q-btn--block" disabled={busy || bpsA === vault.heirs[0]?.bps} onClick={() => act(async () => { const res = await adapter.setHeirs(bpsA); setSplit(null); return res; }, SIGN)}>Save split (signs with ML-DSA-87)</button>
              </div>
              {bpsA === vault.heirs[0]?.bps && <Why>Move the slider to a new share to enable saving.</Why>}
            </Sec>
          )}
        </>
      )}

      {persona === "stranger" && (
        <>
          <Sec eyebrow="Anyone can" title="Trigger it, then pay the heirs" lede={payNote}>
            <div className="stack">
              <button className={`q-btn q-btn--block${next === "trigger" ? "" : " q-btn--ghost"}`} disabled={busy || !canTrigger} onClick={() => act(() => adapter.trigger())}>Trigger the vault</button>
              <button className={`q-btn q-btn--block${next === "settle" ? "" : " q-btn--ghost"}`} disabled={busy || !canSettle} onClick={() => void settle()}>Pay heirs</button>
            </div>
            {!canTrigger && !canSettle && vault.state !== "SETTLED" && <Why>Trigger unlocks when the vault is overdue. Pay heirs unlocks after it is triggered.</Why>}
            {demo && active && vault.state !== "OVERDUE" && <button className="textbtn" onClick={() => setPersona("owner")}>Back to the owner, to skip time</button>}
            <Result r={r} />
            {payoff}
            {vault.state === "SETTLED" && <button className="q-btn q-btn--sm q-btn--block" style={{ marginTop: 14 }} onClick={() => setPersona("heir")}>Continue as {nameA}</button>}
            {(vault.state === "SETTLED" || vault.state === "CLOSED") && <Fresh p={p} />}
          </Sec>
          <HeirView vault={vault} adapter={adapter} run={p.run} persona="stranger" settlement={st} embedded />
        </>
      )}

      {persona === "heir" && <HeirView vault={vault} adapter={adapter} run={p.run} persona="heir" settlement={st} embedded />}
    </div>
  );
}

export function AgentTab(p: TabProps) {
  const { adapter, busy, vault } = p;
  const [r, act] = useAct(p);
  const [agentAddr, setAgentAddr] = useState<string>(pa(adapter.parties.agent.address));
  const [payeeAddr, setPayeeAddr] = useState<string>(pa(adapter.parties.payee.address));
  if (!vault) return <Empty p={p} eyebrow="Agent" title="A capped helper" />;
  const a = vault.agent;
  const t = tokenOf(adapter.tokens, a?.token ?? NATIVE);
  const live = vault.state === "ALIVE" && !!a;
  const ownerActive = isOwnerActive(vault);
  const testnet = adapter.kind === "testnet";
  const wrongWallet = testnet && !!a && (adapter.connectedAccount ?? "").toLowerCase() !== a.agent.toLowerCase();
  const pct = a && a.daily > 0n ? Number((a.spentToday * 100n) / a.daily) : 0;
  const ok = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
  const qor = (n: number) => BigInt(n) * 10n ** 18n;
  const pay = (to: Hex, n: number) => act(() => adapter.agentPay(to, qor(n)));
  return (
    <div className="screen">
      <ScreenHead eyebrow="Agent" title="A capped helper">An agent can pay approved payees up to a cap while the vault is alive. It cannot keep the vault alive and it cannot withdraw.</ScreenHead>
      <Sec>
        <Facts>
          <Fact k="Allowance" v={a ? (a.validUntil < vault.now ? "expired" : "active") : "none"} tone={a ? (a.validUntil < vault.now ? "warn" : "ice") : "dim"} />
          {a && (
            <>
              <Fact k="Agent" v={short(a.agent, 8, 6)} />
              <Fact k="Per payment" v={`${fmtAmount(a.perTx, t.decimals)} ${t.symbol}`} />
              <Fact k="Per day" v={`${fmtAmount(a.spentToday, t.decimals)} / ${fmtAmount(a.daily, t.decimals)} ${t.symbol}`} />
              <Fact k="Valid until" v={fmtDate(a.validUntil)} />
              <Fact k="Allowed payees" v={`${a.payees.length}: ${a.payees.map((x) => short(x, 6, 4)).join(", ")}`} />
            </>
          )}
        </Facts>
        {a && <div className="meter" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }} /></div>}
        {!live && a && <Why>The agent pays only while the vault is alive.</Why>}
      </Sec>

      {a ? (
        <Sec eyebrow="Try it" title="Test the cap" lede="The agent signs with its own ordinary key. The vault checks payee, cap, day total and expiry, and records every refusal on chain.">
          <div className="pair">
            <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy || wrongWallet} onClick={() => pay(a.payees[0], 3)}>Pay 3 QOR invoice</button>
            {!testnet && <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy} onClick={() => pay(adapter.parties.stranger.address, 50)}>Send 50 QOR to new address</button>}
            <button className="q-btn q-btn--ghost q-btn--sm" disabled={busy || wrongWallet} onClick={() => pay(a.payees[0], 8)}>Pay 8 QOR (over cap)</button>
            <button className="q-btn q-btn--danger q-btn--sm" disabled={busy} onClick={() => act(() => adapter.revokeAgent(), SIGN)}>Revoke agent</button>
          </div>
          {wrongWallet && <Why role="status">The agent pays from its own wallet. Connect the agent's wallet ({short(a.agent, 8, 6)}) to try a payment. Your owner wallet cannot, and that is the point.</Why>}
          <Result r={r} />
        </Sec>
      ) : (
        <Sec eyebrow="Allowance" title="Set an allowance" lede="Pick the agent and the one payee it may pay.">
          <label className="f" style={{ marginTop: 0 }}>Agent address<input className="q-field mono" value={agentAddr} onChange={(e) => setAgentAddr(e.target.value.trim())} {...addrProps} placeholder="0x…" /></label>
          <label className="f">Payee address<input className="q-field mono" value={payeeAddr} onChange={(e) => setPayeeAddr(e.target.value.trim())} {...addrProps} placeholder="0x…" /></label>
          <div className="stack">
            <button className="q-btn q-btn--block" disabled={busy || !ownerActive || !ok(agentAddr) || !ok(payeeAddr)} onClick={() => act(() => adapter.setAgent({ agent: agentAddr as Hex, token: NATIVE, perTx: qor(5), daily: qor(20), validForSeconds: 7 * DAY, payees: [payeeAddr as Hex] }), SIGN)}>
              Allow 5 QOR per payment, 20 per day for 7 days
            </button>
          </div>
          {!ownerActive && <Why tone="warn" role="status">This vault is {vault.state.toLowerCase()}. Its allowance was revoked and a new one cannot be set.</Why>}
          {!ownerActive && <Fresh p={p} />}
          {ownerActive && (!ok(agentAddr) || !ok(payeeAddr)) && <Why>Enter both full 0x addresses to enable the allowance.</Why>}
          <Result r={r} />
        </Sec>
      )}
    </div>
  );
}
