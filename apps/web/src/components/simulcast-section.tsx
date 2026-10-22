// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { SimulcastPanel, type SimulcastAddValues, type SimulcastPanelLabels } from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { fillNode } from "../lib/fill.tsx";
import {
  SIMULCAST_POLL_MS,
  isSimulcastPlatform,
  shouldPollSimulcast,
  simulcastError,
  simulcastPlatformOptions,
  simulcastRows,
  simulcastUrlProblem,
  type SimulcastErrorView,
  type SimulcastTargetDto,
} from "../lib/simulcast.ts";
import { browserPollEnv, pollWhileVisible, type PollEnv } from "../lib/stream-health.ts";

function labels(): SimulcastPanelLabels {
  return {
    title: t("simulcast.title"),
    description: t("simulcast.intro"),
    listLabel: t("simulcast.list"),
    emptyTitle: t("simulcast.empty"),
    emptyDescription: t("simulcast.emptyHint"),
    addTitle: t("simulcast.addTitle"),
    name: t("simulcast.name"),
    platform: t("simulcast.platform"),
    url: t("simulcast.url"),
    urlPlaceholder: t("simulcast.urlPlaceholder"),
    urlHint: t("simulcast.urlHint"),
    key: t("simulcast.key"),
    keyHint: t("simulcast.keyHint"),
    add: t("simulcast.add"),
    limitReached: t("simulcast.limitReached"),
    enabled: (name) => t("simulcast.enabled", { name }),
    lastError: (code) => fillNode(t("simulcast.lastError"), "code", <code>{code}</code>),
    remove: (name) => t("simulcast.remove", { name }),
    removeTitle: (name) => t("simulcast.removeTitle", { name }),
    removeDescription: t("simulcast.removeBody"),
    removeConfirm: t("simulcast.removeConfirm"),
  };
}

/** Thrown after an add refusal is already shown inline, so `onError` does not toast it again. */
class ShownInline extends Error {}

/**
 * The `/dashboard` simulcast section: `stream.simulcast.*` behind `SimulcastPanel`. The list is
 * polled every 5 s while a target can change status on its own (`shouldPollSimulcast`) and the
 * tab is visible. A response requested before a local change is dropped, so a slow poll cannot
 * bring back a removed target or an old switch position.
 */
export function SimulcastSection({
  channel,
  pollEnv,
}: {
  channel: string;
  /** Tests pass a fake clock and visibility; the browser's otherwise. */
  pollEnv?: PollEnv;
}): React.JSX.Element {
  const [targets, setTargets] = React.useState<SimulcastTargetDto[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [error, setError] = React.useState<SimulcastErrorView | null>(null);
  const [busyIds, setBusyIds] = React.useState<string[]>([]);
  const seq = React.useRef({ next: 0, minApplied: 0 });

  const load = React.useCallback((): Promise<void> => {
    const s = seq.current;
    const id = s.next++;
    return api()
      .stream.simulcast.list({ channel })
      .then((list) => {
        if (id < s.minApplied) return;
        s.minApplied = id;
        setTargets(list);
        setFailed(false);
      })
      .catch(() => {
        if (id >= s.minApplied) setFailed(true);
      });
  }, [channel]);

  /** A local change landed: answers to requests sent before it are stale. */
  const changed = React.useCallback((update: (list: SimulcastTargetDto[]) => SimulcastTargetDto[]) => {
    seq.current.minApplied = seq.current.next;
    setTargets((list) => (list ? update(list) : list));
  }, []);

  React.useEffect(() => {
    const s = seq.current;
    void load();
    return () => {
      // Unmount or channel change: drop whatever is still in flight.
      s.minApplied = s.next;
    };
  }, [load]);

  const polling = targets !== null && shouldPollSimulcast(targets);
  React.useEffect(() => {
    if (!polling) return;
    let inFlight = false;
    let first = true;
    return pollWhileVisible(
      () => {
        // The first tick would repeat the load that just answered.
        if (first) {
          first = false;
          return;
        }
        if (inFlight) return;
        inFlight = true;
        void load().finally(() => {
          inFlight = false;
        });
      },
      SIMULCAST_POLL_MS,
      pollEnv ?? browserPollEnv(),
    );
  }, [polling, load, pollEnv]);

  const add = async (values: SimulcastAddValues): Promise<void> => {
    const problem = simulcastUrlProblem(values.rtmpUrl);
    if (problem || !isSimulcastPlatform(values.platform)) {
      setError(simulcastError(problem ?? "format"));
      throw new ShownInline();
    }
    try {
      const created = await api().stream.simulcast.create({
        channel,
        name: values.name,
        platform: values.platform,
        rtmpUrl: values.rtmpUrl,
        streamKey: values.streamKey,
        enabled: true,
      });
      setError(null);
      changed((list) => [...list.filter((target) => target.id !== created.id), created]);
      toast.success(t("simulcast.added"));
    } catch (err) {
      setError(simulcastError(err));
      throw new ShownInline();
    }
  };

  const toggle = async (id: string, enabled: boolean): Promise<void> => {
    setBusyIds((ids) => [...ids, id]);
    try {
      const updated = await api().stream.simulcast.update({ channel, id, enabled });
      changed((list) => list.map((target) => (target.id === id ? updated : target)));
    } finally {
      setBusyIds((ids) => ids.filter((busy) => busy !== id));
    }
  };

  const remove = async (id: string): Promise<void> => {
    await api().stream.simulcast.remove({ channel, id });
    changed((list) => list.filter((target) => target.id !== id));
    toast.success(t("simulcast.removed"));
  };

  if (targets === null && failed)
    return (
      <AlertCallout
        data-testid="simulcast-load-error"
        tone="danger"
        live
        title={t("simulcast.title")}
        description={t("simulcast.loadFailed")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        }
      />
    );

  return (
    <SimulcastPanel
      targets={targets ? simulcastRows(targets) : null}
      platforms={simulcastPlatformOptions()}
      labels={labels()}
      onAdd={add}
      onToggle={toggle}
      onRemove={remove}
      onError={(err) => {
        if (!(err instanceof ShownInline)) toastActionError(err, t("simulcast.actionFailed"));
      }}
      error={error}
      busyIds={busyIds}
    />
  );
}
