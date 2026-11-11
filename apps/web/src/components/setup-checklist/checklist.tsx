// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio's "Ready to go live" checklist on `/dashboard` (overhaul wave 3, D5.1; creator-studio
 * P1, ux-journeys J2-a and J2-d). One call (`stream.setupState`) says which steps are done; each
 * step has one action and a time estimate, the current one expands inline, and done steps keep
 * an Edit. While the encoder step is current the page checks for a signal gently (every 10 s while
 * visible, backing off on failures), and after a minute without one it says what to check. Going
 * live happens in the encoder, so there is never a "Go live" button. After the first stream the
 * same card lists only what is still open ("After your first stream"), and it goes away once done.
 */
import { SkeletonText, formatNumber, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { SetupChecklist, type SetupChecklistStep, type SetupStepState } from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import type { StreamSetupState } from "@commonair/contracts/dto";
import type { StreamSetupStep } from "@commonair/contracts/enums";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useRetryingLoad } from "../../lib/retrying-load.ts";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { type PollEnv, browserPollEnv } from "../../lib/stream-health.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { latestSample } from "../stream-health-card.tsx";
import { AudienceStep } from "./audience-step.tsx";
import { type SetupClient, apiSetupClient } from "./client.ts";
import { STEP_KEYS } from "./keys.ts";
import {
  type DashboardIntent,
  ENCODER_SLOW_MS,
  STEP_MINUTES,
  checklistPhase,
  currentStep,
  phaseSteps,
  progressOf,
  resolutionLabel,
  setupPollDelay,
} from "./model.ts";
import { SetupPanel } from "./setup-panel.tsx";

export interface GoLiveChecklistProps {
  channel: string;
  publicUrl: string;
  intent?: DashboardIntent;
  /** Bump to reload the state (stream info saved elsewhere on the page, the channel went live). */
  refreshKey?: string | number;
  /** "Add a title" / Edit on the stream info step: the page's stream info editor. */
  onEditInfo?: () => void;
  client?: SetupClient;
  pollEnv?: PollEnv;
  download?: (filename: string, json: string) => void;
}

