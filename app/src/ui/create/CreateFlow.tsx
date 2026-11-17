import { useEffect, useMemo, useRef, useState } from "react";
import "./create.css";
import type { ActionResult, Adapter, CreateConfig } from "../../chain/types";
import { LatticeCore } from "../../brand/LatticeCore";
import { KeyStream } from "./KeyStream";

export interface CreateFlowProps {
  adapter: Adapter;
  /** Called when the person presses "Open my vault" after a successful seal. */
  onCreated: (r: ActionResult) => void;
  onCancel: () => void;
  /** Called once, inside seal(), the moment the chain accepts the new vault (before "Open my vault"). */
  onSealed?: (r: ActionResult) => void;
  /** True while the vault is being sealed (the host should ignore Escape). */
  onBusyChange?: (busy: boolean) => void;
}

/** The optional adapter members the create flow uses (added by the chain layer). */
type CreateAdapter = Adapter & {
  createVault?(cfg: CreateConfig, progress?: (m: string) => void): Promise<ActionResult>;
  keyBytes?(): Uint8Array;
  prepareKey?(): Uint8Array;
};

const STEPS = ["Heirs", "Heartbeat", "Funds", "Key", "Seal"] as const;
const INTERVALS = [7, 30, 90];
const GRACES = [1, 2, 3];
const PRESETS = [100, 500, 1000];
const MAX_QOR = 1_000_000;
/** Keeper bounty paid to whoever triggers: min(fund / 10, 1 QOR), as the demo chain sets it. */
export const keeperBounty = (fund: number) => Math.min(fund / 10, 1);
const qor = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const DAY = 86_400_000;

export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const clampFund = (v: string) => (Number(v) > MAX_QOR ? String(MAX_QOR) : v);

export function validate(heirs: { label: string }[], fund: string): { names: string | null; fund: string | null } {
  const a = heirs[0].label.trim(), b = heirs[1].label.trim();
  let names: string | null = null;
  if (!a || !b) names = "Give both heirs a name.";
  else if (a.toLowerCase() === b.toLowerCase()) names = "The two heirs need different names.";
  const n = Number(fund);
  let f: string | null = null;
  if (!fund.trim() || !Number.isInteger(n) || n < 1) f = "Enter a whole number of test QOR, at least 1.";
  else if (n > MAX_QOR) f = `Keep it under ${MAX_QOR.toLocaleString("en-US")} test QOR.`;
  return { names, fund: f };
}

