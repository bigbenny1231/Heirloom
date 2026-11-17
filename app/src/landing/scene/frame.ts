/*
 * Hero scene. A PURE function: frame(t, w, h, opts) -> DrawOp[].
 * The page paints the ops on a <canvas>; a Pillow script paints the same ops to PNG for review.
 * Colours are #rrggbb; "lighter" is additive blending. Keep the op count near 300.
 */
import { ICO_V, ICO_E, ICO_F, CRY_V, CRY_E, type V3 } from "./geo";

export type Blend = "source-over" | "lighter";
export type DrawOp =
  | { k: "circle"; x: number; y: number; r: number; fill?: string; stroke?: string; w?: number; a: number; blend?: Blend }
  | { k: "blob"; x: number; y: number; r: number; c: string; a: number; blend?: Blend }
  | { k: "segs"; p: number[]; c: string; w: number; a: number; blend?: Blend; cap?: "butt" }
  | { k: "tris"; p: number[]; c: string; a: number; blend?: Blend }
  | { k: "poly"; p: number[]; close?: boolean; fill?: string; stroke?: string; w?: number; a: number; blend?: Blend; cap?: "butt" }
  | { k: "dots"; p: number[]; r: number; c: string; a: number; blend?: Blend }
  | { k: "rect"; x: number; y: number; w: number; h: number; r?: number; fill?: string; stroke?: string; sw?: number; a: number; blend?: Blend }
  | { k: "text"; x: number; y: number; s: string; size: number; c: string; a: number; font: "mono" | "disp"; align?: "left" | "center" | "right"; track?: number; blend?: Blend };

export interface FrameOpts {
  /** Global time (ms) at which the run began, or -1 for none. */
  runStart: number;
  /** 0 alive, 1 warning, 2 overdue, 3 triggered, 4 settled. */
  stage: number;
  prevStage: number;
  /** ms since the stage last changed. */
  stageT: number;
  /** Check-in window remaining, 0..1. */
  progress: number;
  /** Static frame: no time-driven motion. */
  reduced: boolean;
  /** Cover art: final sealed frame with the three bolts frozen at impact and the REFUSED chips shown. */
  cover?: boolean;
}

/** Run timeline, ms from the click. Keep the React timers in step with these. */
export const T = {
  dimIn: 150, rings: 250, derive: 900, lock: 1500, push0: 1300, push1: 2300,
  bolt: [2150, 2850, 3550], travel: 450, hit: [2600, 3300, 4000],
  tremble: 3900, shatter: 4400, flare: 4600, seal: 5150, caption: 5300, done: 6600,
};

const TAU = Math.PI * 2;
const ICEHEX = "#7EF0FF";
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => { x = clamp(x); return x * x * (3 - 2 * x); };
const eo = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const span = (v: number, a: number, b: number) => clamp((v - a) / (b - a));
const jh = (n: number) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

type RGB = [number, number, number];
const ICE: RGB = [126, 240, 255], SIG: RGB = [255, 107, 44], WARN: RGB = [196, 134, 52], DEAD: RGB = [255, 92, 122], STILL: RGB = [125, 133, 151], WHITE: RGB = [255, 255, 255], VOID: RGB = [5, 7, 13], ALIVE: RGB = [75, 240, 160];
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const hx = (c: RGB) => "#" + c.map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, "0")).join("");
const TINTS: RGB[] = [ICE, WARN, DEAD, DEAD, STILL];
const FRACT = [0, 0.12, 0.55, 1, 0.35];
const FLICK = [0, 1, 0.6, 0.35, 0];
const SDIM = [1, 0.46, 0.6, 0.72, 0.8];

const V0 = 0.00016; // rad per ms, idle spin
function angleAt(t: number, runStart: number, reduced: boolean) {
  if (reduced) return 0.9;
  if (runStart < 0) return V0 * t;
  const rt = t - runStart;
  let a = V0 * runStart;
  if (rt > 0) a += V0 * (rt < 1200 ? rt - (rt * rt) / 2400 : 600);
  if (rt > 7000) a += V0 * 0.3 * (rt - 7000);
  return a;
}
const TILT = 0.42;

function rot(v: V3, ay: number, ax: number): V3 {
  const c = Math.cos(ay), s = Math.sin(ay);
  const x1 = v[0] * c + v[2] * s, z1 = -v[0] * s + v[2] * c;
  const cx = Math.cos(ax), sx = Math.sin(ax);
  return [x1, v[1] * cx - z1 * sx, v[1] * sx + z1 * cx];
}

