// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { App } from "./App";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 60_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout: " + document.body.textContent?.slice(0, 300));
    await act(async () => { await sleep(100); });
  }
}
const btn = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label)) as HTMLButtonElement | undefined;

describe("app", () => {
  it("boots in demo mode, checks in, tries an unsigned withdraw and runs the drill", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<App />); });
    await until(() => !!btn("Check in"));
    expect(document.body.textContent).toContain("500");
    expect(document.body.textContent).toContain("alive");
    // First visit: the vault hero (with Check in) comes before the guide, so Check in is not pushed under the bottom nav.
    const guide = document.querySelector(".guide")!;
    expect(btn("Check in")!.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.body.textContent).toContain("Press Check in. It signs");
    expect(document.querySelector("h2.q-sr")?.textContent).toBe("Your vault");

    await act(async () => { btn("Check in")!.click(); });
    await until(() => document.body.textContent!.includes("Check in: done"));
    expect(document.body.textContent).toContain("PQ signature 4,627 B");

    await act(async () => { btn("Withdraw")!.click(); });
    const box = document.querySelector('input[type=checkbox]') as HTMLInputElement;
    await act(async () => { box.click(); });
    await act(async () => { btn("Try without a signature")!.click(); });
    await until(() => document.body.textContent!.includes("reverted"));
    // The unsigned withdraw is the designed refusal: it reads as a win, not a failure.
    expect(document.querySelector(".res.ok")?.textContent).toContain("Refused, as designed");

    await act(async () => { btn("Q-Day drill")!.click(); });
    await act(async () => { btn("Run the Q-Day drill")!.click(); });
    await until(() => document.body.textContent!.includes("value kept") && /100%/.test(document.body.textContent!) && !btn("Attacking…"), 120_000);
    expect(document.body.textContent).toContain("blocked");
    root.unmount();
  });
});
