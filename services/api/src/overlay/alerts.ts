// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Alert rendering for the overlay (docs/testing/e6-selectors.md "Overlays and alerts"), kept pure
 * so every rule is unit-tested: default configs, template variables, event → alert mapping and the
 * overlay-token expiry rule. A frame carries only what the overlay displays: never a payer id, an
 * email, or an anonymous supporter's name.
 */
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { ALERT_TYPES } from "@commonair/contracts/enums";
import type { BusEvent } from "@commonair/contracts/events";
import { formatMoney } from "@commonair/email";
import { t, OVERLAY_LOCALE } from "./messages.ts";

export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertConfig = z.infer<typeof dto.AlertConfig>;
export type OverlayAlert = z.infer<typeof dto.OverlayAlert>;

export const DEFAULT_ALERT_DURATION_MS = 6000;

/** What `alerts.list` shows for a type the streamer never configured: disabled, default text. */
export function defaultAlertConfig(type: AlertType, locale: string = OVERLAY_LOCALE): AlertConfig {
  return {
    type,
    enabled: false,
    template: { message: t(`alert.default.${type}`, locale), animation: "fade", showMessage: true },
    minAmountCents: 0,
    durationMs: DEFAULT_ALERT_DURATION_MS,
  };
}

/** One config per `ALERT_TYPES` entry, stored rows first, defaults for the rest, in enum order. */
export function withDefaults(stored: readonly AlertConfig[], locale: string = OVERLAY_LOCALE): AlertConfig[] {
  const byType = new Map(stored.map((c) => [c.type, c]));
  return ALERT_TYPES.map((type) => byType.get(type) ?? defaultAlertConfig(type, locale));
}

export interface AlertVars {
  user: string;
  amount?: string | undefined;
  tier?: string | undefined;
  viewers?: string | undefined;
  message?: string | undefined;
}

const VARIABLE = /\$\{(user|amount|tier|viewers|message)\}/g;

/** Fill `${user}`, `${amount}`, `${tier}`, `${viewers}`, `${message}`; a known variable without a value renders empty. */
export function renderTemplate(message: string, vars: AlertVars): string {
  return message.replace(VARIABLE, (_whole, key: keyof AlertVars) => vars[key] ?? "");
}

/** "1000" → "1": EventSub tier codes as the tier number streamers talk about. */
export const tierNumber = (code: unknown): string | undefined =>
  typeof code === "string" && /^[123]000$/.test(code) ? code.slice(0, 1) : undefined;

export interface AlertSource {
  id: string;
  type: AlertType;
  /** Display name, or null when the supporter is anonymous (rendered as the i18n label). */
  userName: string | null;
  amountCents: number | null;
  currency: string | null;
  tier?: string | undefined;
  viewers?: number | undefined;
  supporterMessage?: string | null | undefined;
  occurredAt: string;
  test: boolean;
}

/** Render one alert from its config; the caller has already decided that it should fire. */
export function renderAlert(config: AlertConfig, src: AlertSource, locale: string = OVERLAY_LOCALE): OverlayAlert {
  const shown =
    config.template.showMessage && src.supporterMessage && src.supporterMessage.trim() !== ""
      ? src.supporterMessage
      : null;
  const amount =
    src.amountCents !== null && src.currency ? formatMoney(src.amountCents, src.currency, locale) : undefined;
  const text = renderTemplate(config.template.message, {
    user: src.userName ?? t("alert.anonymous", locale),
    amount,
    tier: src.tier,
    viewers: src.viewers === undefined ? undefined : String(src.viewers),
    message: shown ?? undefined,
  });
  return {
    id: src.id,
    type: src.type,
    text,
    message: shown,
    amountCents: src.amountCents,
    currency: src.currency,
    durationMs: config.durationMs,
    animation: config.template.animation,
    test: src.test,
    occurredAt: src.occurredAt,
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * The alert source for a bus event on `channelId`, or null when the event is not an alert (other
 * channel, other type). `channel.subscribe` with `is_gift` is skipped: the gift event announces it,
 * and announcing both would double every gifted sub.
 */
export function alertSourceOf(ev: BusEvent, channelId: string): AlertSource | null {
  if (ev.channelId !== channelId) return null;
  const p = ev.payload;
  const base = { id: ev.id, occurredAt: ev.occurredAt, test: false };
  switch (ev.type) {
    case "channel.tip": {
      const amount = p.amount as { value?: unknown; currency?: unknown } | undefined;
      if (typeof amount?.value !== "number" || !Number.isSafeInteger(amount.value)) return null;
      const anonymous = p.is_anonymous !== false;
      return {
        ...base,
        type: "tip",
        userName: anonymous ? null : str(p.user_name),
        amountCents: amount.value,
        currency: str(amount.currency),
        supporterMessage: str(p.message),
      };
    }
    case "channel.follow":
      return { ...base, type: "follow", userName: str(p.user_name), amountCents: null, currency: null };
    case "channel.subscribe":
      if (p.is_gift === true) return null;
      return {
        ...base,
        type: "subscription",
        userName: str(p.user_name),
        amountCents: null,
        currency: null,
        tier: tierNumber(p.tier),
      };
    case "channel.subscription.gift":
      return {
        ...base,
        type: "subscription",
        userName: p.is_anonymous === false ? str(p.user_name) : null,
        amountCents: null,
        currency: null,
        tier: tierNumber(p.tier),
      };
    default:
      return null;
  }
}

/** Whether a configured alert fires for this source: enabled, and tips at least the minimum. */
export function alertFires(config: AlertConfig | undefined, src: AlertSource): config is AlertConfig {
  if (!config?.enabled) return false;
  if (src.type === "tip" && (src.amountCents ?? 0) < config.minAmountCents) return false;
  return true;
}

/** Event → alert frame for one channel's overlay, or null when nothing should show. */
export function alertForEvent(
  ev: BusEvent,
  channelId: string,
  configs: readonly AlertConfig[],
  locale: string = OVERLAY_LOCALE,
): OverlayAlert | null {
  const src = alertSourceOf(ev, channelId);
  if (!src) return null;
  const config = configs.find((c) => c.type === src.type);
  return alertFires(config, src) ? renderAlert(config, src, locale) : null;
}

/** Sample values for `interact.alerts.test`. */
export function sampleSource(
  type: AlertType,
  id: string,
  now: Date,
  currency: string,
  locale: string = OVERLAY_LOCALE,
): AlertSource {
  return {
    id,
    type,
    userName: t("alert.sample.user", locale),
    amountCents: type === "tip" ? 500 : null,
    currency: type === "tip" ? currency : null,
    tier: type === "subscription" ? "1" : undefined,
    viewers: type === "raid" ? 42 : undefined,
    supporterMessage: type === "tip" ? t("alert.sample.message", locale) : null,
    occurredAt: now.toISOString(),
    test: true,
  };
}

/**
 * ADR 0021: no expiry (absent or null) or any instant strictly in the future, no upper cap.
 * Returns the expiry, or a reason to refuse.
 */
export function overlayExpiry(
  expiresAt: string | null | undefined,
  now: Date,
): { ok: true; expiresAt: Date | null } | { ok: false; reason: string } {
  if (expiresAt === undefined || expiresAt === null) return { ok: true, expiresAt: null };
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return { ok: false, reason: "Invalid expiry" };
  if (at.getTime() <= now.getTime()) return { ok: false, reason: "The expiry must be in the future" };
  return { ok: true, expiresAt: at };
}

/** Whether a token row is usable now. */
export const overlayTokenLive = (row: { revokedAt: Date | null; expiresAt: Date | null }, now: Date) =>
  row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime());
