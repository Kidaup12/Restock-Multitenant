"use client";

import { createContext, useContext } from "react";

/**
 * The workspace's currency, available to every component that renders money.
 *
 * Why a client context rather than props: `CostValue` is used by roughly twenty
 * screens, half of them client components several levels deep. Threading a
 * currency prop through all of them would be a wide, error-prone change whose
 * failure mode is silent — one missed call site keeps showing the wrong
 * currency. A provider mounted once in the shell reaches all of them, including
 * server components, because the provider is a client ancestor in the tree.
 *
 * The default is deliberate: a workspace with nothing set, and any surface
 * rendered outside the shell (a print view, an email preview), falls back to
 * KES rather than rendering a bare number with no unit at all.
 */

export const DEFAULT_CURRENCY = "KES";

const CurrencyContext = createContext<string>(DEFAULT_CURRENCY);

export function CurrencyProvider({
  currency,
  children,
}: {
  currency: string | null | undefined;
  children: React.ReactNode;
}) {
  return (
    <CurrencyContext.Provider value={currency || DEFAULT_CURRENCY}>{children}</CurrencyContext.Provider>
  );
}

export function useCurrency(): string {
  return useContext(CurrencyContext);
}
