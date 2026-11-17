import { Icon } from "../brand/icons";

/** 1 to 3 are the acts; 4 means the run is finished. */
export type Act = 1 | 2 | 3 | 4;

const ACTS = [
  { title: "Check in, and the vault stays sealed.", body: "Press Check in. It signs a heartbeat with ML-DSA-87 and resets the deadline. Only your lattice signature can change it." },
  { title: "Steal the classical key.", body: "A bot takes the key a quantum computer can break and attacks the vault. Every attempt is refused and your value stays put." },
  { title: "Then stop checking in.", body: "Skip time until the vault is overdue. Then a stranger can trigger it and pay your heirs. No court, no custodian." },
] as const;

interface Props {
  act: Act;
  /** Which screen the person is on, so the right button shows. */
  tab: string;
  onAttack: () => void;
  onLapse: () => void;
  onVault: () => void;
  onStartOver: () => void;
  onSkip: () => void;
  /** Disables Start over while the vault is being rebuilt. */
  busy?: boolean;
  /** One-line version for screens other than the Vault. */
  compact?: boolean;
}

/**
 * The guided run: three acts, non-modal, skippable, reopenable. It drives the real app (Check in, the drill, the
 * dead man's switch) and never replaces it. Sits above the vault hero.
 */
export function Guide({ act, tab, onAttack, onLapse, onVault, onStartOver, onSkip, busy, compact }: Props) {
  const n = Math.min(act, 3);
  const eyebrow = act === 4 ? "Guided run · complete" : `Guided run · 0${n} / 03`;
  const cur = ACTS[n - 1];

  if (compact) {
    return (
      <section className="guide guide--bar" aria-label="Guided run">
        <div className="guide-top">
          <span className="q-eyebrow">{eyebrow}</span>
          <button className="textbtn" onClick={onSkip}>Skip guide</button>
        </div>
        {act === 4 ? (
          <>
            <p className="act-t">That is the whole life of a vault.</p>
            <button className="q-btn q-btn--sm" disabled={busy} onClick={onStartOver}>Start over</button>
          </>
        ) : (
          <>
            <p className="act-t">{cur.title}</p>
            {act === 1 && <button className="q-btn q-btn--ghost q-btn--sm" onClick={onVault}>Back to the vault</button>}
            {act === 2 && (tab === "drill" ? <p className="act-b">Run the drill below.</p> : <button className="q-btn q-btn--sm" onClick={onAttack}>Start the attack</button>)}
            {act === 3 && (tab === "heirs" ? <p className="act-b">Skip to overdue, then continue as a stranger to trigger the vault and pay your heirs.</p> : <button className="q-btn q-btn--sm" onClick={onLapse}>Let it lapse</button>)}
          </>
        )}
      </section>
    );
  }

  return (
    <section className="guide" aria-label="Guided run">
      <div className="guide-top">
        <span className="q-eyebrow">{eyebrow}</span>
        <button className="textbtn" onClick={onSkip}>Skip guide</button>
      </div>
      <ol className="acts">
        {ACTS.map((a, i) => {
          const k = i + 1;
          const isCur = act === k;
          const done = act > k;
          return (
            <li key={k} className={`act${isCur ? " cur" : ""}${done ? " done" : ""}`} aria-current={isCur ? "step" : undefined}>
              <span className="act-n" aria-hidden="true">{done ? <Icon name="check" size={14} /> : `0${k}`}</span>
              <div className="act-c">
                <p className="act-t">{a.title}{done && <span className="q-sr"> (done)</span>}</p>
                {isCur && <p className="act-b">{a.body}</p>}
                {isCur && k === 2 && <button className="q-btn q-btn--sm" onClick={onAttack}>Start the attack</button>}
                {isCur && k === 3 && <button className="q-btn q-btn--sm" onClick={onLapse}>Let it lapse</button>}
              </div>
            </li>
          );
        })}
      </ol>
      {act === 4 && (
        <div className="act-end">
          <p className="act-t">That is the whole life of a vault.</p>
          <p className="act-b">It stayed alive while you checked in, refused a stolen key, and paid your heirs when you stopped. Run it again with a fresh vault.</p>
          <button className="q-btn q-btn--sm" disabled={busy} onClick={onStartOver}>Start over</button>
        </div>
      )}
    </section>
  );
}
