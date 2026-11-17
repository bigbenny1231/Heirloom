import { useRef } from "react";
import "./heir.css";

export type Persona = "owner" | "heir" | "stranger";
const ORDER: { p: Persona; label: string }[] = [
  { p: "owner", label: "Owner" },
  { p: "heir", label: "Heir" },
  { p: "stranger", label: "Stranger" },
];

/** Segmented radio group: who is looking at the vault. Arrow keys move the choice. */
export function PersonaSwitch({ value, onChange }: { value: Persona; onChange: (p: Persona) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number, d: number) => {
    const n = (i + d + ORDER.length) % ORDER.length;
    onChange(ORDER[n].p);
    refs.current[n]?.focus();
  };
  return (
    <div>
      <p className="pz-cap" id="pz-cap">Viewing as</p>
      <div className="pz" role="radiogroup" aria-labelledby="pz-cap">
        {ORDER.map((o, i) => (
          <button
            key={o.p}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            data-p={o.p}
            aria-checked={value === o.p}
            tabIndex={value === o.p ? 0 : -1}
            onClick={() => onChange(o.p)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(i, 1); }
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(i, -1); }
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
