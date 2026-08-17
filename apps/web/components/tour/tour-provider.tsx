"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import type { Role } from "@wezesha/db";
import { cn } from "@/lib/cn";
import { markWelcomed } from "@/lib/auth-actions";
import { Button } from "@/components/ui/button";
import { tourStepsForRole, routeForStep, STEP_ROUTES, type TourStep } from "@/components/tour/steps";

/**
 * In-house interactive tour engine, no dependencies. Steps point at
 * `data-tour="key"` elements; the active target is dimmed around (spotlight),
 * with a tooltip card carrying the copy and controls. Keyboard: arrows to
 * move, Escape to skip. Finishing or skipping stamps Membership.welcomedAt so
 * the tour auto-runs only on the first visit; the profile menu can replay it.
 */

type TourContextValue = {
  /** False when there is no workspace to tour. */
  available: boolean;
  start: () => void;
};

const TourContext = createContext<TourContextValue>({
  available: false,
  start: () => {},
});

export function useTour(): TourContextValue {
  return useContext(TourContext);
}

type Rect = { top: number; left: number; width: number; height: number };

/** First visible element for the step's target keys, in preference order. */
function findTarget(step: TourStep): HTMLElement | null {
  for (const key of step.target) {
    const matches = document.querySelectorAll<HTMLElement>(
      `[data-tour="${key}"]`,
    );
    for (const el of matches) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return el;
    }
  }
  return null;
}

const SPOT_PAD = 6;
const GAP = 12;
const MARGIN = 12;

