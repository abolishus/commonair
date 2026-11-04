// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Theatre mode (D2-player owns it; the channel page lays out from it and chat sizes from it).
 * Contract-step seam: the shape is fixed, D2-player fills in storage and the `t` key.
 */
import * as React from "react";

export interface Theatre {
  theatre: boolean;
  setTheatre: (next: boolean) => void;
}

const OFF: Theatre = { theatre: false, setTheatre: () => {} };

export const TheatreContext = React.createContext<Theatre>(OFF);

/** Outside a `TheatreContext` provider theatre is off and cannot be turned on. */
export function useTheatre(): Theatre {
  return React.useContext(TheatreContext);
}
