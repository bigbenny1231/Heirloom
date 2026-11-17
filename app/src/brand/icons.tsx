import type { ReactNode } from "react";

export type IconName = "vault" | "key" | "withdraw" | "drill" | "heirs" | "agent" | "settings" | "check" | "x" | "arrow-right" | "external" | "copy" | "info" | "lab" | "more" | "play";

const PATHS: Record<IconName, ReactNode> = {
  vault: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="12" cy="12" r="3.4" /><path d="M12 8.6V6.8M12 17.2v-1.8M8.6 12H6.8M17.2 12h-1.8" /></>,
  key: <><circle cx="8" cy="12" r="3.6" /><path d="M11.6 12H20M17 12v3M20 12v2.4" /></>,
  withdraw: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14" /></>,
  drill: <><path d="M12 3.5 5 6.2v5.3c0 4.3 2.9 7.3 7 9 4.1-1.7 7-4.7 7-9V6.2L12 3.5Z" /><path d="m9 12 2.2 2.2L15.2 10" /></>,
  heirs: <><circle cx="9" cy="9" r="3" /><path d="M3.5 19c.4-3 2.6-4.8 5.5-4.8s5.1 1.8 5.5 4.8" /><circle cx="17" cy="10" r="2.3" /><path d="M16.5 14.3c2.4 0 3.9 1.5 4.2 3.7" /></>,
  agent: <><rect x="5" y="7.5" width="14" height="11" rx="3" /><path d="M12 7.5V4.5M9.5 12.5v1M14.5 12.5v1M9.5 16h5" /><circle cx="12" cy="4" r=".6" /></>,
  settings: <><path d="M4 7h9M17 7h3M4 17h3M11 17h9" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  "arrow-right": <path d="M4.5 12h15M13.5 6l6 6-6 6" />,
  external: <><path d="M14 4.5h5.5V10M19.5 4.5 11 13" /><path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" /></>,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" /></>,
  lab: <><path d="M9.5 4.5h5M10.5 4.5v5.2L5.6 18a1.6 1.6 0 0 0 1.4 2.5h10a1.6 1.6 0 0 0 1.4-2.5l-4.9-8.3V4.5" /><path d="M8 14.5h8" /></>,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.2M12 7.8v.4" /></>,
};

export function Icon({ name, size = 20, title }: { name: IconName; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      {PATHS[name]}
    </svg>
  );
}
