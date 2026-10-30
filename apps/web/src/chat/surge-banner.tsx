// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { RelativeTime } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import type { ChannelChatSettings } from "@commonair/contracts/shapes";
import * as React from "react";
import { type ChatGateClient, useChatGateFeatures } from "../components/chat-gate/features.ts";
import { t } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";

export interface SurgeBannerProps {
  channel: string;
  canModerate: boolean;
  signedIn: boolean;
  /** The latest chat settings from the `joined` and `settings` frames; null before the join. */
  settings: ChannelChatSettings | null;
  /** The latest surge state from the `joined` and `surge` frames; null until one arrives. */
  surge: { state: "off" | "on" | "suppressed"; until: string | null } | null;
  /** The viewer's last message was refused with `msg_verified_watch` (reset on reconnect). */
  gateDenied: boolean;
  /** `instance.info` and `chat.surge.*`; tests pass a fake. */
  client?: ChatGateClient;
}

interface ModSurge {
  state: "off" | "on" | "suppressed";
  until: string | null;
  /** Who started or ended it by hand; null for the job, or once a later frame replaced the read. */
  by: string | null;
  unavailable: boolean;
}

/**
 * The surge-mode banner for moderators and the gate hint for viewers (ADR 0015 decisions 6 and 7).
 * Nothing renders until `instance.info` answers, and nothing after a failed read.
 */
export function SurgeBanner(props: SurgeBannerProps): React.JSX.Element | null {
  const features = useChatGateFeatures(props.client);
  if (!features) return null;
  if (props.canModerate)
    return features.surgeGuard ? <ModBanner channel={props.channel} surge={props.surge} client={props.client} /> : null;
  const gated = features.watchGate && (props.settings?.minVerifiedWatchSeconds ?? 0) > 0;
  const surging = features.surgeGuard && props.surge?.state === "on";
  if (!gated && !surging && !props.gateDenied) return null;
  // One sentence, never a countdown or a reason (decision 4).
  return (
    <p data-testid="chat-gate-hint" className="border-s-2 border-primary bg-muted px-2 py-1.5 text-xs">
      {t("surge.hint")}
    </p>
  );
}

function ModBanner({
  channel,
  surge,
  client,
}: {
  channel: string;
  surge: SurgeBannerProps["surge"];
  client?: ChatGateClient;
}): React.JSX.Element | null {
  // The last read or override result, with the frame that was current then: a newer frame wins.
  const [local, setLocal] = React.useState<{ value: ModSurge; basis: SurgeBannerProps["surge"] } | null>(null);
  const [pending, setPending] = React.useState(false);
  const c = React.useCallback(() => client ?? api(), [client]);
  const surgeRef = React.useRef(surge);
  React.useEffect(() => {
    surgeRef.current = surge;
  });

  // Read once on mount, then follow the frames.
  React.useEffect(() => {
    let live = true;
    c()
      .chat.surge.state({ channel })
      .then(
        (s) => {
          if (live)
            setLocal({
              value: { state: s.state, until: s.until, by: s.by?.username ?? null, unavailable: s.unavailable },
              basis: surgeRef.current,
            });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [c, channel]);

  const act = async (action: "start" | "end") => {
    if (pending) return;
    setPending(true);
    try {
      const s = await c().chat.surge.override({ channel, action });
      setLocal({
        value: { state: s.state, until: s.until, by: s.by?.username ?? null, unavailable: false },
        basis: surgeRef.current,
      });
      toast.success(action === "end" ? t("surge.ended") : t("surge.started"));
    } catch (err) {
      toastActionError(err, t("surge.failed"));
    } finally {
      setPending(false);
    }
  };

  // A frame means Valkey answers again; who acted is not in it.
  const fromFrame: ModSurge | null = surge
    ? { state: surge.state, until: surge.until, by: null, unavailable: false }
    : null;
  const state = local && local.basis === surge ? local.value : (fromFrame ?? local?.value ?? null);
  if (!state) return null;
  if (state.unavailable)
    return <AlertCallout data-testid="surge-unavailable" tone="warning" description={t("surge.unavailable")} />;
  if (state.state === "off") return null;
  const on = state.state === "on";
  const until = state.until ? (
    <span className="text-muted-foreground">
      {on ? t("surge.ends") : t("surge.resumes")} <RelativeTime date={state.until} tooltip={false} />
    </span>
  ) : null;
  return (
    <AlertCallout
      data-testid="surge-banner"
      data-state={state.state}
      tone={on ? "warning" : "info"}
      title={on ? t("surge.onTitle") : t("surge.suppressedTitle")}
      description={
        <p>
          {on ? t("surge.onBody") : t("surge.suppressedBody")}
          {state.by ? <> {t("surge.onBy", { name: state.by })}</> : null} {until}
        </p>
      }
      action={
        on ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="surge-end"
            disabled={pending}
            onClick={() => void act("end")}
          >
            {t("surge.end")}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="surge-start"
            disabled={pending}
            onClick={() => void act("start")}
          >
            {t("surge.start")}
          </Button>
        )
      }
    />
  );
}
