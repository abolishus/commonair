// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/import` (ADR 0031; docs/testing/b7-selectors.md "Twitch import"): connect a Twitch account, read
 * the preview (channel details, emotes with their tier or why they are skipped, the schedule as
 * "carried, not applied", the mature suggestion), choose, assert the right to the emote art, start,
 * follow the progress and read the result. The panel paste-in helper sits below. Without the
 * Twitch credentials or with `TWITCH_IMPORT_ENABLED` off the page explains that the import is
 * unavailable. Twitch is named in text only: no logo, no brand colours.
 *
 * `TwitchImportView` is drawn from props so tests render every state; `TwitchImportPage` runs it.
 */
import { EmptyState, RelativeTime, SkeletonGroup, SkeletonText, StatusBadge } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { Field, FieldLabel } from "@commonair/ui/components/field";
import { Label } from "@commonair/ui/components/label";
import { toast } from "@commonair/ui/toast";
import { EMOTE_ASSERTION_VERSION } from "@commonair/twitch";
import { FileImportIcon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { toastActionError } from "../../lib/action-error.ts";
import { api, errorCode } from "../../lib/api.ts";
import { FormError } from "../form-error.tsx";
import {
  canStart,
  defaultChoices,
  isOffered,
  isRunning,
  KIND_KEYS,
  OUTCOME_KEYS,
  POLL_MS,
  previewFields,
  reasonKey,
  RESULT_KEYS,
  tierKey,
  toggleEmote,
  type CallbackOutcome,
  type ImportItemDto,
  type TwitchChoices,
  type TwitchImportDto,
  type TwitchImportStatusDto,
} from "./lib.ts";
import { PanelsPaste, type PanelsClient } from "./panels-paste.tsx";

export interface TwitchImportViewProps {
  /** Null while loading. */
  status: TwitchImportStatusDto | null;
  loadFailed: boolean;
  /** The authorization's outcome from `/import?twitch=…`, once. */
  outcome: CallbackOutcome | null;
  choices: TwitchChoices;
  asserted: boolean;
  connecting: boolean;
  starting: boolean;
  onConnect: () => void;
  onToggleChannel: () => void;
  onToggleEmote: (code: string) => void;
  onAssert: (on: boolean) => void;
  onStart: () => void;
  /** The paste-in helper, mounted when the import is available. */
  panels?: React.ReactNode;
}

export function TwitchImportView(props: TwitchImportViewProps): React.JSX.Element {
  const { status } = props;
  return (
    <div data-testid="import-page" className="flex min-w-0 flex-col gap-6">
      <PageHeader title={t("twitchImport.pageTitle")} description={t("twitchImport.pageIntro")} />
      {props.loadFailed && <FormError>{t("twitchImport.loadFailed")}</FormError>}
      {status === null ? (
        !props.loadFailed && (
          <SkeletonGroup label={t("twitchImport.loading")}>
            <SkeletonText lines={4} />
          </SkeletonGroup>
        )
      ) : !status.available ? (
        <EmptyState
          data-testid="import-unavailable"
          icon={FileImportIcon}
          headingLevel={2}
          title={t("twitchImport.unavailable.title")}
          description={t("twitchImport.unavailable.body")}
        />
      ) : (
        <>
          {props.outcome && (
            <AlertCallout
              tone={props.outcome === "connected" ? "info" : "warning"}
              description={t(OUTCOME_KEYS[props.outcome])}
            />
          )}
          <ImportCard {...props} status={status} />
          {props.panels}
        </>
      )}
    </div>
  );
}

function ImportCard(props: TwitchImportViewProps & { status: TwitchImportStatusDto }): React.JSX.Element {
  const latest = props.status.latest;
  const preview = latest && latest.status === "previewed" ? latest : null;
  const fields = preview ? previewFields(preview) : null;
  const expired = fields?.state === "expired";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("twitchImport.connect.title")}</CardTitle>
        <CardDescription>{t("twitchImport.connect.intro")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {props.status.connected && props.status.twitchLogin && (
          <p className="min-w-0 break-words text-sm">
            {t("twitchImport.connect.connectedAs", { login: props.status.twitchLogin })}
          </p>
        )}
        {expired && <AlertCallout tone="warning" description={t("twitchImport.preview.expired")} />}
        {!(preview && !expired) && !(latest && isRunning(latest)) && (
          <div>
            <Button
              data-testid="import-connect"
              disabled={props.connecting}
              aria-busy={props.connecting || undefined}
              onClick={props.onConnect}
            >
              {latest ? t("twitchImport.connect.again") : t("twitchImport.connect.button")}
            </Button>
          </div>
        )}
        {preview && !expired && fields && <PreviewBody {...props} dto={preview} fields={fields} />}
        {latest && latest.status !== "previewed" && <ResultBody dto={latest} />}
      </CardContent>
    </Card>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

function PreviewBody(
  props: TwitchImportViewProps & { dto: TwitchImportDto; fields: ReturnType<typeof previewFields> },
): React.JSX.Element {
  const { dto, fields } = props;
  const channelId = React.useId();
  const assertId = React.useId();
  const emoteIdBase = React.useId();
  const emotes = dto.preview.items.filter((i) => i.kind === "emote");
  const none = t("twitchImport.preview.none");
  return (
    <div
      data-testid="import-preview"
      data-import-id={dto.id}
      data-expires-at={fields.expiresAt ?? ""}
      className="flex min-w-0 flex-col gap-5"
    >
      {fields.expiresAt && (
        <p className="text-sm text-muted-foreground">
          {t("twitchImport.preview.expiresIn")} <RelativeTime date={fields.expiresAt} />
        </p>
      )}

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${channelId}-h`}>
        <h3 id={`${channelId}-h`} className="text-sm font-medium">
          {t("twitchImport.preview.channelHeading")}
        </h3>
        <div
          data-testid="import-field"
          data-field="channel"
          data-state={props.choices.channel ? "on" : "off"}
          className="flex min-w-0 items-start gap-3"
        >
          <Checkbox id={channelId} checked={props.choices.channel} onCheckedChange={() => props.onToggleChannel()} />
          <div className="flex min-w-0 flex-col gap-2">
            <Label htmlFor={channelId} className="font-normal">
              {t("twitchImport.preview.channelChoice")}
            </Label>
            <dl className="grid min-w-0 gap-2">
              <FieldRow label={t("twitchImport.field.title")}>{fields.title || none}</FieldRow>
              <FieldRow label={t("twitchImport.field.category")}>{fields.category ?? none}</FieldRow>
              <FieldRow label={t("twitchImport.field.tags")}>
                {fields.tags.length ? fields.tags.join(", ") : none}
              </FieldRow>
              <FieldRow label={t("twitchImport.field.language")}>{fields.language || none}</FieldRow>
              <FieldRow label={t("twitchImport.field.description")}>
                <span className="whitespace-pre-line">{fields.description || none}</span>
              </FieldRow>
            </dl>
            <p className="text-xs text-muted-foreground">{t("twitchImport.preview.categoryHint")}</p>
          </div>
        </div>
        {fields.matureSuggested && (
          <AlertCallout data-testid="import-mature" tone="info" description={t("twitchImport.preview.mature")} />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-3" aria-labelledby={`${emoteIdBase}-h`}>
        <h3 id={`${emoteIdBase}-h`} className="text-sm font-medium">
          {t("twitchImport.emotes.heading")}
        </h3>
        {emotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("twitchImport.emotes.none")}</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2" aria-label={t("twitchImport.emotes.heading")}>
            {emotes.map((item) => (
              <EmoteRow
                key={item.ref}
                item={item}
                tier={fields.tiers.get(item.ref) ?? null}
                on={props.choices.emotes.includes(item.ref)}
                id={`${emoteIdBase}-${item.ref}`}
                onToggle={() => props.onToggleEmote(item.ref)}
              />
            ))}
          </ul>
        )}
      </section>

      {fields.schedule.length > 0 && (
        <section
          data-testid="import-schedule"
          data-count={fields.schedule.length}
          className="flex min-w-0 flex-col gap-2"
          aria-label={t("twitchImport.schedule.heading")}
        >
          <h3 className="text-sm font-medium">{t("twitchImport.schedule.heading")}</h3>
          <p className="text-sm text-muted-foreground">{t("twitchImport.schedule.carried")}</p>
          <ul className="flex min-w-0 flex-col gap-1">
            {fields.schedule.map((s) => (
              <li key={`${s.startsAt}-${s.title}`} className="flex min-w-0 flex-wrap gap-x-2 text-sm">
                <RelativeTime date={s.startsAt} live={false} />
                <span className="min-w-0 break-words">{s.title || none}</span>
                {s.category && <span className="text-muted-foreground">{s.category}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {props.choices.emotes.length > 0 && (
        <Field orientation="horizontal">
          <Checkbox
            id={assertId}
            data-testid="import-assertion"
            data-version={EMOTE_ASSERTION_VERSION}
            checked={props.asserted}
            onCheckedChange={(on: boolean) => props.onAssert(on)}
          />
          <FieldLabel htmlFor={assertId}>{t("twitchImport.assertion")}</FieldLabel>
        </Field>
      )}
      <div>
        <Button
          data-testid="import-start"
          disabled={props.starting || !canStart(props.choices, props.asserted)}
          aria-busy={props.starting || undefined}
          onClick={props.onStart}
        >
          {t("twitchImport.start")}
        </Button>
      </div>
    </div>
  );
}

function EmoteRow(props: {
  item: ImportItemDto;
  tier: number | null;
  on: boolean;
  id: string;
  onToggle: () => void;
}): React.JSX.Element {
  const { item, tier } = props;
  const offered = isOffered(item);
  const tierLabel = tier === null ? null : tierKey(tier);
  return (
    <li
      data-testid="import-emote"
      data-code={item.ref}
      data-tier={tier ?? ""}
      data-skip-reason={offered ? "" : (item.reason ?? "")}
      className="flex min-w-0 items-start gap-3"
    >
      <Checkbox id={props.id} checked={offered && props.on} disabled={!offered} onCheckedChange={props.onToggle} />
      <Label htmlFor={props.id} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
        <span className="min-w-0 break-all text-sm">{item.label}</span>
        {tierLabel && <span className="text-xs text-muted-foreground">{t(tierLabel.key, tierLabel.vars)}</span>}
        {!offered && item.reason && (
          <span className="text-xs text-muted-foreground">
            {t(reasonKey(item.reason) ?? "twitchImport.reason.other")}
          </span>
        )}
      </Label>
    </li>
  );
}

function ResultBody({ dto }: { dto: TwitchImportDto }): React.JSX.Element {
  const running = isRunning(dto);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p data-testid="import-progress" data-status={dto.status} className="text-sm" aria-live="polite">
        {running
          ? t("twitchImport.progress.running")
          : dto.status === "done"
            ? t("twitchImport.progress.done")
            : t("twitchImport.progress.failed")}
      </p>
      {!running && dto.result && (
        <ul className="flex min-w-0 flex-col gap-2" aria-label={t("twitchImport.result.label")}>
          {dto.result.map((item) => (
            <li
              key={`${item.kind}:${item.ref}`}
              data-testid="import-result-item"
              data-kind={item.kind}
              data-ref={item.ref}
              data-outcome={item.outcome ?? ""}
              data-reason={item.reason ?? ""}
              className="flex min-w-0 flex-wrap items-center gap-2"
            >
              <span className="min-w-0 break-words text-sm">
                <span className="text-muted-foreground">{t(KIND_KEYS[item.kind])}: </span>
                {item.kind === "schedule"
                  ? t("twitchImport.schedule.count", { count: Number(item.label) || 0 })
                  : item.label || t("twitchImport.preview.none")}
              </span>
              {item.outcome && (
                <StatusBadge
                  tone={item.outcome === "imported" ? "success" : item.outcome === "rejected" ? "danger" : "neutral"}
                >
                  {t(RESULT_KEYS[item.outcome])}
                </StatusBadge>
              )}
              {item.reason && item.outcome !== "imported" && (
                <span className="text-xs text-muted-foreground">
                  {t(reasonKey(item.reason) ?? "twitchImport.reason.other")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// The container -------------------------------------------------------------------------------

export interface TwitchImportClient {
  status: (input: { channel: string }) => Promise<TwitchImportStatusDto>;
  connect: (input: { channel: string }) => Promise<{ authorizeUrl: string }>;
  start: (input: {
    channel: string;
    id: string;
    choices: { channel: boolean; panels: boolean; emotes: string[] };
    assertEmoteRights: boolean;
  }) => Promise<TwitchImportDto>;
}

export const twitchImportClient = (): TwitchImportClient => ({
  status: (input) => api().twitchImport.status(input) as Promise<TwitchImportStatusDto>,
  connect: (input) => api().twitchImport.connect(input),
  start: (input) => api().twitchImport.start(input) as Promise<TwitchImportDto>,
});

export function TwitchImportPage({
  channel,
  outcome,
  client: given,
  panelsClient,
  navigate = (url) => window.location.assign(url),
}: {
  channel: string;
  outcome: CallbackOutcome | null;
  client?: TwitchImportClient;
  panelsClient?: PanelsClient;
  navigate?: (url: string) => void;
}): React.JSX.Element {
  const client = React.useMemo(() => given ?? twitchImportClient(), [given]);
  const [status, setStatus] = React.useState<TwitchImportStatusDto | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [choices, setChoices] = React.useState<TwitchChoices>({ channel: false, emotes: [] });
  const [asserted, setAsserted] = React.useState(false);
  const [connecting, setConnecting] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const previewId = React.useRef<string | null>(null);

  const apply = React.useCallback((s: TwitchImportStatusDto) => {
    setStatus(s);
    setLoadFailed(false);
    const p = s.latest?.status === "previewed" ? s.latest : null;
    // A new preview resets the choices to everything offered.
    if (p && p.id !== previewId.current) {
      previewId.current = p.id;
      setChoices(defaultChoices(p.preview.items));
      setAsserted(false);
    }
  }, []);

  const load = React.useCallback(
    () =>
      client
        .status({ channel })
        .then(apply)
        .catch(() => setLoadFailed(true)),
    [client, channel, apply],
  );
  React.useEffect(() => {
    void load();
  }, [load]);

  // Follow a running import until the worker is done.
  const running = status?.latest ? isRunning(status.latest) : false;
  React.useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(id);
  }, [running, load]);

  const onConnect = async () => {
    setConnecting(true);
    try {
      navigate((await client.connect({ channel })).authorizeUrl);
    } catch (err) {
      setConnecting(false);
      toastActionError(err, t("twitchImport.connect.failed"));
    }
  };

  const onStart = async () => {
    const p = status?.latest;
    if (!p || p.status !== "previewed") return;
    setStarting(true);
    try {
      const dto = await client.start({
        channel,
        id: p.id,
        choices: { channel: choices.channel, panels: false, emotes: choices.emotes },
        assertEmoteRights: asserted,
      });
      setStatus((s) => (s ? { ...s, connected: false, latest: dto } : s));
      toast.success(t("twitchImport.started"));
    } catch (err) {
      const code = errorCode(err);
      toastActionError(
        err,
        code === "PRECONDITION_FAILED"
          ? t("twitchImport.assertionNeeded")
          : code === "CONFLICT"
            ? t("twitchImport.startConflict")
            : t("twitchImport.startFailed"),
      );
      void load();
    } finally {
      setStarting(false);
    }
  };

  return (
    <TwitchImportView
      status={status}
      loadFailed={loadFailed}
      outcome={outcome}
      choices={choices}
      asserted={asserted}
      connecting={connecting}
      starting={starting}
      onConnect={() => void onConnect()}
      onToggleChannel={() => setChoices((c) => ({ ...c, channel: !c.channel }))}
      onToggleEmote={(code) => setChoices((c) => toggleEmote(c, code))}
      onAssert={setAsserted}
      onStart={() => void onStart()}
      panels={<PanelsPaste channel={channel} {...(panelsClient ? { client: panelsClient } : {})} />}
    />
  );
}
