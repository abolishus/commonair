// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Alert rendering and event → alert mapping (docs/testing/e6-selectors.md "Overlays and alerts"). */
import { describe, expect, test } from "vite-plus/test";
import { ALERT_TYPES } from "@commonair/contracts/enums";
import { dto } from "@commonair/contracts";
import type { BusEvent } from "@commonair/contracts/events";
import {
  alertFires,
  alertForEvent,
  alertSourceOf,
  defaultAlertConfig,
  overlayExpiry,
  overlayTokenLive,
  renderAlert,
  renderTemplate,
  sampleSource,
  tierNumber,
  withDefaults,
  type AlertConfig,
  type AlertSource,
} from "../src/overlay/alerts.ts";
import { t } from "../src/overlay/messages.ts";

const CH = "0190f0aa-0000-7000-8000-000000000001";
const OTHER = "0190f0aa-0000-7000-8000-000000000002";
const EV = "0190f0aa-0000-7000-8000-0000000000e1";
const AT = "2026-10-22T12:00:00.000Z";

const cfg = (type: AlertConfig["type"], over: Partial<AlertConfig> = {}): AlertConfig => ({
  type,
  enabled: true,
  template: { message: "${user} ${amount} ${tier} ${viewers} ${message}", animation: "slide", showMessage: true },
  minAmountCents: 0,
  durationMs: 5000,
  ...over,
});
const all = (over: Partial<AlertConfig> = {}) => ALERT_TYPES.map((type) => cfg(type, over));

const broadcaster = { broadcaster_user_id: "o", broadcaster_user_login: "s", broadcaster_user_name: "S" };
const ev = (type: BusEvent["type"], payload: Record<string, unknown>, channelId: string | null = CH): BusEvent => ({
  id: EV,
  type,
  version: "1",
  channelId,
  payload: { ...broadcaster, ...payload },
  occurredAt: AT,
});
const tip = (value: number, extra: Record<string, unknown> = {}) =>
  ev("channel.tip", {
    user_id: "u-1",
    user_login: "vee",
    user_name: "Vee Viewer",
    is_anonymous: false,
    amount: { value, decimal_places: 2, currency: "usd" },
    message: "great stream",
    ...extra,
  });

describe("renderTemplate", () => {
  test("fills every variable", () => {
    expect(
      renderTemplate("${user}|${amount}|${tier}|${viewers}|${message}", {
        user: "A",
        amount: "$2.50",
        tier: "2",
        viewers: "42",
        message: "hi",
      }),
    ).toBe("A|$2.50|2|42|hi");
  });
  test("known variables without a value render empty; unknown ones stay literal", () => {
    expect(renderTemplate("${user} ${amount}${message} ${nope} $user", { user: "A" })).toBe("A  ${nope} $user");
  });
  test("a value containing a variable is not expanded again", () => {
    expect(renderTemplate("${user} ${message}", { user: "${message}", message: "m" })).toBe("${message} m");
  });
});

describe("renderAlert", () => {
  const src = (over: Partial<AlertSource> = {}): AlertSource => ({
    id: EV,
    type: "tip",
    userName: "Vee",
    amountCents: 250,
    currency: "usd",
    supporterMessage: "hello",
    occurredAt: AT,
    test: false,
    ...over,
  });

  test("formats the amount in the instance locale and copies display settings", () => {
    const a = renderAlert(
      cfg("tip", { template: { message: "${user} tipped ${amount}", animation: "none", showMessage: true } }),
      src(),
    );
    expect(a).toMatchObject({
      id: EV,
      type: "tip",
      text: "Vee tipped $2.50",
      message: "hello",
      amountCents: 250,
      currency: "usd",
      durationMs: 5000,
      animation: "none",
      test: false,
      occurredAt: AT,
    });
    expect(dto.OverlayAlert.safeParse(a).success).toBe(true);
  });
  test("zero-decimal currencies", () => {
    expect(
      renderAlert(
        cfg("tip", { template: { message: "${amount}", animation: "fade", showMessage: true } }),
        src({ amountCents: 500, currency: "jpy" }),
      ).text,
    ).toBe("¥500");
  });
  test("anonymous renders the i18n label", () => {
    expect(renderAlert(cfg("tip"), src({ userName: null })).text.startsWith(`${t("alert.anonymous")} `)).toBe(true);
  });
  test("a missing or blank message is null and renders empty", () => {
    for (const m of [null, undefined, "", "   "]) {
      const a = renderAlert(
        cfg("tip", { template: { message: "[${message}]", animation: "fade", showMessage: true } }),
        src({ supporterMessage: m }),
      );
      expect(a.message).toBeNull();
      expect(a.text).toBe("[]");
    }
  });
  test("showMessage false drops the message from both the frame and the text", () => {
    const a = renderAlert(
      cfg("tip", { template: { message: "[${message}]", animation: "fade", showMessage: false } }),
      src(),
    );
    expect(a.message).toBeNull();
    expect(a.text).toBe("[]");
  });
  test("no amount: null amount and currency", () => {
    const a = renderAlert(cfg("follow"), src({ type: "follow", amountCents: null, currency: null }));
    expect(a.amountCents).toBeNull();
    expect(a.currency).toBeNull();
  });
});

