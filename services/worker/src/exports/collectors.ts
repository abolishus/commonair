// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a data export contains (docs/testing/e6-selectors.md "Data export", ADR 0021 decision 1).
 *
 * Every section names its columns explicitly in a `fields` object (never `select *`), so a
 * reviewer can check each one, and every query filters by the requester's own id (or, for a
 * channel export, the id of the channel they own). Other people appear only as the public slug
 * of a channel the requester acted on. No secret is selected anywhere: no password hashes, 2FA
 * secrets, passkey material, OAuth tokens or hashes, stream or simulcast keys, webhook secrets,
 * client secrets, evidence or moderation frames.
 */
import { schema as s, type Executor } from "@commonair/db";
import type { EXPORT_KINDS } from "@commonair/contracts/enums";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export type ExportKind = (typeof EXPORT_KINDS)[number];

export interface ExportScope {
  userId: string;
  /** The requester's own channel; required for a `channel` export. */
  channelId: string | null;
}

export type Row = Record<string, unknown>;

/** A drizzle select builder: awaitable, and renderable to SQL without a connection (unit tests). */
export type Built = PromiseLike<Row[]> & { toSQL(): { sql: string; params: unknown[] } };

export interface Section {
  /** The explicit column allow-list: output key → column or expression. */
  fields: Record<string, unknown>;
  query(tx: Executor, scope: ExportScope): Built;
  /** `one`: the file (or object member) is the first row, or null. Default: an array of rows. */
  one?: boolean;
  /** Per-row post-processing (derived values only; never adds a column from elsewhere). */
  map?(row: Row): Row;
}

export interface ExportFile {
  name: string;
  kind: ExportKind;
  /** One section: the file is that section's value. Several: an object with one member each. */
  sections: Record<string, Section>;
  /** Joins sections into the file's value (default: see `fileValue`). */
  combine?(rows: Record<string, Row[]>): unknown;
}

const channelId = (scope: ExportScope): string => {
  if (!scope.channelId) throw new Error("channel export without a channel");
  return scope.channelId;
};

/** A reason only when it looks like a stable code; free text written by staff is left out. */
const reasonCode = (col: typeof s.modActions.reason) =>
  sql<string | null>`case when ${col} ~ '^[a-z0-9_.:-]{1,64}$' then ${col} else null end`;

// Account export ----------------------------------------------------------------------------

const accountFields = {
  id: s.users.id,
  username: s.users.username,
  displayName: s.users.name,
  email: s.users.email,
  emailVerified: s.users.emailVerified,
  locale: s.users.locale,
  role: s.users.role,
  createdAt: s.users.createdAt,
  matureConfirmedAt: s.users.matureConfirmedAt,
  twoFactorEnabled: s.users.twoFactorEnabled,
  passkeyCount: sql<number>`(select count(*)::int from ${s.passkeys} where ${s.passkeys.userId} = ${s.users.id})`,
};

const sessionFields = {
  createdAt: s.sessions.createdAt,
  expiresAt: s.sessions.expiresAt,
  userAgent: s.sessions.userAgent,
  ipAddress: s.sessions.ipAddress,
};

const connectionFields = { providerId: s.accounts.providerId, createdAt: s.accounts.createdAt };

const followFields = { channelSlug: s.channels.slug, followedAt: s.follows.createdAt, notify: s.follows.notify };

const subscriptionFields = {
  channelSlug: s.channels.slug,
  tier: s.subscriptions.tier,
  status: s.subscriptions.status,
  priceCents: s.subscriptions.priceCents,
  currency: s.subscriptions.currency,
  currentPeriodStart: s.subscriptions.currentPeriodStart,
  currentPeriodEnd: s.subscriptions.currentPeriodEnd,
  cancelAtPeriodEnd: s.subscriptions.cancelAtPeriodEnd,
  // The gifter is never named: only whether it was a gift.
  isGift: sql<boolean>`${s.subscriptions.giftedById} is not null or ${s.subscriptions.giftPaymentId} is not null`,
  createdAt: s.subscriptions.createdAt,
};

const paymentFields = {
  id: s.payments.id,
  kind: s.payments.kind,
  channelSlug: s.channels.slug,
  amountCents: s.payments.amountCents,
  taxCents: s.payments.taxCents,
  refundedCents: s.payments.refundedCents,
  currency: s.payments.currency,
  status: s.payments.status,
  tier: s.payments.tier,
  quantity: s.payments.quantity,
  createdAt: s.payments.createdAt,
  succeededAt: s.payments.succeededAt,
};

const paymentDisputeFields = {
  paymentId: s.disputes.paymentId,
  kind: s.disputes.kind,
  status: s.disputes.status,
  amountCents: s.disputes.amountCents,
  createdAt: s.disputes.createdAt,
  resolvedAt: s.disputes.resolvedAt,
};

