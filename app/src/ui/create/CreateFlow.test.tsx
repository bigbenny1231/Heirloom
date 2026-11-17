// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { CreateFlow } from "./CreateFlow";
import type { Adapter, ActionResult } from "../../chain/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); });

const okResult: ActionResult = { ok: true, title: "Vault created", detail: "Vault sealed.", gasUsed: 123456n, sigBytes: 4627, at: 1 };
function stub(extra: Record<string, unknown> = {}) {
  return { kind: "demo", networkLabel: "In-browser demo chain", createVault: vi.fn(async (_c: unknown, progress?: (m: string) => void) => { progress?.("Deploying"); return okResult; }), keyBytes: () => Uint8Array.from({ length: 2592 }, (_, i) => (i * 7) & 255), ...extra } as unknown as Adapter;
}
function mount(ad: Adapter, onCreated = vi.fn(), onCancel = vi.fn(), onSealed = vi.fn()) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<CreateFlow adapter={ad} onCreated={onCreated} onCancel={onCancel} onSealed={onSealed} />));
  return { onCreated, onCancel, onSealed };
}
const btn = (t: string) => ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => b.textContent?.trim() === t)!;
const h2 = () => document.querySelector("h2")?.textContent;
const setInput = (el: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => { set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("CreateFlow", () => {
  it("walks all five steps and calls createVault with the chosen config", async () => {
    vi.useFakeTimers();
    const ad = stub();
    const { onCreated } = mount(ad);
    expect(h2()).toBe("Who inherits?");
    const inputs = () => [...document.querySelectorAll("input.q-field")] as HTMLInputElement[];
    expect(inputs().map((i) => i.value)).toEqual(["Maya", "Leo"]);
    expect(document.body.textContent).toContain("Maya 60%");
    setInput(inputs()[0], "Ava");
    act(() => btn("Continue").click());
    expect(h2()).toBe("Set the heartbeat.");
    act(() => (document.querySelector('[role=radio][aria-checked]') as HTMLElement | null) && (([...document.querySelectorAll("[role=radio]")] as HTMLElement[]).find((b) => b.textContent === "90 days")!.click()));
    act(() => ([...document.querySelectorAll("[role=radio]")] as HTMLElement[]).find((b) => b.textContent === "3 missed")!.click());
    expect(document.body.textContent).toContain("If you miss 3 check-ins after day 90, anyone can trigger the vault on");
    act(() => btn("Continue").click());
    expect(h2()).toBe("Lock some test QOR.");
    setInput(document.querySelector("input.cf-amount") as HTMLInputElement, "250");
    act(() => btn("Continue").click());
    expect(h2()).toBe("Make your post-quantum key.");
    expect(btn("Make the key first").disabled).toBe(true);
    act(() => btn("Generate my post-quantum key").click());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(document.body.textContent).toContain("Public key ready");
    act(() => btn("Continue").click());
    expect(h2()).toBe("Seal the vault.");
    await act(async () => { btn("Seal the vault").click(); });
    const create = (ad as unknown as { createVault: ReturnType<typeof vi.fn> }).createVault;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual({ heirs: [{ label: "Ava", bps: 6000 }, { label: "Leo", bps: 4000 }], intervalDays: 90, grace: 3, fundQor: 250, keyMode: "DEVICE" });
    expect(document.body.textContent).toContain("gas 123,456");
    expect(document.body.textContent).toContain("signature 4,627 B");
    expect(onCreated).not.toHaveBeenCalled();
    act(() => btn("Open my vault").click());
    expect(onCreated).toHaveBeenCalledWith(okResult);
  });

  it("validates names and amount before moving on", () => {
    const { } = mount(stub());
    const input = document.querySelector("input.q-field") as HTMLInputElement;
    setInput(input, "  ");
    act(() => btn("Continue").click());
    expect(h2()).toBe("Who inherits?");
    expect(document.querySelector('[role=alert]')?.textContent).toContain("name");
  });

  it("explains calmly and cancels when createVault is unavailable", () => {
    const { onCancel } = mount({ kind: "testnet", networkLabel: "QoreChain testnet" } as unknown as Adapter);
    expect(document.body.textContent).toContain("Creating happens on the demo chain.");
    act(() => btn("Go back").click());
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows a static key state when keyBytes is absent", () => {
    mount(stub({ keyBytes: undefined }));
    act(() => btn("Continue").click());
    act(() => btn("Continue").click());
    act(() => btn("Continue").click());
    expect(h2()).toBe("Make your post-quantum key.");
    expect(document.body.textContent).toContain("preview of its bytes is not available");
    expect(btn("Continue").disabled).toBe(false);
  });

  it("uses prepareKey, keeps the finished key on Back, shows the keeper bounty and calls onSealed once", async () => {
    vi.useFakeTimers();
    const prepareKey = vi.fn(() => Uint8Array.from({ length: 2592 }, (_, i) => i & 255));
    const ad = stub({ prepareKey, keyBytes: () => { throw new Error("old key"); } });
    const { onSealed, onCreated } = mount(ad);
    act(() => btn("Continue").click());
    act(() => btn("Continue").click());
    expect(document.body.textContent).toContain("Keeper bounty, paid to whoever triggers");
    expect(document.body.textContent).toContain("1 QOR");
    expect(document.body.textContent).toContain("599.4 QOR");
    act(() => btn("Continue").click());
    act(() => btn("Generate my post-quantum key").click());
    act(() => { vi.advanceTimersByTime(3000); });
    expect(prepareKey).toHaveBeenCalledTimes(1);
    act(() => btn("Back").click());
    act(() => btn("Continue").click());
    expect(document.body.textContent).toContain("Public key ready");
    expect(btn("Continue").disabled).toBe(false);
    expect(prepareKey).toHaveBeenCalledTimes(1);
    act(() => btn("Continue").click());
    await act(async () => { btn("Seal the vault").click(); });
    expect(onSealed).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });
});
