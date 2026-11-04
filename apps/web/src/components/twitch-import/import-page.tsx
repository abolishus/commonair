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
  CHANNEL_FIELDS,
  canStart,
  currentFields,
  defaultChoices,
  FIELD_KEYS,
  fieldOn,
  isOffered,
  isRunning,
  KIND_KEYS,
  OUTCOME_KEYS,
  POLL_MS,
  previewFields,
  reasonKey,
  RESULT_KEYS,
  startChoices,
  tierKey,
  toggleEmote,
  toggleField,
  type CallbackOutcome,
  type ChannelField,
  type CurrentFields,
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
  onToggleField: (field: ChannelField) => void;
  onToggleEmote: (code: string) => void;
  /** The channel's current values, shown beside the imported ones; null while unknown. */
  current?: CurrentFields | null;
  onAssert: (on: boolean) => void;
  onStart: () => void;
  /** The paste-in helper, mounted when the import is available. */
  panels?: React.ReactNode;
}

export function TwitchImportView(props: TwitchImportViewProps): React.JSX.Element {
  const { status } = props;
  return (
    <div data-testid="import-page" className="flex min-w-0 flex-col gap-6">
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

/** One channel field: its checkbox, the value the channel has now and the one the import brings. */
function FieldChoice(props: {
  field: ChannelField;
  id: string;
  enabled: boolean;
  on: boolean;
  current: string | null;
  imported: string;
  multiline?: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { field } = props;
  return (
    <li
      data-testid="twitch-import-field"
      data-field={field}
      data-state={props.enabled && props.on ? "on" : "off"}
      className="flex min-w-0 items-start gap-3"
    >
      <Checkbox
        id={props.id}
        checked={props.enabled && props.on}
        disabled={!props.enabled}
        onCheckedChange={props.onToggle}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={props.id} className="font-normal">
          {t(FIELD_KEYS[field])}
        </Label>
        <span className="min-w-0 break-words text-xs text-muted-foreground" data-value="current">
          {t("twitchImport.fields.current", { value: props.current ?? t("twitchImport.fields.currentUnknown") })}
        </span>
        <span
          className={`min-w-0 break-words text-sm${props.multiline ? " whitespace-pre-line" : ""}`}
          data-value="imported"
        >
          {t("twitchImport.fields.imported", { value: props.imported })}
        </span>
      </div>
    </li>
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
            <p className="text-xs text-muted-foreground">{t("twitchImport.fields.hint")}</p>
            <ul className="flex min-w-0 flex-col gap-3" aria-label={t("twitchImport.fields.label")}>
              {CHANNEL_FIELDS.map((field) => (
                <FieldChoice
                  key={field}
                  field={field}
                  id={`${channelId}-${field}`}
                  enabled={props.choices.channel}
                  on={fieldOn(props.choices, field)}
                  current={currentValue(props.current, field, none)}
                  imported={importedValue(fields, field, none)}
                  multiline={field === "description"}
                  onToggle={() => props.onToggleField(field)}
                />
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("twitchImport.preview.categoryHint")}</p>
            <p className="text-xs text-muted-foreground">{t("twitchImport.fields.matureKept")}</p>
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
          <EmptyState
            data-testid="import-emotes-none"
            icon={FileImportIcon}
            headingLevel={4}
            title={t("twitchImport.emotes.none")}
          />
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

const yesNo = (on: boolean) => t(on ? "twitchImport.fields.yes" : "twitchImport.fields.no");

function importedValue(f: ReturnType<typeof previewFields>, field: ChannelField, none: string): string {
  switch (field) {
    case "title":
      return f.title || none;
    case "category":
      return f.category ?? none;
    case "tags":
      return f.tags.length ? f.tags.join(", ") : none;
    case "language":
      return f.language || none;
    case "description":
      return f.description || none;
    case "mature":
      return yesNo(f.matureSuggested);
  }
}

function currentValue(c: CurrentFields | null | undefined, field: ChannelField, none: string): string | null {
  if (!c) return null;
  switch (field) {
    case "title":
      return c.title || none;
    case "category":
      return c.category ?? none;
    case "tags":
      return c.tags.length ? c.tags.join(", ") : none;
    case "language":
      return c.language || none;
    case "description":
      return c.description || none;
    case "mature":
      return yesNo(c.mature);
  }
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
    choices: ReturnType<typeof startChoices>;
    assertEmoteRights: boolean;
  }) => Promise<TwitchImportDto>;
  /** The channel's current fields, for the comparison in the preview. */
  current?: (input: { channel: string }) => Promise<CurrentFields>;
}

export const twitchImportClient = (): TwitchImportClient => ({
  status: (input) => api().twitchImport.status(input) as Promise<TwitchImportStatusDto>,
  connect: (input) => api().twitchImport.connect(input),
  start: (input) => api().twitchImport.start(input) as Promise<TwitchImportDto>,
  current: async (input) => currentFields(await api().channels.get({ channel: input.channel })),
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
  const [current, setCurrent] = React.useState<CurrentFields | null>(null);
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

  // The channel as it is now, beside each imported value; without it the preview says so.
  const hasPreview = status?.latest?.status === "previewed";
  React.useEffect(() => {
    const read = client.current;
    if (!hasPreview || !read) return;
    let live = true;
    read({ channel })
      .then((c) => {
        if (live) setCurrent(c);
      })
      .catch(() => {
        if (live) setCurrent(null);
      });
    return () => {
      live = false;
    };
  }, [hasPreview, client, channel]);

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
        choices: startChoices(choices),
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
      onToggleField={(field) => setChoices((c) => toggleField(c, field))}
      current={current}
      onToggleEmote={(code) => setChoices((c) => toggleEmote(c, code))}
      onAssert={setAsserted}
      onStart={() => void onStart()}
      panels={<PanelsPaste channel={channel} {...(panelsClient ? { client: panelsClient } : {})} />}
    />
  );
}
