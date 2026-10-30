// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The bell's and the settings page's pure helpers (ADR 0028; N1-inbox). */
import { NOTIFICATION_TYPES } from "@commonair/contracts/enums";
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import {
  type NotificationDto,
  type NotificationPreferencesDto,
  afterReadingOne,
  appendPage,
  applyPreference,
  choiceEnabled,
  describeNotification,
  isOverrideChoice,
  markItemsRead,
  overrideChoice,
  revertPreference,
  targetPath,
} from "../src/lib/notifications.ts";

const CH = "0192f000-0000-7000-8000-0000000000c1";
const BC = "0192f000-0000-7000-8000-0000000000b1";
const PROPOSAL = "0192f000-0000-7000-8000-0000000000a1";

const item = (over: Partial<NotificationDto> = {}): NotificationDto => ({
  id: "0192f000-0000-7000-8000-000000000001",
  type: "system",
  payload: {},
  readAt: null,
  createdAt: "2026-10-20T00:00:00.000Z",
  ...over,
});

describe("describeNotification", () => {
  it("go_live: the slug, the title and a link to the channel", () => {
    const v = describeNotification({
      type: "go_live",
      payload: { channelId: CH, slug: "rivertide", broadcastId: BC, title: "Night <b>run</b>" },
    });
    expect(v).toEqual({
      kind: "go_live",
      slug: "rivertide",
      title: "Night <b>run</b>",
      target: { kind: "channel", slug: "rivertide" },
    });
    expect(targetPath(v.target ?? { kind: "dashboard" })).toBe("/rivertide");
  });

  it("go_live with an empty title (mature, unconfirmed) keeps it empty", () => {
    const v = describeNotification({
      type: "go_live",
      payload: { channelId: CH, slug: "rivertide", broadcastId: BC, title: "" },
    });
    expect(v.kind === "go_live" && v.title).toBe("");
  });

  it("go_live with a malformed payload or a slug that is not one: generic, no link", () => {
    for (const payload of [
      {},
      { channelId: CH, slug: "rivertide" },
      { channelId: CH, slug: "../admin", broadcastId: BC, title: "" },
      { channelId: CH, slug: "https://evil.example", broadcastId: BC, title: "" },
    ])
      expect(describeNotification({ type: "go_live", payload })).toEqual({
        kind: "generic",
        label: "notifications.type.go_live",
        target: null,
      });
  });

  it("proposal and vote_open link the proposal when the payload names a valid id", () => {
    const v = describeNotification({ type: "vote_open", payload: { proposalId: PROPOSAL, kind: "bylaw" } });
    expect(v).toEqual({
      kind: "generic",
      label: "notifications.type.vote_open",
      target: { kind: "proposal", id: PROPOSAL },
    });
    expect(targetPath({ kind: "proposal", id: PROPOSAL })).toBe(`/coop/proposals/${PROPOSAL}`);
    expect(describeNotification({ type: "proposal", payload: { proposalId: "x/../y" } }).target).toBeNull();
    expect(describeNotification({ type: "proposal", payload: {} }).target).toBeNull();
  });

  it("statement of reasons → appeals; export ready → privacy", () => {
    expect(
      describeNotification({ type: "moderation", payload: { kind: "enforcement_statement", statementId: "s" } }),
    ).toEqual({ kind: "generic", label: "notifications.kind.statement", target: { kind: "appeals" } });
    expect(describeNotification({ type: "export_ready", payload: {} }).target).toEqual({ kind: "privacy" });
    expect(targetPath({ kind: "appeals" })).toBe("/settings/appeals");
    expect(targetPath({ kind: "privacy" })).toBe("/settings/privacy");
  });

  it("system: Discord webhook removed and leaked stream key → the dashboard; others no link", () => {
    expect(
      describeNotification({ type: "system", payload: { kind: "discord_webhook_removed", channelId: CH } }),
    ).toEqual({ kind: "generic", label: "notifications.kind.discordWebhookRemoved", target: { kind: "dashboard" } });
    expect(describeNotification({ type: "system", payload: { kind: "stream_key_leaked" } }).target).toEqual({
      kind: "dashboard",
    });
    expect(describeNotification({ type: "system", payload: { kind: "other" } })).toEqual({
      kind: "generic",
      label: "notifications.type.system",
      target: null,
    });
    expect(targetPath({ kind: "dashboard" })).toBe("/dashboard");
  });

  it("staff moderation notices, raids and payouts: their label, no link", () => {
    expect(describeNotification({ type: "moderation", payload: { kind: "urgent_report" } }).target).toBeNull();
    expect(describeNotification({ type: "raid", payload: {} }).target).toBeNull();
    expect(describeNotification({ type: "payout", payload: {} }).target).toBeNull();
  });

  it("every type has a label in the catalog", () => {
    const labels = NOTIFICATION_TYPES.map((type) => describeNotification({ type, payload: {} })).flatMap((v) =>
      v.kind === "generic" ? [v.label] : [],
    );
    expect(labels).toHaveLength(NOTIFICATION_TYPES.length);
    expect(labels.filter((k) => !en[k])).toEqual([]);
  });
});

