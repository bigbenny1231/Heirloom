import type { ActionResult, Hex, TokenInfo } from "../chain/types";

export function fmtAmount(v: bigint, decimals = 18, dp = 2): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let fs = frac.toString().padStart(decimals, "0").slice(0, dp).replace(/0+$/, "");
  // A non-zero amount below the display precision must not read as zero (or as a rounded-up figure).
  if (dp > 0 && fs === "" && whole === 0n && frac > 0n) return `${neg ? "-" : ""}<0.${"0".repeat(dp - 1)}1`;
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${fs ? "." + fs : ""}`;
}

export function parseAmount(s: string, decimals = 18): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

export const short = (h: string, a = 6, b = 4) => (h.length > a + b + 2 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  const d = s / 86400;
  return `${d >= 10 ? Math.round(d) : Math.round(d * 10) / 10} days`;
}

export function fmtDate(sec: number): string {
  try {
    return new Date(sec * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", hour12: false }) + " UTC";
  } catch {
    return String(sec);
  }
}

export function tokenOf(tokens: TokenInfo[], addr: Hex): TokenInfo {
  return tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase()) ?? { address: addr, symbol: short(addr), decimals: 18 };
}

export const bytesLabel = (n: number) => `${n.toLocaleString("en-US")} B`;

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function lsGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
export function lsSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage may be blocked */
  }
}

/** One word for how an action ended. "reverted" is only used when the contract itself refused the call. */
export function statusLabel(r: ActionResult): string {
  if (r.ok) return "done";
  if (r.denied) return "denied";
  if (r.needsConfirm) return "needs confirmation";
  return r.errorName || r.gasUsed !== undefined ? "reverted" : "not sent";
}

/** A refusal the design intends: the agent's cap said no, or the vault refused an unsigned call. It is a win, not a failure. */
export function isRefusal(r: ActionResult): boolean {
  return !r.ok && (!!r.denied || !!r.intendedRefusal);
}

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && !!window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