describe("alertSourceOf / alertForEvent", () => {
  test("tip → tip alert with the display name and amount", () => {
    const a = alertForEvent(tip(250), CH, all());
    expect(a).toMatchObject({ type: "tip", amountCents: 250, currency: "usd", message: "great stream" });
    expect(a?.text).toContain("Vee Viewer");
    expect(a?.text).toContain("$2.50");
  });
  test("anonymous tip never carries the tipper's name, login or id", () => {
    const a = alertForEvent(tip(300, { is_anonymous: true }), CH, all());
    expect(a?.text).toContain(t("alert.anonymous"));
    const frame = JSON.stringify(a);
    for (const leaked of ["Vee Viewer", "vee", "u-1"]) expect(frame).not.toContain(leaked);
  });
  test("follow → follow", () => {
    const a = alertForEvent(
      ev("channel.follow", { user_id: "u", user_login: "f", user_name: "Fan", followed_at: AT }),
      CH,
      all(),
    );
    expect(a).toMatchObject({ type: "follow", amountCents: null });
    expect(a?.text.startsWith("Fan")).toBe(true);
  });
  test("subscribe → subscription with the tier number", () => {
    const a = alertForEvent(
      ev("channel.subscribe", { user_id: "u", user_login: "s", user_name: "Sub", tier: "2000", is_gift: false }),
      CH,
      all(),
    );
    expect(a?.type).toBe("subscription");
    expect(a?.text).toBe("Sub  2  ");
  });
  test("a gifted subscribe is announced by the gift event, not twice", () => {
    expect(
      alertSourceOf(
        ev("channel.subscribe", { user_id: "u", user_login: "s", user_name: "Sub", tier: "1000", is_gift: true }),
        CH,
      ),
    ).toBeNull();
    const gift = alertForEvent(
      ev("channel.subscription.gift", {
        user_id: "g",
        user_login: "g",
        user_name: "Gifter",
        total: 5,
        tier: "1000",
        is_anonymous: false,
      }),
      CH,
      all(),
    );
    expect(gift?.type).toBe("subscription");
    expect(gift?.text.startsWith("Gifter")).toBe(true);
    const anon = alertForEvent(
      ev("channel.subscription.gift", {
        user_id: "g",
        user_login: "g",
        user_name: "Gifter",
        total: 5,
        tier: "1000",
        is_anonymous: true,
      }),
      CH,
      all(),
    );
    expect(JSON.stringify(anon)).not.toContain("Gifter");
  });
  test("disabled type → nothing", () => {
    expect(alertForEvent(tip(1000), CH, all({ enabled: false }))).toBeNull();
    expect(alertForEvent(tip(1000), CH, withDefaults([]))).toBeNull();
  });
  test("below the minimum → nothing; at the minimum → alert", () => {
    const configs = all({ minAmountCents: 100 });
    expect(alertForEvent(tip(50), CH, configs)).toBeNull();
    expect(alertForEvent(tip(99), CH, configs)).toBeNull();
    expect(alertForEvent(tip(100), CH, configs)).not.toBeNull();
  });
  test("the minimum applies to tips only", () => {
    expect(
      alertFires(cfg("follow", { minAmountCents: 1000 }), {
        id: EV,
        type: "follow",
        userName: "x",
        amountCents: null,
        currency: null,
        occurredAt: AT,
        test: false,
      }),
    ).toBe(true);
  });
  test("another channel's event, a platform event, or a non-alert type → nothing", () => {
    expect(alertForEvent(tip(500), OTHER, all())).toBeNull();
    expect(alertForEvent({ ...tip(500), channelId: null }, CH, all())).toBeNull();
    expect(alertForEvent(ev("stream.online", { id: "b", type: "live", started_at: AT }), CH, all())).toBeNull();
  });
  test("a malformed tip amount is ignored", () => {
    expect(alertForEvent(tip(1.5), CH, all())).toBeNull();
    expect(alertForEvent(ev("channel.tip", { is_anonymous: false, user_name: "x" }), CH, all())).toBeNull();
  });
});

