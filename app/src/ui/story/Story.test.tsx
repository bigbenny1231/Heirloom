// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Story } from "./Story";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; vi.useRealTimers(); });

function mount(onDone = () => {}, onSkip = () => {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Story onDone={onDone} onSkip={onSkip} />));
}
const btn = (t: string) => ([...document.querySelectorAll("button")] as HTMLButtonElement[]).find((b) => b.textContent?.includes(t))!;
const title = () => document.querySelector(".st-title")?.textContent;
const key = (k: string) => act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

describe("Story", () => {
  it("starts on chapter I, advances with Next and the keyboard, and reaches Build yours", () => {
    const done = vi.fn();
    mount(done);
    expect(title()).toBe("Your keys guard everything.");
    expect(document.querySelectorAll(".st-bar").length).toBe(4);
    act(() => btn("Next").click());
    expect(title()).toBe("Q-Day.");
    key("ArrowRight");
    expect(title()).toBe("Seal it with a lattice.");
    expect(document.body.textContent).toContain("ML-DSA-87");
    key("ArrowLeft");
    expect(title()).toBe("Q-Day.");
    key("ArrowRight"); key("ArrowRight");
    expect(title()).toBe("Build yours.");
    act(() => btn("Build my vault").click());
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("auto-advances on its clock and Skip calls onSkip (Escape too)", () => {
    vi.useFakeTimers();
    const skip = vi.fn();
    mount(() => {}, skip);
    act(() => { vi.advanceTimersByTime(4500 + 400); });
    expect(title()).toBe("Q-Day.");
    act(() => { vi.advanceTimersByTime(6500 + 400); });
    expect(title()).toBe("Seal it with a lattice.");
    act(() => btn("Skip briefing").click());
    expect(skip).toHaveBeenCalledTimes(1);
    key("Escape");
    expect(skip).toHaveBeenCalledTimes(2);
  });

  it("never uses the reserved button labels", () => {
    mount();
    const reserved = ["Check in", "Withdraw", "Done", "Pay heirs", "Reset the demo"];
    for (const b of document.querySelectorAll("button")) expect(reserved).not.toContain(b.textContent?.trim());
  });
});

describe("Story, touch and focus", () => {
  it("a long press only pauses: the click after it does not turn the page; a quick tap does; the page stops scrolling and Tab stays inside", () => {
    vi.useFakeTimers();
    mount();
    expect(document.body.style.overflow).toBe("hidden");
    const stage = document.querySelector(".st-stage") as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 600, right: 400, bottom: 600, x: 0, y: 0, toJSON() {} }) as DOMRect;
    const ev = (type: string, x: number) => { const e = new MouseEvent(type, { bubbles: true, clientX: x }); return e; };
    // Hold for a second, release, and the click that follows is ignored.
    act(() => { stage.dispatchEvent(ev("pointerdown", 300)); });
    act(() => { vi.advanceTimersByTime(1000); });
    act(() => { stage.dispatchEvent(ev("pointerup", 300)); stage.dispatchEvent(ev("click", 300)); });
    expect(title()).toBe("Your keys guard everything.");
    // A quick tap on the right advances.
    act(() => { stage.dispatchEvent(ev("pointerdown", 300)); stage.dispatchEvent(ev("pointerup", 300)); stage.dispatchEvent(ev("click", 300)); });
    expect(title()).toBe("Q-Day.");
    // Tab from the last control wraps to the first.
    const items = [...document.querySelectorAll<HTMLElement>("button")];
    items[items.length - 1].focus();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); });
    expect(document.activeElement).toBe(items[0]);
    act(() => root!.unmount());
    root = null;
    expect(document.body.style.overflow).toBe("");
  });
});
