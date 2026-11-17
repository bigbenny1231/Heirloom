// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { SignatureLab, diffBytes } from "./SignatureLab";
import type { LabAdapter, LabResult, LabVariant, SignatureInspect } from "./types";
import type { ActionResult } from "../../chain/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sig = new Uint8Array(4627).map((_, i) => (i * 7) % 256);
const insp = (s = sig): SignatureInspect => ({
  action: "checkIn",
  fields: ["tag", "chain id", "contract", "vault id", "action", "args hash", "nonce", "expiry"].map((label, i) => ({ label, value: i === 0 ? "QDMV1" : `v${i}` })),
  digest: `0x${"ab".repeat(32)}`,
  pubkeyHash: `0x${"cd".repeat(32)}`,
  pubkeyBytes: 2592,
  sigBytes: 4627,
  sig: s,
  precompile: "0x0000000000000000000000000000000000000A01",
  at: 1,
});
const flipped = new Uint8Array(sig); flipped[100] ^= 1;
const attempt = vi.fn(async (v: LabVariant): Promise<LabResult> => {
  const base = { title: v, at: 1, variant: v, inspect: insp(v === "flip-bit" ? flipped : sig), gasUsed: 51000n, sigBytes: 4627, ...(v === "flip-bit" ? { flippedAt: 100 } : {}) };
  return v === "valid" ? { ...base, ok: true } : { ...base, ok: false, errorName: v === "replay" ? "BadNonce" : "PQSignatureInvalid" };
});
const mk = (extra: Partial<LabAdapter>) => ({ kind: "demo", ...extra }) as unknown as LabAdapter;
const run = async (fn: () => Promise<ActionResult>) => fn();
const btn = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(t)) as HTMLButtonElement | undefined;
async function mount(a: LabAdapter, extra: { locked?: boolean; lockedReason?: string } = {}) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<SignatureLab adapter={a} busy={false} run={run} refresh={async () => {}} {...extra} />); });
  return { el, root };
}

describe("SignatureLab", () => {
  beforeEach(() => { document.body.innerHTML = ""; });
  it("shows the spec sheet, the grid, and sends the five attempts", async () => {
    const { el } = await mount(mk({ lastSignature: () => insp(), labAttempt: attempt }));
    expect(el.textContent).toContain("QDMV1");
    expect(el.textContent).toContain(`0x${"ab".repeat(32)}`);
    expect(el.textContent).toContain("0x0000000000000000000000000000000000000A01");
    expect(el.textContent).toContain("4,627");
    expect(el.querySelector("canvas")).toBeTruthy();
    for (const l of ["Send it as signed", "Flip one bit and send", "Sign with a different key", "Replay an old signature", "Send an expired signature"]) expect(btn(l)).toBeTruthy();

    await act(async () => { btn("Send it as signed")!.click(); });
    expect(el.textContent).toContain("ACCEPTED");
    await act(async () => { btn("Flip one bit and send")!.click(); });
    expect(el.textContent).toContain("Refused by the contract:");
    expect(el.textContent).toContain("PQSignatureInvalid");
    expect(el.textContent).toContain("gas 51,000");
    expect(el.querySelector(".lab-legend")!.textContent).toContain("touched by the flip");
    expect(el.querySelector("canvas")!.getAttribute("aria-label")).toContain("1 flipped byte marked");
    expect(el.textContent).toContain("The signature that was sent: byte 100 has one bit flipped.");
    await act(async () => { btn("Replay an old signature")!.click(); });
    expect(el.textContent).toContain("BadNonce");
    expect(attempt).toHaveBeenCalledWith("flip-bit");
    expect(el.querySelector(".lab-caption")).toBeNull();
  });

  it("disables the five buttons on a dead vault", async () => {
    const { el } = await mount(mk({ lastSignature: () => insp(), labAttempt: attempt }), { locked: true, lockedReason: "settled" });
    expect(el.textContent).toContain("This vault is settled. Start over to try the lab.");
    for (const l of ["Send it as signed", "Flip one bit and send", "Sign with a different key", "Replay an old signature", "Send an expired signature"]) expect(btn(l)!.disabled).toBe(true);
  });

  it("shows an empty state before the first signature", async () => {
    const { el } = await mount(mk({ lastSignature: () => null, labAttempt: attempt }));
    expect(el.textContent).toContain("Check in once to see your signature here");
    expect(btn("Flip one bit and send")).toBeUndefined();
  });

  it("explains calmly on testnet", async () => {
    const { el } = await mount(mk({ kind: "testnet" } as Partial<LabAdapter>));
    expect(el.textContent).toContain("Not available on testnet");
  });

  it("diffBytes finds the flipped byte", () => {
    expect(diffBytes(sig, flipped)).toEqual([100]);
  });
});
