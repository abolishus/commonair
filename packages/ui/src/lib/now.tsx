// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/**
 * The request time, so server rendering and the first client render of
 * time-relative text agree (no hydration mismatch). Set it from the request on
 * the server and serialize the same value to the client.
 */
const NowContext = React.createContext<number | undefined>(undefined);

export interface NowProviderProps {
  /** Request time: epoch ms, `Date`, or ISO string. */
  now: number | Date | string;
  children: React.ReactNode;
}

export function toEpochMs(value: number | Date | string): number {
  return typeof value === "number" ? value : new Date(value).getTime();
}

export function NowProvider({ now, children }: NowProviderProps): React.JSX.Element {
  return <NowContext.Provider value={toEpochMs(now)}>{children}</NowContext.Provider>;
}

/** The request time from `NowProvider`, if any. */
export function useRequestNow(): number | undefined {
  return React.useContext(NowContext);
}
