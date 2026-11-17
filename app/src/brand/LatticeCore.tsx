import { useId, useMemo, type ReactNode, type CSSProperties } from "react";
import "./lattice.css";

export type LatticeState = "NONE" | "ALIVE" | "WARNING" | "OVERDUE" | "TRIGGERED" | "SETTLED" | "CLOSED";

export interface LatticeCoreProps {
  state: LatticeState;
  /** Pixel size, or a CSS length such as "100%" for a fluid core (the svg keeps its aspect ratio). */
  size?: number | string;
  /** Fraction (0..1) of the check-in window remaining; drives the outer ring. */
  progress?: number;
  label?: string;
  sublabel?: string;
  /** Increment to fire an immediate pulse wave. */
  beat?: number;
  /** "ice" paints an ALIVE lattice in ice (the hero) instead of the app's alive green. */
  tone?: "ice";
  /** Extra SVG drawn on top, in the 320-unit lattice coordinate space (centre 160,160). */
  overlay?: ReactNode;
  /** Extra viewBox height (lattice units) below the core, for an overlay that lives under the ring. */
  extra?: number;
  /** HTML positioned over the core box (annotations). */
  children?: ReactNode;
}

const VB = 320;
const C = VB / 2;
const STEP = 24; // ring 3 reaches about 125 units, inside the progress ring at 147
const RINGS = 3;
const RING_R = 147;
const TICKS = 60;
const RING_LEN = 2 * Math.PI * RING_R;

const STATE_WORD: Record<LatticeState, string> = {
  NONE: "no vault yet",
  ALIVE: "alive",
  WARNING: "warning, check-in due soon",
  OVERDUE: "overdue, check-in missed",
  TRIGGERED: "triggered, ready to settle",
  SETTLED: "settled",
  CLOSED: "closed",
};

interface Node { id: number; x: number; y: number; ring: number; dist: number; r: number; o: number; fx: number; fy: number; q: number; rr: number }
interface Edge { a: Node; b: Node; spoke: boolean; far: boolean; keep: number; flick: boolean; dist: number; len: number }

const hash = (n: number) => {
  let h = (n + 1) * 2654435761;
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return ((h >>> 0) % 10000) / 10000;
};
const f = (n: number) => Math.round(n * 100) / 100;

