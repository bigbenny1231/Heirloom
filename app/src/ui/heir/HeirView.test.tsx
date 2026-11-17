// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { HeirView, computeShares, joinAnd } from "./HeirView";
import { PersonaSwitch, type Persona } from "./PersonaSwitch";
import type { Adapter, Hex, VaultView } from "../../chain/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const QOR = "0x00000000000000000000000000000000000000a1" as Hex;
const QUSD = "0x00000000000000000000000000000000000000b2" as Hex;
const E = 10n ** 18n;
const tokens = [{ address: QOR, symbol: "QOR", decimals: 18 }, { address: QUSD, symbol: "qUSD", decimals: 18 }];
const base = (o: Partial<VaultView>): VaultView => ({
  id: 1n, state: "ALIVE", keyMode: "DEVICE", pubkeyHash: "0x01", nonce: 0, now: 100, lastCheckin: 0, interval: 1000, grace: 1, warningAt: 800, deadline: 1000, bounty: 0n,
  balances: [{ token: QOR, amount: 500n * E }, { token: QUSD, amount: 1000n * E }],
  heirs: [
    { account: "0x01", payoutTo: "0x01", bps: 6000, label: "Maya", claimable: [] },
    { account: "0x02", payoutTo: "0x02", bps: 4000, label: "Leo", claimable: [] },
  ],
  agent: null, ...o,
});
const mount = async (node: React.ReactNode) => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  return { el, root };
};
const run = async <T,>(fn: () => Promise<T>) => fn();

describe("HeirView", () => {
  it("computes shares with the remainder to the last heir", () => {
    const s = computeShares([{ token: QOR, amount: 100n }], [{ bps: 3333 }, { bps: 3333 }, { bps: 3334 }]);
    expect(s.map((x) => x[0].amount)).toEqual([33n, 33n, 34n]);
    expect(joinAnd(["a", "b"])).toBe("a and b");
  });

  it("shows the projected share, then 'received' from the real pre-settlement amounts, and claims what is owed", async () => {
    const claim = vi.fn(async () => ({ ok: true, title: "Claim", at: 1 }));
    const adapter = { kind: "demo", tokens, claim } as unknown as Adapter;
    const view = (v: VaultView | null, p: Persona = "heir") => <HeirView vault={v} adapter={adapter} run={run as never} persona={p} />;
    const { el, root } = await mount(view(base({})));
    expect(el.textContent).toContain("Your share today: 300 QOR and 600 qUSD");
    await act(async () => { root.render(view(base({ state: "TRIGGERED" }))); });
    // Settled: the vault is empty; Leo's qUSD is still owed.
    const settled = base({ state: "SETTLED", balances: [], heirs: [
      { account: "0x01", payoutTo: "0x01", bps: 6000, label: "Maya", claimable: [] },
      { account: "0x02", payoutTo: "0x02", bps: 4000, label: "Leo", claimable: [{ token: QUSD, amount: 400n * E }] },
    ] });
    await act(async () => { root.render(view(settled)); });
    expect(el.textContent).toContain("Maya received 300 QOR and 600 qUSD");
    await act(async () => { [...el.querySelectorAll(".heir-pick button")].find((b) => b.textContent === "Leo")!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(el.textContent).toContain("Leo received 200 QOR");
    expect(el.textContent).toContain("Leo is owed 400 qUSD");
    await act(async () => { [...el.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Claim"))!.click(); });
    expect(claim).toHaveBeenCalledWith(1, QUSD);
  });

  it("shows no claim button to the owner or a stranger", async () => {
    const adapter = { kind: "demo", tokens, claim: vi.fn() } as unknown as Adapter;
    const v = base({ state: "TRIGGERED", heirs: base({}).heirs.map((h) => ({ ...h, claimable: [{ token: QOR, amount: 1n * E }] })) });
    for (const p of ["owner", "stranger"] as Persona[]) {
      const { el } = await mount(<HeirView vault={v} adapter={adapter} run={run as never} persona={p} />);
      expect([...el.querySelectorAll("button")].some((b) => b.textContent?.startsWith("Claim"))).toBe(false);
    }
  });

  it("PersonaSwitch is a radio group that moves with the arrow keys", async () => {
    const onChange = vi.fn();
    const { el } = await mount(<PersonaSwitch value="owner" onChange={onChange} />);
    const radios = [...el.querySelectorAll('[role="radio"]')] as HTMLElement[];
    expect(radios.map((r) => r.textContent)).toEqual(["Owner", "Heir", "Stranger"]);
    expect(radios[0].getAttribute("aria-checked")).toBe("true");
    await act(async () => { radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith("heir");
    await act(async () => { radios[2].click(); });
    expect(onChange).toHaveBeenCalledWith("stranger");
  });
});
