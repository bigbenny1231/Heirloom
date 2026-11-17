import { useEffect, useRef } from "react";
import { frame, type FrameOpts } from "./frame";
import { paint } from "./draw";

export interface HeroCanvasProps {
  /** "idle" before any run, "running" during, "done" after. */
  run: "idle" | "running" | "done";
  /** Changes on every click of Run Q-Day so a replay restarts the timeline. */
  runId: number;
  stage: number;
  progress: number;
  reduced: boolean;
  label: string;
}

/** Real-time canvas for the hero. Pauses off screen and in hidden tabs, DPR capped at 2, static under reduced motion. */
export function HeroCanvas({ run, runId, stage, progress, reduced, label }: HeroCanvasProps) {
  const cv = useRef<HTMLCanvasElement | null>(null);
  const st = useRef({ run, runId, stage, progress, reduced, runStart: -1, prevStage: 0, stageAt: -1e9, lastRunId: 0, lastStage: 0, draw: () => {} });

  /* keep the mutable state the loop reads in step with props, without restarting the loop */
  useEffect(() => {
    const s = st.current, now = typeof performance !== "undefined" ? performance.now() : 0;
    if (runId !== s.lastRunId) { s.lastRunId = runId; s.runStart = runId > 0 ? now : -1; s.prevStage = 0; s.stageAt = -1e9; s.lastStage = 0; }
    if (stage !== s.lastStage) { s.prevStage = s.lastStage; s.lastStage = stage; s.stageAt = now; }
    s.run = run; s.runId = runId; s.stage = stage; s.progress = progress; s.reduced = reduced;
    s.draw();
  }, [run, runId, stage, progress, reduced]);

  useEffect(() => {
    const canvas = cv.current;
    if (!canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try { ctx = canvas.getContext("2d"); } catch { ctx = null; }
    if (!ctx) return;
    const c2 = ctx;
    let raf = 0, visible = true, w = 0, h = 0, dpr = 1;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, Math.round(r.width)); h = Math.max(1, Math.round(r.height));
      dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    };
    const draw = () => {
      if (!w || !h) size();
      if (!w || !h) return;
      const s = st.current, now = performance.now();
      const fin = s.reduced && s.run === "done";
      const o: FrameOpts = {
        runStart: fin ? 1 : s.run === "idle" ? -1 : s.runStart < 0 ? 1 : s.runStart,
        stage: s.stage, prevStage: s.prevStage, stageT: s.reduced ? 1e9 : now - s.stageAt, progress: s.progress,
        reduced: s.reduced,
      };
      c2.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(c2, frame(s.reduced ? 0 : now, w, h, o), w, h);
    };
    st.current.draw = draw;
    const loop = () => {
      raf = 0;
      if (!visible || document.hidden || st.current.reduced) return;
      draw();
      raf = requestAnimationFrame(loop);
    };
    const kick = () => { if (!raf && visible && !document.hidden && !st.current.reduced) raf = requestAnimationFrame(loop); };
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => { size(); draw(); }) : null;
    ro?.observe(canvas);
    const io = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); if (visible) kick(); }) : null;
    io?.observe(canvas);
    const vis = () => { if (document.hidden) { if (raf) cancelAnimationFrame(raf); raf = 0; } else { draw(); kick(); } };
    document.addEventListener("visibilitychange", vis);
    size(); draw(); kick();
    /* fonts load after first paint: redraw once they are in */
    try { (document as unknown as { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => draw()); } catch { /* ignore */ }
    return () => { if (raf) cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect(); document.removeEventListener("visibilitychange", vis); st.current.draw = () => {}; };
  }, []);

  /* reduced motion: the loop is off, so repaint on every prop change (done in the sync effect) */
  return <canvas ref={cv} className="hc-canvas" role="img" aria-label={label} />;
}
