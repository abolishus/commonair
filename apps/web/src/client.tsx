// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client entry (TanStack Start's default plus two steps): load the catalog of the locale the
 * server rendered (`<html lang>`) before hydrating, so the first client render uses the same
 * strings and React does not throw away the server's HTML; and check the server's bootstrap
 * (`window.$_TSR`) is there first (`./hydration-guard.ts`).
 */
import { StartClient } from "@tanstack/react-start/client";
import { StrictMode, startTransition } from "react";
import { hydrateRoot } from "react-dom/client";
import { BOOT_ATTRIBUTE, bootDecision, sessionStore } from "./hydration-guard.ts";
import { bootClientLocale } from "./i18n/client.ts";

// The document this module was evaluated for: the locale load is async, and the check below
// must see whether the window still shows it when that resolves.
const entryDocument = document;

function hydrate(): void {
  const decision = bootDecision({
    entryDocument,
    currentDocument: window.document,
    bootstrap: Reflect.get(window, "$_TSR") as unknown,
    storage: sessionStore(),
    now: Date.now(),
    search: window.location.search,
  });
  if (decision === "stale") return;
  // Only on a miss: an attribute React does not render stays off the hydrated `<html>`.
  if (decision !== "hydrate") entryDocument.documentElement.dataset[BOOT_ATTRIBUTE] = decision;
  if (decision === "reload") {
    console.warn("hydration bootstrap missing; reloading once");
    window.location.reload();
    return;
  }
  if (decision === "missing") console.warn("hydration bootstrap missing again; hydrating anyway");
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
