import { useEffect, useRef, type ReactNode } from "react";
import { lockScroll } from "./scrollLock";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** A full-screen layer inside the app (the create flow). Locks page scroll, traps focus, gives focus back when it closes. */
export function FullScreen({ label, children, onEscape, className = "" }: { label: string; children: ReactNode; onEscape?: () => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const esc = useRef(onEscape);
  esc.current = onEscape;
  useEffect(() => {
    const el = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    const unlock = lockScroll();
    el?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { esc.current?.(); return; }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1], active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (active === last || !el.contains(active))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      unlock();
      try { opener?.focus?.({ preventScroll: true }); } catch { /* the opener may be gone */ }
    };
  }, []);
  return (
    <div ref={ref} className={`fs ${className}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      <div className="fs-in">{children}</div>
    </div>
  );
}
