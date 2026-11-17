import type { CSSProperties } from "react";
import { LatticeCore, LATTICE_POINTS } from "../../brand/LatticeCore";

export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
/** Eased 0..1 for the slice [a,b] of p. */
export const seg = (p: number, a: number, b: number) => {
  const t = clamp((p - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A classical key glyph (bow + shaft + teeth) centred on its bow. */
export function KeyGlyph({ x, y, scale = 1, rot = 0, color = "var(--signal)", draw = 1, className }: { x: number; y: number; scale?: number; rot?: number; color?: string; draw?: number; className?: string }) {
  const L = 150;
  return (
    <g className={className} transform={`translate(${x} ${y}) rotate(${rot}) scale(${scale})`} fill="none" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx={0} cy={0} r={13} strokeDasharray={`${L} ${L}`} strokeDashoffset={(1 - draw) * L} />
      <circle cx={0} cy={0} r={4} strokeDasharray={`${L} ${L}`} strokeDashoffset={(1 - draw) * L} />
      <path d="M13 0 H58 M46 0 V11 M56 0 V8" strokeDasharray={`${L} ${L}`} strokeDashoffset={(1 - draw) * L} />
    </g>
  );
}

export interface Line { text: string; at: number; tone?: "signal" | "ice" }
export function Readout({ lines, p, label }: { lines: Line[]; p: number; label: string }) {
  return (
    <ul className="st-readout" aria-label={label}>
      {lines.map((l) => (
        <li key={l.text} className={`st-ro${p >= l.at ? " is-on" : ""}${l.tone ? ` st-ro--${l.tone}` : ""}`} aria-hidden={p >= l.at ? undefined : true}>
          <span className="st-ro-dot" aria-hidden="true" />
          {l.text}
        </li>
      ))}
    </ul>
  );
}

/* ---------- I: your keys guard everything ---------- */
export const I_LINES: Line[] = [
  { text: "secp256k1", at: 0.25, tone: "signal" },
  { text: "32-byte private key", at: 0.45, tone: "signal" },
  { text: "64-byte signature", at: 0.65, tone: "signal" },
];
export function ChapterI({ p }: { p: number }) {
  const coins = 5;
  return (
    <div className="st-vis">
      <svg viewBox="0 0 320 220" className="st-svg" role="img" aria-label="An orange classical key guarding a stack of funds">
        <g className="st-grid" aria-hidden="true">
          {[40, 80, 120, 160, 200].map((y) => <line key={y} x1="0" x2="320" y1={y} y2={y} />)}
        </g>
        <KeyGlyph x={70} y={110} scale={1.5} draw={seg(p, 0, 0.35)} />
        <line className="st-leash" x1={158} y1={110} x2={228} y2={110} strokeDasharray="4 5" style={{ opacity: seg(p, 0.3, 0.5) }} />
        <g aria-hidden="true">
          {Array.from({ length: coins }, (_, i) => {
            const t = seg(p, 0.2 + i * 0.07, 0.4 + i * 0.07);
            return (
              <g key={i} style={{ opacity: t }} transform={`translate(0 ${(1 - t) * -14})`}>
                <ellipse cx={262} cy={150 - i * 11} rx={30} ry={9} className="st-coin" />
                <path d={`M232 ${150 - i * 11} v5 a30 9 0 0 0 60 0 v-5`} className="st-coin-side" />
              </g>
            );
          })}
        </g>
        <text x="262" y="186" textAnchor="middle" className="st-svg-t">1,000 QOR</text>
        <text x="70" y="160" textAnchor="middle" className="st-svg-t is-signal">classical key</text>
      </svg>
    </div>
  );
}

/* ---------- II: Q-Day ---------- */
const SOLVE_END = 0.5;
const fixed = (i: number) => ((i * 97 + 41) % 256).toString(16).padStart(2, "0").toUpperCase();
const noise = (i: number, tick: number) => (((i + 3) * 2654435761 + tick * 40503) >>> 7 & 255).toString(16).padStart(2, "0").toUpperCase();
export const II_LINES: Line[] = [
  { text: "Shor's algorithm on a 33-byte public key", at: 0.08, tone: "signal" },
  { text: "private key derived", at: SOLVE_END, tone: "signal" },
  { text: "funds leaving the vault", at: 0.62, tone: "signal" },
];
export function ChapterII({ p }: { p: number }) {
  const solve = clamp(p / SOLVE_END);
  const tick = Math.floor(p * 70);
  const pay = seg(p, 0.55, 0.95);
  const balance = Math.round(1000 * (1 - pay));
  const N = 16;
  const coins = 9;
  const rot = p * 900;
  const done = p >= SOLVE_END;
  return (
    <div className="st-vis">
      <svg viewBox="0 0 320 250" className="st-svg" role="img" aria-label="A quantum machine solving the public key, then funds streaming to a thief">
        <g transform={`translate(160 62)`} aria-hidden="true">
          <circle r={50} className="st-qring" style={{ opacity: 0.35 }} />
          <g transform={`rotate(${rot})`}><circle r={40} className="st-qring is-dash" /><circle cx={40} r={3.4} className="st-qnode" /></g>
          <g transform={`rotate(${-rot * 1.6})`}><circle r={27} className="st-qring is-dash2" /><circle cy={-27} r={3} className="st-qnode" /></g>
          <circle r={11} className={`st-qcore${done ? " is-done" : ""}`} />
          <path d={`M0 -50 A50 50 0 ${solve > 0.5 ? 1 : 0} 1 ${Math.sin(solve * Math.PI * 2) * 50} ${-Math.cos(solve * Math.PI * 2) * 50}`} className="st-qarc" />
        </g>
        <line x1="160" x2="160" y1="118" y2="146" className="st-beam" style={{ opacity: done ? 0.2 : 0.8 }} />
        <g aria-hidden="true">
          <rect x="22" y="196" width="68" height="40" rx="4" className="st-box" />
          <text x="56" y="220" textAnchor="middle" className="st-svg-t">vault</text>
          <rect x="230" y="196" width="68" height="40" rx="4" className="st-box is-signal" style={{ opacity: 0.5 + pay * 0.5 }} />
          <text x="264" y="220" textAnchor="middle" className="st-svg-t is-signal">thief</text>
          <line x1="92" x2="228" y1="216" y2="216" className="st-leash" strokeDasharray="3 6" />
          {Array.from({ length: coins }, (_, i) => {
            const t = clamp(pay * (coins + 3) / coins * 1 - i / coins * 0.9 - 0.02, 0, 1);
            if (t <= 0 || t >= 1) return null;
            return <circle key={i} cx={lerp(94, 226, t)} cy={216 + Math.sin(t * Math.PI * 3) * 3} r={4.2} className="st-flow" />;
          })}
        </g>
      </svg>
      <div className="st-hex" aria-hidden="true">
        <span className="st-hex-k">02</span>
        {Array.from({ length: N }, (_, i) => {
          const locked = solve >= 1 || solve * 1.25 > (i + 1) / N;
          return <span key={i} className={locked ? "is-lock" : "is-spin"}>{locked ? fixed(i) : noise(i, tick)}</span>;
        })}
      </div>
      <div className="st-bal">
        <span className="st-bal-k">{done ? "private key derived" : `deriving ${Math.floor(solve * 100)}%`}</span>
        <span className="st-bal-v" aria-label={`vault balance ${balance} QOR`}>{balance.toLocaleString("en-US")} QOR</span>
      </div>
    </div>
  );
}

/* ---------- III: seal it with a lattice ---------- */
export const III_LINES: Line[] = [
  { text: "ML-DSA-87 · FIPS 204", at: 0.2, tone: "ice" },
  { text: "pk 2,592 B · sig 4,627 B", at: 0.4, tone: "ice" },
  { text: "stolen key refused", at: 0.8, tone: "signal" },
];
const SORTED = [...LATTICE_POINTS].sort((a, b) => Math.hypot(a.x - 160, a.y - 160) - Math.hypot(b.x - 160, b.y - 160));
const BUILT = 0.55;
export function ChapterIII({ p }: { p: number }) {
  const built = p >= BUILT;
  const shown = Math.floor(clamp(p / BUILT) * SORTED.length);
  const approach = seg(p, 0.6, 0.76);
  const bounce = seg(p, 0.78, 0.97);
  const kx = p < 0.78 ? lerp(420, 322, approach) : lerp(322, 420, bounce);
  const kRot = p < 0.78 ? 0 : bounce * 200;
  const hit = p >= 0.76 && p < 0.9;
  const showKey = p >= 0.6;
  return (
    <div className="st-vis st-vis--core">
      <div className="st-core-wrap">
        <LatticeCore
          state={built ? "ALIVE" : "NONE"}
          tone="ice"
          size="100%"
          progress={1}
          beat={built ? 1 : 0}
          overlay={
            <g aria-hidden="true">
              {!built && SORTED.slice(0, shown).map((n, i) => <circle key={i} cx={n.x} cy={n.y} r={i === shown - 1 ? 5 : 3.2} className="st-asm" />)}
              {hit && <circle cx={160} cy={160} r={147} className="st-impact" />}
              {showKey && (
                <g>
                  <KeyGlyph x={kx} y={160} scale={0.9} rot={kRot} />
                  {p >= 0.76 && <text x={kx} y={196} textAnchor="middle" className="st-svg-t is-signal" fontSize="11">refused</text>}
                </g>
              )}
            </g>
          }
        />
      </div>
    </div>
  );
}

/* ---------- IV: build yours ---------- */
export function ChapterIV({ pulse }: { pulse: number }) {
  return (
    <div className="st-vis st-vis--core">
      <div className="st-core-wrap st-core-wrap--sm">
        <LatticeCore state="ALIVE" tone="ice" size="100%" progress={1} beat={pulse} />
      </div>
    </div>
  );
}

export const CHAPTER_STYLE = (n: number): CSSProperties => ({ ["--ch" as string]: n });
