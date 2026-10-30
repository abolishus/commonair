// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The export's column allow-lists. A change here is a change to what leaves the platform in a
 * user's archive: review it against docs/testing/e6-selectors.md "Data export" before updating.
 */
import { createDb } from "@commonair/db";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { EXPORT_FILES, fileValue, filesFor } from "../src/exports/collectors.ts";

// Never connects: postgres.js opens a connection on the first query, and these only render SQL.
const handle = createDb({ url: "postgres://nobody:nothing@127.0.0.1:9/none", max: 1 });
afterAll(() => handle.close());

const USER = "0190f0f0-0000-7000-8000-00000000aaaa";
const CHANNEL = "0190f0f0-0000-7000-8000-00000000bbbb";
const scope = { userId: USER, channelId: CHANNEL };

const allowed = Object.fromEntries(
  EXPORT_FILES.map((f) => [
    f.name,
    Object.fromEntries(Object.entries(f.sections).map(([n, s]) => [n, Object.keys(s.fields)])),
  ]),
);

describe("export collectors", () => {
  test("files per kind match the spec's archive table", () => {
    expect(filesFor("account").map((f) => f.name)).toEqual([
      "account.json",
      "sessions.json",
      "connections.json",
      "follows.json",
      "subscriptions.json",
      "payments.json",
      "tips.json",
      "chat.json",
      "coop.json",
      "safety.json",
      "enforcement_statements.json",
      "notifications.json",
      "consents.json",
      "developer.json",
      "interact.json",
      "blocks.json",
    ]);
    expect(filesFor("channel").map((f) => f.name)).toEqual([
      "channel.json",
      "vods.json",
      "clips.json",
      "revenue.json",
      "payouts.json",
      "moderation-actions.json",
    ]);
  });

  test("every section's column allow-list", () => {
    expect(allowed).toEqual({
      "account.json": {
        account: [
          "id",
          "username",
          "displayName",
          "email",
          "emailVerified",
          "locale",
          "role",
          "createdAt",
          "matureConfirmedAt",
          "twoFactorEnabled",
          "passkeyCount",
        ],
      },
      "sessions.json": { sessions: ["createdAt", "expiresAt", "userAgent", "ipAddress"] },
      "connections.json": { connections: ["providerId", "createdAt"] },
      "follows.json": { follows: ["channelSlug", "followedAt", "notify"] },
      "subscriptions.json": {
        subscriptions: [
          "channelSlug",
          "tier",
          "status",
          "priceCents",
          "currency",
          "currentPeriodStart",
          "currentPeriodEnd",
          "cancelAtPeriodEnd",
          "isGift",
          "createdAt",
        ],
      },
      "payments.json": {
        payments: [
          "id",
          "kind",
          "channelSlug",
          "amountCents",
          "taxCents",
          "refundedCents",
          "currency",
          "status",
          "tier",
          "quantity",
          "createdAt",
          "succeededAt",
        ],
        disputes: ["paymentId", "kind", "status", "amountCents", "createdAt", "resolvedAt"],
      },
      "tips.json": { tips: ["channelSlug", "amountCents", "currency", "message", "anonymous", "status", "createdAt"] },
      "chat.json": { chat: ["channelSlug", "body", "isAction", "deleted", "createdAt"] },
      "coop.json": {
        memberships: ["class", "status", "basis", "joinedAt", "lapsedAt", "exitedAt"],
        shares: ["amountCents", "currency", "status", "purchasedAt", "refundedAt", "createdAt"],
        votes: ["proposalId", "choice", "castAt"],
        proposals: ["id", "title", "body", "kind", "status", "createdAt"],
        comments: ["proposalId", "body", "createdAt"],
        candidacies: ["electionId", "statement", "nominatedAt", "elected"],
        boardSeats: ["class", "termStart", "termEnd"],
        patronage: ["periodId", "periodStart", "periodEnd", "status", "amountCents", "currency", "lines"],
      },
      "safety.json": {
        reports: ["reason", "status", "createdAt"],
        appeals: ["kind", "status", "body", "createdAt", "resolvedAt"],
        dmcaCounterNotices: [
          "noticeId",
          "fullName",
          "address",
          "phone",
          "itemIds",
          "statement",
          "goodFaithStatement",
          "consentToJurisdiction",
          "signature",
          "restoreAfter",
          "restoredAt",
          "suitFiledAt",
          "createdAt",
        ],
        accountActions: ["action", "sourceType", "createdAt", "reversedAt", "reversedReason"],
        labels: ["label", "appliedAt", "removedAt"],
        platformActions: ["action", "reasonCode", "durationSeconds", "createdAt"],
        channelBans: ["channelSlug", "action", "durationSeconds", "createdAt"],
      },
      // ADR 0019 decision 4 columns only: no moderator note, no reversal, no delivery rows.
      "enforcement_statements.json": {
        enforcement_statements: [
          "id",
          "sourceAuditId",
          "sourceAction",
          "channelId",
          "contentType",
          "contentId",
          "restrictionKind",
          "restrictionDetail",
          "restrictionEndsAt",
          "territorialScope",
          "facts",
          "source",
          "automatedDetection",
          "automatedDecision",
          "groundKind",
          "clauseId",
          "clauseVersion",
          "legalBasis",
          "guidelinesDocumentId",
          "noticeDocumentId",
          "appealSubjectType",
          "appealSubjectId",
          "createdAt",
        ],
      },
      "notifications.json": { notifications: ["type", "readAt", "createdAt"] },
      "consents.json": { consents: ["choices", "policyVersion", "createdAt"] },
      "developer.json": {
        oauthApps: ["name", "description", "redirectUris", "confidential", "createdAt"],
        tokens: ["personal", "scopes", "expiresAt", "lastUsedAt", "revokedAt", "createdAt"],
        bots: ["username", "displayName", "createdAt"],
        botTokens: ["botUsername", "scopes", "expiresAt", "lastUsedAt", "revokedAt", "createdAt"],
        webhooks: ["type", "version", "transport", "callbackUrl", "status", "createdAt"],
      },
      "interact.json": {
        pointsBalances: ["channelSlug", "points"],
        pointsTransactions: ["id", "channelSlug", "delta", "reason", "createdAt"],
        pollVotes: ["channelSlug", "pollId", "choiceId", "votes", "pointsSpent", "castAt"],
        predictionBets: ["channelSlug", "predictionId", "outcomeId", "points", "payout", "placedAt"],
        songRequests: ["channelSlug", "url", "status", "createdAt"],
      },
      "blocks.json": { blocks: ["username", "blockedAt"] },
      "channel.json": {
        settings: [
          "slug",
          "displayName",
          "title",
          "description",
          "categorySlug",
          "tags",
          "language",
          "mature",
          "theme",
          "chatSettings",
          "vodEnabled",
          "vodRetentionDays",
          "createdAt",
        ],
        panels: ["position", "title", "body", "linkUrl", "createdAt"],
        subscriptionTiers: ["tier", "name", "priceCents", "benefits"],
        alertConfigs: ["type", "enabled", "template", "minAmountCents", "durationMs"],
        simulcastTargets: ["name", "platform", "rtmpUrl", "enabled", "createdAt"],
      },
      "vods.json": { vods: ["id", "title", "visibility", "status", "durationSeconds", "createdAt"] },
      "clips.json": { clips: ["id", "title", "status", "durationSeconds", "views", "createdAt"] },
      "revenue.json": {
        revenue: ["date", "kind", "grossCents", "feeCents", "taxCents", "refundedCents", "currency", "status"],
      },
      "payouts.json": {
        payouts: ["periodStart", "periodEnd", "amountCents", "currency", "status", "provider", "createdAt", "paidAt"],
      },
      "moderation-actions.json": { actions: ["action", "durationSeconds", "createdAt"] },
    });
  });

  // Columns that hold secrets or other people: none may be selected, by any section.
  const FORBIDDEN =
    /"(password|token|secret|backup_codes|public_key|credential_id|access_token|refresh_token|id_token|access_token_hash|refresh_token_hash|client_secret_hash|client_id|key_hash|stream_key_ciphertext|secret_ciphertext|token_hash|ip_hash|device_hash|frame_key|impersonated_by|gifted_by_id|creator_id|moderator_id|target_user_id|reporter_id|subject_id|assignee_id|resolver_id|resolution|evidence|deleted_by|reply_to_id|payload|details|body_hash)"\s*(,|from|$)/i;

  for (const file of EXPORT_FILES)
    for (const [name, section] of Object.entries(file.sections))
      test(`${file.name} ${name}: selects only allowed columns, filtered by the requester`, () => {
        const q = section.query(handle.db, scope).toSQL();
        const select = q.sql.slice(0, q.sql.search(/ from /i));
        expect(select).not.toMatch(FORBIDDEN);
        expect(q.sql).toMatch(/ where /i);
        // Every query is bound to the requester's id or their own channel's id.
        expect(q.params.some((p) => p === USER || p === CHANNEL)).toBe(true);
        const ids = q.params.filter((p) => typeof p === "string" && /^[0-9a-f-]{36}$/.test(p));
        expect(ids.filter((p) => p !== USER && p !== CHANNEL)).toEqual([]);
      });

  test("channel sections refuse to run without the requester's channel", () => {
    const channel = EXPORT_FILES.find((f) => f.name === "vods.json");
    expect(() => channel?.sections.vods?.query(handle.db, { userId: USER, channelId: null })).toThrow(/channel/);
  });

  test("file values: single records, arrays, objects, and payments with their disputes", () => {
    const byName = (n: string) => {
      const f = EXPORT_FILES.find((x) => x.name === n);
      if (!f) throw new Error(n);
      return f;
    };
    expect(fileValue(byName("account.json"), { account: [] })).toBeNull();
    expect(fileValue(byName("account.json"), { account: [{ id: USER }] })).toEqual({ id: USER });
    expect(fileValue(byName("follows.json"), { follows: [{ channelSlug: "a" }] })).toEqual([{ channelSlug: "a" }]);
    expect(fileValue(byName("channel.json"), { settings: [{ slug: "s" }], panels: [] })).toEqual({
      settings: { slug: "s" },
      panels: [],
      subscriptionTiers: [],
      alertConfigs: [],
      simulcastTargets: [],
    });
    expect(
      fileValue(byName("payments.json"), {
        payments: [{ id: "p1" }, { id: "p2" }],
        disputes: [{ paymentId: "p2", kind: "refund", amountCents: 100 }],
      }),
    ).toEqual([
      { id: "p1", disputes: [] },
      { id: "p2", disputes: [{ kind: "refund", amountCents: 100 }] },
    ]);
    expect(fileValue(byName("interact.json"), { pointsBalances: [{ channelSlug: "a", points: 5 }] })).toEqual({
      pointsBalances: [{ channelSlug: "a", points: 5 }],
      pointsTransactions: [],
      pollVotes: [],
      predictionBets: [],
      songRequests: [],
    });
    const revenue = byName("revenue.json").sections.revenue;
    expect(revenue?.map?.({ grossCents: 1000, taxCents: 100, feeCents: 59 })).toMatchObject({ netCents: 841 });
  });
});
