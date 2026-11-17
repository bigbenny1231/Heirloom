import { useState } from "react";
import type { LogEntry } from "../App";
import { bytesLabel, isRefusal, short, statusLabel } from "./format";

/** Typeset activity ledger, newest first. Collapsed to the latest three on phones. */
export function Ledger({ log }: { log: LogEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className={`ledger${open ? " open" : ""}`} aria-label="Activity log">
      <div className="ledger-h">
        <div>
          <div className="q-eyebrow">Ledger</div>
          <h3>Activity</h3>
        </div>
        {log.length > 3 && (
          <button className="textbtn more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Show fewer" : `Show all ${log.length}`}</button>
        )}
      </div>
      <div className="entries">
        {log.length === 0 && <p className="small" style={{ margin: "12px 0 0" }}>Every action shows its gas and signature size here.</p>}
        {log.map((e) => (
          <div className="entry" key={e.n}>
            <div className="t">
              <b>{e.title}</b>
              <span className={`s ${e.ok || isRefusal(e) ? "ok" : "bad"}`}>{statusLabel(e)}</span>
            </div>
            {e.detail && <div className="k">{e.detail}</div>}
            {e.errorName && <div className="errname">{e.errorName}</div>}
            <div className="meta">
              {e.txHash && <span>tx {short(e.txHash, 10, 6)}</span>}
              {e.simBlock !== undefined && <span>sim block #{e.simBlock}</span>}
              {e.gasUsed !== undefined && <span>gas {e.gasUsed.toLocaleString("en-US")}</span>}
              {e.sigBytes !== undefined && (e.sigBytes === 0 ? <span>no signature</span> : <span className="pq-text">PQ signature {bytesLabel(e.sigBytes)}</span>)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