/* ---- the classical key: pieces in glyph units (bow centre -8, shaft to +12), y down ---- */
interface Piece { kind: "arc" | "line"; a: number[]; ang: number; v: [number, number]; spin: number }
const ARC_N = 4;
const PIECES: Piece[] = [
  ...Array.from({ length: ARC_N }, (_, i) => ({ kind: "arc" as const, a: [-8, 0, 5.5, (i / ARC_N) * TAU + 0.15, ((i + 1) / ARC_N) * TAU - 0.15], ang: 0, v: [[-0.9, -0.5], [-0.5, 0.9], [0.4, 0.8], [-1.0, 0.4]][i] as [number, number], spin: [-2.4, 1.8, -1.5, 2.6][i] })),
  { kind: "line", a: [-2.5, 0, 4.5, 0], ang: 0, v: [-0.3, 1.0], spin: 1.6 },
  { kind: "line", a: [4.5, 0, 12, 0], ang: 0, v: [0.9, 0.7], spin: -1.9 },
  { kind: "line", a: [7.5, 0, 7.5, 4.6], ang: 0, v: [0.2, 1.3], spin: 3.0 },
  { kind: "line", a: [12, 0, 12, 3.4], ang: 0, v: [1.2, 0.9], spin: -2.7 },
  { kind: "line", a: [-12, -3, -10, -5.4], ang: 0, v: [-1.4, -0.2], spin: 2.1 },
  { kind: "line", a: [-9, 3, -7.4, 5.4], ang: 0, v: [-0.8, 1.2], spin: -1.2 },
  { kind: "line", a: [-5, -4.6, -2.6, -5.6], ang: 0, v: [0.1, -0.5], spin: 1.4 },
  { kind: "line", a: [-3, 3.4, -1, 4.8], ang: 0, v: [0.5, 1.4], spin: -2.2 },
  { kind: "line", a: [-6, -1, -3, -2.5], ang: 0, v: [-1.1, 0.3], spin: 2.8 },
  { kind: "line", a: [3, 1, 6, 2.4], ang: 0, v: [1.3, 0.2], spin: -3.1 },
  { kind: "line", a: [9, -1.5, 11.5, -2.5], ang: 0, v: [1.0, -0.2], spin: 2.2 },
  { kind: "line", a: [-10, 1, -8, 2], ang: 0, v: [-1.3, 0.8], spin: -2.6 },
  { kind: "line", a: [0, -2, 2.4, -3.4], ang: 0, v: [0.3, 1.0], spin: 3.3 },
  { kind: "line", a: [5, 2.5, 7, 4], ang: 0, v: [0.7, 1.2], spin: -2.0 },
];
const HEX = "9F3A7C21B8E4D065";

