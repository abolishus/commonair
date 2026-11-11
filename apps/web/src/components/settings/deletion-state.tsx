// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The member's account deletion request, shared by the banner on every settings page and the
 * Privacy & data danger zone (D7.4), so cancelling in one place updates the other. The settings
 * layout provides it; a page rendered without the layout (tests, a stray mount) loads its own.
 */
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import type { DeletionRequestDto } from "../../lib/privacy.ts";
import { trackUi } from "../../lib/ui-metrics.ts";

export interface DeletionClient {
  get(): Promise<DeletionRequestDto | null>;
  request(confirmUsername: string): Promise<DeletionRequestDto>;
  cancel(): Promise<unknown>;
}

export const deletionClient = (): DeletionClient => ({
  get: () => Promise.resolve().then(() => api().me.deletion.get()),
  request: (confirmUsername) => Promise.resolve().then(() => api().me.deletion.request({ confirmUsername })),
  cancel: () => Promise.resolve().then(() => api().me.deletion.cancel()),
});

export interface DeletionState {
  /** undefined while loading; null when nothing is scheduled (or the last request was canceled). */
  request: DeletionRequestDto | null | undefined;
  failed: boolean;
  reload: () => void;
  schedule: (confirmUsername: string) => Promise<void>;
  cancel: () => Promise<void>;
}

const Ctx = React.createContext<DeletionState | null>(null);

/** Only a scheduled request is pending; a completed one never reaches a signed-in page. */
export function scheduledRequest(request: DeletionRequestDto | null | undefined): DeletionRequestDto | null {
  return request?.status === "scheduled" ? request : null;
}

function useDeletionLoader(
  client: DeletionClient,
  enabled: boolean,
  initial?: DeletionRequestDto | null,
): DeletionState {
  const [request, setRequest] = React.useState<DeletionRequestDto | null | undefined>(initial);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.get().then(
      (r) => {
        if (!live) return;
        setRequest(r);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, enabled, attempt]);
  const schedule = React.useCallback(
    async (confirmUsername: string) => {
      const scheduled = await client.request(confirmUsername);
      setRequest(scheduled);
      trackUi("deletion", "confirm");
      toast.success(t("d7Settings.delete.scheduledToast"));
    },
    [client],
  );
  const cancel = React.useCallback(async () => {
    await client.cancel();
    setRequest((r) => (r ? { ...r, status: "canceled" } : null));
    trackUi("deletion", "dismiss");
    toast.success(t("d7Settings.delete.canceledToast"));
  }, [client]);
  const reload = React.useCallback(() => setAttempt((n) => n + 1), []);
  return { request, failed, reload, schedule, cancel };
}

/**
 * The banner's request as `Me.settingsSummary` states it: only the scheduled date is known, which
 * is all the banner and Cancel need. `id` and `retained` stay empty until a page loads the request.
 */
export function summaryRequest(scheduledFor: string | null | undefined): DeletionRequestDto | null {
  return scheduledFor ? { id: "", status: "scheduled", scheduledFor, retained: [] } : null;
}

export function DeletionProvider({
  client: clientProp,
  initial,
  children,
}: {
  client?: DeletionClient;
  /** From the bootstrap (`Me.settingsSummary`): given, the provider makes no request of its own. */
  initial?: DeletionRequestDto | null;
  children: React.ReactNode;
}): React.JSX.Element {
  const [client] = React.useState(() => clientProp ?? deletionClient());
  const state = useDeletionLoader(client, initial === undefined, initial);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** The shared state under the layout, or this component's own load without it. */
export function useDeletion(clientProp?: DeletionClient): DeletionState {
  const shared = React.useContext(Ctx);
  const [client] = React.useState(() => clientProp ?? deletionClient());
  const own = useDeletionLoader(client, shared === null);
  return shared ?? own;
}