export function GoLiveChecklist({
  channel,
  publicUrl,
  intent,
  refreshKey,
  onEditInfo,
  client = apiSetupClient,
  pollEnv,
  download,
}: GoLiveChecklistProps): React.JSX.Element | null {
  const setup = useRetryingLoad(`setup|${channel}`, () => client.state(channel));
  // The live check's answer, newer than the load's until the load answers again (it is kept with
  // the answer it replaced, so a fresh load wins).
  const [polled, setPolledState] = React.useState<{ over: StreamSetupState | null; state: StreamSetupState } | null>(
    null,
  );
  const state = polled && polled.over === setup.data ? polled.state : setup.data;
  const setupData = setup.data;
  const setPolled = React.useCallback(
    (s: StreamSetupState) => setPolledState({ over: setupData, state: s }),
    [setupData],
  );

  const { reload } = setup;
  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reload();
  }, [refreshKey, reload]);

  const phase = state ? checklistPhase(state) : null;
  const steps = state && phase ? phaseSteps(state, phase) : [];
  const current = currentStep(steps, intent);

  const needsIngest = phase === "setup";
  const ingest = useRetryingLoad(`ingest|${channel}|${needsIngest ? 1 : 0}`, () =>
    needsIngest ? client.ingest(channel) : Promise.resolve(null),
  );
  const [newKey, setNewKey] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const createKey = async () => {
    trackUi("studio.checklist", "create", "stream_key");
    setCreating(true);
    try {
      const created = await client.createKey(channel);
      setNewKey(created.key);
      reload();
      ingest.reload();
    } catch {
      toast.error(t("d5Dashboard.key.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  // The live check: only while the encoder step is current.
  const checking = current === "encoder_connected";
  useLiveCheck(checking, channel, client, setPolled, pollEnv);
  const slow = useElapsed(checking, ENCODER_SLOW_MS);
  const signal = useSignal(state, channel, client);

  React.useEffect(() => {
    if (current) trackUi("studio.checklist", "view", current);
  }, [current]);

  if (!state) {
    if (setup.state === "failed")
      return (
        <SectionLoadError
          section={t("d5Dashboard.checklist.section")}
          load={setup}
          data-testid="setup-checklist-error"
          retryTestId="setup-checklist-retry"
        />
      );
    return (
      <div data-testid="setup-checklist-loading" aria-busy="true" aria-label={t("d5Dashboard.checklist.loading")}>
        <SkeletonText lines={4} />
      </div>
    );
  }
  if (phase === "complete" || steps.length === 0) return null;

  const click = (step: StreamSetupStep) => () => trackUi("studio.checklist", "click", step);
  const linkButton = (step: StreamSetupStep, to: string, label: string, primary: boolean, testid: string) => (
    <Button
      data-testid={testid}
      variant={primary ? "brand" : "outline"}
      size="sm"
      data-filled-cta={primary ? "" : undefined}
      nativeButton={false}
      render={<Link to={to} onClick={click(step)} />}
    >
      {label}
    </Button>
  );
  const editLink = (step: StreamSetupStep, to: string) => (
    <Button
      data-testid={`setup-step-${step}-edit`}
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={<Link to={to} onClick={click(step)} />}
    >
      {t("d5Dashboard.checklist.edit")}
    </Button>
  );

  const panel = (primary: boolean) => (
    <SetupPanel
      ingest={ingest}
      newKey={newKey}
      canCreate={ingest.data?.activeKeyPrefix === null}
      creating={creating}
      onCreate={() => void createKey()}
      primary={primary}
      loadObsConfig={() => client.obsConfig(channel)}
      download={download}
    />
  );

  const view = (s: (typeof steps)[number]): SetupChecklistStep => {
    const stepState: SetupStepState = s.done ? "done" : s.step === current ? "current" : "todo";
    const isCurrent = stepState === "current";
    const minutes = STEP_MINUTES[s.step];
    const base: SetupChecklistStep = {
      id: s.step,
      title: t(STEP_KEYS[s.step].title),
      hint: t(STEP_KEYS[s.step].hint),
      summary: t(STEP_KEYS[s.step].summary),
      state: stepState,
      optional: s.optional,
      estimate: minutes === null ? undefined : t("d5Dashboard.checklist.estimate", { minutes }),
    };
    switch (s.step) {
      case "channel_profile":
        return {
          ...base,
          action: s.done
            ? editLink(s.step, "/dashboard/settings")
            : linkButton(
                s.step,
                "/dashboard/settings",
                t("d5Dashboard.step.channel_profile.action"),
                isCurrent,
                "setup-step-channel_profile-action",
              ),
        };
      case "stream_info": {
        const edit = () => {
          click(s.step)();
          onEditInfo?.();
        };
        return {
          ...base,
          action: (
            <Button
              data-testid={s.done ? "setup-step-stream_info-edit" : "setup-step-stream_info-action"}
              variant={s.done ? "ghost" : isCurrent ? "brand" : "outline"}
              size="sm"
              data-filled-cta={isCurrent ? "" : undefined}
              onClick={edit}
            >
              {s.done ? t("d5Dashboard.checklist.edit") : t("d5Dashboard.step.stream_info.action")}
            </Button>
          ),
        };
      }
      case "stream_key":
        return {
          ...base,
          summary: ingest.data?.activeKeyPrefix
            ? t("d5Dashboard.step.stream_key.summary", { prefix: ingest.data.activeKeyPrefix })
            : base.summary,
          action: s.done ? editLink(s.step, "/dashboard/settings") : undefined,
          detail: panel(isCurrent),
        };
      case "encoder_connected":
        return {
          ...base,
          summary: signal ?? base.summary,
          detail: (
            <EncoderWait slow={slow} newKey={newKey !== null} panel={panel(false)} onRehearse={click("rehearsal")} />
          ),
        };
      case "rehearsal":
        return {
          ...base,
          action: s.done
            ? undefined
            : linkButton(
                s.step,
                "/rehearse",
                t("d5Dashboard.step.rehearsal.action"),
                false,
                "setup-step-rehearsal-action",
              ),
        };
      case "first_live":
        // Going live is the encoder's Start Streaming, never a button here.
        return { ...base, estimate: s.done ? undefined : t("d5Dashboard.step.first_live.how") };
      case "import_twitch":
        return {
          ...base,
          action: s.done
            ? editLink(s.step, "/import")
            : linkButton(
                s.step,
                "/import",
                t("d5Dashboard.step.import_twitch.action"),
                isCurrent,
                "setup-step-import_twitch-action",
              ),
        };
      case "bring_your_audience":
        return {
          ...base,
          action: s.done ? editLink(s.step, "/move") : undefined,
          detail: (
            <AudienceStep
              channel={channel}
              publicUrl={publicUrl}
              client={client}
              primary={isCurrent}
              onMarked={reload}
            />
          ),
        };
    }
  };

  const { done, total } = progressOf(steps);
  return (
    <SetupChecklist
      id="go-live-checklist"
      data-testid="setup-checklist"
      data-phase={phase}
      data-current={current ?? ""}
      title={phase === "setup" ? t("d5Dashboard.checklist.title") : t("d5Dashboard.checklist.afterTitle")}
      progressText={t("d5Dashboard.checklist.progress", { done, total })}
      done={done}
      total={total}
      steps={steps.map(view)}
      labels={{
        done: t("d5Dashboard.checklist.state.done"),
        current: t("d5Dashboard.checklist.state.current"),
        todo: t("d5Dashboard.checklist.state.todo"),
        optional: t("d5Dashboard.checklist.optional"),
        progress: t("d5Dashboard.checklist.progressLabel"),
      }}
      footer={phase === "setup" ? t("d5Dashboard.checklist.support") : undefined}
    />
  );
}

function EncoderWait({
  slow,
  newKey,
  panel,
  onRehearse,
}: {
  slow: boolean;
  newKey: boolean;
  panel: React.ReactNode;
  onRehearse: () => void;
}): React.JSX.Element {
  // A key created on this page is shown once: the setup stays open (until closed) so it stays on screen.
  const [toggled, setToggled] = React.useState<boolean | null>(null);
  const open = toggled ?? newKey;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <output data-testid="setup-encoder-waiting" aria-live="polite" className="block text-sm">
        {t("d5Dashboard.step.encoder_connected.waiting")}
      </output>
      {slow ? (
        <AlertCallout
          data-testid="setup-encoder-slow"
          tone="info"
          description={t("d5Dashboard.step.encoder_connected.slow")}
          action={
            <span className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                nativeButton={false}
                render={<Link to="/rehearse" onClick={onRehearse} />}
              >
                {t("d5Dashboard.step.encoder_connected.slowRehearse")}
              </Button>
              <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="/dashboard/settings" />}>
                {t("d5Dashboard.step.encoder_connected.slowSettings")}
              </Button>
            </span>
          }
        />
      ) : null}
      <div>
        <Button
          data-testid="setup-encoder-toggle"
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setToggled(!open)}
        >
          {open ? t("d5Dashboard.step.stream_key.hideSetup") : t("d5Dashboard.step.stream_key.showSetup")}
        </Button>
      </div>
      {open ? panel : null}
    </div>
  );
}

