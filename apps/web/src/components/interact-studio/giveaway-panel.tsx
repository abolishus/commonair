// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Giveaways on `/interact` (ADR 0039; docs/testing/b7-selectors.md "Giveaways"), for the owner and
 * editors: the open form (title, prize, winners, an optional chat keyword and timed close, and the
 * three free eligibility rules), then the live card (entrant count refreshed while open, the
 * published seed commitment) with close, draw and a confirmed cancel, then the winners as
 * pseudonyms and the link to the public verify page. Renders nothing while the instance has
 * giveaways off.
 */
import { ConfirmDialog, StatusBadge } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { GiftIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode, type Api } from "../../lib/api.ts";
import { giveawaysEnabled } from "../../chat/interact/client.ts";
import {
  GIVEAWAY_LIMITS,
  STATUS_KEYS,
  emptyGiveawayDraft,
  giveawayInput,
  type GiveawayDraft,
  type GiveawayDto,
  type GiveawayFieldErrors,
} from "../giveaways/logic.ts";
import { POLL_REFRESH_MS } from "./poll-panel.tsx";
import { StudioSection, TextField, useLiveState, usePolling } from "./shared.tsx";

export type GiveawayStudioApi = Pick<Api, "interact" | "instance">;

const isLive = (g: GiveawayDto | null): g is GiveawayDto =>
  g !== null && (g.status === "open" || g.status === "closed");

export interface GiveawayPanelProps {
  channel: string;
  client?: GiveawayStudioApi;
  refreshMs?: number;
}

/** Loads the flag and the current giveaway, then renders the panel (nothing while giveaways are off). */
export function GiveawayPanel({ channel, client, refreshMs }: GiveawayPanelProps): React.JSX.Element | null {
  const [c] = React.useState<GiveawayStudioApi>(() => client ?? api());
  const [loaded, setLoaded] = React.useState<{ giveaway: GiveawayDto | null } | null>(null);
  React.useEffect(() => {
    let live = true;
    giveawaysEnabled(c)
      .then(async (on) => (on ? { giveaway: await c.interact.giveaways.current({ channel }) } : null))
      .then((r) => {
        if (live) setLoaded(r);
      })
      .catch(() => {
        // Off or unreachable: the rest of the studio still works; nothing to show here.
        if (live) setLoaded(null);
      });
    return () => {
      live = false;
    };
  }, [c, channel]);
  if (!loaded) return null;
  return <GiveawayStudio channel={channel} initial={loaded.giveaway} client={c} refreshMs={refreshMs} />;
}

type Action = "close" | "draw" | "cancel";

export function GiveawayStudio({
  channel,
  initial,
  client,
  refreshMs = POLL_REFRESH_MS,
}: {
  channel: string;
  initial: GiveawayDto | null;
  client: GiveawayStudioApi;
  refreshMs?: number;
}): React.JSX.Element {
  const [giveaway, setGiveaway, refresh] = useLiveState(initial);
  usePolling(giveaway?.status === "open", refreshMs, () =>
    refresh(() => client.interact.giveaways.current({ channel })),
  );

  const act = async (action: Action): Promise<void> => {
    if (!giveaway) return;
    const g = client.interact.giveaways;
    const input = { channel, id: giveaway.id };
    const next =
      action === "close" ? await g.close(input) : action === "draw" ? await g.draw(input) : await g.cancel(input);
    setGiveaway(next);
    toast.success(
      action === "close"
        ? t("giveaways.studio.closed")
        : action === "draw"
          ? t("giveaways.studio.drawn")
          : t("giveaways.studio.cancelled"),
    );
  };

  return (
    <StudioSection
      icon={GiftIcon}
      title={t("giveaways.studio.title")}
      description={t("giveaways.studio.intro")}
      data-testid="giveaway-panel"
    >
      {giveaway ? <GiveawayLive channel={channel} giveaway={giveaway} onAction={act} /> : null}
      {isLive(giveaway) ? null : (
        <GiveawayForm
          onOpen={async (draft) => {
            const checked = giveawayInput(channel, draft);
            if (!checked.ok) return checked.errors;
            setGiveaway(await client.interact.giveaways.open(checked.input));
            toast.success(t("giveaways.studio.opened"));
            return null;
          }}
        />
      )}
    </StudioSection>
  );
}

function ActionButton({
  action,
  onAction,
  onError,
  testId,
  label,
  variant = "default",
}: {
  action: Action;
  onAction: (a: Action) => Promise<void>;
  onError: (err: unknown) => void;
  testId: string;
  label: string;
  variant?: "default" | "outline";
}): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      type="button"
      variant={variant}
      data-testid={testId}
      disabled={pending}
      onClick={() => {
        setPending(true);
        onAction(action)
          .catch(onError)
          .finally(() => setPending(false));
      }}
    >
      {label}
    </Button>
  );
}

