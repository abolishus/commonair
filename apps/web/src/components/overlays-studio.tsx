// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { SkeletonGroup, SkeletonText, formatMoney, useLocale } from "@commonair/ui";
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { AlertPreview } from "@commonair/ui/blocks/media";
import {
  AlertConfigCard,
  OverlayTokenPanel,
  fillAlertTemplate,
  type AlertConfigDraft,
  type AlertConfigLabels,
  type OverlayTokenLabels,
  type OverlayTokenStatusView,
} from "@commonair/ui/blocks/studio";
import { Button } from "@commonair/ui/components/button";
import { SplitLayout } from "@commonair/ui/layouts";
import { toast } from "@commonair/ui/toast";
import * as React from "react";
import { t } from "../i18n/index.ts";
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
import { useLoad } from "./money/use-load.ts";

function alertLabels(): AlertConfigLabels {
  return {
    enabled: t("overlays.alert.enabled"),
    on: t("overlays.alert.on"),
    off: t("overlays.alert.off"),
    message: t("overlays.alert.message"),
    variables: t("overlays.alert.variables"),
    messageError: t("overlays.alert.messageError"),
    showMessage: t("overlays.alert.showMessage"),
    minAmount: t("overlays.alert.minAmount"),
    minAmountHint: t("overlays.alert.minAmountHint"),
    minAmountError: t("overlays.alert.minAmountError"),
    durationSeconds: t("overlays.alert.duration"),
    durationError: t("overlays.alert.durationError"),
    animation: t("overlays.alert.animation"),
    animations: [
      { value: "fade", label: t("overlays.alert.animation.fade") },
      { value: "slide", label: t("overlays.alert.animation.slide") },
      { value: "none", label: t("overlays.alert.animation.none") },
    ],
    save: t("overlays.alert.save"),
    test: t("overlays.alert.test"),
  };
}

function tokenLabels(): OverlayTokenLabels {
  return {
    title: t("overlays.token.title"),
    description: t("overlays.token.intro"),
    active: t("overlays.token.active"),
    inactive: t("overlays.token.inactive"),
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
    create: t("overlays.token.create"),
    rotate: t("overlays.token.rotate"),
    rotateTitle: t("overlays.token.rotateTitle"),
    rotateDescription: t("overlays.token.rotateBody"),
    url: t("overlays.token.url"),
    urlHint: t("overlays.token.urlHint"),
    showUrl: t("overlays.token.show"),
    hideUrl: t("overlays.token.hide"),
    copy: t("overlays.token.copy"),
    copied: t("overlays.token.copied"),
    copyFailed: t("overlays.token.copyFailed"),
    revoke: t("overlays.token.revoke"),
    revokeTitle: t("overlays.token.revokeTitle"),
    revokeDescription: t("overlays.token.revokeBody"),
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

/** Alert configuration, one card per type (`interact.alerts.*`). */
function AlertConfigs({ channel, currency }: { channel: string; currency: string }): React.JSX.Element {
  const { locale } = useLocale();
  const loaded = useLoad(`alerts:${channel}`, () => api().interact.alerts.list({ channel }));
  // Saved answers replace the loaded config of their type until the next load.
  const [saved, setSaved] = React.useState<Partial<Record<AlertType, AlertConfigDto>>>({});
  const labels = alertLabels();
  const sample = {
    user: t("overlays.preview.user"),
    amount: formatMoney(500, currency, locale),
    tier: t("overlays.preview.tier"),
    viewers: t("overlays.preview.viewers"),
    message: t("overlays.preview.message"),
  };

  if (loaded.data === null && loaded.failed)
    return <LoadError testId="alerts-load-error" message={t("overlays.alertsLoadFailed")} onRetry={loaded.reload} />;
  if (loaded.data === null)
    return (
      <SkeletonGroup label={t("overlays.loading")}>
        <SkeletonText lines={8} />
      </SkeletonGroup>
    );

  const configs = orderedAlertConfigs(loaded.data).map((config) => saved[config.type] ?? config);
  const save = async (type: AlertType, draft: AlertConfigDraft): Promise<void> => {
    const result = await api().interact.alerts.set(alertSetInput(channel, type, draft));
    setSaved((current) => ({ ...current, [type]: result }));
    toast.success(t("overlays.alert.saved"));
  };
  const test = async (type: AlertType): Promise<void> => {
    await api().interact.alerts.test({ channel, type });
    toast.success(t("overlays.alert.testSent"));
  };

  return (
    <div className="flex flex-col gap-4">
      {configs.map((config) => (
        <AlertConfigCard
          key={config.type}
          type={config.type}
          title={alertTitle(config.type)}
          description={alertDescription(config.type)}
          config={alertDraft(config)}
          variables={ALERT_VARIABLES[config.type]}
          currency={currency}
          locale={locale}
          labels={labels}
          note={config.type === "raid" ? t("overlays.alert.raidNote") : undefined}
          onSave={(draft) => save(config.type, draft)}
          onTest={() => test(config.type)}
          onError={(err) => toastActionError(err, t("overlays.alert.failed"))}
          preview={(draft) => (
            <AlertPreview
              name={sample.user}
              eventLabel={fillAlertTemplate(draft.message, sample)}
              message={draft.showMessage && ALERT_VARIABLES[config.type].includes("message") ? sample.message : ""}
              stageLabel={t("overlays.preview.label")}
            />
          )}
        />
      ))}
    </div>
  );
}

/**
 * The overlay URL (`interact.overlays.{token,status,revoke}`). The URL from the create response
 * lives only in this component's state: never in storage, a query cache or the address bar, and
 * it is dropped on revoke and on leaving the page.
 */
function OverlayToken({ channel }: { channel: string }): React.JSX.Element {
  const loaded = useLoad(`overlay-token:${channel}`, () => api().interact.overlays.status({ channel }));
  const [local, setLocal] = React.useState<OverlayTokenStatusView | null>(null);
  const [createdUrl, setCreatedUrl] = React.useState<string | null>(null);
  const status = local ?? loaded.data;

  if (status === null && loaded.failed)
    return (
      <LoadError testId="overlay-token-load-error" message={t("overlays.tokenLoadFailed")} onRetry={loaded.reload} />
    );

  const create = async (expiresAt: string | null): Promise<void> => {
    const created = await api().interact.overlays.token(overlayTokenInput(channel, expiresAt));
    // Only the alerts URL is kept (it is what OBS needs); the bare token is not held anywhere.
    setCreatedUrl(created.alertsUrl);
    setLocal({ active: true, createdAt: new Date().toISOString(), expiresAt: created.expiresAt });
    toast.success(t("overlays.token.createdToast"));
  };
  const revoke = async (): Promise<void> => {
    await api().interact.overlays.revoke({ channel });
    setCreatedUrl(null);
    setLocal({ active: false, createdAt: null, expiresAt: null });
    toast.success(t("overlays.token.revoked"));
  };

  return (
    <OverlayTokenPanel
      status={status}
      createdUrl={createdUrl}
      labels={tokenLabels()}
      onCreate={create}
      onRevoke={revoke}
      onError={(err) => toastActionError(err, t("overlays.token.failed"))}
    />
  );
}

/** `/overlays`: alert cards beside the overlay URL panel. */
export function OverlaysStudio({ channel, currency }: { channel: string; currency: string }): React.JSX.Element {
  return (
    <SplitLayout
      asideWidth="lg"
      main={<AlertConfigs channel={channel} currency={currency} />}
      aside={<OverlayToken channel={channel} />}
    />
  );
}
