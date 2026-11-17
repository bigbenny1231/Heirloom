const C13 = 2 * Math.PI * 13;

/** Miniature lattice core: hairline ring, a three-quarter ice progress arc, one centre node and six satellites. */
export function LogoMark({ size = 28 }: { size?: number }) {
  const sats = Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return [16 + Math.cos(a) * 6.5, 16 + Math.sin(a) * 6.5] as const;
  });
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="13" stroke="var(--ice)" strokeOpacity=".28" strokeWidth="1" />
      <circle
        cx="16" cy="16" r="13" stroke="var(--ice)" strokeWidth="1.8" strokeLinecap="round"
        strokeDasharray={`${(C13 * 0.75).toFixed(2)} ${C13.toFixed(2)}`} transform="rotate(-90 16 16)"
      />
      {sats.map(([x, y], i) => <line key={`l${i}`} x1="16" y1="16" x2={x.toFixed(2)} y2={y.toFixed(2)} stroke="var(--ice)" strokeOpacity=".3" strokeWidth=".8" />)}
      {sats.map(([x, y], i) => <circle key={i} cx={x.toFixed(2)} cy={y.toFixed(2)} r="1.4" fill="var(--ice)" />)}
      <circle cx="16" cy="16" r="2.2" fill="var(--ice)" />
    </svg>
  );
}

/** One name everywhere: the wordmark is "Heirloom". */
export function Logo({ size = 28, withText = true }: { size?: number; withText?: boolean; full?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: Math.round(size * 0.38), color: "var(--text)" }}>
      <LogoMark size={size} />
      {withText && (
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 600, fontStretch: "var(--stretch-display, 118%)", fontSize: Math.round(size * 0.58), letterSpacing: "-.02em", lineHeight: 1, whiteSpace: "nowrap" }}>
          Heirloom
        </span>
      )}
    </span>
  );
}
