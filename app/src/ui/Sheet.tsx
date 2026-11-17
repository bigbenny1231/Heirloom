import { useEffect, useRef, type ReactNode } from "react";
import { lockScroll } from "./scrollLock";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** Modal sheet: focus moves in and is trapped, Escape closes, the page behind does not scroll, focus returns to the opener. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // a new onClose each render must not re-run the effect and steal focus
  const downOnBackdrop = useRef(false);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current;
    el?.focus();
    const unlock = lockScroll();
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeRef.current();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !el.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => {
      window.removeEventListener("keydown", h);
      unlock();
      try {
        opener?.focus?.();
      } catch {
        /* the opener may be gone */
      }
    };
  }, []);

  return (
    <div
      className="sheet-bg"
      onMouseDown={(e) => { downOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        // Close only when the press began on the backdrop, so a drag that ends there does not dismiss the sheet.
        if (downOnBackdrop.current && e.target === e.currentTarget) closeRef.current();
        downOnBackdrop.current = false;
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="q-eyebrow">Heirloom</div>
        <h2>{title}</h2>
        {children}
        <button className="q-btn q-btn--ghost q-btn--block" onClick={() => closeRef.current()}>Done</button>
      </div>
    </div>
  );
}
