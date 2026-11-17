import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionResult } from "../../chain/types";
import { ScreenHead, Sec, Why } from "../kit";
import { bytesLabel, prefersReducedMotion } from "../format";
import type { TabProps } from "../tabs";
import type { LabAdapter, LabResult, LabVariant, SignatureInspect } from "./types";
import "./lab.css";

export interface SignatureLabProps {
  adapter: TabProps["adapter"];
  busy: boolean;
  run: TabProps["run"];
  refresh: TabProps["refresh"];
  /** The vault cannot take lab attempts (missing or not live). */
  locked?: boolean;
  lockedReason?: string;
}

const COLS = 64;
const CELL = 6;

const VARIANTS: { v: LabVariant; label: string; blurb: string }[] = [
  { v: "valid", label: "Send it as signed", blurb: "A fresh signature from your key over the next nonce. The contract should accept it." },
  { v: "flip-bit", label: "Flip one bit and send", blurb: "Changes one bit of the 4,627 signature bytes. The contract should refuse it." },
  { v: "wrong-key", label: "Sign with a different key", blurb: "A different key signs the same digest. Checked against your pinned key, it fails." },
  { v: "replay", label: "Replay an old signature", blurb: "Sends a signature whose nonce is already spent." },
  { v: "expired", label: "Send an expired signature", blurb: "A correct signature whose expiry time has passed." },
];

/** Indices of the bytes that differ between two signatures. */
export function diffBytes(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

function drawGrid(canvas: HTMLCanvasElement, sig: Uint8Array, flipped: Set<number>) {
  let ctx: CanvasRenderingContext2D | null = null;
  try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
  if (!ctx) return;
  const rows = Math.ceil(sig.length / COLS);
  const dpr = typeof window !== "undefined" ? Math.max(1, Math.min(3, window.devicePixelRatio || 1)) : 1;
  const w = COLS * CELL, h = rows * CELL;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#05070D";
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < sig.length; i++) {
    const x = (i % COLS) * CELL, y = Math.floor(i / COLS) * CELL;
    const t = sig[i] / 255;
    if (flipped.has(i)) {
      ctx.fillStyle = "#FF6B2C";
    } else {
      // deep blue -> ice
      const r = Math.round(16 + t * 110), g = Math.round(40 + t * 200), b = Math.round(66 + t * 189);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
    }
    ctx.fillRect(x + 0.5, y + 0.5, CELL - 1, CELL - 1);
  }
  if (flipped.size) {
    ctx.strokeStyle = "rgba(255,107,44,.9)";
    ctx.lineWidth = 1.5;
    flipped.forEach((i) => ctx!.strokeRect((i % COLS) * CELL - 1, Math.floor(i / COLS) * CELL - 1, CELL + 1, CELL + 1));
    // A ring about three cells wide so the flip is findable at a glance.
    flipped.forEach((i) => {
      ctx!.beginPath();
      ctx!.arc((i % COLS) * CELL + CELL / 2, Math.floor(i / COLS) * CELL + CELL / 2, CELL * 3, 0, Math.PI * 2);
      ctx!.stroke();
    });
  }
}

function ByteGrid({ sig, flipped, caption }: { sig: Uint8Array; flipped: Set<number>; caption?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [probe, setProbe] = useState<number | null>(null);
  useEffect(() => { if (ref.current) drawGrid(ref.current, sig, flipped); }, [sig, flipped]);
  const rows = Math.ceil(sig.length / COLS);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width) return;
    const col = Math.floor(((e.clientX - r.left) / r.width) * COLS);
    const row = Math.floor(((e.clientY - r.top) / r.height) * rows);
    const i = row * COLS + col;
    setProbe(col >= 0 && col < COLS && i >= 0 && i < sig.length ? i : null);
  };
  return (
    <div className="lab-grid">
      <div className="lab-canvas-wrap">
        <canvas
          ref={ref}
          className="lab-canvas"
          width={COLS * CELL}
          height={rows * CELL}
          role="img"
          aria-label={`The ${sig.length.toLocaleString("en-US")} signature bytes as a heat grid, ${COLS} bytes per row.${flipped.size ? ` ${flipped.size} flipped byte${flipped.size === 1 ? "" : "s"} marked in orange.` : ""}`}
          onPointerMove={at}
          onPointerDown={at}
          onPointerLeave={() => setProbe(null)}
        />
      </div>
      {caption && <p className="lab-caption">{caption}</p>}
      <div className="lab-readout" aria-hidden="true">
        {probe === null ? `${sig.length.toLocaleString("en-US")} bytes, ${COLS} per row. Touch a cell to read a byte.` : `byte ${probe.toLocaleString("en-US")} · row ${Math.floor(probe / COLS) + 1} · 0x${hex2(sig[probe])}${flipped.has(probe) ? " · flipped" : ""}`}
      </div>
      <div className="lab-legend">
        <span><i className="i-lo" />low byte</span>
        <span><i className="i-hi" />high byte</span>
        {flipped.size > 0 && <span><i className="i-flip" />touched by the flip</span>}
      </div>
    </div>
  );
}

