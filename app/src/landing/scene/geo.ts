/* Static geometry for the hero crystal: a once-subdivided icosphere (42 nodes, 120 edges, 80 panels) and an inner icosahedron. */
export type V3 = [number, number, number];

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

function icosahedron() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v: V3[] = ([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]] as V3[]).map(norm);
  const f: [number, number, number][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  return { v, f };
}

function build() {
  const { v: base, f: bf } = icosahedron();
  const V: V3[] = base.slice();
  const cache = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const key = a < b ? `${a}_${b}` : `${b}_${a}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    V.push(norm([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2]));
    cache.set(key, V.length - 1);
    return V.length - 1;
  };
  const F: [number, number, number][] = [];
  for (const [a, b, c] of bf) {
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    F.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
  }
  const seen = new Set<string>();
  const E: [number, number][] = [];
  for (const f of F) for (let i = 0; i < 3; i++) {
    const a = f[i], b = f[(i + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!seen.has(key)) { seen.add(key); E.push([a, b]); }
  }
  return { V, E, F };
}

const g = build();
export const ICO_V = g.V;
export const ICO_E = g.E;
export const ICO_F = g.F;

const ic = icosahedron();
export const CRY_V = ic.v;
export const CRY_E: [number, number][] = (() => {
  const seen = new Set<string>(); const out: [number, number][] = [];
  for (const f of ic.f) for (let i = 0; i < 3; i++) {
    const a = f[i], b = f[(i + 1) % 3], key = a < b ? `${a}_${b}` : `${b}_${a}`;
    if (!seen.has(key)) { seen.add(key); out.push([a, b]); }
  }
  return out;
})();