describe("list helpers", () => {
  const a = item({ id: "a" });
  const b = item({ id: "b", readAt: "2026-10-19T00:00:00.000Z" });
  const c = item({ id: "c" });

  it("markItemsRead: the named ids, or every unread one; read ones keep their time", () => {
    const at = "2026-10-21T00:00:00.000Z";
    expect(markItemsRead([a, b, c], ["a"], at).map((n) => n.readAt)).toEqual([at, b.readAt, null]);
    expect(markItemsRead([a, b, c], null, at).map((n) => n.readAt)).toEqual([at, b.readAt, at]);
  });

  it("appendPage drops ids already shown", () => {
    expect(appendPage([a, b], [b, c]).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("afterReadingOne counts down to 0; a capped count asks again", () => {
    expect(afterReadingOne({ count: 3, capped: false })).toEqual({ count: 2, capped: false });
    expect(afterReadingOne({ count: 0, capped: false })).toEqual({ count: 0, capped: false });
    expect(afterReadingOne({ count: 99, capped: true })).toBeNull();
  });
});

describe("preferences helpers", () => {
  const A = { id: CH, slug: "alpha", displayName: "Alpha" };
  const B = { id: BC, slug: "bravo", displayName: "Bravo" };
  const prefs: NotificationPreferencesDto = {
    type: "go_live",
    defaults: { in_app: true, email: false, push: false },
    builtIn: { in_app: true, email: true, push: true },
    channels: [{ channel: B, media: { email: true } }],
    emailVerified: true,
  };

  it("overrideChoice and choiceEnabled map default/on/off", () => {
    expect(overrideChoice(prefs, "bravo", "email")).toBe("on");
    expect(overrideChoice(prefs, "bravo", "push")).toBe("default");
    expect(overrideChoice(prefs, "alpha", "email")).toBe("default");
    expect([choiceEnabled("default"), choiceEnabled("on"), choiceEnabled("off")]).toEqual([null, true, false]);
    expect(["default", "on", "off", "x", null].map(isOverrideChoice)).toEqual([true, true, true, false, false]);
  });

  it("a default change is no longer built in", () => {
    const next = applyPreference(prefs, { medium: "email", channel: null, enabled: true });
    expect(next.defaults.email).toBe(true);
    expect(next.builtIn).toEqual({ in_app: true, email: false, push: true });
    // A default cannot be removed: unchanged.
    expect(applyPreference(prefs, { medium: "email", channel: null, enabled: null })).toBe(prefs);
  });

  it("overrides are added (sorted by slug), changed and removed", () => {
    const added = applyPreference(prefs, { medium: "push", channel: "alpha", enabled: false }, A);
    expect(added.channels).toEqual([
      { channel: A, media: { push: false } },
      { channel: B, media: { email: true } },
    ]);
    const removed = applyPreference(added, { medium: "email", channel: "bravo", enabled: null });
    expect(removed.channels).toEqual([{ channel: A, media: { push: false } }]);
    // Without the channel's details a new override cannot be shown: nothing added.
    expect(applyPreference(prefs, { medium: "push", channel: "alpha", enabled: true }).channels).toEqual(
      prefs.channels,
    );
  });

  it("revertPreference restores one cell and keeps the others", () => {
    const changed = applyPreference(
      applyPreference(prefs, { medium: "email", channel: "bravo", enabled: false }),
      { medium: "push", channel: "alpha", enabled: true },
      A,
    );
    const reverted = revertPreference(changed, prefs, { medium: "email", channel: "bravo" });
    expect(overrideChoice(reverted, "bravo", "email")).toBe("on");
    expect(overrideChoice(reverted, "alpha", "push")).toBe("on");
    // A cell that had no override goes back to none.
    expect(
      overrideChoice(revertPreference(changed, prefs, { medium: "push", channel: "alpha" }), "alpha", "push"),
    ).toBe("default");
    const def = applyPreference(prefs, { medium: "push", channel: null, enabled: true });
    const back = revertPreference(def, prefs, { medium: "push", channel: null });
    expect(back.defaults.push).toBe(false);
    expect(back.builtIn.push).toBe(true);
  });
});