describe("raid alert (E8)", () => {
  // `channel.raid` has no broadcaster fields: the outbox row is keyed on the target channel.
  const raid = (viewers: unknown, channelId: string | null = CH): BusEvent => ({
    id: EV,
    type: "channel.raid",
    version: "1",
    channelId,
    payload: {
      from_broadcaster_user_id: "src-owner",
      from_broadcaster_user_login: "raider",
      from_broadcaster_user_name: "Raider Rae",
      to_broadcaster_user_id: "o",
      to_broadcaster_user_login: "s",
      to_broadcaster_user_name: "S",
      viewers,
    },
    occurredAt: AT,
  });
  test("raid on the target → raid alert with the raider's display name and the viewers", () => {
    const a = alertForEvent(raid(12), CH, [
      cfg("raid", { template: { message: "${user} raids with ${viewers}!", animation: "slide", showMessage: true } }),
    ]);
    expect(a).toMatchObject({
      id: EV,
      type: "raid",
      text: "Raider Rae raids with 12!",
      amountCents: null,
      message: null,
      test: false,
    });
    expect(dto.OverlayAlert.parse(a)).toEqual(a);
  });
  test("the default raid template", () => {
    const a = alertForEvent(raid(0), CH, [{ ...defaultAlertConfig("raid"), enabled: true }]);
    expect(a?.text).toBe(t("alert.default.raid").replace("${user}", "Raider Rae").replace("${viewers}", "0"));
  });
  test("disabled, another channel (the source's overlay) or a malformed count → nothing", () => {
    expect(alertForEvent(raid(5), CH, [cfg("raid", { enabled: false })])).toBeNull();
    expect(alertForEvent(raid(5), OTHER, all())).toBeNull();
    expect(alertForEvent(raid(-1), CH, all())).toBeNull();
    expect(alertForEvent(raid(1.5), CH, all())).toBeNull();
    expect(alertForEvent(raid("5"), CH, all())).toBeNull();
  });
  test("the minimum amount never applies to raids", () => {
    expect(alertForEvent(raid(1), CH, [cfg("raid", { minAmountCents: 10_000 })])?.type).toBe("raid");
  });
});

describe("defaults and samples", () => {
  test("one config per type in enum order, stored rows win", () => {
    const stored = cfg("tip", { minAmountCents: 77 });
    const out = withDefaults([stored]);
    expect(out.map((c) => c.type)).toEqual([...ALERT_TYPES]);
    expect(out.find((c) => c.type === "tip")).toEqual(stored);
    expect(out.find((c) => c.type === "follow")).toEqual(defaultAlertConfig("follow"));
  });
  test("defaults are disabled, fade, 6000 ms, min 0, an i18n message", () => {
    for (const type of ALERT_TYPES) {
      const d = defaultAlertConfig(type);
      expect(d).toMatchObject({ enabled: false, minAmountCents: 0, durationMs: 6000 });
      expect(d.template).toEqual({ message: t(`alert.default.${type}`), animation: "fade", showMessage: true });
      expect(dto.AlertConfig.safeParse(d).success).toBe(true);
    }
  });
  test("sample alerts are flagged as tests and render for every type", () => {
    for (const type of ALERT_TYPES) {
      const a = renderAlert(defaultAlertConfig(type), sampleSource(type, EV, new Date(AT), "usd"));
      expect(a.test).toBe(true);
      expect(a.text).not.toMatch(/\$\{/);
      expect(dto.OverlayAlert.safeParse(a).success).toBe(true);
    }
  });
  test("tier codes", () => {
    expect(tierNumber("1000")).toBe("1");
    expect(tierNumber("3000")).toBe("3");
    expect(tierNumber("4000")).toBeUndefined();
    expect(tierNumber(1000)).toBeUndefined();
  });
});

describe("overlay token expiry", () => {
  const now = new Date(AT);
  test("absent or null: no expiry", () => {
    expect(overlayExpiry(undefined, now)).toEqual({ ok: true, expiresAt: null });
    expect(overlayExpiry(null, now)).toEqual({ ok: true, expiresAt: null });
  });
  test("future: accepted, no upper cap", () => {
    expect(overlayExpiry("2026-10-22T12:00:00.001Z", now)).toEqual({
      ok: true,
      expiresAt: new Date("2026-10-22T12:00:00.001Z"),
    });
    expect(overlayExpiry("2126-01-01T00:00:00Z", now).ok).toBe(true);
  });
  test("now or past or garbage: refused", () => {
    expect(overlayExpiry(AT, now).ok).toBe(false);
    expect(overlayExpiry("2020-01-01T00:00:00Z", now).ok).toBe(false);
    expect(overlayExpiry("not a date", now).ok).toBe(false);
  });
  test("a token is live while unrevoked and unexpired", () => {
    expect(overlayTokenLive({ revokedAt: null, expiresAt: null }, now)).toBe(true);
    expect(overlayTokenLive({ revokedAt: null, expiresAt: new Date(now.getTime() + 1) }, now)).toBe(true);
    expect(overlayTokenLive({ revokedAt: null, expiresAt: now }, now)).toBe(false);
    expect(overlayTokenLive({ revokedAt: now, expiresAt: null }, now)).toBe(false);
  });
});