/** Deterministic pointy-top hex lattice, mildly skewed so it reads as a cube/isometric field. */
function buildLattice() {
  const nodes: Node[] = [];
  const SQ3 = Math.sqrt(3);
  for (let q = -RINGS; q <= RINGS; q++) {
    for (let r = Math.max(-RINGS, -q - RINGS); r <= Math.min(RINGS, -q + RINGS); r++) {
      const ring = Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
      const x = STEP * (SQ3 * (q + r / 2));
      const y = STEP * 1.5 * r * 0.94;
      const dist = Math.hypot(x, y) / (STEP * SQ3 * 0.9);
      const id = nodes.length;
      const len = Math.hypot(x, y) || 1;
      const jitter = 0.7 + hash(id) * 0.6;
      nodes.push({
        id, x: C + x, y: C + y, ring, dist: f(dist), q, rr: r,
        r: ring === 0 ? 5.2 : f(3.4 - ring * 0.55 + hash(id + 50) * 0.5),
        o: ring === 0 ? 1 : f(0.95 - ring * 0.2 + hash(id + 9) * 0.1),
        fx: f((x / len) * (2 + ring * 2.2) * jitter + (hash(id + 3) - 0.5) * 2),
        fy: f((y / len) * (2 + ring * 2.2) * jitter + (hash(id + 4) - 0.5) * 2),
      });
    }
  }
  const byQR = new Map(nodes.map((n) => [`${n.q},${n.rr}`, n]));
  const dirs: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (a: Node, b: Node, far: boolean) => {
    const key = a.id < b.id ? `${a.id}-${b.id}` : `${b.id}-${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    // draw from the outer node to the inner node so a shortened dash retracts from the centre
    const [outer, inner] = Math.hypot(a.x - C, a.y - C) >= Math.hypot(b.x - C, b.y - C) ? [a, b] : [b, a];
    const i = edges.length;
    edges.push({
      a: outer, b: inner, far,
      spoke: !far && inner.ring === 0 && (outer.q + outer.rr) % 2 === 0 && [0, 2, 4].includes(dirs.findIndex(([dq, dr]) => dq === outer.q && dr === outer.rr)),
      keep: f(0.1 + hash(i + 100) * 0.55),
      flick: hash(i + 200) > 0.62,
      dist: f((outer.dist + inner.dist) / 2),
      len: Math.hypot(outer.x - inner.x, outer.y - inner.y),
    });
  };
  for (const n of nodes) {
    for (const [dq, dr] of dirs) {
      const m = byQR.get(`${n.q + dq},${n.rr + dr}`);
      if (m) add(n, m, false);
    }
  }
  // long-range chords for depth (skip-one neighbours on the middle ring), faint
  for (const n of nodes) {
    if (n.ring !== 2) continue;
    for (const [dq, dr] of dirs) {
      const m = byQR.get(`${n.q + dq * 2},${n.rr + dr * 2}`);
      if (m && m.ring === 2 && hash(n.id * 7 + dq * 3 + dr) > 0.35) add(n, m, true);
    }
  }
  return { nodes, edges };
}

const LATTICE = buildLattice();
/** Node centres in lattice units, for overlays that react to the lattice (impact ripples). */
export const LATTICE_POINTS: { x: number; y: number }[] = LATTICE.nodes.map((n) => ({ x: f(n.x), y: f(n.y) }));

/** Explicit dash lengths (no pathLength): full line, a fraction of it when fractured, or a wireframe dash. */
function edgeDash(e: Edge, state: LatticeState): string {
  if (state === "NONE") return "2 4";
  const frac = state === "OVERDUE" ? e.keep : state === "TRIGGERED" ? e.keep * 0.55 : 1;
  return `${f(e.len * frac)} ${f(e.len * 2)}`;
}

export function LatticeCore({ state, size = 280, progress, label, sublabel, beat, tone, overlay, extra = 0, children }: LatticeCoreProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { nodes, edges } = LATTICE;
  const fluid = typeof size === "string";
  const cls = `lc lc--${state.toLowerCase()}${tone === "ice" ? " lc--ice" : ""}${fluid ? " lc--fluid" : ""}`;
  const hasRing = state !== "NONE" && state !== "CLOSED" && state !== "SETTLED";
  const p = progress === undefined ? (hasRing ? 1 : 0) : Math.max(0, Math.min(1, progress));
  const aria = [`Vault ${STATE_WORD[state]}`, label && label.toLowerCase() !== STATE_WORD[state] ? label : "", sublabel].filter(Boolean).join(". ");

  const ticks = useMemo(
    () => Array.from({ length: TICKS }, (_, i) => {
      const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
      const major = i % 5 === 0;
      const r1 = RING_R + 4, r2 = RING_R + (major ? 11 : 7);
      return { i, major, x1: f(C + Math.cos(a) * r1), y1: f(C + Math.sin(a) * r1), x2: f(C + Math.cos(a) * r2), y2: f(C + Math.sin(a) * r2) };
    }),
    [],
  );

  const gid = `lcg${uid}`;
  const gidn = `lcn${uid}`;
  const showSweep = state === "ALIVE" || state === "WARNING";
  return (
    <div className={cls} style={{ width: size }}>
      <div className="lc-stage">
        <svg
          className="lc-svg"
          {...(fluid ? {} : { width: size as number, height: Math.round(((size as number) * (VB + 12 + extra)) / (VB + 12)) })}
          viewBox={`-6 -6 ${VB + 12} ${VB + 12 + extra}`}
          role="img"
          aria-label={aria}
        >
          <defs>
            <radialGradient id={gid} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--lc)" stopOpacity=".26" />
              <stop offset="55%" stopColor="var(--lc)" stopOpacity=".07" />
              <stop offset="100%" stopColor="var(--lc)" stopOpacity="0" />
            </radialGradient>
            <radialGradient id={gidn} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--lc)" stopOpacity=".5" />
              <stop offset="100%" stopColor="var(--lc)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx={C} cy={C} r={RING_R + 8} fill={`url(#${gid})`} />
          <circle className="lc-track" cx={C} cy={C} r={RING_R} />
          {ticks.map((t) => (
            <line key={t.i} className={`lc-tick${t.major ? " is-major" : ""}${hasRing && t.i / TICKS < p ? " is-on" : ""}`} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} />
          ))}
          {hasRing && p > 0 && (
            <g transform={`rotate(-90 ${C} ${C})`}>
              <circle className="lc-prog-glow" cx={C} cy={C} r={RING_R} style={{ strokeDasharray: `${f(p * RING_LEN)} ${f(RING_LEN)}` }} />
              <circle className="lc-prog" cx={C} cy={C} r={RING_R} style={{ strokeDasharray: `${f(p * RING_LEN)} ${f(RING_LEN)}` }} />
            </g>
          )}
          {showSweep && <circle className="lc-sweep" cx={C} cy={C} r={130} />}
          <g className="lc-edges">
            {edges.map((e, i) => (
              <line
                key={i}
                className={`lc-edge${e.spoke ? " is-spoke" : ""}${e.flick ? " is-flick" : ""}`}
                x1={f(e.a.x)} y1={f(e.a.y)} x2={f(e.b.x)} y2={f(e.b.y)}
                style={{ "--dist": e.dist, "--eo": e.far ? 0.14 : e.spoke ? 0.55 : 0.3, strokeDasharray: edgeDash(e, state) } as CSSProperties}
              />
            ))}
          </g>
          <g className="lc-nodes">
            {nodes.map((n) => (
              <g key={n.id} className="lc-node-g" style={{ "--fx": `${n.fx}px`, "--fy": `${n.fy}px` } as CSSProperties}>
                <circle className="lc-node-glow" cx={f(n.x)} cy={f(n.y)} r={f(n.r * 2.6)} fill={`url(#${gidn})`} />
                <circle className="lc-node" cx={f(n.x)} cy={f(n.y)} r={n.r} style={{ "--dist": n.dist, "--o": n.o } as CSSProperties} />
              </g>
            ))}
          </g>
          <circle className="lc-halo lc-core-halo" cx={C} cy={C} r={13} />
          <circle className="lc-core" cx={C} cy={C} r={6.4} />
          {beat !== undefined && beat > 0 && (
            <g key={beat} aria-hidden="true">
              <circle className="lc-beat-ring" cx={C} cy={C} r={RING_R} />
              {nodes.map((n) => (
                <circle key={n.id} className="lc-beat-node" cx={f(n.x)} cy={f(n.y)} r={Math.max(2, n.r - 0.6)} style={{ "--dist": n.dist } as CSSProperties} />
              ))}
            </g>
          )}
          {overlay}
        </svg>
        {children}
      </div>
      {label && <div className="lc-label">{label}</div>}
      {sublabel && <div className="lc-sub">{sublabel}</div>}
    </div>
  );
}
