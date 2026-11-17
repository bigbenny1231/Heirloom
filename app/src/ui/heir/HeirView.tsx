import { useRef, useState } from "react";
import type { ActionResult, Adapter, Hex, VaultView } from "../../chain/types";
import { LatticeCore } from "../../brand/LatticeCore";
import { Result, ScreenHead, Sec, Why } from "../kit";
import { fmtAmount, fmtDuration, tokenOf } from "../format";
import type { Settlement, TabProps } from "../tabs";
import type { Persona } from "./PersonaSwitch";
import "./heir.css";

export interface HeirViewProps {
  vault: VaultView | null;
  adapter: Adapter;
  run: TabProps["run"];
  persona: Persona;
  /** Optional: what the Heirs tab recorded at settlement, used only when this view never saw the vault before it settled. */
  settlement?: Settlement | null;
  /** Inside another screen (the Heirs screen): no screen heading of its own, just a one-line lede. */
  embedded?: boolean;
}

type Amounts = { token: Hex; amount: bigint }[];

/** Split balances by bps. The last heir takes the remainder so the shares add up to the whole balance. */
export function computeShares(balances: Amounts, heirs: { bps: number }[]): Amounts[] {
  const live = balances.filter((b) => b.amount > 0n);
  const given = live.map(() => 0n);
  return heirs.map((h, hi) => {
    const last = hi === heirs.length - 1;
    return live.map((b, bi) => {
      const share = last ? b.amount - given[bi] : (b.amount * BigInt(h.bps)) / 10000n;
      given[bi] += share;
      return { token: b.token, amount: share };
    }).filter((x) => x.amount > 0n);
  });
}

export const joinAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const STATE_LINE: Record<VaultView["state"], string> = {
  NONE: "There is no vault yet.",
  ALIVE: "The owner is checking in. Nothing can be claimed.",
  WARNING: "A check-in is late. Nothing can be claimed yet.",
  OVERDUE: "Check-in missed. Anyone can trigger the vault now.",
  TRIGGERED: "Triggered. Anyone can settle and pay the heirs.",
  SETTLED: "Settled. The heirs have been paid.",
  CLOSED: "Closed by the owner. Nothing is owed.",
};
const STATE_HEAD: Record<VaultView["state"], string> = { NONE: "No vault", ALIVE: "Alive", WARNING: "Warning", OVERDUE: "Overdue", TRIGGERED: "Triggered", SETTLED: "Settled", CLOSED: "Closed" };
const WHO: Record<Persona, { eyebrow: string; title: string; lede: string }> = {
  owner: { eyebrow: "Owner view", title: "Your heirs, as they see it", lede: "You keep checking in. Heirs can see their share but cannot claim anything while you do." },
  heir: { eyebrow: "Heir view", title: "What you would receive", lede: "This is the vault from an heir's side. You claim only what you are owed, and only after settlement." },
  stranger: { eyebrow: "Stranger view", title: "What anyone can do", lede: "A stranger can see the vault and trigger it once it is overdue. A stranger cannot claim for an heir or move funds." },
};