const tipFields = {
  channelSlug: s.channels.slug,
  amountCents: s.tips.amountCents,
  currency: s.tips.currency,
  message: s.tips.message,
  anonymous: s.tips.anonymous,
  status: s.tips.status,
  createdAt: s.tips.createdAt,
};

const chatFields = {
  channelSlug: s.channels.slug,
  body: s.chatMessages.body,
  isAction: s.chatMessages.isAction,
  deleted: sql<boolean>`${s.chatMessages.deletedAt} is not null`,
  createdAt: s.chatMessages.createdAt,
};

const membershipFields = {
  class: s.memberships.class,
  status: s.memberships.status,
  basis: s.memberships.basis,
  joinedAt: s.memberships.joinedAt,
  lapsedAt: s.memberships.lapsedAt,
  exitedAt: s.memberships.exitedAt,
};

const shareFields = {
  amountCents: s.membershipShares.amountCents,
  currency: s.membershipShares.currency,
  status: s.membershipShares.status,
  purchasedAt: s.membershipShares.purchasedAt,
  refundedAt: s.membershipShares.refundedAt,
  createdAt: s.membershipShares.createdAt,
};

const voteFields = { proposalId: s.votes.proposalId, choice: s.votes.choice, castAt: s.votes.castAt };

const proposalFields = {
  id: s.proposals.id,
  title: s.proposals.title,
  body: s.proposals.body,
  kind: s.proposals.kind,
  status: s.proposals.status,
  createdAt: s.proposals.createdAt,
};

const commentFields = {
  proposalId: s.proposalComments.proposalId,
  body: s.proposalComments.body,
  createdAt: s.proposalComments.createdAt,
};

const candidacyFields = {
  electionId: s.electionCandidates.electionId,
  statement: s.electionCandidates.statement,
  nominatedAt: s.electionCandidates.nominatedAt,
  elected: s.electionCandidates.elected,
};

const boardSeatFields = {
  class: s.boardSeats.class,
  termStart: s.boardSeats.termStart,
  termEnd: s.boardSeats.termEnd,
};

const patronageFields = {
  periodId: s.patronageAllocations.periodId,
  periodStart: s.patronagePeriods.periodStart,
  periodEnd: s.patronagePeriods.periodEnd,
  status: s.patronagePeriods.status,
  amountCents: s.patronageAllocations.amountCents,
  currency: s.patronagePeriods.currency,
  lines: s.patronageAllocations.lines,
};

const reportFields = { reason: s.reports.reason, status: s.reports.status, createdAt: s.reports.createdAt };

const appealFields = {
  kind: s.appeals.kind,
  status: s.appeals.status,
  body: s.appeals.body,
  createdAt: s.appeals.createdAt,
  resolvedAt: s.appeals.resolvedAt,
};

/** The user's own DMCA counter-notices (their text, as filed; never the claimant's notice). */
const counterNoticeFields = {
  noticeId: s.dmcaCounterNotices.noticeId,
  fullName: s.dmcaCounterNotices.fullName,
  address: s.dmcaCounterNotices.address,
  phone: s.dmcaCounterNotices.phone,
  itemIds: s.dmcaCounterNotices.itemIds,
  statement: s.dmcaCounterNotices.statement,
  goodFaithStatement: s.dmcaCounterNotices.goodFaithStatement,
  consentToJurisdiction: s.dmcaCounterNotices.consentToJurisdiction,
  signature: s.dmcaCounterNotices.signature,
  restoreAfter: s.dmcaCounterNotices.restoreAfter,
  restoredAt: s.dmcaCounterNotices.restoredAt,
  suitFiledAt: s.dmcaCounterNotices.suitFiledAt,
  createdAt: s.dmcaCounterNotices.createdAt,
};

/** DMCA strikes and terminations about the user. */
const accountActionFields = {
  action: s.accountActions.action,
  sourceType: s.accountActions.sourceType,
  createdAt: s.accountActions.createdAt,
  reversedAt: s.accountActions.reversedAt,
  reversedReason: s.accountActions.reversedReason,
};

const labelFields = {
  label: s.contentLabels.label,
  appliedAt: s.contentLabels.appliedAt,
  removedAt: s.contentLabels.removedAt,
};

const platformActionFields = {
  action: s.modActions.action,
  reasonCode: reasonCode(s.modActions.reason),
  durationSeconds: s.modActions.durationSeconds,
  createdAt: s.modActions.createdAt,
};

const channelBanFields = {
  channelSlug: s.channels.slug,
  action: s.modActions.action,
  durationSeconds: s.modActions.durationSeconds,
  createdAt: s.modActions.createdAt,
};

/**
 * Statements of reasons about the user (ADR 0019 decision 6, w0-selectors "Data export"): the
 * stored decision 4 columns only. No moderator note (joined on read, never stored), no reversal
 * (computed on read), no delivery rows.
 */
