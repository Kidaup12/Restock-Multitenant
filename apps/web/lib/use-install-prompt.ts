"use client";

import { useEffect, useState } from "react";

/*
 * Captures the browser's beforeinstallprompt event so "Install app" can
 * trigger it on demand. Chromium-only; elsewhere (or once installed)
 * `canInstall` stays false and callers hide the action. The capture lives at
 * module scope because the event usually fires before any component mounts.
 */

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let captured: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

function notify() {
  for (const subscriber of subscribers) subscriber();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    captured = event as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    captured = null;
    notify();
  });
}

export function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(false);

  useEffect(() => {
    const sync = () =>
      setCanInstall(
        captured !== null &&
          !window.matchMedia("(display-mode: standalone)").matches,
      );
    sync();
    subscribers.add(sync);
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  async function promptInstall() {
    const prompt = captured;
    if (!prompt) return;
    // A captured event is single-use in Chromium.
    captured = null;
    notify();
    await prompt.prompt();
  }

  return { canInstall, promptInstall };
}
