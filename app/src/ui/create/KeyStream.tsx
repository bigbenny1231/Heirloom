import { useEffect, useRef, useState } from "react";

const COLS = 54;
const hex = (b: number) => b.toString(16).padStart(2, "0");
function reduced() {
  try { return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/**
 * The "Generate my post-quantum key" step. The visual is the real public key: its bytes stream in as a hex window and a heat grid.
 * `bytes` and `done` live in the parent so Back and Continue keep the finished state. With no getBytes the step shows a static
 * explanation and reports done immediately.
 */
export function KeyStream({ getBytes, bytes, done, onBytes, onDone }: { getBytes?: () => Uint8Array; bytes: Uint8Array | null; done: boolean; onBytes: (b: Uint8Array) => void; onDone: () => void }) {
  const [n, setN] = useState(() => (done && bytes ? bytes.length : 0));
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => { if (!getBytes) doneRef.current(); }, [getBytes]);

  const stream = (b: Uint8Array) => {
    drawn.current = 0;
    if (timer.current) clearInterval(timer.current);
    if (reduced() || b.length === 0) { setN(b.length); return; }
    const total = b.length;
    const t0 = Date.now();
    const id = (timer.current = setInterval(() => {
      const f = Math.min(1, (Date.now() - t0) / 2600);
      setN(Math.round(total * f * f * (3 - 2 * f)));
      if (f >= 1) clearInterval(id);
    }, 40));
  };

  const start = () => {
    let b: Uint8Array;
    try { b = getBytes!(); } catch { b = new Uint8Array(0); }
    onBytes(b);
    stream(b);
  };

  // Came back mid-stream: resume with the bytes already made.
  useEffect(() => { if (bytes && !done) stream(bytes); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => { if (bytes && n >= bytes.length && n > 0) doneRef.current(); }, [n, bytes]);

  // incremental heat grid
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !bytes) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = cv.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return;
    const rows = Math.ceil(bytes.length / COLS);
    const s = 5;
    if (cv.width !== COLS * s) { cv.width = COLS * s; cv.height = rows * s; }
    for (let i = drawn.current; i < n; i++) {
      const v = bytes[i];
      ctx.fillStyle = `hsl(${185 + (v / 255) * 20} 90% ${18 + (v / 255) * 55}%)`;
      ctx.fillRect((i % COLS) * s, Math.floor(i / COLS) * s, s - 1, s - 1);
    }
    drawn.current = n;
  }, [n, bytes]);

  const started = !!bytes;

  if (!getBytes) {
    return (
      <div className="cf-key">
        <div className="cf-key-static">
          <p className="q-mono">pk 2,592 B · sig 4,627 B</p>
          <p>The key is made on this device when you seal the vault. A live preview of its bytes is not available in this mode.</p>
        </div>
      </div>
    );
  }

  const total = bytes?.length ?? 2592;
  const finished = !!bytes && n >= total && total > 0;
  const lo = bytes ? Math.max(0, n - 96) : 0;
  const win = bytes ? Array.from(bytes.subarray(lo, n), hex) : [];
  const lines: string[] = [];
  for (let i = 0; i < win.length; i += 16) lines.push(win.slice(i, i + 16).join(" "));

  return (
    <div className="cf-key">
      {!started ? (
        <button type="button" className="q-btn q-btn--block" onClick={start}>Generate my post-quantum key</button>
      ) : (
        <>
          <canvas ref={canvas} className="cf-heat" aria-hidden="true" />
          <pre className="cf-hex q-mono" aria-hidden="true">{lines.join("\n") || "…"}</pre>
          <div className="cf-prog" aria-hidden="true"><span style={{ width: `${(n / total) * 100}%` }} /></div>
          <p className="cf-key-count q-mono" aria-hidden="true">
            {finished ? `Public key ready · ${total.toLocaleString("en-US")} bytes · ML-DSA-87` : `${n.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} bytes`}
          </p>
          <p className="q-sr" role="status" aria-live="polite">{finished ? `Public key ready, ${total.toLocaleString("en-US")} bytes, ML-DSA-87.` : ""}</p>
        </>
      )}
    </div>
  );
}
