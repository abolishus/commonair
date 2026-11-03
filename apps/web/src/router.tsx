// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRouter } from "@tanstack/react-router";
import { ErrorState, NotFoundState } from "./components/not-found.tsx";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    // Every route without its own (embeds, overlays, leaf pages) gets the shared states with an
    // action, never TanStack's default page with its "Show Error" details (F13).
    defaultErrorComponent: ({ reset }) => <ErrorState reset={reset} />,
    defaultNotFoundComponent: () => <NotFoundState />,
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