export function frame(t: number, w: number, h: number, o: FrameOpts): DrawOp[] {
  const reduced = o.reduced;
  const rt = o.cover ? 6500 : o.runStart < 0 ? -1 : reduced ? 1e5 : t - o.runStart;
  const running = rt >= 0 && rt < T.done;
  const afterRun = rt >= T.done;
  const hasRun = rt >= 0;

  /* layout */
  const reserve = clamp(h * 0.31, 62, 112);
  const Rr = Math.max(40, Math.min(w * 0.44, (h - reserve) / 2.16));
  const cx = w / 2, cy = 8 + 1.08 * Rr;
  const ks = (Rr / 60) * 1.6; // glyph unit in px (key is large: it is the actor)
  const keyYs = 8 + 2.16 * Rr + 10 + 5.8 * ks; // key position on screen // glyph unit in px

  /* tint (lerped across stage changes) */
  const sk = reduced ? 1 : smooth(o.stageT / 700);
  const tint = mix(TINTS[o.prevStage] ?? ICE, TINTS[o.stage] ?? ICE, sk);
  const tintHex = hx(tint);
  const sk0 = (SDIM[o.prevStage] ?? 1) + ((SDIM[o.stage] ?? 1) - (SDIM[o.prevStage] ?? 1)) * sk;
  const tintW = hx(mix(tint, WHITE, 0.55 * sk0));
  const fr = (FRACT[o.prevStage] ?? 0) + ((FRACT[o.stage] ?? 0) - (FRACT[o.prevStage] ?? 0)) * sk;
  const flk = (FLICK[o.prevStage] ?? 0) + ((FLICK[o.stage] ?? 0) - (FLICK[o.prevStage] ?? 0)) * sk;

  /* run envelopes */
  const dm = hasRun ? smooth(span(rt, T.dimIn, 700)) * (1 - smooth(span(rt, 4600, 5400))) : 0;
  const sd = (SDIM[o.prevStage] ?? 1) + ((SDIM[o.stage] ?? 1) - (SDIM[o.prevStage] ?? 1)) * sk;
  const base = (1 - 0.5 * dm) * sd; // lattice alpha under the dim and the stage
  const push = hasRun ? smooth(span(rt, T.push0, T.push1)) * (1 - smooth(span(rt, 4700, 5900))) : 0;
  const zoom = 1 + 0.1 * push;
  const flareK = hasRun ? Math.sin(Math.PI * clamp(span(rt, T.flare, 5900))) : 0;
  const sealP = hasRun && o.stage === 0 ? 1 : 0;
  let shx = 0, shy = 0;
  if (hasRun && !reduced && !o.cover) {
    for (const ti of T.hit) {
      const a = rt - ti;
      if (a >= 0 && a < 600) { const k = Math.exp(-a / 90) * 3.2; shx += Math.sin(a * 0.19 + ti) * k; shy += Math.cos(a * 0.23 + ti * 1.3) * k * 0.8; }
    }
    const sa = rt - T.shatter;
    if (sa >= 0 && sa < 500) { const k = Math.exp(-sa / 110) * 4; shx += Math.sin(sa * 0.21) * k; shy += Math.cos(sa * 0.27) * k * 0.8; }
  }

  const keyX = cx;
  const keyY = cy + (keyYs - cy) / zoom; // scene-space y that lands on keyYs after the camera push
  /* camera */
  const ang = angleAt(t, o.runStart, reduced);
  const frozen = angleAt(o.runStart + 1500, o.runStart, reduced);
  const sph = Rr * 0.8;
  const DIST = 3;
  const kk = sph * DIST;
  const wob = reduced || o.cover ? 0 : Math.sin(t / 3100) * 0.05;
  const proj = (v: V3, ay: number, ax: number, scale = 1, push = 0): { x: number; y: number; z: number } => {
    const p = rot(v, ay, ax + wob);
    const s = kk / (DIST - p[2] * scale);
    const e = 1 + fr * 0.12 * push;
    return { x: cx + p[0] * s * scale * e, y: cy + p[1] * s * scale * e, z: p[2] };
  };

  /* impact targets: three front nodes, lower-left, lower-right, centre. Chosen at the frozen angle so bolts land on real nodes. */
  const want = [[-0.6, 0.35], [0.6, 0.35], [0, 0.62]]; // ripple origins: nodes nearest the ring impact points
  const targets = want.map(([wx, wy]) => {
    let best = 0, bd = 9;
    ICO_V.forEach((v, i) => {
      const p = rot(v, frozen, TILT + 0);
      if (p[2] < 0.25) return;
      const d = Math.hypot(p[0] - wx, p[1] - wy);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  });
  const hitT = T.hit;
  const energyOf = (v: V3) => {
    if (!hasRun) return 0;
    let e = 0;
    const ert = o.cover ? T.hit[2] + 250 : rt;
    for (let k = 0; k < 3; k++) {
      const age = (ert - hitT[k]) / 1000;
      if (age < 0) continue;
      const tv = ICO_V[targets[k]];
      const d = Math.acos(clamp(v[0] * tv[0] + v[1] * tv[1] + v[2] * tv[2], -1, 1));
      e += Math.exp(-(d * d) / 0.1) * Math.exp(-age * 5.5) * 1.3;
      e += Math.exp(-Math.pow((d - 3.4 * age) / 0.3, 2)) * Math.exp(-age * 1.15) * 0.95;
    }
    return e;
  };

  const A: DrawOp[] = []; // scene group: shaken and zoomed together
  const Hd: DrawOp[] = []; // HUD group: stays put

  /* ---- background ---- */
  A.push({ k: "blob", x: cx, y: cy, r: Math.min(Rr * 1.6, cx, cy + 4), c: hx(mix(VOID, tint, 0.55)), a: 0.16 * base + 0.1 * flareK, blend: "lighter" });
  A.push({ k: "blob", x: cx, y: cy, r: Rr * 1.05, c: tintHex, a: 0.1 + 0.2 * flareK, blend: "lighter" });
  A.push({ k: "blob", x: keyX, y: keyY, r: Math.min(Rr * 0.8, (h - keyYs) * 2.2), c: hx(SIG), a: hasRun && rt < T.shatter + 300 ? 0.12 + 0.2 * dm : 0.07, blend: "lighter" });

  /* ---- particle field ---- */
  const dr = reduced ? 0 : t;
  const pb: number[][] = [[], [], []];
  for (let i = 0; i < 54; i++) {
    const x = jh(i * 3.1) * w, sp = 4 + jh(i * 1.7) * 9;
    const y = ((jh(i * 5.3) * h - (dr / 1000) * sp) % h + h) % h;
    pb[i % 3].push(x, y);
  }
  pb.forEach((p, i) => A.push({ k: "dots", p, r: 0.7 + i * 0.35, c: i === 2 ? tintW : tintHex, a: (0.16 + i * 0.1) * base * (reduced ? 1 : 0.85 + 0.15 * Math.sin(dr / 900 + i)), blend: "lighter" }));

  /* ---- countdown ring ---- */
  const ringA = (0.55 + 0.4 * flareK) * base + 0.1;
  A.push({ k: "circle", x: cx, y: cy, r: Rr, stroke: tintHex, w: 1, a: 0.16 * base + 0.06 });
  const prog = clamp(o.progress);
  const arc: number[] = [], N = 72;
  for (let i = 0; i <= N; i++) { const a = -Math.PI / 2 + (i / N) * prog * TAU; arc.push(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr); }
  A.push({ k: "poly", p: arc, stroke: tintHex, w: 6.5, a: 0.2 * ringA, blend: "lighter" });
  A.push({ k: "poly", p: arc, stroke: tintHex, w: 2.4, a: ringA, blend: "lighter" });
  const hd = -Math.PI / 2 + prog * TAU;
  A.push({ k: "blob", x: cx + Math.cos(hd) * Rr, y: cy + Math.sin(hd) * Rr, r: 10, c: tintW, a: 0.7 * base, blend: "lighter" });
  const tmaj: number[] = [], tmin: number[] = [];
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU - Math.PI / 2, maj = i % 5 === 0, r1 = Rr * 1.035, r2 = Rr * 1.035 + (maj ? 9 : 5);
    (maj ? tmaj : tmin).push(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
  }
  A.push({ k: "segs", p: tmin, c: tintHex, w: 1, a: 0.38 * base });
  A.push({ k: "segs", p: tmaj, c: tintHex, w: 1.5, a: 0.7 * base });
  if (hasRun && sealP && rt > T.shatter) {
    const sa = smooth(span(rt, T.shatter + 100, T.shatter + 1000));
    A.push({ k: "circle", x: cx, y: cy, r: Rr * 1.12, stroke: tintHex, w: 1, a: 0.5 * sa });
  }

  /* ---- 3D lattice ---- */
  const idlePh = reduced ? -1 : ((t % 5200) / 5200) * 1.35;
  const P3 = ICO_V.map((v) => proj(v, ang, TILT, 1, 1));
  const nodeE = ICO_V.map((v, i) => {
    let e = energyOf(v);
    if (idlePh >= 0 && !hasRun || (idlePh >= 0 && afterRun)) {
      const rr = Math.hypot(P3[i].x - cx, P3[i].y - cy) / sph;
      e += 0.8 * Math.exp(-Math.pow((rr - idlePh) / 0.17, 2)) * (P3[i].z > -0.2 ? 1 : 0.5);
    }
    return e;
  });
  const nodeD = nodeE.map((e) => e + flareK * 0.5); // display energy: hits + flare
  const eb: number[][] = [[], [], [], [], []];
  const lit: { a: number; b: number; e: number; z: number }[] = [];
  ICO_E.forEach(([a, b], idx) => {
    if (fr > 0 && jh(idx * 7.7) < fr * 0.42) return;
    const z = (P3[a].z + P3[b].z) / 2, e = Math.max(nodeD[a], nodeD[b]);
    let fk = 1;
    if (flk > 0 && !reduced) fk = 1 - flk * (jh(Math.floor(t / 110) + idx * 3.3) < 0.35 ? 0.85 : 0);
    if (e > 0.14) lit.push({ a, b, e, z });
    if (fk < 0.5) return;
    const bi = Math.min(4, Math.floor(clamp((z + 1) / 2) * 5));
    eb[bi].push(P3[a].x, P3[a].y, P3[b].x, P3[b].y);
  });
  eb.forEach((p, bi) => A.push({ k: "segs", p, c: tintHex, w: 0.8 + bi * 0.12, a: (0.05 + bi * 0.12) * base, blend: "lighter" }));

  /* panels: front faces that a shock wave is crossing light up */
  const panels: { p: number[]; e: number }[] = [];
  ICO_F.forEach((f) => {
    const cxv = (ICO_V[f[0]][0] + ICO_V[f[1]][0] + ICO_V[f[2]][0]) / 3, cyv = (ICO_V[f[0]][1] + ICO_V[f[1]][1] + ICO_V[f[2]][1]) / 3, czv = (ICO_V[f[0]][2] + ICO_V[f[1]][2] + ICO_V[f[2]][2]) / 3;
    const e = (nodeE[f[0]] + nodeE[f[1]] + nodeE[f[2]]) / 3;
    if (e < 0.16) return;
    const z = (P3[f[0]].z + P3[f[1]].z + P3[f[2]].z) / 3;
    if (z < -0.1) return;
    void cxv; void cyv; void czv;
    panels.push({ p: [P3[f[0]].x, P3[f[0]].y, P3[f[1]].x, P3[f[1]].y, P3[f[2]].x, P3[f[2]].y], e });
  });
  panels.sort((a, b) => b.e - a.e).slice(0, 26).forEach((f) => A.push({ k: "poly", p: f.p, close: true, fill: tintHex, stroke: tintW, w: 0.8, a: clamp(f.e * 0.22, 0, 0.42) * sk0, blend: "lighter" }));
  lit.slice(0, 46).forEach((l) => A.push({ k: "segs", p: [P3[l.a].x, P3[l.a].y, P3[l.b].x, P3[l.b].y], c: l.e > 0.9 ? tintW : tintHex, w: 1.2 + clamp(l.e) * 0.9, a: clamp(0.3 + l.e * 0.55) * (0.5 + 0.5 * clamp((l.z + 1) / 2)) * sk0, blend: "lighter" }));

  /* inner crystal, counter-rotating */
  const ca = -ang * 1.7 + 0.6, C3 = CRY_V.map((v) => proj([v[0] * 0.38, v[1] * 0.38, v[2] * 0.38], ca, TILT + 0.5));
  const cp: number[] = [];
  CRY_E.forEach(([a, b]) => cp.push(C3[a].x, C3[a].y, C3[b].x, C3[b].y));
  const breath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin(t / 700);
  A.push({ k: "segs", p: cp, c: tintW, w: 1.1, a: (0.4 + 0.25 * flareK) * base + 0.1, blend: "lighter" });
  A.push({ k: "blob", x: cx, y: cy, r: sph * 0.34, c: tintW, a: (0.22 + 0.12 * breath + 0.35 * flareK + 0.25 * nodeE.slice(0, 1).length * 0) * base, blend: "lighter" });
  A.push({ k: "dots", p: C3.flatMap((p) => [p.x, p.y]), r: 1.8, c: tintW, a: 0.8 * base, blend: "lighter" });
  A.push({ k: "circle", x: cx, y: cy, r: 3.2 + 1.4 * breath + 3 * flareK, fill: "#ffffff", a: 0.95, blend: "lighter" });

  /* nodes: depth buckets, then lit nodes individually */
  const nb: number[][] = [[], [], [], []];
  const litN: number[] = [];
  P3.forEach((p, i) => {
    if (nodeD[i] > 0.2) litN.push(i);
    nb[Math.min(3, Math.floor(clamp((p.z + 1) / 2) * 4))].push(p.x, p.y);
  });
  nb.forEach((p, bi) => A.push({ k: "dots", p, r: 1.1 + bi * 0.55 * (Rr / 120), c: bi > 1 ? tintW : tintHex, a: (0.28 + bi * 0.2) * base, blend: "lighter" }));
  litN.sort((a, b) => nodeD[b] - nodeD[a]).slice(0, 22).forEach((i) => {
    const e = clamp(nodeD[i] / 1.2), p = P3[i];
    A.push({ k: "blob", x: p.x, y: p.y, r: 9 + 15 * e, c: tintHex, a: 0.55 * e * sk0, blend: "lighter" });
    A.push({ k: "circle", x: p.x, y: p.y, r: 2.1 + 2.4 * e + (p.z > 0 ? 0.6 : 0), fill: hx(mix(tint, WHITE, e * 0.7 * sk0)), a: 0.95 * sk0, blend: "lighter" });
  });

  /* ---- the classical key ---- */
  const keyAlive = !hasRun || rt < T.shatter;
  const kp = (gx: number, gy: number, tx = 0, ty = 0, a = 0) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [keyX + (gx * c - gy * s) * ks + tx, keyY + (gx * s + gy * c) * ks + ty];
  };
  const trem = hasRun && !reduced && rt > T.tremble && rt < T.shatter ? 1 : 0;
  const ktx = trem ? Math.sin(t * 0.9) * 1.6 : 0, kty = trem ? Math.cos(t * 1.1) * 1.4 : 0;
  const kGlow = hasRun ? smooth(span(rt, 200, 1400)) * (1 - smooth(span(rt, T.shatter, T.shatter + 500))) : 0.35 + (reduced ? 0 : 0.15 * Math.sin(t / 520));
  const kBright = hasRun ? smooth(span(rt, 200, 1200)) : 0;
  const sa = o.cover ? 1.2 : (rt - T.shatter) / 1000; // seconds since shatter (cover art freezes mid-flight)
  const shat = hasRun && rt >= T.shatter;
  const pieceAlpha = shat ? (o.cover ? 0.75 : 1 - smooth(span(sa, 0.5, 1.6))) : 1;
  if (!shat || sa < 1.6) A.push({ k: "blob", x: keyX, y: keyY, r: Rr * (0.26 + 0.18 * kGlow), c: hx(SIG), a: 0.45 * kGlow + 0.1, blend: "lighter" });
  const kcol = hx(mix(SIG, WHITE, 0.25 * kBright));
  if (!shat || pieceAlpha > 0.01) PIECES.forEach((pc, pi) => {
    const D = shat ? (1 - Math.exp(-Math.max(0, sa) / 0.55)) * 1.05 : 0;
    const tx = (shat ? pc.v[0] * D * Rr * 1.0 : ktx), ty = (shat ? pc.v[1] * D * Rr * 1.0 + 0.0 : kty);
    const ra = shat ? pc.spin * D * 3 : 0;
    const mid: [number, number] = pc.kind === "arc" ? [pc.a[0], pc.a[1]] : [(pc.a[0] + pc.a[2]) / 2, (pc.a[1] + pc.a[3]) / 2];
    const tp = (gx: number, gy: number) => {
      const lx = gx - mid[0], ly = gy - mid[1], c = Math.cos(ra), s = Math.sin(ra);
      return kp(mid[0] + lx * c - ly * s, mid[1] + lx * s + ly * c, tx, ty);
    };
    const jit = shat ? 0 : 0;
    void jit; void pi;
    if (pc.kind === "arc") {
      const [gx, gy, r, a0, a1] = pc.a, pts: number[] = [];
      for (let i = 0; i <= 8; i++) { const a = a0 + ((a1 - a0) * i) / 8; pts.push(...tp(gx + Math.cos(a) * r, gy + Math.sin(a) * r)); }
      A.push({ k: "poly", p: pts, stroke: hx(SIG), w: 8, a: 0.3 * pieceAlpha, blend: "lighter", cap: "butt" });
      A.push({ k: "poly", p: pts, stroke: kcol, w: 2.6, a: pieceAlpha, blend: "lighter", cap: "butt" });
    } else {
      const p = [...tp(pc.a[0], pc.a[1]), ...tp(pc.a[2], pc.a[3])];
      A.push({ k: "segs", p, c: hx(SIG), w: 8, a: 0.3 * pieceAlpha, blend: "lighter", cap: "butt" });
      A.push({ k: "segs", p, c: kcol, w: 2.6, a: pieceAlpha, blend: "lighter", cap: "butt" });
    }
  });
  if (shat && (sa < 1.6 || o.cover)) {
    const tr: number[] = [], fa = o.cover ? 0.9 : 0.9 * (1 - smooth(span(sa, 0.5, 1.6)));
    for (let i = 0; i < 12; i++) {
      const an = jh(i * 6.7 + 1) * TAU, sz = 4 + jh(i * 3.9) * 5, D = (1 - Math.exp(-Math.max(0, sa) / 0.5)) * (0.7 + jh(i * 9.1) * 0.9) * Rr * 0.85;
      const fx = keyX + Math.cos(an) * D * 1.15, fy = keyY + Math.sin(an) * D * 0.8 + 18 * sa * sa, ro = jh(i * 2.2) * TAU + sa * (jh(i) < 0.5 ? 4 : -4);
      for (let v = 0; v < 3; v++) tr.push(fx + Math.cos(ro + (v * TAU) / 3) * sz, fy + Math.sin(ro + (v * TAU) / 3) * sz);
    }
    A.push({ k: "tris", p: tr, c: "#FF6B2C", a: fa, blend: "lighter" });
  }
  if (shat && sa < 1.7) {
    const sp1: number[] = [], sp2: number[] = [];
    for (let i = 0; i < 44; i++) {
      const ang2 = Math.PI * (0.05 + jh(i * 2.3) * 0.9) * (jh(i * 4.1) < 0.5 ? 1 : -1) * 0.5 + (jh(i * 4.1) < 0.5 ? 0.35 : Math.PI - 0.35);
      const sp = (0.6 + jh(i * 8.9) * 1.5) * Rr, D = (1 - Math.exp(-Math.max(0, sa) / 0.45)) * 0.45;
      const x = keyX + Math.cos(ang2) * sp * D + (jh(i) - 0.5) * 6, y = keyY + Math.sin(ang2) * sp * D * 0.9 + 0.5 * 30 * sa * sa;
      (i % 2 ? sp1 : sp2).push(x, y);
    }
    const f = Math.exp(-sa / 0.8);
    A.push({ k: "dots", p: sp1, r: 1.9, c: hx(mix(SIG, WHITE, 0.4)), a: 0.9 * f, blend: "lighter" });
    A.push({ k: "dots", p: sp2, r: 1.2, c: hx(SIG), a: 0.8 * f, blend: "lighter" });
  }
  if (shat && sa < 1.0) {
    const q = sa / 1.0;
    A.push({ k: "circle", x: keyX, y: keyY, r: Rr * 2.3 * eo(q), stroke: hx(SIG), w: 12 * (1 - q) + 2, a: 0.28 * (1 - q), blend: "lighter" });
    A.push({ k: "circle", x: keyX, y: keyY, r: Rr * 2.3 * eo(q), stroke: hx(mix(SIG, WHITE, 0.55)), w: 3.6 * (1 - q) + 1, a: 0.95 * (1 - q), blend: "lighter" });
    A.push({ k: "circle", x: keyX, y: keyY, r: Rr * 1.3 * eo(span(sa, 0.05, 0.7)), stroke: hx(SIG), w: 2, a: 0.8 * (1 - span(sa, 0.05, 0.7)), blend: "lighter" });
  }
  if (shat && sa < 0.8) {
    const fl = Math.exp(-sa / 0.14);
    A.push({ k: "blob", x: keyX, y: keyY, r: Math.min(Rr * 1.0, (h - keyYs) * 3.2), c: hx(mix(SIG, WHITE, 0.7)), a: 1.0 * fl, blend: "lighter" });
    A.push({ k: "blob", x: keyX, y: keyY, r: Rr * 0.38, c: "#ffffff", a: 1.0 * fl, blend: "lighter" });
    A.push({ k: "segs", p: [keyX - 0.3 * w, keyY, keyX + 0.3 * w, keyY], c: hx(mix(SIG, WHITE, 0.6)), w: 2.2, a: 0.5 * fl, blend: "lighter" });
  }
  if (hasRun && rt >= T.flare && rt < T.flare + 700) A.push({ k: "blob", x: cx, y: cy, r: Math.min(cx, cy + 4) * 1.0, c: ICEHEX, a: 0.5 * Math.exp(-(rt - T.flare) / 170), blend: "lighter" });

  /* quantum interference rings around the key */
  if (hasRun && rt > T.rings && rt < 1500) {
    const k = smooth(span(rt, T.rings, 700)) * (1 - smooth(span(rt, 900, 1500)));
    const maxR = Rr * 0.95, sp = (rt - T.rings) / 1000;
    for (const dx of [-0.11, 0.11]) for (let i = 0; i < 6; i++) {
      const r = (((sp * 0.5 + i / 6) % 1) * maxR);
      A.push({ k: "circle", x: keyX + dx * Rr, y: keyY, r, stroke: hx(SIG), w: 1.2, a: 0.85 * k * (1 - r / maxR), blend: "lighter" });
    }
  }

  /* bolts: each ends ON the ring, at 150, 30 and 90 degrees below the centre. The lattice holds. */
  const BANG = [150, 30, 90].map((d) => (d * Math.PI) / 180);
  const chips: { x: number; y: number; a: number }[] = [];
  for (let b = 0; b < 3; b++) {
    const brt = o.cover ? T.hit[b] + 40 : rt;
    const t0 = T.bolt[b], u = (brt - t0) / T.travel;
    if (!hasRun || u < 0) continue;
    const ex = cx + Rr * Math.cos(BANG[b]), ey = cy + Rr * Math.sin(BANG[b]);
    const sx = keyX, sy = keyY - 5.5 * ks, dxv = ex - sx, dyv = ey - sy, len = Math.max(20, Math.hypot(dxv, dyv));
    const nx = -dyv / len, ny = dxv / len, side = b === 0 ? -1 : b === 1 ? 1 : 1, amp = len * (b === 2 ? 0.28 : 0.3) * side;
    const flickT = reduced || o.cover ? 3 : Math.floor(t / 55);
    const pt = (v: number) => {
      const s = Math.sin(Math.PI * v), jt = (jh(Math.round(v * 14) + b * 31 + flickT * 0.37) - 0.5) * 7 * s;
      return [sx + dxv * v + nx * (amp * s + jt), sy + dyv * v + ny * (amp * s + jt)];
    };
    const head = clamp(u), age = (brt - t0 - T.travel) / 1000;
    const tail = o.cover ? 0 : Math.max(0, head - 0.7) * (1 - eo(age / 0.15));
    const nseg = 10;
    for (let i = 0; i < nseg; i++) {
      const v0 = tail + ((head - tail) * i) / nseg, v1 = tail + ((head - tail) * (i + 1)) / nseg;
      if (head - tail < 0.02) break;
      const f = (i + 1) / nseg, fade = o.cover ? 1 : u > 1 ? Math.exp(-age / 0.22) : 1;
      const p = [...pt(v0), ...pt(v1)], depth = 0.55 + 0.9 * v1;
      A.push({ k: "segs", p, c: hx(SIG), w: (8 + 12 * f) * depth, a: 0.3 * f * fade, blend: "lighter" });
      A.push({ k: "segs", p, c: hx(mix(SIG, WHITE, 0.25 * f)), w: (2 + 3.2 * f) * depth, a: (0.5 + 0.5 * f) * fade, blend: "lighter" });
      A.push({ k: "segs", p, c: "#ffffff", w: (0.8 + 1.2 * f) * depth, a: 0.9 * f * f * fade, blend: "lighter" });
    }
    if (u <= 1.0 && u >= 0 && !o.cover) { const hp = pt(head); A.push({ k: "blob", x: hp[0], y: hp[1], r: 16, c: hx(mix(SIG, WHITE, 0.6)), a: 0.9, blend: "lighter" }); }
    /* impact on the ring: flash, a +-25 degree arc ripple along the ring, a soft shock ring */
    const ia = brt - T.hit[b];
    if (ia >= 0) {
      const f = ia / 1000;
      A.push({ k: "blob", x: ex, y: ey, r: Rr * 0.24, c: hx(mix(tint, WHITE, 0.6)), a: 0.7 * Math.exp(-f / 0.12), blend: "lighter" });
      A.push({ k: "blob", x: ex, y: ey, r: Rr * 0.2, c: hx(SIG), a: 0.5 * Math.exp(-f / 0.2), blend: "lighter" });
      const half = (25 * Math.PI / 180) * (0.35 + 0.65 * eo(f / 0.35)), arcA = Math.max(0, 1 - f / 1.1);
      const ap: number[] = [];
      for (let i = 0; i <= 14; i++) { const a = BANG[b] - half + (2 * half * i) / 14; ap.push(cx + Math.cos(a) * Rr, cy + Math.sin(a) * Rr); }
      A.push({ k: "poly", p: ap, stroke: tintHex, w: 9, a: 0.3 * arcA, blend: "lighter" });
      A.push({ k: "poly", p: ap, stroke: tintW, w: 2.6, a: 0.95 * arcA, blend: "lighter" });
      const rf = f;
      if (rf < 0.8) A.push({ k: "circle", x: ex, y: ey, r: Rr * 0.5 * eo(rf / 0.8), stroke: hx(mix(tint, WHITE, 0.4)), w: 1.5, a: 0.7 * (1 - rf / 0.8), blend: "lighter" });
      if (o.cover || f < 0.7) chips.push({ x: cx + Math.cos(BANG[b]) * (Rr * zoom + 18), y: cy + Math.sin(BANG[b]) * (Rr * zoom + 18), a: o.cover ? 1 : Math.min(smooth(f / 0.08), 1 - smooth(span(f, 0.55, 0.7))) });
    }
  }

  /* ---- compose: zoom + shake on the scene group ---- */
  const out: DrawOp[] = [];
  const zx = (x: number) => cx + (x - cx) * zoom + shx;
  const zy = (y: number) => cy + (y - cy) * zoom + shy;
  const mapP = (p: number[]) => p.map((v, i) => (i % 2 ? zy(v) : zx(v)));
  for (const op of A) {
    switch (op.k) {
      case "circle": out.push({ ...op, x: zx(op.x), y: zy(op.y), r: op.r * zoom }); break;
      case "blob": out.push({ ...op, x: zx(op.x), y: zy(op.y), r: op.r * zoom }); break;
      case "dots": out.push({ ...op, p: mapP(op.p) }); break;
      case "tris": out.push({ ...op, p: mapP(op.p) }); break;
      case "segs": case "poly": out.push({ ...op, p: mapP(op.p) }); break;
      default: out.push(op);
    }
  }

  /* ---- HUD: annotations, readout, plate. Never overlaps the scene's ring. ---- */
  const mono = 11;
  const narrow = w < 340;
  const na = 0.95 * (1 - 0.25 * dm);
  if (!narrow) {
    Hd.push({ k: "text", x: 2, y: 12, s: "ML-DSA-87", size: mono, c: "#A3ADC2", a: na, font: "mono" });
    Hd.push({ k: "text", x: 2, y: 25, s: "FIPS 204", size: mono, c: "#E9EDF7", a: na, font: "mono" });
    Hd.push({ k: "text", x: w - 2, y: 12, s: "pk 2,592 B", size: mono, c: "#A3ADC2", a: na, font: "mono", align: "right" });
    Hd.push({ k: "text", x: w - 2, y: 25, s: "sig 4,627 B", size: mono, c: "#E9EDF7", a: na, font: "mono", align: "right" });
  }
  const hits = hasRun ? T.hit.filter((x) => rt >= x).length : 0;
  const bx = w - 2;
  const counting = hasRun && (o.cover || (rt >= T.hit[0] && rt < T.shatter + 200));
  if (counting) {
    const n = o.cover ? 3 : hits;
    if (narrow) Hd.push({ k: "text", x: cx, y: h - 8, s: `FORGED ${n}/3`, size: 11, c: hx(SIG), a: 1, font: "mono", align: "center", track: 0.5 });
    else {
      Hd.push({ k: "text", x: bx, y: keyYs - 4, s: `FORGED ${n}/3`, size: 11, c: hx(SIG), a: 1, font: "mono", align: "right", track: 0.5 });
      Hd.push({ k: "text", x: bx, y: keyYs + 10, s: "refused · no PQ sig", size: 11, c: "#A3ADC2", a: 0.95, font: "mono", align: "right" });
    }
  } else if (!narrow && o.stage === 0) {
    Hd.push({ k: "text", x: bx, y: keyYs + 3, s: "secp256k1", size: mono, c: hx(SIG), a: 0.9 * (hasRun && rt > T.shatter ? 0.55 : 1), font: "mono", align: "right" });
  }
  if (!narrow && !counting && o.stage === 0) {
    Hd.push({ k: "text", x: 2, y: keyYs - 4, s: "modulus q", size: mono, c: "#A3ADC2", a: 0.9 * base, font: "mono" });
    Hd.push({ k: "text", x: 2, y: keyYs + 10, s: "8 380 417", size: mono, c: "#E9EDF7", a: 0.9 * base, font: "mono" });
  }
  /* REFUSED chips: one per impact, 18 px outside the ring */
  for (const c of chips) {
    if (c.a <= 0.01) continue;
    const cw = 78, chh = 22, x0 = clamp(c.x - cw / 2, 2, w - cw - 2), y0 = c.y - chh / 2;
    Hd.push({ k: "rect", x: x0, y: y0, w: cw, h: chh, r: 4, fill: "#05070D", a: 0.92 * c.a });
    Hd.push({ k: "rect", x: x0, y: y0, w: cw, h: chh, r: 4, stroke: hx(ALIVE), sw: 1.5, a: c.a });
    Hd.push({ k: "text", x: x0 + cw / 2, y: y0 + 15, s: "REFUSED", size: 12, c: hx(ALIVE), a: c.a, font: "mono", align: "center", track: 1.5 });
  }

  /* hex readout under the key: dark plate, scrambles, locks left to right, names itself, gone before the shatter */
  const y1 = h - 23, y2 = h - 8;
  if (hasRun && !o.cover && rt >= T.derive && rt < 2150) {
    const lockT = (i: number) => T.derive + 120 + (i / HEX.length) * (T.lock - T.derive - 220);
    let s = "0x";
    const hexd = "0123456789ABCDEF";
    for (let i = 0; i < HEX.length; i++) s += rt >= lockT(i) ? HEX[i] : hexd[Math.floor(jh(i * 13.1 + Math.floor(rt / 45) * 1.7) * 16)];
    const fadeOut = 1 - smooth(span(rt, 1850, 2100)), fin = smooth(span(rt, T.derive, T.derive + 150)) * fadeOut;
    Hd.push({ k: "rect", x: cx - 112, y: y1 - 15, w: 224, h: h - y1 + 15, fill: "#05070D", a: 0.92 * fin });
    Hd.push({ k: "text", x: cx, y: y1, s, size: 11, c: hx(rt >= T.lock ? mix(SIG, WHITE, 0.3) : SIG), a: fin, font: "mono", align: "center", track: 1 });
    if (rt >= T.lock) Hd.push({ k: "text", x: cx, y: y2, s: "private key derived", size: 11, c: hx(SIG), a: smooth(span(rt, T.lock, T.lock + 200)) * fadeOut, font: "mono", align: "center", track: 0.6 });
  }
  if (hasRun && rt >= T.shatter + 500 && o.stage === 0 && !(narrow && counting)) {
    Hd.push({ k: "text", x: cx, y: y2, s: "classical key shattered", size: 11, c: hx(SIG), a: 0.8 * smooth(span(rt, T.shatter + 500, T.shatter + 1300)), font: "mono", align: "center", track: 0.6 });
  }
  if (!hasRun) {
    Hd.push({ k: "text", x: cx, y: y2, s: "classical key · secp256k1", size: 10, c: "#A3ADC2", a: 0.85, font: "mono", align: "center", track: 0.4 });
  }

  /* SEALED plate: stamps in at the centre of the crystal */
  if (hasRun && sealP && rt >= T.seal) {
    const k = rt - T.seal;
    const sc = 1 + 0.45 * (1 - eo(k / 230));
    const pa = smooth(k / 120);
    const pw = Math.min(w * 0.64, 250) * sc, ph = Math.max(44, Math.min(60, Rr * 0.5)) * sc;
    const x0 = cx - pw / 2, y0 = cy - ph / 2;
    Hd.push({ k: "blob", x: cx, y: cy, r: pw * 0.8, c: tintHex, a: 0.35 * pa * Math.exp(-k / 700), blend: "lighter" });
    Hd.push({ k: "rect", x: x0, y: y0, w: pw, h: ph, fill: "#05070D", a: 0.9 * pa });
    Hd.push({ k: "rect", x: x0, y: y0, w: pw, h: ph, stroke: tintW, sw: 1.3, a: 0.95 * pa });
    /* tick corners */
    const cl = 7 * sc, cp2: number[] = [];
    for (const [px, py, dx, dy] of [[x0, y0, 1, 1], [x0 + pw, y0, -1, 1], [x0, y0 + ph, 1, -1], [x0 + pw, y0 + ph, -1, -1]]) cp2.push(px - dx * 3, py - dy * 3 + dy * cl, px - dx * 3, py - dy * 3, px - dx * 3, py - dy * 3, px - dx * 3 + dx * cl, py - dy * 3);
    Hd.push({ k: "segs", p: cp2, c: tintHex, w: 1.2, a: 0.9 * pa, blend: "lighter" });
    Hd.push({ k: "text", x: cx, y: cy - ph * 0.06, s: "SEALED", size: Math.min(21, Rr * 0.17) * sc, c: tintW, a: pa, font: "mono", align: "center", track: 5 * sc });
    Hd.push({ k: "text", x: cx, y: cy + ph * 0.32, s: "ML-DSA-87 · verified on chain", size: 11 * sc, c: "#A3ADC2", a: pa * 0.95, font: "mono", align: "center", track: 0.3 });
  }
  if (hasRun && o.stage === 4) {
    Hd.push({ k: "text", x: cx - 8, y: keyYs + 2, s: "60% Maya", size: 11, c: ICEHEX, a: smooth(o.stageT / 600), font: "mono", align: "right" });
    Hd.push({ k: "text", x: cx + 8, y: keyYs + 2, s: "40% Leo", size: 11, c: "#A48BFF", a: smooth(o.stageT / 600), font: "mono", align: "left" });
  }

  return [...out, ...Hd];
}
