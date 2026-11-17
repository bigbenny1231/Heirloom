import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "./App";
import { Landing } from "./landing/Landing";
import { addressFromHash } from "./chain/testnet";
import { lsSet } from "./ui/format";
import type { Hex } from "./chain/types";

/** The testnet adapter reads "#addr=0x..." or "&addr=0x..." from the hash, so any hash with addr= is the app. */
export function routeFromHash(hash: string): "landing" | "app" {
  if (hash.includes("addr=")) return "app";
  const h = hash.replace(/^#\/?/, "").split(/[&?]/)[0];
  return h === "app" ? "app" : "landing";
}

/** Reading the hash can throw in a sandboxed frame. */
function readHash(): string {
  try {
    return window.location.hash;
  } catch {
    return "";
  }
}

/**
 * Landing and app. The app, once opened, is never unmounted: going back to the site only hides it, so the demo vault
 * and the testnet key survive. Routing sets state first and writes the hash second, so it works where the hash is blocked.
 */
export function Root() {
  const [route, setRoute] = useState<"landing" | "app">(() => routeFromHash(readHash()));
  const [seen, setSeen] = useState(route === "app");
  const [addr] = useState<Hex | null>(() => addressFromHash(readHash()));
  const [demoReq, setDemoReq] = useState(0);
  const [labReq, setLabReq] = useState(0);

  const go = useCallback((r: "landing" | "app") => {
    setRoute(r);
    if (r === "app") setSeen(true);
    try {
      window.location.hash = r === "app" ? "#/app" : "#/";
    } catch {
      /* sandboxed frame: state already moved */
    }
  }, []);

  useEffect(() => {
    const on = () => {
      const r = routeFromHash(readHash());
      setRoute(r);
      if (r === "app") setSeen(true);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // Scroll after the new screen is in place, not before it is shown.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      try {
        window.scrollTo(0, 0);
      } catch {
        /* no scrolling here */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [route]);

  // Move focus to the new screen's heading once it is in place (not on the first render).
  const firstRoute = useRef(true);
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false;
      return;
    }
    const id = requestAnimationFrame(() => {
      try {
        const h = document.querySelector<HTMLElement>(route === "app" ? ".app h1" : ".ld-h1");
        if (h) {
          if (!h.hasAttribute("tabindex")) h.setAttribute("tabindex", "-1");
          h.focus({ preventScroll: true });
        }
      } catch {
        /* focus is a convenience */
      }
    });
    return () => cancelAnimationFrame(id);
  }, [route]);

  const openApp = useCallback(() => {
    // The landing page promises "no wallet": every landing button opens Demo mode (and the briefing, the first time).
    lsSet("qdmv.mode", "demo");
    setDemoReq((n) => n + 1);
    go("app");
  }, [go]);
  /** The Signature lab teaser: straight to the Lab screen, no briefing in between. */
  const openLab = useCallback(() => {
    lsSet("qdmv.mode", "demo");
    setLabReq((n) => n + 1);
    setDemoReq((n) => n + 1);
    go("app");
  }, [go]);

  return (
    <>
      {route === "landing" && <Landing onOpenApp={openApp} onOpenLab={openLab} />}
      {seen && (
        <div hidden={route !== "app"}>
          <App onBack={() => go("landing")} suggestedAddr={addr} demoRequest={demoReq} active={route === "app"} openTo={labReq > 0 ? { screen: "lab", n: labReq } : undefined} />
        </div>
      )}
    </>
  );
}
