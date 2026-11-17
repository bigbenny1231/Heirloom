// @vitest-environment happy-dom
/**
 * The v2 experience end to end, in a headless DOM on the real in-browser chain: first-run briefing, the create flow, the
 * signing moment on Check in, the Signature lab, the Q-Day takeover, the persona switch and the five-tab navigation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { App } from "./App";
import { createDemoAdapter } from "./chain/demo";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.textContent ?? "";
async function until(cond: () => boolean, ms = 90_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout: " + text().slice(0, 700));
    await act(async () => { await sleep(100); });
  }
}
const buttons = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];
const btn = (label: string) => buttons().find((b) => b.textContent?.includes(label));
const exact = (label: string) => buttons().find((b) => b.textContent?.trim() === label);
const tab = (label: string) => buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent === label)!;
const radio = (label: string) => ([...document.querySelectorAll('[role="radio"]')] as HTMLElement[]).find((b) => b.textContent === label);
const click = async (b: HTMLElement | undefined) => {
  if (!b) throw new Error("not found; page: " + text().slice(0, 500));
  await act(async () => { b.click(); });
};
const dialog = (label: string) => document.querySelector(`[role="dialog"][aria-label="${label}"]`);

let root: Root | null = null;
let host: HTMLElement | null = null;
async function mount(props: Parameters<typeof App>[0] = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<App {...props} />); });
}
beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); document.body.innerHTML = ""; });

describe("v2 experience", () => {
  it("the contract's timing is warning at one interval and trigger at interval x (1 + grace), as the create preview says", async () => {
    const a = await createDemoAdapter(() => {});
    const r = await a.createVault!({ heirs: [{ label: "Maya", bps: 6000 }, { label: "Leo", bps: 4000 }], intervalDays: 30, grace: 2, fundQor: 1000, keyMode: "DEVICE" });
    expect(r.ok).toBe(true);
    const v = (await a.snapshot())!;
    expect(v.warningAt - v.lastCheckin).toBe(30 * 86400);
    expect(v.deadline - v.lastCheckin).toBe(30 * 86400 * (1 + 2));
    expect(v.heirs.map((h) => h.label)).toEqual(["Maya", "Leo"]);
  });

  it("standalone App shows neither the briefing nor the create flow", async () => {
    await mount();
    await until(() => !!btn("Check in"));
    expect(dialog("Q-Day briefing")).toBeNull();
    expect(dialog("Create your vault")).toBeNull();
  });

  it("first run: briefing, skip lands on the sample vault, it is remembered, and it can be replayed", async () => {
    await mount({ demoRequest: 1 });
    expect(dialog("Q-Day briefing")).not.toBeNull();
    await click(exact("Skip briefing"));
    expect(dialog("Q-Day briefing")).toBeNull();
    await until(() => !!btn("Check in") && text().includes("alive"));
    expect(text()).toContain("500");
    expect(localStorage.getItem("qdmv.story")).toBe("1");
    // A later visit from the landing page goes straight to the console.
    await act(async () => { root!.render(<App demoRequest={2} />); });
    expect(dialog("Q-Day briefing")).toBeNull();
    await click(btn("Replay the briefing"));
    expect(dialog("Q-Day briefing")).not.toBeNull();
    await click(exact("Skip briefing"));
    expect(dialog("Q-Day briefing")).toBeNull();
  });

  it("briefing, create flow, signing moment, Signature lab and persona view all work on the real chain", async () => {
    await mount({ demoRequest: 1 });
    for (let i = 0; i < 3; i++) await click(btn("Next chapter"));
    await click(exact("Build my vault"));
    await until(() => dialog("Create your vault")?.querySelector("h2")?.textContent === "Who inherits?");
    await click(exact("Continue")); // heirs (Maya 60 / Leo 40)
    expect(dialog("Create your vault")!.textContent).toContain("If you miss 2 check-ins after day 30, anyone can trigger the vault on");
    await click(exact("Continue")); // heartbeat (30 days, 2 missed)
    await click(exact("Continue")); // 1,000 test QOR
    await click(exact("Generate my post-quantum key"));
    await until(() => text().includes("Public key ready"));
    await click(exact("Continue"));
    await click(exact("Seal the vault"));
    await until(() => !!exact("Open my vault"));
    expect(text()).toContain("signature 4,627 B");
    await click(exact("Open my vault"));
    expect(dialog("Create your vault")).toBeNull();
    await until(() => !!btn("Check in") && text().includes("alive"));
    expect(text()).toContain("1,000");

    // The signing moment: fields assemble, the lattice beats, then the verdict from the chain.
    await click(btn("Check in"));
    await until(() => /Verified on chain by pqcVerify \(0x…[0-9A-F]{4}\)/.test(text()));
    expect(text()).toContain("4,627 B");

    // Signature lab: the real signature, then one flipped bit is refused with the contract's own error name.
    await click(btn("See the signature"));
    await until(() => text().includes("Your signature, under glass"));
    await click(exact("Send it as signed"));
    await until(() => text().includes("ACCEPTED"));
    await click(exact("Flip one bit and send"));
    await until(() => text().includes("PQSignatureInvalid"));
    expect(text()).toContain("REFUSED");

    // Time and heirs: skip to overdue as the owner, trigger and pay as a stranger, then the heir sees real amounts.
    await click(tab("Heirs"));
    await click(btn("Skip to overdue"));
    await until(() => text().includes("overdue"));
    await click(btn("Continue as a stranger"));
    await click(btn("Trigger the vault"));
    await until(() => text().includes("Trigger vault: done"));
    await click(btn("Pay heirs"));
    await until(() => text().includes("Pay heirs: done"));
    expect(text()).toMatch(/Settled\. Maya received 599\.4 QOR/);
    await click(radio("Heir"));
    expect(text()).toMatch(/Maya received 599\.4 QOR/);
    expect([...document.querySelectorAll("button")].filter((b) => b.textContent === "Trigger the vault").length).toBe(0);
  });

  it("four tabs plus a More button, with Agent, Withdraw and Keys in the More list", async () => {
    await mount();
    await until(() => !!btn("Check in"));
    const main = [...document.querySelectorAll(".tabs-list [role=tab]")].map((t) => t.textContent);
    expect(main).toEqual(["Vault", "Lab", "Q-Day drill", "Heirs"]);
    expect([...document.querySelectorAll(".tabs-more [role=tab]")].map((t) => t.textContent)).toEqual(["Agent", "Withdraw", "Keys"]);
    // More is a plain button outside every tablist, not a tab.
    const more = document.querySelector<HTMLButtonElement>("button.tab-more")!;
    expect(more.textContent).toBe("More");
    expect(more.getAttribute("role")).toBeNull();
    expect(more.closest('[role="tablist"]')).toBeNull();
    expect(more.getAttribute("aria-haspopup")).toBe("true");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".tabs-more.is-open")).not.toBeNull();
    // Opening the list moves focus to its first item.
    expect(document.activeElement).toBe(tab("Agent"));
    await click(tab("Keys"));
    expect(tab("Keys").getAttribute("aria-selected")).toBe("true");
    expect(more.getAttribute("data-current")).toBe("true");
    expect(document.querySelector(".tabs-more.is-open")).toBeNull();
    // Picking an item gives focus back to More.
    expect(document.activeElement).toBe(more);
    expect(document.querySelector('[role="tabpanel"]')?.id).toBe("p-keys");
    await click(tab("Vault"));
    expect(more.getAttribute("data-current")).toBe("false");
    // Every landmark and list has its own name.
    const names = [...document.querySelectorAll("nav, [role=tablist]")].map((n) => n.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("the drill opens as the Q-Day takeover, then leaves its result on the drill screen", async () => {
    await mount();
    await until(() => !!btn("Check in"));
    await click(tab("Q-Day drill"));
    await click(btn("Run the Q-Day drill"));
    const qd = () => document.querySelector('[role="dialog"][aria-labelledby="qd-title"]');
    expect(qd()).not.toBeNull();
    expect(qd()!.textContent).toContain("Q-Day: your classical key is public.");
    await until(() => !!qd() && qd()!.textContent!.includes("Value kept: 100%. The stolen key moved nothing."), 120_000);
    await until(() => exact("Close") !== undefined && !exact("Close")!.disabled);
    await click(exact("Close"));
    expect(qd()).toBeNull();
    await until(() => text().includes("value kept") && /100%/.test(text()));
  });

  it("the vault names its heirs and the keeper bounty, the guide stays off the Lab, and a dead vault locks the lab", async () => {
    await mount();
    await until(() => !!btn("Check in"));
    expect(text()).toMatch(/Maya 60% · Leo 40%/);
    expect(text()).not.toContain("Sample vault");
    expect(text()).toContain("Keeper bounty");
    expect(text()).toContain("Guided run");
    await click(tab("Lab"));
    expect(document.querySelector(".guide--bar")).toBeNull();
    // Let it lapse and settle, then the lab is locked with a way out.
    await click(tab("Heirs"));
    await click(btn("Skip to overdue"));
    await until(() => text().includes("overdue"));
    await click(btn("Continue as a stranger"));
    await click(btn("Trigger the vault"));
    await until(() => text().includes("Trigger vault: done"));
    await click(btn("Pay heirs"));
    await until(() => text().includes("Pay heirs: done"));
    expect(text()).toContain("went to the keeper who triggered it");
    await click(tab("Lab"));
    await until(() => text().includes("Start over to try the lab."));
    expect(text()).toContain("This vault is settled.");
  });
});
