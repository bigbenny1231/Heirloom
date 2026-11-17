// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Landing } from "./Landing";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

function mount(onOpen: () => void, onLab?: () => void) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Landing onOpenApp={onOpen} onOpenLab={onLab} />));
}
const btns = () => [...document.querySelectorAll("button")] as HTMLButtonElement[];

describe("Landing", () => {
  it("renders headline, six FAQ items and the CTA opens the app", () => {
    const open = vi.fn();
    mount(open);
    expect(document.querySelector("h1")?.textContent).toBe("Built to outlive Q-Day.");
    expect(document.querySelectorAll(".ld-faq details").length).toBe(6);
    const cta = btns().find((b) => b.textContent?.includes("Open the vault, no wallet"))!;
    act(() => { cta.click(); });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("Run Q-Day is a real button, runs once, and persists its final frame with Replay", () => {
    vi.useFakeTimers();
    try {
      mount(() => {});
      const run = btns().find((b) => b.textContent?.includes("Run Q-Day"))!;
      expect(run.tabIndex).toBeGreaterThanOrEqual(0);
      act(() => run.focus());
      expect(document.activeElement).toBe(run);
      const hero = document.querySelector(".ld-hero-core")!;
      expect(hero.getAttribute("data-run")).toBe("idle");
      act(() => { run.click(); });
      expect(hero.getAttribute("data-run")).toBe("running");
      expect(run.getAttribute("aria-disabled")).toBe("true");
      act(() => { vi.advanceTimersByTime(7000); });
      expect(hero.getAttribute("data-run")).toBe("done");
      expect(hero.textContent).toContain("Value kept: 100%");
      expect(btns().some((b) => b.textContent?.trim() === "Replay")).toBe(true);
      // the final frame persists: nothing resets it
      act(() => { vi.advanceTimersByTime(20000); });
      expect(hero.getAttribute("data-run")).toBe("done");
      // the finale shows one way into the vault, not two, and both secondary actions
      const hs = document.querySelector(".ld-hero")!;
      const inHero = [...hs.querySelectorAll("button")].filter((b) => b.textContent?.includes("Open the vault, no wallet"));
      expect(inHero.length).toBe(1);
      expect(hero.contains(inHero[0])).toBe(true);
      expect([...hero.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Stop checking in")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reduced motion jumps straight to the final frame", () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: /reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
    try {
      mount(() => {});
      const run = btns().find((b) => b.textContent?.includes("Run Q-Day"))!;
      act(() => { run.click(); });
      expect(document.querySelector(".ld-hero-core")!.getAttribute("data-run")).toBe("done");
    } finally {
      window.matchMedia = mm;
    }
  });

  it("teases the Signature lab: one flipped bit is refused, and the button opens the lab", () => {
    const lab = vi.fn(), open = vi.fn();
    mount(open, lab);
    const section = document.getElementById("lab")!;
    expect(section.textContent).toContain("Flip one bit of a real ML-DSA-87 signature and watch the contract refuse it");
    expect(section.textContent).toContain("Accepted");
    act(() => { btns().find((b) => b.textContent === "Flip one bit")!.click(); });
    expect(section.textContent).toContain("PQSignatureInvalid");
    act(() => { btns().find((b) => b.textContent?.includes("Try it on the real chain"))!.click(); });
    expect(lab).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});
