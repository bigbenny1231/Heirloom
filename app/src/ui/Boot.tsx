import { LatticeCore } from "../brand/LatticeCore";
import { Icon } from "../brand/icons";

/** Boot: the lattice assembles in NONE state while the real steps tick by. */
export function Boot({ steps, mode }: { steps: string[]; mode: "demo" | "testnet" }) {
  const shown = steps.length ? steps : ["Starting"];
  return (
    <div className="boot" role="status" aria-live="polite">
      <LatticeCore state="NONE" size={210} />
      <h2 className="q-display">{mode === "demo" ? "Sealing your vault" : "Preparing your key"}</h2>
      <p className="q-muted" style={{ margin: "10px 0 0", maxWidth: "34ch" }}>
        {mode === "demo" ? "A fresh ML-DSA-87 key and a real vault contract, built in this page. A few seconds." : "A fresh ML-DSA-87 key for this page. Your wallet is only used when you act."}
      </p>
      <ol className="steps">
        {shown.map((s, i) => (
          <li key={`${i}-${s}`}>
            <span className="mk">{i < shown.length - 1 && <Icon name="check" size={16} />}</span>
            <span>{s}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