const enforcementStatementFields = {
  id: s.enforcementStatements.id,
  sourceAuditId: s.enforcementStatements.sourceAuditId,
  sourceAction: s.enforcementStatements.sourceAction,
  channelId: s.enforcementStatements.channelId,
  contentType: s.enforcementStatements.contentType,
  contentId: s.enforcementStatements.contentId,
  restrictionKind: s.enforcementStatements.restrictionKind,
  restrictionDetail: s.enforcementStatements.restrictionDetail,
  restrictionEndsAt: s.enforcementStatements.restrictionEndsAt,
  territorialScope: s.enforcementStatements.territorialScope,
  facts: s.enforcementStatements.facts,
  source: s.enforcementStatements.source,
  automatedDetection: s.enforcementStatements.automatedDetection,
  automatedDecision: s.enforcementStatements.automatedDecision,
  groundKind: s.enforcementStatements.groundKind,
  clauseId: s.enforcementStatements.clauseId,
  clauseVersion: s.enforcementStatements.clauseVersion,
  legalBasis: s.enforcementStatements.legalBasis,
  guidelinesDocumentId: s.enforcementStatements.guidelinesDocumentId,
  noticeDocumentId: s.enforcementStatements.noticeDocumentId,
  appealSubjectType: s.enforcementStatements.appealSubjectType,
  appealSubjectId: s.enforcementStatements.appealSubjectId,
  createdAt: s.enforcementStatements.createdAt,
};

const notificationFields = {
  type: s.notifications.type,
  readAt: s.notifications.readAt,
  createdAt: s.notifications.createdAt,
};

const consentFields = {
  choices: s.consentRecords.choices,
  policyVersion: s.consentRecords.policyVersion,
  createdAt: s.consentRecords.createdAt,
};

const oauthAppFields = {
  name: s.oauthApps.name,
  description: s.oauthApps.description,
  redirectUris: s.oauthApps.redirectUris,
  confidential: s.oauthApps.confidential,
  createdAt: s.oauthApps.createdAt,
};

const tokenFields = {
  personal: sql<boolean>`${s.oauthTokens.appId} is null`,
  scopes: s.oauthTokens.scopes,
  expiresAt: s.oauthTokens.expiresAt,
  lastUsedAt: s.oauthTokens.lastUsedAt,
  revokedAt: s.oauthTokens.revokedAt,
  createdAt: s.oauthTokens.createdAt,
};

const botFields = {
  username: s.users.username,
  displayName: s.users.name,
  createdAt: s.users.createdAt,
};

const botTokenFields = {
  botUsername: s.users.username,
  scopes: s.oauthTokens.scopes,
  expiresAt: s.oauthTokens.expiresAt,
  lastUsedAt: s.oauthTokens.lastUsedAt,
  revokedAt: s.oauthTokens.revokedAt,
  createdAt: s.oauthTokens.createdAt,
};

const webhookFields = {
  type: s.eventSubscriptions.type,
  version: s.eventSubscriptions.version,
  transport: s.eventSubscriptions.transport,
  callbackUrl: s.eventSubscriptions.callbackUrl,
  status: s.eventSubscriptions.status,
  createdAt: s.eventSubscriptions.createdAt,
};

/**
 * E8 channel features (ADR 0026): the user's points per channel and their ledger, poll votes,
 * prediction bets and song requests. Channels appear by their public slug only.
 */
const pointsBalanceFields = { channelSlug: s.channels.slug, points: s.loyaltyBalances.points };

const pointsTransactionFields = {
  id: s.loyaltyTransactions.id,
  channelSlug: s.channels.slug,
  delta: s.loyaltyTransactions.delta,
  reason: s.loyaltyTransactions.reason,
  createdAt: s.loyaltyTransactions.createdAt,
};

const pollVoteFields = {
  channelSlug: s.channels.slug,
  pollId: s.pollVotes.pollId,
  choiceId: s.pollVotes.choiceId,
  votes: s.pollVotes.votes,
  pointsSpent: s.pollVotes.pointsSpent,
  castAt: s.pollVotes.castAt,
};

const predictionBetFields = {
  channelSlug: s.channels.slug,
  predictionId: s.predictionBets.predictionId,
  outcomeId: s.predictionBets.outcomeId,
  points: s.predictionBets.points,
  payout: s.predictionBets.payout,
  placedAt: s.predictionBets.placedAt,
};

const songRequestFields = {
  channelSlug: s.channels.slug,
  url: s.songRequests.url,
  status: s.songRequests.status,
  createdAt: s.songRequests.createdAt,
};

// Channel export ----------------------------------------------------------------------------

const channelSettingsFields = {
  slug: s.channels.slug,
  displayName: s.channels.displayName,
  title: s.channels.title,
  description: s.channels.description,
  categorySlug: s.categories.slug,
  tags: s.channels.tags,
  language: s.channels.language,
  mature: s.channels.mature,
  theme: s.channels.theme,
  chatSettings: s.channels.chatSettings,
  vodEnabled: s.channels.vodEnabled,
  vodRetentionDays: s.channels.vodRetentionDays,
  createdAt: s.channels.createdAt,
};

