// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SkeletonGroup, SkeletonText, StatusBadge, formatMoney, formatNumber, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { AmountField, SelectField, SwitchField } from "@commonair/ui/blocks/forms";
import { AlertPreview } from "@commonair/ui/blocks/media";
import {
  ALERT_DURATION_MAX_MS,
  ALERT_DURATION_MIN_MS,
  ALERT_MESSAGE_MAX,
  OverlayTokenPanel,
  fillAlertTemplate,
  type AlertConfigDraft,
  type OverlayLinkUrls,
  type OverlayTokenLabels,
  type OverlayTokenStatusView,
} from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@commonair/ui/components/field";
import { Input } from "@commonair/ui/components/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@commonair/ui/components/tabs";
import { SplitLayout } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t, type MessageKey } from "../i18n/index.ts";
import { toastActionError } from "../lib/action-error.ts";
import { api } from "../lib/api.ts";
import { fillNode } from "../lib/fill.tsx";
import {
  ALERT_VARIABLES,
  alertDescription,
  alertDraft,
  alertSetInput,
  alertTitle,
  orderedAlertConfigs,
  overlayTokenInput,
  type AlertConfigDto,
  type AlertType,
} from "../lib/overlays.ts";
import {
  alertDraftProblems,
  dirtyAlertTypes,
  sameAlertDraft,
  type AlertDraftProblems,
} from "./content-library/alert-drafts.ts";
import { useLoad } from "./money/use-load.ts";

function tokenLabels(locale: string): OverlayTokenLabels {
  return {
    title: t("d5Content.links.title"),
    description: t("d5Content.links.intro"),
    active: t("overlays.token.active"),
    inactive: t("d5Content.links.inactive"),
    created: (time) => fillNode(t("overlays.token.created"), "time", time),
    expires: (time) => fillNode(t("overlays.token.expires"), "time", time),
    noExpiry: t("overlays.token.noExpiry"),
    expiry: t("overlays.token.expiry"),
    expiryOptions: {
      none: t("overlays.token.expiry.none"),
      "1d": t("overlays.token.expiry.1d"),
      "7d": t("overlays.token.expiry.7d"),
      "30d": t("overlays.token.expiry.30d"),
      "90d": t("overlays.token.expiry.90d"),
      "6mo": t("overlays.token.expiry.6mo"),
      date: t("overlays.token.expiry.date"),
    },
    expiryDate: t("overlays.token.expiryDate"),
    expiryDateInvalid: t("overlays.token.expiryDateInvalid"),
    expiryDatePast: t("overlays.token.expiryDatePast"),
    create: t("d5Content.links.create"),
    rotate: t("d5Content.links.rotate"),
    rotateTitle: t("d5Content.links.rotateTitle"),
    rotateDescription: t("d5Content.links.rotateBody"),
    links: {
      alerts: { name: t("d5Content.links.alerts.name"), hint: t("d5Content.links.alerts.hint") },
      chat: { name: t("d5Content.links.chat.name"), hint: t("d5Content.links.chat.hint") },
      goals: { name: t("d5Content.links.goals.name"), hint: t("d5Content.links.goals.hint") },
    },
    size: (width, height) =>
      t("d5Content.links.size", { width: formatNumber(width, locale), height: formatNumber(height, locale) }),
    urlHint: t("d5Content.links.urlHint"),
    linksHidden: t("d5Content.links.hidden"),
    obsTitle: t("d5Content.links.obsTitle"),
    obsSteps: [
      t("d5Content.links.obs.1"),
      t("d5Content.links.obs.2"),
      t("d5Content.links.obs.3"),
      t("d5Content.links.obs.4"),
    ],
    showUrl: t("d5Content.links.show"),
    hideUrl: t("d5Content.links.hide"),
    copy: t("overlays.token.copy"),
    copied: t("d5Content.links.copied"),
    copyFailed: t("d5Content.links.copyFailed"),
    revoke: t("overlays.token.revoke"),
    revokeTitle: t("d5Content.links.revokeTitle"),
    revokeDescription: t("d5Content.links.revokeBody"),
  };
}

function LoadError({ testId, message, onRetry }: { testId: string; message: string; onRetry: () => void }) {
  return (
    <AlertCallout
      data-testid={testId}
      tone="danger"
      live
      description={message}
      action={
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      }
    />
  );
}

const ANIMATIONS = ["fade", "slide", "none"] as const;
const ANIMATION_KEYS: Record<(typeof ANIMATIONS)[number], MessageKey> = {
  fade: "overlays.alert.animation.fade",
  slide: "overlays.alert.animation.slide",
  none: "overlays.alert.animation.none",
};
const TAB_KEYS: Record<AlertType, MessageKey> = {
  tip: "d5Content.alerts.tab.tip",
  follow: "d5Content.alerts.tab.follow",
  subscription: "d5Content.alerts.tab.subscription",
  raid: "d5Content.alerts.tab.raid",
};
const isAnimation = (value: string): value is AlertConfigDraft["animation"] =>
  (ANIMATIONS as readonly string[]).includes(value);

