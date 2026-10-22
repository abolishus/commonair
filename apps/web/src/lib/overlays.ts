// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/overlays` (studio) logic, pure for unit tests: the alert types in page order, an
 * `AlertConfig` as the card's draft and back as `interact.alerts.set` input, and the token
 * request. The overlay URL itself is never handled here: it lives only in the page's state.
 */
import { ALERT_TYPES } from "@commonair/contracts/enums";
import type { AlertConfigDraft, AlertVariable } from "@commonair/ui/blocks/studio";
import { t, type MessageKey } from "../i18n/index.ts";
import type { Api } from "./api.ts";

export type AlertConfigDto = Awaited<ReturnType<Api["interact"]["alerts"]["list"]>>[number];
export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertSetInput = Parameters<Api["interact"]["alerts"]["set"]>[0];
export type OverlayTokenInput = Parameters<Api["interact"]["overlays"]["token"]>[0];
export type OverlayTokenStatusDto = Awaited<ReturnType<Api["interact"]["overlays"]["status"]>>;

/** Page order: what streamers set up first. Every `ALERT_TYPES` entry appears once. */
export const ALERT_TYPE_ORDER: readonly AlertType[] = ["tip", "follow", "subscription", "raid"];

/** The variables `AlertTemplate.message` can use per type (the API fills them). */
export const ALERT_VARIABLES: Record<AlertType, readonly AlertVariable[]> = {
  tip: ["user", "amount", "message"],
  follow: ["user"],
  subscription: ["user", "tier", "message"],
  raid: ["user", "viewers"],
};

const TITLE_KEYS: Record<AlertType, MessageKey> = {
  tip: "overlays.alert.tip",
  follow: "overlays.alert.follow",
  subscription: "overlays.alert.subscription",
  raid: "overlays.alert.raid",
};

const DESCRIPTION_KEYS: Record<AlertType, MessageKey> = {
  tip: "overlays.alert.tipHint",
  follow: "overlays.alert.followHint",
  subscription: "overlays.alert.subscriptionHint",
  raid: "overlays.alert.raidHint",
};

export const alertTitle = (type: AlertType): string => t(TITLE_KEYS[type]);
export const alertDescription = (type: AlertType): string => t(DESCRIPTION_KEYS[type]);

/** Configs in page order; a type the API did not return is left out rather than invented. */
export function orderedAlertConfigs(configs: readonly AlertConfigDto[]): AlertConfigDto[] {
  return ALERT_TYPE_ORDER.flatMap((type) => configs.filter((config) => config.type === type).slice(0, 1));
}

export function alertDraft(config: AlertConfigDto): AlertConfigDraft {
  return {
    enabled: config.enabled,
    message: config.template.message,
    showMessage: config.template.showMessage,
    minAmountCents: config.minAmountCents,
    durationMs: config.durationMs,
    animation: config.template.animation,
  };
}

/**
 * `interact.alerts.set` input. Only text and animation exist in E6: no `imageKey` or `soundKey`
 * is ever sent (the API refuses them). The amount threshold applies to tips only.
 */
export function alertSetInput(channel: string, type: AlertType, draft: AlertConfigDraft): AlertSetInput {
  return {
    channel,
    type,
    enabled: draft.enabled,
    template: { message: draft.message, animation: draft.animation, showMessage: draft.showMessage },
    minAmountCents: type === "tip" ? draft.minAmountCents : 0,
    durationMs: draft.durationMs,
  };
}

/** `interact.overlays.token` input: `null` asks for a token that never expires. */
export function overlayTokenInput(channel: string, expiresAt: string | null): OverlayTokenInput {
  return { channel, expiresAt };
}