const panelFields = {
  position: s.channelPanels.position,
  title: s.channelPanels.title,
  body: s.channelPanels.body,
  linkUrl: s.channelPanels.linkUrl,
  createdAt: s.channelPanels.createdAt,
};

const subTierFields = {
  tier: s.channelSubTiers.tier,
  name: s.channelSubTiers.name,
  priceCents: s.channelSubTiers.priceCents,
  benefits: s.channelSubTiers.benefits,
};

const alertConfigFields = {
  type: s.alertConfigs.type,
  enabled: s.alertConfigs.enabled,
  template: s.alertConfigs.template,
  minAmountCents: s.alertConfigs.minAmountCents,
  durationMs: s.alertConfigs.durationMs,
};

// The encrypted key column is deliberately absent.
const simulcastTargetFields = {
  name: s.simulcastTargets.name,
  platform: s.simulcastTargets.platform,
  rtmpUrl: s.simulcastTargets.rtmpUrl,
  enabled: s.simulcastTargets.enabled,
  createdAt: s.simulcastTargets.createdAt,
};

const vodFields = {
  id: s.vods.id,
  title: s.vods.title,
  visibility: s.vods.visibility,
  status: s.vods.status,
  durationSeconds: s.vods.durationSeconds,
  createdAt: s.vods.createdAt,
};

// No creator: clips by other people must not name them.
const clipFields = {
  id: s.clips.id,
  title: s.clips.title,
  status: s.clips.status,
  durationSeconds: s.clips.durationSeconds,
  views: s.clips.views,
  createdAt: s.clips.createdAt,
};

// No payer and no payment id: only the money and its state.
const revenueFields = {
  date: s.payments.createdAt,
  kind: s.payments.kind,
  grossCents: s.payments.amountCents,
  feeCents: s.payments.feeCents,
  taxCents: s.payments.taxCents,
  refundedCents: s.payments.refundedCents,
  currency: s.payments.currency,
  status: s.payments.status,
};

const payoutFields = {
  periodStart: s.payouts.periodStart,
  periodEnd: s.payouts.periodEnd,
  amountCents: s.payouts.amountCents,
  currency: s.payouts.currency,
  status: s.payouts.status,
  provider: s.payouts.provider,
  createdAt: s.payouts.createdAt,
  paidAt: s.payouts.paidAt,
};

// No target and no moderator.
const channelModActionFields = {
  action: s.modActions.action,
  durationSeconds: s.modActions.durationSeconds,
  createdAt: s.modActions.createdAt,
};

const asNumber = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Every file of both kinds, in archive order. */
const blockFields = {
  username: s.users.username,
  blockedAt: s.userBlocks.createdAt,
};

// N1 (ADR 0028): go-live preferences (a null channel is the member's default for the medium).
const notificationPreferenceFields = {
  type: s.notificationPreferences.type,
  channelSlug: s.channels.slug,
  medium: s.notificationPreferences.medium,
  enabled: s.notificationPreferences.enabled,
  updatedAt: s.notificationPreferences.updatedAt,
};

// Never the endpoint or keys: they are the browser's, encrypted, and of no use to the member.
const pushSubscriptionFields = {
  id: s.pushSubscriptions.id,
  createdAt: s.pushSubscriptions.createdAt,
  lastSuccessAt: s.pushSubscriptions.lastSuccessAt,
  failures: s.pushSubscriptions.failures,
};

// Never the URL: it is a secret that lets anyone post to the channel's Discord.
const discordWebhookFields = {
  configured: sql<boolean>`${s.discordWebhooks.channelId} is not null`,
  setAt: s.discordWebhooks.setAt,
  lastPostedAt: s.discordWebhooks.lastPostedAt,
};

