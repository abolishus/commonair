// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client entry (TanStack Start's default plus one step): load the catalog of the locale the
 * server rendered (`<html lang>`) before hydrating, so the first client render uses the same
 * strings and React does not throw away the server's HTML.
 */
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { bootClientLocale } from "./i18n/client.ts";

function hydrate(): void {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <StartClient />
      </StrictMode>,
    );
  });
}

// A catalog that fails to load still hydrates (in English); the page must never stay inert.
bootClientLocale(document.documentElement.lang).then(hydrate, hydrate);
