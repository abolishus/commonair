// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

/** Where a Base UI portal mounts: an element, a ref to one, or null for `<body>`. */
export type PortalContainer = HTMLElement | ShadowRoot | React.RefObject<HTMLElement | ShadowRoot | null> | null;

const PortalContainerContext = React.createContext<PortalContainer>(null);

export interface PortalContainerProviderProps {
  /** The element popups in this subtree portal into; null keeps `<body>`. */
  container: PortalContainer;
  children: React.ReactNode;
}

/**
 * Sets the default portal container for the popovers, menus, dialogs and tooltips below it.
 * `<body>` is not painted while another element is fullscreen, so a fullscreen player passes its
 * own root here and its popups stay visible.
 */
export function PortalContainerProvider({ container, children }: PortalContainerProviderProps): React.JSX.Element {
  return <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>;
}

/** The container a portal uses: the explicit prop when given, else the nearest provider's (`<body>` when neither). */
export function usePortalContainer(explicit?: PortalContainer): PortalContainer | undefined {
  const inherited = React.useContext(PortalContainerContext);
  return explicit ?? inherited ?? undefined;
}