export const EXPORT_FILES: readonly ExportFile[] = [
  {
    name: "account.json",
    kind: "account",
    sections: {
      account: {
        one: true,
        fields: accountFields,
        query: (tx, { userId }) => tx.select(accountFields).from(s.users).where(eq(s.users.id, userId)),
      },
    },
  },
  {
    name: "sessions.json",
    kind: "account",
    sections: {
      sessions: {
        fields: sessionFields,
        query: (tx, { userId }) =>
          tx
            .select(sessionFields)
            .from(s.sessions)
            .where(eq(s.sessions.userId, userId))
            .orderBy(asc(s.sessions.createdAt)),
      },
    },
  },
  {
    name: "connections.json",
    kind: "account",
    sections: {
      connections: {
        fields: connectionFields,
        query: (tx, { userId }) =>
          tx
            .select(connectionFields)
            .from(s.accounts)
            .where(eq(s.accounts.userId, userId))
            .orderBy(asc(s.accounts.createdAt)),
      },
    },
  },
  {
    name: "follows.json",
    kind: "account",
    sections: {
      follows: {
        fields: followFields,
        query: (tx, { userId }) =>
          tx
            .select(followFields)
            .from(s.follows)
            .innerJoin(s.channels, eq(s.channels.id, s.follows.channelId))
            .where(eq(s.follows.followerId, userId))
            .orderBy(asc(s.follows.createdAt)),
      },
    },
  },
  {
    name: "subscriptions.json",
    kind: "account",
    sections: {
      subscriptions: {
        fields: subscriptionFields,
        query: (tx, { userId }) =>
          tx
            .select(subscriptionFields)
            .from(s.subscriptions)
            .innerJoin(s.channels, eq(s.channels.id, s.subscriptions.channelId))
            .where(eq(s.subscriptions.subscriberId, userId))
            .orderBy(asc(s.subscriptions.createdAt)),
      },
    },
  },
  {
    name: "payments.json",
    kind: "account",
    sections: {
      payments: {
        fields: paymentFields,
        query: (tx, { userId }) =>
          tx
            .select(paymentFields)
            .from(s.payments)
            .leftJoin(s.channels, eq(s.channels.id, s.payments.channelId))
            .where(eq(s.payments.userId, userId))
            .orderBy(asc(s.payments.createdAt)),
      },
      disputes: {
        fields: paymentDisputeFields,
        query: (tx, { userId }) =>
          tx
            .select(paymentDisputeFields)
            .from(s.disputes)
            .innerJoin(s.payments, eq(s.payments.id, s.disputes.paymentId))
            .where(eq(s.payments.userId, userId))
            .orderBy(asc(s.disputes.createdAt)),
      },
    },
    // Refunds and chargebacks of a payment travel with it.
    combine: ({ payments = [], disputes = [] }) =>
      payments.map((p) => ({
        ...p,
        disputes: disputes.filter((d) => d.paymentId === p.id).map(({ paymentId: _p, ...d }) => d),
      })),
  },
  {
    name: "tips.json",
    kind: "account",
    sections: {
      tips: {
        fields: tipFields,
        query: (tx, { userId }) =>
          tx
            .select(tipFields)
            .from(s.tips)
            .innerJoin(s.channels, eq(s.channels.id, s.tips.channelId))
            .where(eq(s.tips.fromUserId, userId))
            .orderBy(asc(s.tips.createdAt)),
      },
    },
  },
  {
    name: "chat.json",
    kind: "account",
    sections: {
      chat: {
        fields: chatFields,
        query: (tx, { userId }) =>
          tx
            .select(chatFields)
            .from(s.chatMessages)
            .innerJoin(s.channels, eq(s.channels.id, s.chatMessages.channelId))
            .where(eq(s.chatMessages.userId, userId))
            .orderBy(asc(s.chatMessages.createdAt)),
      },
    },
  },
  {
    name: "coop.json",
    kind: "account",
    sections: {
      memberships: {
        fields: membershipFields,
        query: (tx, { userId }) =>
          tx
            .select(membershipFields)
            .from(s.memberships)
            .where(eq(s.memberships.userId, userId))
            .orderBy(asc(s.memberships.joinedAt)),
      },
      shares: {
        fields: shareFields,
        query: (tx, { userId }) =>
          tx
            .select(shareFields)
            .from(s.membershipShares)
            .where(eq(s.membershipShares.userId, userId))
            .orderBy(asc(s.membershipShares.createdAt)),
      },
      votes: {
        fields: voteFields,
        query: (tx, { userId }) =>
          tx.select(voteFields).from(s.votes).where(eq(s.votes.userId, userId)).orderBy(asc(s.votes.castAt)),
      },
      proposals: {
        fields: proposalFields,
        query: (tx, { userId }) =>
          tx
            .select(proposalFields)
            .from(s.proposals)
            .where(eq(s.proposals.authorId, userId))
            .orderBy(asc(s.proposals.createdAt)),
      },
      comments: {
        fields: commentFields,
        query: (tx, { userId }) =>
          tx
            .select(commentFields)
            .from(s.proposalComments)
            .where(eq(s.proposalComments.authorId, userId))
            .orderBy(asc(s.proposalComments.createdAt)),
      },
      candidacies: {
        fields: candidacyFields,
        query: (tx, { userId }) =>
          tx
            .select(candidacyFields)
            .from(s.electionCandidates)
            .where(eq(s.electionCandidates.userId, userId))
            .orderBy(asc(s.electionCandidates.nominatedAt)),
      },
      boardSeats: {
        fields: boardSeatFields,
        query: (tx, { userId }) =>
          tx
            .select(boardSeatFields)
            .from(s.boardSeats)
            .where(eq(s.boardSeats.userId, userId))
            .orderBy(asc(s.boardSeats.termStart)),
      },
      patronage: {
        fields: patronageFields,
        query: (tx, { userId }) =>
          tx
            .select(patronageFields)
            .from(s.patronageAllocations)
            .innerJoin(s.patronagePeriods, eq(s.patronagePeriods.id, s.patronageAllocations.periodId))
            .where(eq(s.patronageAllocations.userId, userId))
            .orderBy(asc(s.patronagePeriods.periodStart)),
      },
    },
  },
  {
    name: "safety.json",
    kind: "account",
    sections: {
      reports: {
        fields: reportFields,
        query: (tx, { userId }) =>
          tx
            .select(reportFields)
            .from(s.reports)
            .where(eq(s.reports.reporterId, userId))
            .orderBy(asc(s.reports.createdAt)),
      },
      appeals: {
        fields: appealFields,
        query: (tx, { userId }) =>
          tx
            .select(appealFields)
            .from(s.appeals)
            .where(eq(s.appeals.appellantId, userId))
            .orderBy(asc(s.appeals.createdAt)),
      },
      dmcaCounterNotices: {
        fields: counterNoticeFields,
        query: (tx, { userId }) =>
          tx
            .select(counterNoticeFields)
            .from(s.dmcaCounterNotices)
            .where(eq(s.dmcaCounterNotices.userId, userId))
            .orderBy(asc(s.dmcaCounterNotices.createdAt)),
      },
      accountActions: {
        fields: accountActionFields,
        query: (tx, { userId }) =>
          tx
            .select(accountActionFields)
            .from(s.accountActions)
            .where(eq(s.accountActions.userId, userId))
            .orderBy(asc(s.accountActions.createdAt)),
      },
      labels: {
        fields: labelFields,
        query: (tx, { userId }) =>
          tx
            .select(labelFields)
            .from(s.contentLabels)
            .innerJoin(s.channels, eq(s.channels.id, s.contentLabels.channelId))
            .where(eq(s.channels.ownerId, userId))
            .orderBy(asc(s.contentLabels.appliedAt)),
      },
      platformActions: {
        fields: platformActionFields,
        query: (tx, { userId }) =>
          tx
            .select(platformActionFields)
            .from(s.modActions)
            .where(and(eq(s.modActions.targetUserId, userId), eq(s.modActions.scope, "platform")))
            .orderBy(asc(s.modActions.createdAt)),
      },
      channelBans: {
        fields: channelBanFields,
        query: (tx, { userId }) =>
          tx
            .select(channelBanFields)
            .from(s.modActions)
            .innerJoin(s.channels, eq(s.channels.id, s.modActions.channelId))
            .where(and(eq(s.modActions.targetUserId, userId), eq(s.modActions.scope, "channel")))
            .orderBy(asc(s.modActions.createdAt)),
      },
    },
  },
  {
    name: "enforcement_statements.json",
    kind: "account",
    sections: {
      enforcement_statements: {
        fields: enforcementStatementFields,
        query: (tx, { userId }) =>
          tx
            .select(enforcementStatementFields)
            .from(s.enforcementStatements)
            .where(eq(s.enforcementStatements.recipientUserId, userId))
            .orderBy(asc(s.enforcementStatements.createdAt), asc(s.enforcementStatements.id)),
      },
    },
  },
  {
    name: "notifications.json",
    kind: "account",
    sections: {
      notifications: {
        fields: notificationFields,
        query: (tx, { userId }) =>
          tx
            .select(notificationFields)
            .from(s.notifications)
            .where(eq(s.notifications.userId, userId))
            .orderBy(asc(s.notifications.createdAt)),
      },
      // N1 (ADR 0028).
      preferences: {
        fields: notificationPreferenceFields,
        query: (tx, { userId }) =>
          tx
            .select(notificationPreferenceFields)
            .from(s.notificationPreferences)
            .leftJoin(s.channels, eq(s.channels.id, s.notificationPreferences.channelId))
            .where(eq(s.notificationPreferences.userId, userId))
            .orderBy(asc(s.notificationPreferences.updatedAt), asc(s.notificationPreferences.id)),
      },
      pushSubscriptions: {
        fields: pushSubscriptionFields,
        query: (tx, { userId }) =>
          tx
            .select(pushSubscriptionFields)
            .from(s.pushSubscriptions)
            .where(eq(s.pushSubscriptions.userId, userId))
            .orderBy(asc(s.pushSubscriptions.createdAt), asc(s.pushSubscriptions.id)),
      },
    },
  },
  {
    name: "consents.json",
    kind: "account",
    sections: {
      consents: {
        fields: consentFields,
        query: (tx, { userId }) =>
          tx
            .select(consentFields)
            .from(s.consentRecords)
            .where(eq(s.consentRecords.userId, userId))
            .orderBy(asc(s.consentRecords.createdAt)),
      },
    },
  },
  {
    name: "developer.json",
    kind: "account",
    sections: {
      oauthApps: {
        fields: oauthAppFields,
        query: (tx, { userId }) =>
          tx
            .select(oauthAppFields)
            .from(s.oauthApps)
            .where(eq(s.oauthApps.ownerId, userId))
            .orderBy(asc(s.oauthApps.createdAt)),
      },
      tokens: {
        fields: tokenFields,
        query: (tx, { userId }) =>
          tx
            .select(tokenFields)
            .from(s.oauthTokens)
            .where(eq(s.oauthTokens.userId, userId))
            .orderBy(asc(s.oauthTokens.createdAt)),
      },
      bots: {
        fields: botFields,
        query: (tx, { userId }) =>
          tx.select(botFields).from(s.users).where(eq(s.users.botOwnerId, userId)).orderBy(asc(s.users.createdAt)),
      },
      botTokens: {
        fields: botTokenFields,
        query: (tx, { userId }) =>
          tx
            .select(botTokenFields)
            .from(s.oauthTokens)
            .innerJoin(s.users, eq(s.users.id, s.oauthTokens.userId))
            .where(eq(s.users.botOwnerId, userId))
            .orderBy(asc(s.oauthTokens.createdAt)),
      },
      webhooks: {
        fields: webhookFields,
        query: (tx, { userId }) =>
          tx
            .select(webhookFields)
            .from(s.eventSubscriptions)
            .where(eq(s.eventSubscriptions.userId, userId))
            .orderBy(asc(s.eventSubscriptions.createdAt)),
      },
    },
  },
  {
    name: "interact.json",
    kind: "account",
    sections: {
      pointsBalances: {
        fields: pointsBalanceFields,
        query: (tx, { userId }) =>
          tx
            .select(pointsBalanceFields)
            .from(s.loyaltyBalances)
            .innerJoin(s.channels, eq(s.channels.id, s.loyaltyBalances.channelId))
            .where(eq(s.loyaltyBalances.userId, userId))
            .orderBy(asc(s.channels.slug)),
      },
      pointsTransactions: {
        fields: pointsTransactionFields,
        query: (tx, { userId }) =>
          tx
            .select(pointsTransactionFields)
            .from(s.loyaltyTransactions)
            .innerJoin(s.channels, eq(s.channels.id, s.loyaltyTransactions.channelId))
            .where(eq(s.loyaltyTransactions.userId, userId))
            .orderBy(asc(s.loyaltyTransactions.createdAt), asc(s.loyaltyTransactions.id)),
      },
      pollVotes: {
        fields: pollVoteFields,
        query: (tx, { userId }) =>
          tx
            .select(pollVoteFields)
            .from(s.pollVotes)
            .innerJoin(s.polls, eq(s.polls.id, s.pollVotes.pollId))
            .innerJoin(s.channels, eq(s.channels.id, s.polls.channelId))
            .where(eq(s.pollVotes.userId, userId))
            .orderBy(asc(s.pollVotes.castAt)),
      },
      predictionBets: {
        fields: predictionBetFields,
        query: (tx, { userId }) =>
          tx
            .select(predictionBetFields)
            .from(s.predictionBets)
            .innerJoin(s.predictions, eq(s.predictions.id, s.predictionBets.predictionId))
            .innerJoin(s.channels, eq(s.channels.id, s.predictions.channelId))
            .where(eq(s.predictionBets.userId, userId))
            .orderBy(asc(s.predictionBets.placedAt)),
      },
      songRequests: {
        fields: songRequestFields,
        query: (tx, { userId }) =>
          tx
            .select(songRequestFields)
            .from(s.songRequests)
            .innerJoin(s.channels, eq(s.channels.id, s.songRequests.channelId))
            .where(eq(s.songRequests.requesterId, userId))
            .orderBy(asc(s.songRequests.createdAt)),
      },
    },
  },
  // W1: users the requester blocked (ADR 0012 decision 8), as their public slug and the time.
  {
    name: "blocks.json",
    kind: "account",
    sections: {
      blocks: {
        fields: blockFields,
        query: (tx, { userId }) =>
          tx
            .select(blockFields)
            .from(s.userBlocks)
            .innerJoin(s.users, eq(s.users.id, s.userBlocks.blockedUserId))
            .where(eq(s.userBlocks.userId, userId))
            .orderBy(asc(s.userBlocks.createdAt)),
      },
    },
  },
  {
    name: "channel.json",
    kind: "channel",
    sections: {
      settings: {
        one: true,
        fields: channelSettingsFields,
        query: (tx, scope) =>
          tx
            .select(channelSettingsFields)
            .from(s.channels)
            .leftJoin(s.categories, eq(s.categories.id, s.channels.categoryId))
            .where(and(eq(s.channels.id, channelId(scope)), eq(s.channels.ownerId, scope.userId))),
      },
      panels: {
        fields: panelFields,
        query: (tx, scope) =>
          tx
            .select(panelFields)
            .from(s.channelPanels)
            .where(eq(s.channelPanels.channelId, channelId(scope)))
            .orderBy(asc(s.channelPanels.position)),
      },
      subscriptionTiers: {
        fields: subTierFields,
        query: (tx, scope) =>
          tx
            .select(subTierFields)
            .from(s.channelSubTiers)
            .where(eq(s.channelSubTiers.channelId, channelId(scope)))
            .orderBy(asc(s.channelSubTiers.tier)),
      },
      alertConfigs: {
        fields: alertConfigFields,
        query: (tx, scope) =>
          tx
            .select(alertConfigFields)
            .from(s.alertConfigs)
            .where(eq(s.alertConfigs.channelId, channelId(scope)))
            .orderBy(asc(s.alertConfigs.type)),
      },
      simulcastTargets: {
        fields: simulcastTargetFields,
        query: (tx, scope) =>
          tx
            .select(simulcastTargetFields)
            .from(s.simulcastTargets)
            .where(eq(s.simulcastTargets.channelId, channelId(scope)))
            .orderBy(asc(s.simulcastTargets.createdAt)),
      },
      // N1 (ADR 0028): whether a Discord webhook is set, never its URL. Always one row.
      discordWebhook: {
        one: true,
        fields: discordWebhookFields,
        query: (tx, scope) =>
          tx
            .select(discordWebhookFields)
            .from(s.channels)
            .leftJoin(s.discordWebhooks, eq(s.discordWebhooks.channelId, s.channels.id))
            .where(and(eq(s.channels.id, channelId(scope)), eq(s.channels.ownerId, scope.userId))),
      },
    },
  },
  {
    name: "vods.json",
    kind: "channel",
    sections: {
      vods: {
        fields: vodFields,
        query: (tx, scope) =>
          tx
            .select(vodFields)
            .from(s.vods)
            .where(eq(s.vods.channelId, channelId(scope)))
            .orderBy(asc(s.vods.createdAt)),
      },
    },
  },
  {
    name: "clips.json",
    kind: "channel",
    sections: {
      clips: {
        fields: clipFields,
        query: (tx, scope) =>
          tx
            .select(clipFields)
            .from(s.clips)
            .where(eq(s.clips.channelId, channelId(scope)))
            .orderBy(asc(s.clips.createdAt)),
      },
    },
  },
  {
    name: "revenue.json",
    kind: "channel",
    sections: {
      revenue: {
        fields: revenueFields,
        query: (tx, scope) =>
          tx
            .select(revenueFields)
            .from(s.payments)
            .where(eq(s.payments.channelId, channelId(scope)))
            .orderBy(asc(s.payments.createdAt)),
        map: (r) => ({
          ...r,
          netCents: asNumber(r.grossCents) - asNumber(r.taxCents) - asNumber(r.feeCents),
        }),
      },
    },
  },
  {
    name: "payouts.json",
    kind: "channel",
    sections: {
      payouts: {
        fields: payoutFields,
        query: (tx, { userId }) =>
          tx
            .select(payoutFields)
            .from(s.payouts)
            .where(eq(s.payouts.userId, userId))
            .orderBy(asc(s.payouts.periodStart)),
      },
    },
  },
  {
    name: "moderation-actions.json",
    kind: "channel",
    sections: {
      actions: {
        fields: channelModActionFields,
        query: (tx, scope) =>
          tx
            .select(channelModActionFields)
            .from(s.modActions)
            .where(and(eq(s.modActions.channelId, channelId(scope)), inArray(s.modActions.scope, ["channel"])))
            .orderBy(asc(s.modActions.createdAt)),
      },
    },
  },
];

export const filesFor = (kind: ExportKind) => EXPORT_FILES.filter((f) => f.kind === kind);

/** The value a file holds, from its sections' rows. */
export function fileValue(file: ExportFile, rows: Record<string, Row[]>): unknown {
  if (file.combine) return file.combine(rows);
  const names = Object.keys(file.sections);
  const value = (name: string) => {
    const section = file.sections[name];
    const r = rows[name] ?? [];
    return section?.one ? (r[0] ?? null) : r;
  };
  if (names.length === 1 && names[0] !== undefined) return value(names[0]);
  return Object.fromEntries(names.map((n) => [n, value(n)]));
}

/** Run every section of `kind` for `scope`. Call inside the export's read-only transaction. */
export async function collect(tx: Executor, kind: ExportKind, scope: ExportScope): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const file of filesFor(kind)) {
    const rows: Record<string, Row[]> = {};
    for (const [name, section] of Object.entries(file.sections)) {
      const r = await section.query(tx, scope);
      rows[name] = section.map ? r.map((row) => section.map?.(row) ?? row) : r;
    }
    out.set(file.name, fileValue(file, rows));
  }
  return out;
}
