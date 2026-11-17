// @vitest-environment happy-dom
/**
 * Walks the Demo-mode screens the first app test does not: Keys (backup, bad import, rotate), Heirs (split, payout
 * change, trigger, settle), Agent (pay, caps, revoke, locked after settlement), Withdraw (locked note), Settings
 * (reset, Testnet mode without a wallet). Real bytecode and real ML-DSA-87 underneath, as in the app.
 */
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { App } from "./App";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.textContent ?? "";
async function until(cond: () => boolean, ms = 90_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout: " + text().slice(0, 600));
    await act(async () => { await sleep(100); });
  }
}
const buttons = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];
const btn = (label: string) => buttons().find((b) => b.textContent?.includes(label));
const tab = (label: string) => buttons().find((b) => b.getAttribute("role") === "tab" && b.textContent === label)!;
const radio = (label: string) => ([...document.querySelectorAll('[role="radio"]')] as HTMLElement[]).find((b) => b.textContent === label);
const click = async (b: HTMLElement | undefined) => {
  if (!b) throw new Error("button not found; page: " + text().slice(0, 400));
  await act(async () => { b.click(); });
};
/** Set a controlled input/select/textarea the way React listens for it. */
async function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const idle = () => until(() => !btn("Check in") || !buttons().some((b) => b.textContent?.includes("Attacking")));

describe("app flows (demo mode)", () => {
  it("keys, heirs, agent, settlement, reset and testnet-without-wallet all behave", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<App />); });
    await until(() => !!btn("Check in"));

    // No browser dialogs anywhere: the page must work inside a sandboxed frame.
    for (const k of ["alert", "confirm", "prompt", "open"] as const) {
      (window as unknown as Record<string, unknown>)[k] = () => { throw new Error(`window.${k} was called`); };
    }

    // ---- Keys: backup string shows and hides; a bad import is refused in the page (never "reverted")
    await click(tab("Keys"));
    expect(text()).toContain("this key");
    await click(btn("Show backup string"));
    const backup = (document.querySelector("textarea[readonly]") as HTMLTextAreaElement).value;
    expect(backup).toMatch(/^qdmv1:[0-9a-f]{64}:[0-9a-f]{8}$/);
    const importBox = [...document.querySelectorAll("textarea")].find((t) => !t.readOnly)!;
    await setValue(importBox, "not-a-key");
    await click(btn("Import key"));
    await until(() => text().includes("Import device key: not sent"));
    expect(text()).toContain("not a QDMV device key");

    // rotate: the old backup string must disappear with the old key
    await click(btn("Rotate device key"));
    await click(btn("Rotate now"));
    await until(() => text().includes("Rotate device key: done"));
    expect(document.querySelector("textarea[readonly]")).toBeNull();
    expect(text()).toContain("this key");
    await click(btn("Show backup string"));
    const backup2 = (document.querySelector("textarea[readonly]") as HTMLTextAreaElement).value;
    expect(backup2).not.toBe(backup);

    // importing the OLD key asks first, then is honest about the mismatch
    await setValue([...document.querySelectorAll("textarea")].find((t) => !t.readOnly)!, backup);
    await click(btn("Import key"));
    await until(() => text().includes("Import this key?"));
    await click(btn("Cancel"));
    expect(text()).not.toContain("Import this key?");

    // the new key really signs: check in on the Vault tab
    await click(tab("Vault"));
    await click(btn("Check in"));
    await until(() => text().includes("Check in: done"));

    // ---- Agent: inside the cap pays, over the cap and an unknown payee are denied without a revert
    await click(tab("Agent"));
    expect(text()).toContain("active");
    await click(btn("Pay 3 QOR invoice"));
    await until(() => text().includes("Agent pays: done"));
    await click(btn("Pay 8 QOR (over cap)"));
    await until(() => text().includes("OVER_PER_TX"));
    expect(text()).toContain("Agent pays: denied");
    await click(btn("Send 50 QOR to new address"));
    await until(() => text().includes("PAYEE_NOT_ALLOWED"));
    await click(btn("Revoke agent"));
    await until(() => text().includes("Revoke agent: done"));
    expect(text()).toContain("Set an allowance");
    await click(btn("Allow 5 QOR per payment"));
    await until(() => text().includes("Set agent allowance: done"));

    // ---- Heirs: split, heir-signed payout change, then the dead man's switch
    await click(tab("Heirs"));
    expect(text()).toContain("60%");
    const range = document.querySelector("input[type=range]") as HTMLInputElement;
    await setValue(range, "7000");
    await click(btn("Save split"));
    await until(() => text().includes("Set heirs: done"));
    expect(text()).toContain("70%");

    const sel = document.querySelector("select") as HTMLSelectElement;
    await setValue(sel, sel.options[3].value); // "New wallet"
    await click(btn("Sign and change payout"));
    await until(() => text().includes("Change heir payout: done"));

    // Anyone can trigger, so Trigger and Pay heirs live under the Stranger view. Nothing is triggerable while the vault is alive.
    await click(radio("Stranger"));
    expect(btn("Trigger the vault")!.disabled).toBe(true);
    await click(radio("Owner"));
    await click(btn("Skip to overdue"));
    await until(() => text().includes("overdue"));
    await click(btn("Continue as a stranger"));
    await click(btn("Trigger the vault"));
    await until(() => text().includes("Trigger vault: done"));
    expect(text()).toContain("triggered");
    await click(btn("Pay heirs"));
    await until(() => text().includes("Pay heirs: done"));
    expect(text()).toContain("settled");
    expect(text()).toMatch(/Settled\. Maya (received|is owed)/);

    // ---- after settlement: the vault is empty and every owner screen says why it is locked
    await click(tab("Vault"));
    expect(btn("Check in")!.disabled).toBe(true);
    await click(tab("Withdraw"));
    expect(text()).toContain("Owner actions are locked");
    await click(tab("Agent"));
    expect(text()).toContain("a new one cannot be set");
    expect(btn("Allow 5 QOR per payment")!.disabled).toBe(true);
    await click(tab("Q-Day drill"));
    expect(text()).toContain("Vault is empty or no longer active.");
    expect(btn("Run the Q-Day drill")!.disabled).toBe(true);

    // ---- Settings: reset brings the sample vault back and clears the log and old toasts
    await click(buttons().find((b) => b.className === "chip"));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click(btn("Reset the demo"));
    await until(() => !btn("Reset the demo")!.disabled && text().includes("Every action shows its gas"), 120_000);
    await click(btn("Done"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(tab("Vault"));
    await until(() => text().includes("alive"));
    expect(text()).toContain("500");
    expect(btn("Check in")!.disabled).toBe(false);

    // ---- Testnet mode with no wallet: a plain empty state, no crash, and a way back
    await click(buttons().find((b) => b.className === "chip"));
    await click(buttons().find((b) => b.textContent === "Testnet"));
    await until(() => text().includes("No wallet found"));
    await click(btn("Done"));
    await until(() => text().includes("No vault yet") || text().includes("Could not start"));
    await click(buttons().find((b) => b.className === "chip"));
    await click(buttons().find((b) => b.textContent === "Demo"));
    await click(btn("Done"));
    await until(() => !!btn("Check in") && text().includes("alive"), 120_000);
    void idle;
    root.unmount();
  });
});