function GiveawayLive({
  channel,
  giveaway: g,
  onAction,
}: {
  channel: string;
  giveaway: GiveawayDto;
  onAction: (a: Action) => Promise<void>;
}): React.JSX.Element {
  const onError = (err: unknown) => toastActionError(err, t("giveaways.studio.actionFailed"));
  return (
    <div
      data-testid="giveaway-live"
      data-giveaway-id={g.id}
      data-status={g.status}
      data-entries={g.entries}
      className="flex min-w-0 flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-medium break-words">{g.title}</h3>
        <StatusBadge tone={g.status === "open" ? "success" : "neutral"}>{t(STATUS_KEYS[g.status])}</StatusBadge>
      </div>
      <p className="text-sm break-words">{t("giveaways.card.prize", { prize: g.prize })}</p>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("giveaways.card.entries", { count: g.entries })}
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-xs text-muted-foreground">{t("giveaways.studio.commitment")}</p>
        <code data-testid="giveaway-commitment" className="font-mono text-xs break-all">
          {g.seedCommitment}
        </code>
      </div>
      {g.status === "drawn" ? (
        <ol className="flex min-w-0 flex-col gap-1 text-xs" aria-label={t("giveaways.studio.winners")}>
          {g.winners.length === 0 ? <li>{t("giveaways.studio.noWinners")}</li> : null}
          {g.winners.map((w) => (
            <li key={w.rank} className="font-mono break-all">
              {t("giveaways.verify.winnerRow", { rank: w.rank, pseudonym: w.pseudonym })}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {g.status === "open" ? (
          <ActionButton
            action="close"
            onAction={onAction}
            onError={onError}
            testId="giveaway-close"
            label={t("giveaways.studio.close")}
            variant="outline"
          />
        ) : null}
        {g.status === "open" || g.status === "closed" ? (
          <>
            <ActionButton
              action="draw"
              onAction={onAction}
              onError={onError}
              testId="giveaway-draw"
              label={t("giveaways.studio.draw")}
            />
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" data-testid="giveaway-cancel">
                  {t("giveaways.studio.cancel")}
                </Button>
              }
              title={t("giveaways.studio.cancelTitle")}
              description={t("giveaways.studio.cancelBody")}
              confirmLabel={t("giveaways.studio.cancelConfirm")}
              contentProps={{ "data-testid": "giveaway-cancel-confirm" }}
              variant="destructive"
              onConfirm={() => onAction("cancel")}
              onError={onError}
            />
          </>
        ) : null}
        <Link
          to="/$channel/giveaways/$giveawayId"
          params={{ channel, giveawayId: g.id }}
          className="self-center text-xs underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("giveaways.card.verify")}
        </Link>
      </div>
    </div>
  );
}

type OpenGiveaway = (draft: GiveawayDraft) => Promise<GiveawayFieldErrors | null>;

export function GiveawayForm({ onOpen }: { onOpen: OpenGiveaway }): React.JSX.Element {
  const [draft, setDraft] = React.useState<GiveawayDraft>(emptyGiveawayDraft);
  const [errors, setErrors] = React.useState<GiveawayFieldErrors>({});
  const [pending, setPending] = React.useState(false);
  const field = (name: keyof GiveawayDraft) => ({
    value: draft[name],
    onChange: (v: string) => setDraft((d) => ({ ...d, [name]: v })),
    error: errors[name] ? t(errors[name]) : undefined,
  });

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    try {
      const result = await onOpen(draft);
      if (result) setErrors(result);
      else {
        setErrors({});
        setDraft(emptyGiveawayDraft());
      }
    } catch (err) {
      if (errorCode(err) === "CONFLICT") toast.error(t("giveaways.studio.error.busy"));
      else toastActionError(err, t("giveaways.studio.openFailed"));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      data-testid="giveaway-form"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-4"
      aria-label={t("giveaways.form.label")}
    >
      <TextField
        label={t("giveaways.form.title")}
        data-testid="giveaway-title"
        description={t("giveaways.form.titleHint", { max: GIVEAWAY_LIMITS.titleMax })}
        {...field("title")}
      />
      <TextField
        label={t("giveaways.form.prize")}
        data-testid="giveaway-prize"
        multiline
        description={t("giveaways.form.prizeHint", { max: GIVEAWAY_LIMITS.prizeMax })}
        {...field("prize")}
      />
      <TextField
        label={t("giveaways.form.winnerCount")}
        data-testid="giveaway-winner-count"
        numeric
        description={t("giveaways.form.winnerCountHint", { max: GIVEAWAY_LIMITS.maxWinners })}
        {...field("winnerCount")}
      />
      <TextField
        label={t("giveaways.form.keyword")}
        data-testid="giveaway-keyword"
        description={t("giveaways.form.keywordHint")}
        {...field("keyword")}
      />
      <TextField
        label={t("giveaways.form.duration")}
        data-testid="giveaway-duration"
        numeric
        description={t("giveaways.form.durationHint", { max: GIVEAWAY_LIMITS.maxDurationMinutes })}
        {...field("duration")}
      />
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 text-xs font-medium">{t("giveaways.form.eligibility")}</legend>
        <p className="text-sm text-muted-foreground">{t("giveaways.form.eligibilityHint")}</p>
        <TextField
          label={t("giveaways.form.minAccountAge")}
          data-testid="giveaway-min-account-age"
          numeric
          {...field("minAccountAgeDays")}
        />
        <TextField
          label={t("giveaways.form.minFollowDays")}
          data-testid="giveaway-min-follow-days"
          numeric
          description={t("giveaways.form.minFollowDaysHint")}
          {...field("minFollowDays")}
        />
        <TextField
          label={t("giveaways.form.minWatch")}
          data-testid="giveaway-min-watch"
          numeric
          description={t("giveaways.form.minWatchHint")}
          {...field("minWatchSeconds")}
        />
      </fieldset>
      <p className="text-sm text-muted-foreground">{t("giveaways.form.prizeNote")}</p>
      <Button type="submit" data-testid="giveaway-open" disabled={pending} className="self-start">
        {t("giveaways.form.open")}
      </Button>
    </form>
  );
}
