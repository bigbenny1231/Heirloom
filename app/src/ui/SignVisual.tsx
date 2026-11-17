import { useEffect, useRef, useState } from "react";
import type { ActionResult, SignatureInspect } from "../chain/types";
import { bytesLabel, prefersReducedMotion, short } from "./format";

/** The ~1 s signing moment after a check-in: the eight digest fields assemble, the lattice beats, the 4,627 signature bytes stream, then the verdict. */
export function SignVisual({ sig, res, onBeat, onLab }: { sig: SignatureInspect; res: ActionResult; onBeat: () => void; onLab?: () => void }) {
  const reduced = useRef(prefersReducedMotion()).current;
  const [phase, setPhase] = useState<0 | 1 | 2>(reduced ? 2 : 0);
  const [fields, setFields] = useState(reduced ? sig.fields.length : 0);
  const [streamed, setStreamed] = useState(reduced ? sig.sigBytes : 0);
  const beat = useRef(onBeat);
  beat.current = onBeat;

  useEffect(() => {
    if (reduced) {
      beat.current();
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    const n = sig.fields.length;
    // 0 to ~450 ms: the fields drop into place one by one.
    for (let i = 1; i <= n; i++) timers.push(setTimeout(() => setFields(i), Math.round((i * 450) / n)));
    // ~480 ms: the lattice beats and the signature bytes burst.
    timers.push(setTimeout(() => { setPhase(1); beat.current(); }, 480));
    const steps = 6;
    for (let i = 1; i <= steps; i++) timers.push(setTimeout(() => setStreamed(Math.round((sig.sigBytes * i) / steps)), 480 + Math.round((i * 400) / steps)));
    // ~900 ms: verified.
    timers.push(setTimeout(() => setPhase(2), 900));
    return () => timers.forEach(clearTimeout);
  }, [sig, reduced]);

  // A short run of the real signature bytes, rolling as the burst goes by.
  const at = Math.min(Math.max(0, sig.sig.length - 16), Math.floor((streamed / Math.max(1, sig.sigBytes)) * sig.sig.length));
  const roll = [...sig.sig.slice(at, at + 16)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const pre = `0x…${sig.precompile.slice(-4).toUpperCase()}`;

  return (
    <div className="sv" data-phase={phase}>
      {phase < 2 && (
        <div className="sv-live" aria-hidden="true">
          <div className="sv-chips">
            {sig.fields.map((f, i) => (
              <span key={f.label + i} className={`sv-chip${i < fields ? " on" : ""}`} title={f.value}>{f.label}</span>
            ))}
          </div>
          <div className="sv-bytes q-mono">
            <span>{phase === 0 ? `digest ${fields < sig.fields.length ? "assembling" : short(sig.digest, 10, 6)}` : roll}</span>
            <b>{phase === 0 ? "" : `${bytesLabel(streamed)} / ${bytesLabel(sig.sigBytes)}`}</b>
          </div>
        </div>
      )}
      {phase === 2 && (
        <div className="sv-done">
          <p className="sv-final"><b>Verified on chain by pqcVerify ({pre})</b><span className="q-mono">gas {res.gasUsed !== undefined ? res.gasUsed.toLocaleString("en-US") : "n/a"} · {bytesLabel(sig.sigBytes)}</span></p>
          {onLab && <button type="button" className="textbtn sv-link" onClick={onLab}>See the signature</button>}
        </div>
      )}
    </div>
  );
}
