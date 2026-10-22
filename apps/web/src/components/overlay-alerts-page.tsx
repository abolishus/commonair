// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { OverlayAlertsView, useAlertQueue, type OverlayState } from "@commonair/ui/blocks/overlay";
import * as React from "react";
import { overlayApi } from "../lib/api.ts";
import { connectOverlay, type OverlayConnectionDeps } from "../lib/overlay-connection.ts";
import { overlayTokenFrom } from "../lib/overlay-page.ts";

export function browserOverlayDeps(token: string): OverlayConnectionDeps {
  const client = overlayApi(token);
  return {
    loadState: () => client.interact.overlays.state(),
    openEvents: (url) => new EventSource(url),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/** A URL without a token: the state "call" answers 401 at once, so the page ends refused. */
function withoutToken(): OverlayConnectionDeps {
  return {
    loadState: () => Promise.reject(Object.assign(new Error("no overlay token"), { code: "UNAUTHORIZED" })),
    openEvents: () => {
      throw new Error("no overlay token");
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  };
}

/**
 * `/overlay/alerts`: reads the token from the query string in the browser only (it is never
 * rendered on the server), connects (`connectOverlay`) and shows one alert at a time. Refused
 * means nothing visible and no reconnecting.
 */
export function OverlayAlertsPage({
  deps = browserOverlayDeps,
}: {
  /** Tests pass a fake API and `EventSource`. */
  deps?: (token: string) => OverlayConnectionDeps;
}): React.JSX.Element {
  const [state, setState] = React.useState<OverlayState>("connecting");
  const { current, enqueue, clear } = useAlertQueue();
  const makeDeps = React.useRef(deps);

  React.useEffect(() => {
    const token = overlayTokenFrom(window.location.search);
    // No token is answered like a refused one: no request, no stream.
    const connection = token ? makeDeps.current(token) : withoutToken();
    return connectOverlay(connection, { onState: setState, onAlert: enqueue });
  }, [enqueue]);

  React.useEffect(() => {
    if (state === "refused") clear();
  }, [state, clear]);

  return <OverlayAlertsView state={state} alert={current} />;
}