/** One alert type's fields; the page's save bar saves them (one `alert-config` per type). */
function AlertForm({
  type,
  saved,
  draft,
  durationText,
  problems,
  currency,
  locale,
  onChange,
  onDurationText,
  onAmountValidity,
  onTest,
}: {
  type: AlertType;
  saved: AlertConfigDraft;
  draft: AlertConfigDraft;
  durationText: string;
  problems: AlertDraftProblems;
  currency: string;
  locale: string;
  onChange: (patch: Partial<AlertConfigDraft>) => void;
  onDurationText: (text: string) => void;
  onAmountValidity: (valid: boolean) => void;
  onTest: () => Promise<void>;
}): React.JSX.Element {
  const id = React.useId();
  const [testing, setTesting] = React.useState(false);
  const variables = ALERT_VARIABLES[type];
  const sample = {
    user: t("overlays.preview.user"),
    amount: formatMoney(500, currency, locale),
    tier: t("overlays.preview.tier"),
    viewers: t("overlays.preview.viewers"),
    message: t("overlays.preview.message"),
  };
  const test = async (): Promise<void> => {
    setTesting(true);
    try {
      await onTest();
    } catch (caught) {
      toastActionError(caught, t("overlays.alert.failed"));
    } finally {
      setTesting(false);
    }
  };
  const durationSeconds = Number(durationText);
  return (
    <section
      data-testid="alert-config"
      data-type={type}
      data-enabled={String(saved.enabled)}
      data-dirty={!sameAlertDraft(saved, draft) || undefined}
      aria-labelledby={`${id}-title`}
      className="flex min-w-0 flex-col gap-4 border bg-card p-4"
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={`${id}-title`} className="text-base font-medium">
            {alertTitle(type)}
          </h2>
          <p className="text-sm text-muted-foreground">{alertDescription(type)}</p>
        </div>
        <StatusBadge tone={saved.enabled ? "success" : "neutral"}>
          {saved.enabled ? t("overlays.alert.on") : t("overlays.alert.off")}
        </StatusBadge>
      </header>
      <AlertPreview
        name={sample.user}
        eventLabel={fillAlertTemplate(draft.message, sample)}
        message={draft.showMessage && variables.includes("message") ? sample.message : ""}
        stageLabel={t("overlays.preview.label")}
      />
      <FieldGroup>
        <SwitchField
          label={t("overlays.alert.enabled")}
          checked={draft.enabled}
          onCheckedChange={(enabled) => onChange({ enabled })}
          switchProps={{ "data-testid": "alert-enabled" }}
        />
        <Field data-invalid={problems.message || undefined}>
          <FieldLabel htmlFor={`${id}-message`}>{t("overlays.alert.message")}</FieldLabel>
          <Input
            id={`${id}-message`}
            data-testid="alert-message"
            maxLength={ALERT_MESSAGE_MAX}
            value={draft.message}
            aria-invalid={problems.message || undefined}
            aria-describedby={`${id}-variables`}
            onChange={(event) => onChange({ message: event.currentTarget.value })}
          />
          <div id={`${id}-variables`} className="flex flex-wrap items-center gap-1">
            <FieldDescription>{t("overlays.alert.variables")}</FieldDescription>
            {variables.map((variable) => (
              <Button
                key={variable}
                type="button"
                variant="outline"
                size="xs"
                className="font-mono"
                data-variable={variable}
                onClick={() => onChange({ message: `${draft.message}\${${variable}}`.slice(0, ALERT_MESSAGE_MAX) })}
              >
                {`\${${variable}}`}
              </Button>
            ))}
          </div>
          {problems.message ? <FieldError>{t("overlays.alert.messageError")}</FieldError> : null}
        </Field>
        {variables.includes("message") ? (
          <SwitchField
            label={t("overlays.alert.showMessage")}
            checked={draft.showMessage}
            onCheckedChange={(showMessage) => onChange({ showMessage })}
          />
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          {type === "tip" ? (
            <AmountField
              data-testid="alert-min-amount"
              label={t("overlays.alert.minAmount")}
              currency={currency}
              locale={locale}
              value={draft.minAmountCents}
              min={0}
              onValueChange={(minAmountCents) => onChange({ minAmountCents })}
              onValidityChange={onAmountValidity}
              rangeError={t("overlays.alert.minAmountError")}
              hint={t("overlays.alert.minAmountHint")}
            />
          ) : null}
          <Field data-invalid={problems.duration || undefined}>
            <FieldLabel htmlFor={`${id}-duration`}>{t("overlays.alert.duration")}</FieldLabel>
            <Input
              id={`${id}-duration`}
              data-testid="alert-duration"
              data-ms={problems.duration ? "" : Math.round(durationSeconds * 1000)}
              type="number"
              inputMode="decimal"
              min={ALERT_DURATION_MIN_MS / 1000}
              max={ALERT_DURATION_MAX_MS / 1000}
              step={0.5}
              value={durationText}
              aria-invalid={problems.duration || undefined}
              onChange={(event) => onDurationText(event.currentTarget.value)}
            />
            {problems.duration ? <FieldError>{t("overlays.alert.durationError")}</FieldError> : null}
          </Field>
          <SelectField
            label={t("overlays.alert.animation")}
            options={ANIMATIONS.map((value) => ({
              value,
              label: t(ANIMATION_KEYS[value]),
              "data-testid": `alert-animation-option-${value}`,
            }))}
            value={draft.animation}
            onValueChange={(value) => {
              if (isAnimation(value)) onChange({ animation: value });
            }}
            data-testid="alert-animation"
            data-value={draft.animation}
          />
        </div>
      </FieldGroup>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          data-testid="alert-test"
          disabled={testing}
          aria-busy={testing || undefined}
          onClick={() => void test()}
        >
          {t("overlays.alert.test")}
        </Button>
      </div>
    </section>
  );
}

interface AlertState {
  saved: AlertConfigDraft;
  draft: AlertConfigDraft;
  durationText: string;
  amountValid: boolean;
}

const stateOf = (config: AlertConfigDto): AlertState => {
  const d = alertDraft(config);
  return { saved: d, draft: d, durationText: String(d.durationMs / 1000), amountValid: true };
};

/**
 * Alert configuration (`interact.alerts.*`): one tab per type, one sticky save bar for every
 * change (`alert-save`, `alert-discard`, `alert-save-bar` with `data-dirty` = the count).
 */
function AlertConfigs({ channel, currency }: { channel: string; currency: string }): React.JSX.Element {
  const { locale } = useLocale();
  const loaded = useLoad(`alerts:${channel}`, () => api().interact.alerts.list({ channel }));
  const [states, setStates] = React.useState<Partial<Record<AlertType, AlertState>> | null>(null);
  const [loadedFrom, setLoadedFrom] = React.useState<unknown>(null);
  const [saving, setSaving] = React.useState(false);
  // A fresh load replaces every draft (adjusting state during render).
  if (loaded.data !== null && loaded.data !== loadedFrom) {
    setLoadedFrom(loaded.data);
    setStates(Object.fromEntries(orderedAlertConfigs(loaded.data).map((c) => [c.type, stateOf(c)])));
  }

  if (loaded.data === null && loaded.failed)
    return <LoadError testId="alerts-load-error" message={t("overlays.alertsLoadFailed")} onRetry={loaded.reload} />;
  if (loaded.data === null || states === null)
    return (
      <SkeletonGroup label={t("overlays.loading")}>
        <SkeletonText lines={8} />
      </SkeletonGroup>
    );

  const types = orderedAlertConfigs(loaded.data).map((c) => c.type);
  const entries = types.flatMap((type) => {
    const s = states[type];
    return s ? [{ type, ...s }] : [];
  });
  const dirty = dirtyAlertTypes(entries);
  const problemsOf = (s: AlertState, type: AlertType) =>
    alertDraftProblems(s.draft, s.durationText, type === "tip" && !s.amountValid);
  const invalid = dirty.some((type) => {
    const s = states[type];
    return s ? problemsOf(s, type).any : false;
  });
  const update = (type: AlertType, patch: (s: AlertState) => Partial<AlertState>) =>
    setStates((current) => {
      const s = current?.[type];
      return s ? { ...current, [type]: { ...s, ...patch(s) } } : current;
    });

  const saveAll = async (): Promise<void> => {
    if (saving || invalid || dirty.length === 0) return;
    setSaving(true);
    const results = await Promise.allSettled(
      dirty.map(async (type) => {
        const s = states[type];
        if (!s) return;
        const result = await api().interact.alerts.set(
          alertSetInput(channel, type, { ...s.draft, message: s.draft.message.trim() }),
        );
        update(type, () => stateOf(result));
      }),
    );
    setSaving(false);
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length === 0) toast.success(t("d5Content.alerts.saved", { count: dirty.length }));
    else toastActionError(failed[0]?.reason, t("d5Content.alerts.saveFailed"));
  };
  const discard = () =>
    setStates((current) =>
      current
        ? Object.fromEntries(
            Object.entries(current).map(([type, s]) => [
              type,
              { ...s, draft: s.saved, durationText: String(s.saved.durationMs / 1000), amountValid: true },
            ]),
          )
        : current,
    );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Tabs defaultValue={types[0]}>
        <TabsList aria-label={t("d5Content.alerts.tabs")} className="max-w-full overflow-x-auto">
          {types.map((type) => (
            <TabsTrigger key={type} value={type} data-testid={`alert-tab-${type}`}>
              {t(TAB_KEYS[type])}
              {dirty.includes(type) ? (
                <>
                  <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                  <span className="sr-only">{t("d5Content.alerts.tabUnsaved")}</span>
                </>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {entries.map((s) => (
          <TabsContent key={s.type} value={s.type} keepMounted className="min-w-0">
            <AlertForm
              type={s.type}
              saved={s.saved}
              draft={s.draft}
              durationText={s.durationText}
              problems={problemsOf(s, s.type)}
              currency={currency}
              locale={locale}
              onChange={(patch) => update(s.type, (c) => ({ draft: { ...c.draft, ...patch } }))}
              onDurationText={(text) =>
                update(s.type, (c) => {
                  const seconds = Number(text);
                  const durationMs =
                    text.trim() !== "" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : c.draft.durationMs;
                  return { durationText: text, draft: { ...c.draft, durationMs } };
                })
              }
              onAmountValidity={(amountValid) => update(s.type, () => ({ amountValid }))}
              onTest={async () => {
                await api().interact.alerts.test({ channel, type: s.type });
                toast.success(t("overlays.alert.testSent"));
              }}
            />
          </TabsContent>
        ))}
      </Tabs>
      <div
        data-testid="alert-save-bar"
        data-dirty={dirty.length}
        className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-2 border-t bg-background py-3"
      >
        <p aria-live="polite" className="me-auto text-sm text-muted-foreground">
          {dirty.length === 0
            ? t("d5Content.alerts.allSaved")
            : invalid
              ? t("d5Content.alerts.invalid")
              : t("d5Content.alerts.unsaved", { count: dirty.length })}
        </p>
        <Button
          type="button"
          variant="ghost"
          data-testid="alert-discard"
          disabled={dirty.length === 0 || saving}
          onClick={discard}
        >
          {t("d5Content.alerts.discard")}
        </Button>
        <Button
          type="button"
          data-testid="alert-save"
          disabled={dirty.length === 0 || invalid || saving}
          aria-busy={saving || undefined}
          onClick={() => void saveAll()}
        >
          {t("d5Content.alerts.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * The overlay links (`interact.overlays.{token,status,revoke}`). The URLs from the create
 * response live only in this component's state: never in storage, a query cache or the address
 * bar, and they are dropped on revoke and on leaving the page.
 */
function OverlayToken({ channel }: { channel: string }): React.JSX.Element {
  const { locale } = useLocale();
  const loaded = useLoad(`overlay-token:${channel}`, () => api().interact.overlays.status({ channel }));
  const [local, setLocal] = React.useState<OverlayTokenStatusView | null>(null);
  const [createdUrls, setCreatedUrls] = React.useState<OverlayLinkUrls | null>(null);
  const status = local ?? loaded.data;

  if (status === null && loaded.failed)
    return (
      <LoadError testId="overlay-token-load-error" message={t("overlays.tokenLoadFailed")} onRetry={loaded.reload} />
    );

  const create = async (expiresAt: string | null): Promise<void> => {
    const created = await api().interact.overlays.token(overlayTokenInput(channel, expiresAt));
    // The three URLs only; the bare token is not held anywhere.
    setCreatedUrls({ alerts: created.alertsUrl, chat: created.chatUrl, goals: created.goalsUrl });
    setLocal({ active: true, createdAt: new Date().toISOString(), expiresAt: created.expiresAt });
    toast.success(t("d5Content.links.createdToast"));
  };
  const revoke = async (): Promise<void> => {
    await api().interact.overlays.revoke({ channel });
    setCreatedUrls(null);
    setLocal({ active: false, createdAt: null, expiresAt: null });
    toast.success(t("d5Content.links.revoked"));
  };

  return (
    <OverlayTokenPanel
      status={status}
      createdUrls={createdUrls}
      labels={tokenLabels(locale)}
      onCreate={create}
      onRevoke={revoke}
      onError={(err) => toastActionError(err, t("overlays.token.failed"))}
    />
  );
}

/** `/overlays`: the alerts, one save bar, beside the three overlay links. */
export function OverlaysStudio({ channel, currency }: { channel: string; currency: string }): React.JSX.Element {
  return (
    <SplitLayout
      asideWidth="lg"
      main={<AlertConfigs channel={channel} currency={currency} />}
      aside={<OverlayToken channel={channel} />}
    />
  );
}