export function TourProvider({
  role,
  autoStart,
  canOpenInsights = true,
  children,
}: {
  role: Role | null;
  autoStart: boolean;
  /** False when the workspace's plan locks Insights — the tour must not walk
   *  someone onto a screen they cannot open. */
  canOpenInsights?: boolean;
  children: React.ReactNode;
}) {
  const [steps, setSteps] = useState<TourStep[] | null>(null);
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardStyle, setCardStyle] = useState<React.CSSProperties | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef(false);
  /** Step key whose one navigation has already been spent. */
  const navigatedFor = useRef<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  const step = steps !== null && steps.length > 0 ? (steps[index] ?? null) : null;
  const active = step !== null;
  const total = steps?.length ?? 0;

  const start = useCallback(() => {
    if (!role) return;
    // Keep a step if the engine can navigate to its page (STEP_ROUTES) or its
    // target is already on screen — so the walkthrough visits every page, not
    // just the sidebar links visible from Today.
    const chosen = tourStepsForRole(role, canOpenInsights).filter(
      (s) => STEP_ROUTES[s.key] || findTarget(s)
    );
    if (chosen.length === 0) return;
    // A replay from the profile menu starts at step one again, and that step is
    // owed its navigation even though a previous run already spent it.
    navigatedFor.current = null;
    setIndex(0);
    setRect(null);
    setCardStyle(null);
    setSteps(chosen);
  }, [role, canOpenInsights]);

  const finish = useCallback(() => {
    setSteps(null);
    setRect(null);
    setCardStyle(null);
    // First-visit stamp; harmless when replayed from the menu.
    void markWelcomed().catch(() => {});
  }, []);

  // First shell visit (welcomedAt null): run once after layout settles.
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    const timer = setTimeout(start, 600);
    return () => clearTimeout(timer);
  }, [autoStart, start]);

  // Walk into the step's page, ONCE per step. Navigating changes the page
  // behind the spotlight; the target (a sidebar item, present on every page)
  // stays put while the content the tour is describing loads underneath.
  //
  // Re-deciding on every pathname change made the tour a trap: click Suppliers
  // during step one and this effect fired again and pushed you back to Today,
  // so the app was unusable until the tour was skipped. Remembering which step
  // already had its navigation leaves the person's own clicks alone.
  useEffect(() => {
    const route = routeForStep(step, pathname, navigatedFor.current);
    if (step) navigatedFor.current = step.key;
    if (route) router.push(route);
  }, [step, pathname, router]);

  // Bring the step's target into view.
  useEffect(() => {
    if (!step) return;
    const el = findTarget(step);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [step]);

  // Track the target's rect through scroll/resize (and the desktop/mobile
  // switch, since findTarget re-queries and picks the visible twin).
  useEffect(() => {
    if (!step) return;
    let raf = 0;
    const measure = () => {
      const el = findTarget(step);
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        prev.top === r.top &&
        prev.left === r.left &&
        prev.width === r.width &&
        prev.height === r.height
          ? prev
          : { top: r.top, left: r.left, width: r.width, height: r.height },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };
    measure();
    // After a navigation the target renders async — retry briefly so the
    // spotlight locks onto the new page instead of sitting centered.
    const retries = [80, 200, 400, 700, 1100, 1600].map((ms) => setTimeout(measure, ms));
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    return () => {
      cancelAnimationFrame(raf);
      retries.forEach(clearTimeout);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, [step]);

  // Place the tooltip: below the target when it fits, else above; clamped to
  // the viewport so it never overflows on small screens.
  useLayoutEffect(() => {
    if (!step) return;
    const card = cardRef.current;
    if (!card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    if (!rect) {
      setCardStyle({ top: Math.max(MARGIN, (vh - ch) / 2), left: (vw - cw) / 2 });
      return;
    }
    let top = rect.top + rect.height + SPOT_PAD + GAP;
    if (top + ch > vh - MARGIN) top = rect.top - SPOT_PAD - GAP - ch;
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - ch));
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - cw));
    setCardStyle({ top, left });
  }, [step, rect]);

  useEffect(() => {
    if (step) cardRef.current?.focus();
  }, [step]);

  const goNext = useCallback(() => {
    if (!steps) return;
    if (index >= steps.length - 1) finish();
    else setIndex((i) => i + 1);
  }, [steps, index, finish]);

  const goBack = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goNext();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goBack();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, finish, goNext, goBack]);

  const last = index === total - 1;

  return (
    <TourContext.Provider value={{ available: role !== null, start }}>
      {children}
      {step &&
        createPortal(
          <div className="fixed inset-0 z-50">
            {/* Blocks the page while the tour runs; the spotlight box below
                carries the actual dimming shadow. */}
            <div className="absolute inset-0" />
            {rect ? (
              <div
                aria-hidden="true"
                className="absolute rounded-lg shadow-[0_0_0_100vmax_rgb(0_0_0/0.55)] ring-2 ring-accent transition-all duration-300 ease-out"
                style={{
                  top: rect.top - SPOT_PAD,
                  left: rect.left - SPOT_PAD,
                  width: rect.width + SPOT_PAD * 2,
                  height: rect.height + SPOT_PAD * 2,
                }}
              />
            ) : (
              <div aria-hidden="true" className="absolute inset-0 bg-black/55" />
            )}
            <div
              ref={cardRef}
              role="dialog"
              aria-modal="true"
              aria-label={step.title}
              tabIndex={-1}
              className={cn(
                "absolute w-[min(340px,calc(100vw-24px))] rounded-lg border border-edge bg-surface p-4 shadow-pop outline-none",
                "transition-[top,left] duration-300 ease-out",
                cardStyle === null && "invisible",
              )}
              style={cardStyle ?? undefined}
            >
              <div className="text-xs font-medium text-ink-faint">
                {index + 1} of {total}
              </div>
              <h2 className="mt-1 text-base font-semibold text-ink">
                {step.title}
              </h2>
              <p className="mt-1 text-sm text-ink-muted">{step.body}</p>
              <div className="mt-4 flex items-center gap-2">
                <button
                  type="button"
                  onClick={finish}
                  className="text-xs font-medium text-ink-muted transition-colors hover:text-ink"
                >
                  Skip tour
                </button>
                <div className="ml-auto flex items-center gap-2">
                  {index > 0 && (
                    <Button variant="ghost" size="sm" onClick={goBack}>
                      Back
                    </Button>
                  )}
                  <Button size="sm" onClick={goNext}>
                    {last ? "Done" : "Next"}
                  </Button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </TourContext.Provider>
  );
}
