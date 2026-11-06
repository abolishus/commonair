// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/rehearse` (W2-rehearsal): the owner's page, polling `stream.rehearsal.status` and `.report`
 * every 5 s while the tab is visible, and the invitee's watch view (`/rehearse?channel=<slug>`).
 */
import { EmptyState } from "@commonair/ui";
import { toast } from "@commonair/ui/toast";
import { VideoOffIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import type { RehearsalReport, RehearsalStatus } from "@commonair/contracts/dto";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { browserPollEnv, pollWhileVisible } from "../../lib/stream-health.ts";
import { armErrorKey, inviteErrorKey, MAX_INVITEES, REHEARSAL_POLL_MS, suggestions } from "./lib.ts";
import { RehearsalPanel } from "./panel.tsx";
import { RehearsalPlayer, type RehearsalPlayerState } from "./watch-player.tsx";

/** The report of the current or last rehearsal; null when there is none in the last 24 h. */
async function loadReport(channel: string): Promise<RehearsalReport | null> {
  try {
    return await api().stream.rehearsal.report({ channel });
  } catch (err) {
    if (errorCode(err) === "NOT_FOUND") return null;
    throw err;
  }
}

export function RehearsePage({ channel }: { channel: string }): React.JSX.Element {
  const [status, setStatus] = React.useState<RehearsalStatus | null>(null);
  const [report, setReport] = React.useState<RehearsalReport | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [keyPrefix, setKeyPrefix] = React.useState<string | null | undefined>(undefined);
  const [followers, setFollowers] = React.useState<{ username: string; excluded: boolean }[]>([]);
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const inFlight = React.useRef(false);

  const refresh = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const [s, r] = await Promise.all([api().stream.rehearsal.status({ channel }), loadReport(channel)]);
      setStatus(s);
      setReport(r);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      inFlight.current = false;
    }
  }, [channel]);

  React.useEffect(() => {
    const stop = pollWhileVisible(() => void refresh(), REHEARSAL_POLL_MS, browserPollEnv());
    return stop;
  }, [refresh]);

  // The countdown ticks every second between polls.
  React.useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    api()
      .stream.ingest({ channel })
      .then((i) => !cancelled && setKeyPrefix(i.activeKeyPrefix))
      .catch(() => !cancelled && setKeyPrefix(null));
    api()
      .channels.followers({ channel, limit: 50 })
      .then(
        (p) => !cancelled && setFollowers(p.items.map((f) => ({ username: f.user.username, excluded: f.excluded }))),
      )
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [channel]);

  const watchHref =
    typeof window === "undefined"
      ? `/rehearse?channel=${encodeURIComponent(channel)}`
      : `${window.location.origin}/rehearse?channel=${encodeURIComponent(channel)}`;

  return (
    <RehearsalPanel
      status={status}
      report={report}
      nowMs={nowMs}
      keyPrefix={keyPrefix}
      suggestions={suggestions(followers, status?.invitees ?? [])}
      loadFailed={failed}
      channel={channel}
      watchHref={watchHref}
      player={<RehearsalPlayer key={status?.broadcastId ?? "none"} channel={channel} testId="rehearsal-player" />}
      onArm={async () => {
        try {
          setStatus(await api().stream.rehearsal.arm({ channel }));
          toast.success(t("rehearsal.armed"));
        } catch (err) {
          toast.error(t(armErrorKey(err)));
        }
      }}
      onDisarm={async () => {
        try {
          setStatus(await api().stream.rehearsal.disarm({ channel }));
          toast.success(t("rehearsal.disarmed"));
          void refresh();
        } catch (err) {
          toast.error(t("rehearsal.disarmFailed"));
          throw err;
        }
      }}
      onInvite={async (username) => {
        try {
          setStatus(await api().stream.rehearsal.invite({ channel, username, remove: false }));
          toast.success(t("rehearsal.invitees.added", { username }));
        } catch (err) {
          // `max` fills the limit refusal's placeholder; the other refusals ignore it.
          toast.error(t(inviteErrorKey(err), { max: MAX_INVITEES }));
          throw err;
        }
      }}
      onRemove={async (username) => {
        try {
          setStatus(await api().stream.rehearsal.invite({ channel, username, remove: true }));
        } catch (err) {
          toast.error(t(inviteErrorKey(err), { max: MAX_INVITEES }));
        }
      }}
    />
  );
}

/**
 * An invitee's view of someone else's rehearsal. Opened before the streamer publishes (or between
 * reconnects), it asks again every poll while visible and starts playing when the rehearsal does.
 * While it waits, the retries' own loading state never replaces the "nothing yet" notice.
 */
export function RehearsalWatchView({ channel }: { channel: string }): React.JSX.Element {
  const [state, setState] = React.useState<RehearsalPlayerState>("loading");
  const [waiting, setWaiting] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const onState = React.useCallback((s: RehearsalPlayerState) => {
    setState(s);
    if (s === "unavailable") setWaiting(true);
    else if (s !== "loading") setWaiting(false);
  }, []);
  React.useEffect(() => {
    if (!waiting) return;
    let first = true;
    // pollWhileVisible ticks at once; the player just answered, so the first retry waits a poll.
    return pollWhileVisible(
      () => {
        if (first) first = false;
        else setAttempt((a) => a + 1);
      },
      REHEARSAL_POLL_MS,
      browserPollEnv(),
    );
  }, [waiting]);
  const shown: RehearsalPlayerState = waiting ? "unavailable" : state;
  return (
    <div data-testid="rehearsal-watch" data-state={shown} className="flex min-w-0 flex-col gap-6">
      {waiting ? (
        <EmptyState
          icon={VideoOffIcon}
          title={t("rehearsal.watch.unavailable")}
          description={t("rehearsal.watch.unavailableHint")}
        />
      ) : null}
      <div hidden={waiting} className="min-w-0">
        <RehearsalPlayer key={attempt} channel={channel} onState={onState} />
      </div>
    </div>
  );
}
