"use client";

import { useEffect } from "react";

/* Registers the app-shell service worker (public/sw.js). Production only,
   so dev never fights a stale cache. */
export function SwRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is progressive enhancement; failure is non-fatal.
    });
  }, []);

  return null;
}
