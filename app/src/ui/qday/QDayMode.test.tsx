// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act, useState } from "react";
import { QDayMode } from "./QDayMode";
import type { Adapter, DrillReport, DrillRow } from "../../chain/types";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ROWS: DrillRow[] = [
  { name: "Withdraw with the stolen key", how: "classical ECDSA signature", blocked: true, harmless: false, revert: "PQSignatureInvalid", valueMoved: "0" },
  { name: "Replay a heartbeat", how: "old signature", blocked: true, harmless: true, revert: "accepted, changed nothing", valueMoved: "0" },
];
const REPORT: DrillReport = { rows: ROWS, tried: 2, blocked: 2, valueKeptPct: 100, valueKept: "100%", distinctPaths: 2, reachedVerifier: 1, scope: "Against the real contract bytecode." };

function Host({ onClose, runSpy }: { onClose: () => void; runSpy: () => void }) {
  const [d, setD] = useState<{ rows: DrillRow[]; report: DrillReport | null; running: boolean }>({ rows: [], report: null, running: false });
  const runDrill = async () => {
    runSpy();
    setD({ rows: [], report: null, running: true });
    for (let i = 0; i < ROWS.length; i++) { await sleep(5); setD((s) => ({ ...s, rows: ROWS.slice(0, i + 1) })); }
    setD({ rows: ROWS, report: REPORT, running: false });
  };
  return <QDayMode open adapter={{} as Adapter} drill={d} runDrill={runDrill} onClose={onClose} />;
}

describe("QDayMode", () => {
  it("runs the drill, prints each attempt, ends on the verdict and closes", async () => {
    const onClose = vi.fn(); const runSpy = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    await act(async () => { root.render(<Host onClose={onClose} runSpy={runSpy} />); });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[role="dialog"]')).toBeTruthy();
    expect(el.textContent).toContain("Q-Day: your classical key is public.");
    // Escape does nothing while running.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).not.toHaveBeenCalled();
    for (let i = 0; i < 60 && !(el.textContent!.includes("Value kept") && el.textContent!.includes("NO EFFECT") && el.textContent!.includes("REFUSED")); i++) await act(async () => { await sleep(50); });
    expect(el.textContent).toContain("Value kept: 100%. The stolen key moved nothing.");
    expect(el.textContent).toContain("REFUSED");
    expect(el.textContent).toContain("PQSignatureInvalid");
    expect(el.textContent).toContain("NO EFFECT");
    // Live region carries only start and final verdict.
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toContain("Value kept 100 percent");
    expect(el.querySelector(".qd__term")!.getAttribute("aria-live")).toBe("off");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    const close = [...el.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    await act(async () => { close.click(); });
    expect(onClose).toHaveBeenCalledTimes(2);
    await act(async () => { root.unmount(); });
  });

  it("reveals one attempt at a time, whatever the chain's speed, and shows a failed drill with Close enabled", async () => {
    const many: DrillRow[] = Array.from({ length: 6 }, (_, i) => ({ ...ROWS[0], name: `Attempt ${i + 1}` }));
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    const rep: DrillReport = { ...REPORT, rows: many, tried: 6, blocked: 6 };
    // The chain answers all six at once.
    await act(async () => { root.render(<QDayMode open adapter={{} as Adapter} drill={{ rows: many, report: rep, running: false }} runDrill={async () => {}} onClose={() => {}} />); });
    // Opened with a finished drill: everything is already there.
    expect(el.querySelectorAll(".qd-t").length).toBe(6);
    await act(async () => { root.unmount(); });

    const el2 = document.createElement("div");
    document.body.appendChild(el2);
    const root2 = createRoot(el2);
    function Live() {
      const [d, setD] = useState<{ rows: DrillRow[]; report: DrillReport | null; running: boolean }>({ rows: [], report: null, running: true });
      return <><button id="all" onClick={() => setD({ rows: many, report: rep, running: false })}>all</button><QDayMode open adapter={{} as Adapter} drill={d} runDrill={async () => {}} onClose={() => {}} /></>;
    }
    await act(async () => { root2.render(<Live />); });
    await act(async () => { (el2.querySelector("#all") as HTMLButtonElement).click(); });
    // Right after the whole result lands, only the first row or two are on screen and the drill is not done.
    expect(el2.querySelectorAll(".qd-t:not(.qd__wait)").length).toBeLessThan(4);
    expect(el2.textContent).not.toContain("Value kept: 100%");
    const close0 = [...el2.querySelectorAll("button")].find((b) => b.textContent === "Running…");
    expect(close0).toBeTruthy();
    for (let i = 0; i < 80 && !el2.textContent!.includes("Value kept: 100%"); i++) await act(async () => { await sleep(50); });
    expect(el2.textContent).toContain("Value kept: 100%");
    expect(el2.querySelectorAll(".qd-t").length).toBe(6);
    await act(async () => { root2.unmount(); });

    const el3 = document.createElement("div");
    document.body.appendChild(el3);
    const root3 = createRoot(el3);
    await act(async () => { root3.render(<QDayMode open adapter={{} as Adapter} drill={{ rows: [], report: null, running: false, error: "The chain stopped." }} runDrill={async () => {}} onClose={() => {}} />); });
    expect(el3.textContent).toContain("The chain stopped.");
    expect([...el3.querySelectorAll("button")].find((b) => b.textContent === "Close")!.disabled).toBe(false);
    await act(async () => { root3.unmount(); });
  });

  it("renders nothing when closed", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    await act(async () => { createRoot(el).render(<QDayMode open={false} adapter={{} as Adapter} drill={{ rows: [], report: null, running: false }} runDrill={async () => {}} onClose={() => {}} />); });
    expect(el.innerHTML).toBe("");
  });
});
