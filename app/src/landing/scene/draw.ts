import type { DrawOp } from "./frame";

const MONO = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const DISP = '"Archivo", "Inter", system-ui, sans-serif';

/** Paint ops onto a 2D context whose transform is already set to CSS pixels. */
export function paint(ctx: CanvasRenderingContext2D, ops: DrawOp[], w: number, h: number) {
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let blend: GlobalCompositeOperation = "source-over";
  for (const op of ops) {
    const b = op.blend ?? "source-over";
    if (b !== blend) { ctx.globalCompositeOperation = b; blend = b; }
    ctx.globalAlpha = Math.max(0, Math.min(1, op.a));
    switch (op.k) {
      case "circle":
        ctx.beginPath(); ctx.arc(op.x, op.y, Math.max(0, op.r), 0, Math.PI * 2);
        if (op.fill) { ctx.fillStyle = op.fill; ctx.fill(); }
        if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.w ?? 1; ctx.stroke(); }
        break;
      case "blob": {
        if (op.r <= 0.5) break;
        const g = ctx.createRadialGradient(op.x, op.y, 0, op.x, op.y, op.r);
        g.addColorStop(0, op.c); g.addColorStop(0.4, op.c + "66"); g.addColorStop(1, op.c + "00");
        ctx.fillStyle = g; ctx.fillRect(op.x - op.r, op.y - op.r, op.r * 2, op.r * 2);
        break;
      }
      case "tris":
        if (!op.p.length) break;
        ctx.beginPath();
        for (let i = 0; i < op.p.length; i += 6) { ctx.moveTo(op.p[i], op.p[i + 1]); ctx.lineTo(op.p[i + 2], op.p[i + 3]); ctx.lineTo(op.p[i + 4], op.p[i + 5]); ctx.closePath(); }
        ctx.fillStyle = op.c; ctx.fill();
        break;
      case "segs":
        if (!op.p.length) break;
        ctx.lineCap = op.cap === "butt" ? "butt" : "round";
        ctx.beginPath();
        for (let i = 0; i < op.p.length; i += 4) { ctx.moveTo(op.p[i], op.p[i + 1]); ctx.lineTo(op.p[i + 2], op.p[i + 3]); }
        ctx.strokeStyle = op.c; ctx.lineWidth = op.w; ctx.stroke();
        break;
      case "poly":
        if (op.p.length < 4) break;
        ctx.lineCap = op.cap === "butt" ? "butt" : "round";
        ctx.beginPath(); ctx.moveTo(op.p[0], op.p[1]);
        for (let i = 2; i < op.p.length; i += 2) ctx.lineTo(op.p[i], op.p[i + 1]);
        if (op.close) ctx.closePath();
        if (op.fill) { ctx.fillStyle = op.fill; ctx.fill(); }
        if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.w ?? 1; ctx.stroke(); }
        break;
      case "dots":
        if (!op.p.length) break;
        ctx.beginPath();
        for (let i = 0; i < op.p.length; i += 2) { ctx.moveTo(op.p[i] + op.r, op.p[i + 1]); ctx.arc(op.p[i], op.p[i + 1], op.r, 0, Math.PI * 2); }
        ctx.fillStyle = op.c; ctx.fill();
        break;
      case "rect": {
        const rr = op.r ?? 0;
        if (rr > 0) {
          const x = op.x, y = op.y, w2 = op.w, h2 = op.h;
          ctx.beginPath(); ctx.moveTo(x + rr, y); ctx.arcTo(x + w2, y, x + w2, y + h2, rr); ctx.arcTo(x + w2, y + h2, x, y + h2, rr); ctx.arcTo(x, y + h2, x, y, rr); ctx.arcTo(x, y, x + w2, y, rr); ctx.closePath();
          if (op.fill) { ctx.fillStyle = op.fill; ctx.fill(); }
          if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.sw ?? 1; ctx.stroke(); }
        } else {
          if (op.fill) { ctx.fillStyle = op.fill; ctx.fillRect(op.x, op.y, op.w, op.h); }
          if (op.stroke) { ctx.strokeStyle = op.stroke; ctx.lineWidth = op.sw ?? 1; ctx.strokeRect(op.x, op.y, op.w, op.h); }
        }
        break;
      }
      case "text": {
        ctx.font = `500 ${op.size}px ${op.font === "mono" ? MONO : DISP}`;
        ctx.fillStyle = op.c; ctx.textBaseline = "alphabetic";
        const ls = op.track ?? 0;
        (ctx as unknown as { letterSpacing: string }).letterSpacing = `${ls}px`;
        const al = op.align ?? "left";
        const tw = ctx.measureText(op.s).width - ls; // trailing spacing is not visible
        const x = al === "center" ? op.x - tw / 2 : al === "right" ? op.x - tw : op.x;
        ctx.textAlign = "left";
        ctx.fillText(op.s, x, op.y);
        (ctx as unknown as { letterSpacing: string }).letterSpacing = "0px";
        break;
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}
