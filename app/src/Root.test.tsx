// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRoot, type Root as ReactRoot } from "react-dom/client";
import { act } from "react";
import { Root } from "./Root";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = () => document.body.textContent ?? "";
async function until(cond: () => boolean, ms = 60_000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timeout: " + text().slice(0, 500));
    await act(async () => { await sleep(100); });
  }
}
const btn = (label: string) => ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => b.textContent?.includes(label));

let root: ReactRoot | null = null;
async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Root />); });
}
beforeEach(() => { try { localStorage.clear(); window.location.hash = ""; } catch { /* none */ } });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

describe("landing to app", () => {
  it("the hero button opens the app with the briefing, once", async () => {
    await mount();
    await act(async () => { btn("Open the vault, no wallet")!.click(); });
    expect(document.querySelector('[role="dialog"][aria-label="Q-Day briefing"]')).not.toBeNull();
    await act(async () => { [...document.querySelectorAll("button")].find((b) => b.textContent === "Skip briefing")!.click(); });
    await until(() => !!btn("Check in"));
    expect(localStorage.getItem("qdmv.story")).toBe("1");
  });

  it("the Signature lab teaser goes straight to the Lab screen with a real signature", async () => {
    await mount();
    await act(async () => { btn("Try it on the real chain")!.click(); });
    expect(document.querySelector('[role="dialog"][aria-label="Q-Day briefing"]')).toBeNull();
    await until(() => text().includes("Your signature, under glass"));
    await until(() => !!btn("Flip one bit and send"));
  });
});