export function HeirView({ vault, adapter, run, persona, settlement, embedded }: HeirViewProps) {
  const [idx, setIdx] = useState(0);
  const [res, setRes] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  // Remember the funds before settlement: afterwards the vault holds none, so "received" must come from this.
  const pre = useRef<{ balances: Amounts; bps: number[] } | null>(null);
  if (vault && vault.state !== "SETTLED" && vault.state !== "CLOSED" && vault.state !== "NONE" && vault.balances.some((b) => b.amount > 0n)) {
    pre.current = { balances: vault.balances.map((b) => ({ ...b })), bps: vault.heirs.map((h) => h.bps) };
  }

  const who = WHO[persona];
  const head = embedded ? <p className="heir-lede">{who.lede}</p> : <ScreenHead eyebrow={who.eyebrow} title={who.title}>{who.lede}</ScreenHead>;
  const cls = embedded ? "hv" : "screen hv";
  if (!vault || vault.state === "NONE") {
    return (
      <div className={cls}>
        {head}
        <Why>There is no vault yet. Create one and its heirs show up here.</Why>
      </div>
    );
  }

  const settled = vault.state === "SETTLED";
  const heirs = vault.heirs;
  const fmt = (a: Amounts) => joinAnd(a.filter((x) => x.amount > 0n).map((x) => { const t = tokenOf(adapter.tokens, x.token); return `${fmtAmount(x.amount, t.decimals)} ${t.symbol}`; }));
  // Shares: from the live balances before settlement, from the remembered snapshot after it.
  const base = settled ? pre.current?.balances : vault.balances;
  const bps = settled && pre.current && pre.current.bps.length === heirs.length ? pre.current.bps : heirs.map((h) => h.bps);
  const shares = base ? computeShares(base, bps.map((b) => ({ bps: b }))) : null;

  const owedOf = (i: number) => (heirs[i]?.claimable ?? []).filter((c) => c.amount > 0n);
  const receivedOf = (i: number): Amounts | null => {
    if (!shares) return null;
    const owed = owedOf(i);
    return shares[i].map((s) => ({ token: s.token, amount: s.amount - (owed.find((o) => o.token === s.token)?.amount ?? 0n) })).filter((x) => x.amount > 0n);
  };

  const claim = async (i: number, token: Hex) => {
    setBusy(true);
    try { setRes(await run(() => adapter.claim(i, token), "Claiming…")); } finally { setBusy(false); }
  };

  const core = (
    <div className="heir-state">
      <LatticeCore state={vault.state} size={96} progress={vault.state === "ALIVE" || vault.state === "WARNING" ? Math.max(0, Math.min(1, (vault.deadline - vault.now) / Math.max(1, vault.deadline - vault.lastCheckin))) : undefined} />
      <p>
        <b>{STATE_HEAD[vault.state]}</b>
        {STATE_LINE[vault.state]}
        {(vault.state === "ALIVE" || vault.state === "WARNING") && ` Next deadline in ${fmtDuration(Math.max(0, vault.deadline - vault.now))}.`}
      </p>
    </div>
  );

  const card = (i: number, withClaim: boolean) => {
    const h = heirs[i];
    if (!h) return null;
    const owed = owedOf(i);
    const rec = settled ? receivedOf(i) : null;
    const fallback = settled && !rec && settlement?.find((s) => s.label === h.label);
    const pct = `${(h.bps / 100).toFixed(h.bps % 100 ? 1 : 0)}%`;
    const projected = shares?.[i] ?? [];
    return (
      <div key={i} className={`heir-card${settled ? " is-paid" : ""}`}>
        <div className="heir-card__top"><span className="heir-card__name">{h.label}</span><span className="heir-card__pct">{pct}</span></div>
        {!settled && (
          <>
            <p className="heir-card__line">{projected.length ? `${persona === "heir" ? "Your" : `${h.label}'s`} share today: ${fmt(projected)}` : "Nothing locked in the vault yet."}</p>
            <p className="heir-card__sub">{vault.state === "TRIGGERED" ? "Settle the vault and this becomes claimable." : vault.state === "CLOSED" ? "The owner closed the vault." : "Paid only if the owner stops checking in."}</p>
          </>
        )}
        {settled && rec && rec.length > 0 && <p className="heir-card__line big">{h.label} received {fmt(rec)}</p>}
        {settled && fallback && <p className="heir-card__line big">{h.label} received {fallback.amounts}</p>}
        {settled && !rec && !fallback && owed.length === 0 && <p className="heir-card__line">Paid at settlement.</p>}
        {settled && owed.length > 0 && <p className="heir-card__line owed">{h.label} is owed {fmt(owed)}</p>}
        {withClaim && owed.map((c) => {
          const t = tokenOf(adapter.tokens, c.token);
          return <button key={c.token} className="q-btn" disabled={busy} onClick={() => void claim(i, c.token)}>Claim {fmtAmount(c.amount, t.decimals)} {t.symbol}</button>;
        })}
        {settled && owed.length === 0 && (rec?.length || fallback) ? <p className="heir-card__sub">Nothing left to claim.</p> : null}
      </div>
    );
  };

  const sel = Math.min(idx, Math.max(0, heirs.length - 1));
  return (
    <div className={cls}>
      {head}
      {core}
      {persona === "heir" ? (
        <Sec eyebrow="Your share" title={heirs[sel] ? `You are ${heirs[sel].label}` : "No heirs"}>
          {heirs.length > 1 && (
            <div className="heir-pick" role="group" aria-label="Which heir">
              {heirs.map((h, i) => <button key={i} type="button" aria-pressed={i === sel} onClick={() => { setIdx(i); setRes(null); }}>{h.label}</button>)}
            </div>
          )}
          {card(sel, true)}
          <Result r={res} />
        </Sec>
      ) : (
        <Sec eyebrow="Shares" title="Who gets what">
          <div className="heir-list">{heirs.map((_, i) => card(i, false))}</div>
          <Why>{persona === "owner" ? "Heirs claim for themselves. You cannot claim on their behalf, and you can stop all of this by checking in." : "A stranger can trigger an overdue vault and settle it, but every payout goes to the heirs."}</Why>
        </Sec>
      )}
    </div>
  );
}