export function CreateFlow({ adapter, onCreated, onCancel, onSealed, onBusyChange }: CreateFlowProps) {
  const ad = adapter as CreateAdapter;
  const supported = typeof ad.createVault === "function";
  const [step, setStep] = useState(0);
  const [names, setNames] = useState<[string, string]>(["Maya", "Leo"]);
  const [pct, setPct] = useState(60);
  const [interval, setIntervalDays] = useState(30);
  const [grace, setGrace] = useState(2);
  const [fund, setFund] = useState("1000");
  const [touched, setTouched] = useState(false);
  const [keyDone, setKeyDone] = useState(false);
  const [keyData, setKeyData] = useState<Uint8Array | null>(null);
  const sealedRef = useRef(false);
  const [phase, setPhase] = useState<"idle" | "sealing" | "done" | "failed">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const head = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const busyCb = useRef(onBusyChange);
  busyCb.current = onBusyChange;
  useEffect(() => { busyCb.current?.(phase === "sealing"); }, [phase]);
  useEffect(() => () => busyCb.current?.(false), []);

  const heirs = useMemo(() => [{ label: names[0].trim(), bps: pct * 100 }, { label: names[1].trim(), bps: (100 - pct) * 100 }], [names, pct]);
  const cfg: CreateConfig = useMemo(
    () => ({ heirs, intervalDays: interval, grace, fundQor: Number(fund) || 0, keyMode: "DEVICE" }),
    [heirs, interval, grace, fund],
  );
  const problems = validate(heirs, fund);
  const triggerOn = fmtDate(now + (interval + grace * interval) * DAY);
  const warnOn = fmtDate(now + interval * DAY);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    head.current?.focus({ preventScroll: false });
    try { window.scrollTo?.(0, 0); } catch { /* not in a browser */ }
  }, [step]);

  if (!supported) {
    return (
      <section className="cf" aria-labelledby="cf-h">
        <p className="q-eyebrow">Create a vault</p>
        <h2 id="cf-h" className="cf-h" tabIndex={-1}>Creating happens on the demo chain.</h2>
        <p className="cf-lede">You are connected to {adapter.networkLabel}. New vaults are sealed on the in-browser demo chain, where the clock can be skipped and everything is real contract bytecode. This testnet connection keeps the vault it already has.</p>
        <p className="cf-note">Switch to Demo mode in settings to build a new vault.</p>
        <div className="cf-nav"><button type="button" className="q-btn q-btn--block" onClick={onCancel}>Go back</button></div>
      </section>
    );
  }

  const next = () => {
    if (step === 0 || step === 2) {
      setTouched(true);
      if ((step === 0 && problems.names) || (step === 2 && problems.fund)) return;
    }
    setTouched(false);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };
  const back = () => { setTouched(false); setStep((s) => Math.max(0, s - 1)); };

  const seal = async () => {
    setPhase("sealing"); setError(null); setLog([]);
    try {
      const r = await ad.createVault!(cfg, (m) => setLog((l) => [...l, m].slice(-6)));
      setResult(r);
      if (r.ok) { setPhase("done"); sealedRef.current = true; onSealed?.(r); } else { setPhase("failed"); setError(r.detail || r.title); }
    } catch (e) {
      setPhase("failed");
      setError(e instanceof Error ? e.message : "The vault could not be created.");
    }
  };

  const getKey = typeof ad.prepareKey === "function" ? () => ad.prepareKey!() : typeof ad.keyBytes === "function" ? () => ad.keyBytes!() : undefined;
  const cancel = () => { if (phase === "done" && !sealedRef.current && result) { sealedRef.current = true; onSealed?.(result); } onCancel(); };
  const canNext = step === 3 ? keyDone || !getKey : true;
  const sealing = phase === "sealing";
  const setName = (i: 0 | 1, v: string) => setNames((n) => (i === 0 ? [v, n[1]] : [n[0], v]));

  return (
    <section className="cf" aria-labelledby="cf-h">
      <div className="cf-top">
        <p className="q-eyebrow">Create a vault</p>
        <button type="button" className="cf-cancel" onClick={cancel} disabled={sealing}>Cancel</button>
      </div>
      <ol className="cf-dots" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} className={`cf-dot${i < step ? " is-done" : ""}${i === step ? " is-now" : ""}`} aria-current={i === step ? "step" : undefined}>
            <span className="cf-dot-i" aria-hidden="true">{i < step ? "✓" : i + 1}</span>
            <span className="cf-dot-l">{s}<span className="q-sr">{i < step ? ", complete" : i === step ? ", current step" : ""}</span></span>
          </li>
        ))}
      </ol>
      <p className="q-sr" role="status" aria-live="polite">{`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}</p>

      {step === 0 && (
        <div className="cf-step">
          <h2 id="cf-h" className="cf-h" tabIndex={-1} ref={head}>Who inherits?</h2>
          <p className="cf-lede">Two heirs. They receive the vault in the split you choose, only after it is triggered.</p>
          <div className="cf-fields">
            {([0, 1] as const).map((i) => (
              <label key={i} className="cf-field">
                <span className="cf-lab">Heir {i + 1}</span>
                <input className="q-field" value={names[i]} maxLength={24} autoComplete="off" spellCheck={false} aria-invalid={touched && !!problems.names} aria-describedby="cf-names-err" onChange={(e) => setName(i, e.target.value)} />
              </label>
            ))}
          </div>
          <p id="cf-names-err" className="cf-err" role={touched && problems.names ? "alert" : undefined}>{touched ? problems.names : ""}</p>
          <div className="cf-split">
            <div className="cf-split-head">
              <span className="cf-lab">Split</span>
              <span className="q-mono cf-split-v" aria-live="polite">{heirs[0].label || "Heir 1"} {pct}% · {heirs[1].label || "Heir 2"} {100 - pct}%</span>
            </div>
            <div className="cf-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
            <div className="cf-split-ctl">
              <button type="button" className="cf-step-btn" aria-label="Give the first heir 5% less" disabled={pct <= 5} onClick={() => setPct((v) => Math.max(5, v - 5))}>−</button>
              <input type="range" min={5} max={95} step={5} value={pct} aria-label={`Share for ${heirs[0].label || "heir 1"}, percent`} onChange={(e) => setPct(Number(e.target.value))} className="cf-range" />
              <button type="button" className="cf-step-btn" aria-label="Give the first heir 5% more" disabled={pct >= 95} onClick={() => setPct((v) => Math.min(95, v + 5))}>+</button>
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="cf-step">
          <h2 id="cf-h" className="cf-h" tabIndex={-1} ref={head}>Set the heartbeat.</h2>
          <p className="cf-lede">You check in with a lattice signature. Miss it long enough and anyone can trigger the vault.</p>
          <fieldset className="cf-fs">
            <legend className="cf-lab">Check in every</legend>
            <div className="cf-seg" role="radiogroup" aria-label="Check-in interval">
              {INTERVALS.map((d) => (
                <button key={d} type="button" role="radio" aria-checked={interval === d} className={`cf-opt${interval === d ? " is-on" : ""}`} onClick={() => setIntervalDays(d)}>{d} days</button>
              ))}
            </div>
          </fieldset>
          <fieldset className="cf-fs">
            <legend className="cf-lab">Grace before it can be triggered</legend>
            <div className="cf-seg" role="radiogroup" aria-label="Missed check-ins allowed">
              {GRACES.map((g) => (
                <button key={g} type="button" role="radio" aria-checked={grace === g} className={`cf-opt${grace === g ? " is-on" : ""}`} onClick={() => setGrace(g)}>{g} missed</button>
              ))}
            </div>
          </fieldset>
          <p className="cf-preview" aria-live="polite">
            If you miss {grace} check-in{grace > 1 ? "s" : ""} after day {interval}, anyone can trigger the vault on <strong className="q-mono">{triggerOn}</strong>.
            <span className="cf-sub">The warning starts {warnOn}. Each check-in resets the clock.</span>
          </p>
        </div>
      )}

      {step === 2 && (
        <div className="cf-step">
          <h2 id="cf-h" className="cf-h" tabIndex={-1} ref={head}>Lock some test QOR.</h2>
          <p className="cf-lede">Test QOR has no value. It is moved into the vault when it is created. 1,200 test qUSD are deposited too.</p>
          <label className="cf-field">
            <span className="cf-lab">Amount, test QOR</span>
            <input className="q-field cf-amount" inputMode="numeric" pattern="[0-9]*" value={fund} autoComplete="off" aria-invalid={touched && !!problems.fund} aria-describedby="cf-fund-err" onChange={(e) => setFund(clampFund(e.target.value.replace(/[^0-9]/g, "").slice(0, 7).replace(/^0+(?=\d)/, "")))} />
          </label>
          <div className="cf-presets" role="group" aria-label="Amount presets">
            {PRESETS.map((v) => (
              <button key={v} type="button" className={`cf-chip${fund === String(v) ? " is-on" : ""}`} onClick={() => setFund(String(v))}>{v.toLocaleString("en-US")}</button>
            ))}
          </div>
          <p id="cf-fund-err" className="cf-err" role={touched && problems.fund ? "alert" : undefined}>{touched ? problems.fund : ""}</p>
          {!problems.fund && (
            <dl className="cf-pay">
              <div><dt>Keeper bounty, paid to whoever triggers</dt><dd className="q-mono">{qor(keeperBounty(Number(fund)))} QOR</dd></div>
              {heirs.map((h) => (
                <div key={h.label}><dt>{h.label}</dt><dd className="q-mono">{qor(((Number(fund) - keeperBounty(Number(fund))) * h.bps) / 10000)} QOR</dd></div>
              ))}
            </dl>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="cf-step">
          <h2 id="cf-h" className="cf-h" tabIndex={-1} ref={head}>Make your post-quantum key.</h2>
          <p className="cf-lede">An ML-DSA-87 key pair, made on this device. The vault stores only the hash of the public key.</p>
          <KeyStream getBytes={getKey} bytes={keyData} done={keyDone} onBytes={setKeyData} onDone={() => setKeyDone(true)} />
        </div>
      )}

      {step === 4 && (
        <div className="cf-step">
          <h2 id="cf-h" className="cf-h" tabIndex={-1} ref={head}>{phase === "done" ? "Sealed." : "Seal the vault."}</h2>
          <div className="cf-seal">
            <div className="cf-seal-core" aria-hidden="true">
              <LatticeCore state={phase === "done" ? "ALIVE" : "NONE"} tone="ice" size="100%" progress={1} beat={phase === "done" ? 1 : 0} />
            </div>
            <dl className="cf-sum">
              <div><dt>Heirs</dt><dd>{heirs[0].label} {pct}% · {heirs[1].label} {100 - pct}%</dd></div>
              <div><dt>Heartbeat</dt><dd>every {interval} days, {grace} missed</dd></div>
              <div><dt>Locked</dt><dd className="q-mono">{Number(fund).toLocaleString("en-US")} test QOR</dd></div>
              <div><dt>Also deposited</dt><dd className="q-mono">1,200 test qUSD</dd></div>
              <div><dt>Keeper bounty, paid to whoever triggers</dt><dd className="q-mono">{qor(keeperBounty(Number(fund)))} QOR</dd></div>
              <div><dt>Heirs split the rest</dt><dd className="q-mono">{qor(Number(fund) - keeperBounty(Number(fund)))} QOR</dd></div>
              <div><dt>Key</dt><dd className="q-mono">ML-DSA-87 · pk 2,592 B · sig 4,627 B</dd></div>
            </dl>
          </div>
          <div className="cf-log" role="status" aria-live="polite" aria-busy={sealing}>
            {sealing && log.length === 0 && <p className="q-mono">Starting…</p>}
            {log.map((m, i) => <p key={i} className="q-mono">{m}</p>)}
            {phase === "done" && result && (
              <p className="cf-ok">
                {result.detail || result.title}
                <span className="cf-stats q-mono">
                  {result.gasUsed !== undefined && <span>gas {result.gasUsed.toLocaleString("en-US")}</span>}
                  <span>signature {(result.sigBytes ?? 4627).toLocaleString("en-US")} B</span>
                </span>
              </p>
            )}
            {phase === "failed" && <p className="cf-err" role="alert">{error}</p>}
          </div>
          <p className="cf-note">Testnet only, not deployed yet, no third-party audit. Not a will.</p>
        </div>
      )}

      <div className="cf-nav">
        {phase === "done" ? (
          <button type="button" className="q-btn q-btn--block" onClick={() => result && onCreated(result)}>Open my vault</button>
        ) : step < STEPS.length - 1 ? (
          <>
            <button type="button" className="q-btn q-btn--ghost" onClick={back} disabled={step === 0}>Back</button>
            <button type="button" className="q-btn" onClick={next} disabled={!canNext}>{step === 3 ? (keyDone || !getKey ? "Continue" : "Make the key first") : "Continue"}</button>
          </>
        ) : (
          <>
            <button type="button" className="q-btn q-btn--ghost" onClick={back} disabled={sealing}>Back</button>
            <button type="button" className="q-btn" onClick={seal} disabled={sealing}>{sealing ? "Sealing…" : phase === "failed" ? "Try again" : "Seal the vault"}</button>
          </>
        )}
      </div>
    </section>
  );
}

export default CreateFlow;
