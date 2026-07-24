"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Content-loading signal shared between the page skeletons and the sidebar.
 * Every page-level skeleton (a Suspense fallback / loading.tsx, which all use the
 * composite Skeleton* components) renders a <SkeletonLoadingBeacon/> for its
 * lifetime, so `useRouteLoading()` is true exactly while a skeleton is on screen.
 * The nav spinner reads it, so the spinner and the skeleton appear and clear
 * together instead of the spinner finishing at route-commit.
 */
const RouteLoadingContext = createContext<{
  loading: boolean;
  add: () => void;
  remove: () => void;
}>({ loading: false, add: () => {}, remove: () => {} });

export function RouteLoadingProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const add = useCallback(() => setCount((c) => c + 1), []);
  const remove = useCallback(() => setCount((c) => Math.max(0, c - 1)), []);
  return (
    <RouteLoadingContext.Provider value={{ loading: count > 0, add, remove }}>
      {children}
    </RouteLoadingContext.Provider>
  );
}

/** True while any page-level skeleton is mounted (content still loading). */
export function useRouteLoading(): boolean {
  return useContext(RouteLoadingContext).loading;
}

/** Rendered inside each page skeleton; flags "content loading" for its lifetime. */
export function SkeletonLoadingBeacon() {
  const { add, remove } = useContext(RouteLoadingContext);
  useEffect(() => {
    add();
    return remove;
  }, [add, remove]);
  return null;
}
