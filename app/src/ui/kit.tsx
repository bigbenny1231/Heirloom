import type { ReactNode } from "react";
import type { ActionResult } from "../chain/types";
import { Icon } from "../brand/icons";
import { bytesLabel, isRefusal, statusLabel } from "./format";

/** Eyebrow + display heading + one-line explanation that opens every screen. */
export function ScreenHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="sh">
      <div className="q-eyebrow">{eyebrow}</div>
      <h2 className="q-display">{title}</h2>
      {children && <p>{children}</p>}
    </header>
  );
}

/** A hairline-ruled section. */
export function Sec({ eyebrow, title, lede, children }: { eyebrow?: string; title?: string; lede?: ReactNode; children?: ReactNode }) {
  return (
    <section className="sec">
      {eyebrow && <div className="q-eyebrow">{eyebrow}</div>}
      {title && <h3>{title}</h3>}
      {lede && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="facts">{children}</dl>;
}
export function Fact({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: "ice" | "alive" | "warn" | "dead" | "dim" }) {
  return (
    <div className="fact">
      <dt>{k}</dt>
      <dd className={tone ?? ""}>{v}</dd>
    </div>
  );
}

/** One calm sentence with an info icon: why something is locked, or what it means. */
export function Why({ children, tone, role }: { children: ReactNode; tone?: "warn" | "dead"; role?: "status" | "alert" }) {
  return (
    <p className={`why${tone ? ` ${tone}` : ""}`} role={role}>
      <Icon name="info" size={18} />
      <span>{children}</span>
    </p>
  );
}

/** The one inline result line: ok / denied / not sent / reverted. Wording comes from statusLabel. An intended refusal reads as a win. */
export function Result({ r }: { r: ActionResult | null }) {
  if (!r) return null;
  const refusal = isRefusal(r);
  return (
    <div className={`res ${r.ok || refusal ? "ok" : "bad"}`} role="status">
      <b>{r.title}: {statusLabel(r)}</b>
      {refusal && <span className="win">Refused, as designed. Nothing moved.</span>}
      {r.detail && <span>{r.detail}</span>}
      {r.errorName && <div className="errname">{r.errorName}</div>}
      <div className="meta">
        {r.gasUsed !== undefined && <>gas {r.gasUsed.toLocaleString("en-US")} · </>}
        {r.sigBytes !== undefined && (r.sigBytes === 0 ? "sent without a signature" : <span className="pq-text">signed, {bytesLabel(r.sigBytes)}</span>)}
      </div>
    </div>
  );
}

/** A plain message line (not an ActionResult). */
export function Msg({ tone = "info", children, role = "status" }: { tone?: "ok" | "bad" | "info"; children: ReactNode; role?: "status" | "alert" }) {
  return <div className={`res ${tone}`} role={role}>{children}</div>;
}