/**
 * Polls `stream.setupState` while `active` and the page is visible: every 10 s, doubling after
 * each failure up to a minute. Hidden tabs stop; becoming visible checks at once.
 */
function useLiveCheck(
  active: boolean,
  channel: string,
  client: Pick<SetupClient, "state">,
  onState: (s: StreamSetupState) => void,
  env?: PollEnv,
): void {
  const onStateRef = React.useRef(onState);
  React.useEffect(() => {
    onStateRef.current = onState;
  });
  React.useEffect(() => {
    if (!active) return;
    const e = env ?? browserPollEnv();
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let inFlight = false;
    const schedule = () => {
      if (stopped || !e.isVisible()) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(tick, setupPollDelay(failures));
    };
    const tick = () => {
      timer = null;
      if (stopped || inFlight || !e.isVisible()) return;
      inFlight = true;
      client
        .state(channel)
        .then(
          (s) => {
            failures = 0;
            if (!stopped) onStateRef.current(s);
          },
          () => {
            failures += 1;
          },
        )
        .finally(() => {
          inFlight = false;
          schedule();
        });
    };
    const unlisten = e.onVisibilityChange(() => {
      if (e.isVisible()) {
        if (timer === null && !inFlight) tick();
      } else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    });
    schedule();
    return () => {
      stopped = true;
      unlisten();
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, channel, client, env]);
}

/** True once `active` has held for `ms`. */
function useElapsed(active: boolean, ms: number): boolean {
  const [elapsed, setElapsed] = React.useState(false);
  React.useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => {
      clearTimeout(timer);
      setElapsed(false);
    };
  }, [active, ms]);
  return elapsed;
}

/**
 * When the encoder step ticks while the page is open, what the signal looks like ("Signal
 * received: 1920×1080 at 60 fps."), from one `stream.health` read. Null until then, or when the
 * sample carries no resolution.
 */
function useSignal(
  state: StreamSetupState | null,
  channel: string,
  client: Pick<SetupClient, "health">,
): string | null {
  const { locale } = useLocale();
  const connected = state ? state.steps.find((s) => s.step === "encoder_connected")?.done === true : null;
  const wasConnected = React.useRef<boolean | null>(null);
  const [signal, setSignal] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (connected === null) return;
    const before = wasConnected.current;
    wasConnected.current = connected;
    // Only a tick seen on this page; a channel that connected last week needs no signal line.
    if (before !== false || !connected) return;
    let live = true;
    client.health(channel).then(
      (h) => {
        const s = latestSample(h);
        if (!live || !s || s.width === null || s.height === null || s.fps === null) return;
        // Warnings about the signal (a low resolution, long keyframes) are the health card's.
        setSignal(
          t("d5Dashboard.step.encoder_connected.ok", {
            resolution: resolutionLabel(`${s.width}x${s.height}`),
            fps: formatNumber(Math.round(s.fps), locale),
          }),
        );
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [connected, channel, client, locale]);
  return signal;
}
