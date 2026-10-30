// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { useLocation } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import {
  type WaitingWorker,
  type WorkerContainer,
  applyUpdate,
  pwaExcludedPath,
  registerServiceWorker,
  whenIdle,
} from "../../pwa/register.ts";

/** One registration per page load, whatever the route does afterwards. */
let registering = false;

/** The non-blocking "new version" banner: reloading is the viewer's choice. */
export function UpdatePrompt({ onReload, onDismiss }: { onReload: () => void; onDismiss: () => void }) {
  return (
    <section
      aria-live="polite"
      data-testid="pwa-update-prompt"
      className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-md flex-wrap items-center justify-between gap-2 border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
    >
      <p className="min-w-0">{t("pwa.update.message")}</p>
      <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t("pwa.update.dismiss")}
        </Button>
        <Button size="sm" data-testid="pwa-update-reload" onClick={onReload}>
          {t("pwa.update.reload")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Mounted once under the root providers: registers the service worker in production builds, after
 * hydration and once the browser is idle, and offers a reload when a new build's worker waits.
 * Never on `/overlay/*` or `/embed/*` (they run inside OBS and other sites).
 */
export function PwaRoot(): React.JSX.Element | null {
  const pathname = useLocation({ select: (location) => location.pathname });
  const excluded = pwaExcludedPath(pathname);
  const [waiting, setWaiting] = React.useState<WaitingWorker | null>(null);

  React.useEffect(() => {
    if (!import.meta.env.PROD || excluded || registering || !("serviceWorker" in navigator)) return;
    registering = true;
    const container = navigator.serviceWorker as unknown as WorkerContainer;
    let started = false;
    const cancel = whenIdle(() => {
      started = true;
      registerServiceWorker(container, setWaiting).catch(() => {
        // No worker (private mode, blocked storage): the site works as before, without the app shell.
        registering = false;
      });
    });
    return () => {
      if (started) return;
      cancel();
      registering = false;
    };
  }, [excluded]);

  if (!waiting || excluded) return null;
  return (
    <UpdatePrompt
      onReload={() =>
        applyUpdate(navigator.serviceWorker as unknown as WorkerContainer, waiting, () => window.location.reload())
      }
      onDismiss={() => setWaiting(null)}
    />
  );
}