function Spec({ s }: { s: SignatureInspect }) {
  return (
    <div className="lab-sheet">
      <div className="lab-sheet__head"><span>Signed action</span><b>{s.action}</b></div>
      <dl className="lab-spec">
        {s.fields.map((f, i) => (
          <div key={f.label + i}>
            <span className="n" aria-hidden="true">{String(i + 1).padStart(2, "0")}</span>
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
        <div className="wide"><span className="n" aria-hidden="true">=</span><dt>Digest the key signs</dt><dd className="long">{s.digest}</dd></div>
        <div className="wide"><span className="n" aria-hidden="true">pk</span><dt>Public key hash</dt><dd className="long">{s.pubkeyHash}</dd></div>
        <div><span className="n" aria-hidden="true">B</span><dt>Sizes</dt><dd>public key {bytesLabel(s.pubkeyBytes)} · signature {bytesLabel(s.sigBytes)}</dd></div>
        <div className="wide"><span className="n" aria-hidden="true">0x</span><dt>pqcVerify precompile</dt><dd>{s.precompile}</dd></div>
      </dl>
    </div>
  );
}

function FlipStrip({ r }: { r: LabResult }) {
  const insp = r.inspect, at = r.flippedAt;
  if (!insp || typeof at !== "number") return null;
  const start = Math.max(0, Math.min(insp.sig.length - 16, at - 8));
  const bytes = Array.from(insp.sig.slice(start, start + 16));
  const sentByte = insp.sig[at];
  // A single-bit flip: the original is not kept on the result, so recover it from the cached signature when it is known.
  const orig = r.originalByte;
  const jump = () => { try { document.getElementById("lab-bytes")?.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }); } catch { /* no scrolling here */ } };
  return (
    <div className="lab-flip">
      <div className="lab-flip__hex q-mono" aria-hidden="true">
        {bytes.map((b, k) => <span key={start + k} className={start + k === at ? "is-flip" : undefined} style={start + k === at ? { color: "var(--signal)" } : undefined}>{hex2(b)}</span>)}
      </div>
      <p className="lab-flip__line q-mono">byte {at.toLocaleString("en-US")}: 0x{orig === undefined ? "??" : hex2(orig)} → 0x{hex2(sentByte)} (one bit)</p>
      <button type="button" className="textbtn" onClick={jump}>See it in the grid</button>
    </div>
  );
}

function Outcome({ v, r }: { v: LabVariant; r: LabResult }) {
  const expectAccept = v === "valid";
  const sent = r.ok || r.errorName !== undefined || r.gasUsed !== undefined;
  const gas = r.gasUsed !== undefined ? `gas ${r.gasUsed.toLocaleString("en-US")}` : null;
  let cls = "neutral", tag = "NOT SENT", line: React.ReactNode = r.detail ?? r.title;
  if (r.ok) {
    tag = "ACCEPTED";
    if (expectAccept) { cls = "accepted"; line = "Accepted by the contract. The signature matched the digest."; }
    else { cls = "bad"; line = "Accepted, which should not happen. Report this."; }
  } else if (sent) {
    tag = "REFUSED";
    if (!expectAccept) { cls = "refused"; line = <>Refused by the contract: <code>{r.errorName ?? "reverted"}</code>. Nothing moved.</>; }
    else { cls = "bad"; line = <>Refused: <code>{r.errorName ?? "reverted"}</code>. {r.detail}</>; }
  }
  return (
    <div className={`lab-res ${cls}`} role="status">
      <span className="lab-res__tag">{tag}</span>
      <span className="lab-res__line">{line}</span>
      <span className="lab-res__meta">{[gas, r.sigBytes ? `signature ${bytesLabel(r.sigBytes)}` : null].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

export function SignatureLab({ adapter, busy, run, locked = false, lockedReason }: SignatureLabProps) {
  const lab = adapter as LabAdapter;
  const sig = lab.lastSignature?.() ?? null;
  const canTry = typeof lab.labAttempt === "function";
  const [results, setResults] = useState<Partial<Record<LabVariant, LabResult>>>({});
  const [pending, setPending] = useState<LabVariant | null>(null);
  // After a flip the grid shows the signature that was actually sent, with only the flipped byte marked.
  const [sent, setSent] = useState<{ sig: Uint8Array; at: number; inspect: SignatureInspect } | null>(null);
  const flipped = useMemo(() => new Set<number>(sent ? [sent.at] : []), [sent]);

  const attempt = async (v: LabVariant) => {
    if (!lab.labAttempt) return;
    setPending(v);
    try {
      const res = (await run(() => lab.labAttempt!(v) as Promise<ActionResult>, v === "valid" ? "Sending the signed call…" : "Sending a bad call to the contract…")) as LabResult;
      setResults((m) => ({ ...m, [v]: res }));
      if (v === "flip-bit" && res.inspect && typeof res.flippedAt === "number") setSent({ sig: res.inspect.sig, at: res.flippedAt, inspect: res.inspect });
      else setSent(null);
    } finally {
      setPending(null);
    }
  };

  const testnet = adapter.kind === "testnet";
  return (
    <div className="screen lab">
      <ScreenHead eyebrow="Signature lab" title="Your signature, under glass">
        The last real ML-DSA-87 signature your key made, and the five ways to send the vault something it should refuse.
      </ScreenHead>

      {sig && canTry && (
        <button type="button" className="textbtn lab-jump" onClick={() => { try { document.getElementById("lab-try")?.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" }); } catch { /* no scrolling here */ } }}>Jump to the five attacks</button>
      )}

      {!sig && !canTry && (
        <div className="lab-empty">
          <h3>{testnet ? "Not available on testnet" : "No signature yet"}</h3>
          <p>{testnet
            ? "The lab sends deliberately bad transactions, and that runs only against the in-browser chain. Demo mode has it. Nothing is wrong here."
            : "Check in once to see your signature here."}</p>
        </div>
      )}

      {!sig && canTry && (
        <div className="lab-empty">
          <h3>No signature yet</h3>
          <p>Check in once to see your signature here.</p>
        </div>
      )}

      {sig && (
        <>
          <Sec eyebrow="Spec sheet" title="What the key signed" lede="Eight fields, hashed into one digest. Change any one and the signature stops matching.">
            <Spec s={sent?.inspect ?? sig} />
          </Sec>
          <div id="lab-bytes"><Sec eyebrow="The bytes" title={`${sig.sigBytes.toLocaleString("en-US")} bytes of signature`} lede="Every cell is one byte. A lattice signature looks like noise because it must.">
            <ByteGrid sig={sent ? sent.sig : sig.sig} flipped={flipped} caption={sent ? `The signature that was sent: byte ${sent.at.toLocaleString("en-US")} has one bit flipped.` : undefined} />
          </Sec></div>
        </>
      )}

      {sig && canTry && (
        <div id="lab-try" className="lab-try-anchor"><Sec eyebrow="Try to break it" title="Send it to the contract" lede="These are real transactions on the in-browser chain. Only the first one is allowed to work.">
          {locked && <p className="lab-locked" role="status">This vault is {lockedReason ?? "not live"}. Start over to try the lab.</p>}
          <div className="lab-try">
            {VARIANTS.map(({ v, label, blurb }) => {
              const r = results[v];
              const win = r && ((v === "valid" && r.ok) || (v !== "valid" && !r.ok));
              return (
                <div key={v} className={`lab-row${r ? (win ? " is-win" : " is-bad") : ""}`}>
                  <div className="lab-row__top">
                    <p>{blurb}</p>
                    <button className={`q-btn ${v === "valid" ? "" : "q-btn--ghost"}`} disabled={busy || pending !== null || locked} aria-busy={pending === v} onClick={() => void attempt(v)}>
                      {pending === v ? "Sending…" : label}
                    </button>
                  </div>
                  {r && <Outcome v={v} r={r} />}
                  {r && v === "flip-bit" && r.inspect && typeof r.flippedAt === "number" && <FlipStrip r={r} />}
                </div>
              );
            })}
          </div>
        </Sec></div>
      )}

      {sig && !canTry && <Why>{testnet ? "Bad-signature attempts run only in the in-browser demo. The signature above is real." : "This build cannot send lab attempts."}</Why>}
    </div>
  );
}
