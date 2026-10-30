// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sample data for every template, used by `bun run preview` and the tests.
 * Links are built from the instance's public URL, as real callers must.
 */
import type { TemplateData } from "./registry.ts";
import type { TemplateId } from "./template.tsx";

export type SampleData = { [K in TemplateId]: TemplateData<K> };

export interface SampleValues {
  displayName: string;
  channelName: string;
  proposalTitle: string;
  contentTitle: string;
  device: string;
  location: string;
  foundIn: string;
  /** A moderator's note on a DMCA decision. */
  decisionNote: string;
  /** A postal address (DMCA counter-notice). */
  address: string;
  /** A counter-notice statement. */
  statement: string;
}

export const ENGLISH_SAMPLE_VALUES: SampleValues = {
  displayName: "Ada",
  channelName: "ada_plays",
  proposalTitle: "Raise the creator share to 85%",
  contentTitle: "Speedrun night, part 2",
  device: "Firefox on Linux",
  location: "Lisbon, Portugal",
  foundIn: "a public code repository",
  decisionNote: "The notice does not identify the copyrighted work.",
  address: "1 Example Street, Springfield",
  statement: "I recorded this performance myself and hold the rights to it.",
};

export function sampleData(publicUrl: string, v: SampleValues = ENGLISH_SAMPLE_VALUES): SampleData {
  const url = (path: string) => `${publicUrl.replace(/\/+$/, "")}${path}`;
  const at = "2026-10-18T14:30:00Z";
  return {
    verifyEmail: { displayName: v.displayName, verifyUrl: url("/verify-email?token=sample"), expiresInMinutes: 60 },
    magicLink: { signInUrl: url("/sign-in/magic?token=sample"), expiresInMinutes: 15 },
    passwordReset: { resetUrl: url("/reset-password?token=sample"), expiresInMinutes: 30 },
    twoFactorEnabled: { changedAt: at, securityUrl: url("/settings/security") },
    twoFactorDisabled: { changedAt: at, securityUrl: url("/settings/security") },
    newSignIn: {
      signedInAt: at,
      device: v.device,
      approximateLocation: v.location,
      sessionsUrl: url("/settings/security/sessions"),
    },
    streamKeyRevoked: {
      channelName: v.channelName,
      detectedAt: at,
      foundIn: v.foundIn,
      streamKeysUrl: url("/dashboard/stream-keys"),
    },
    dataExportReady: { downloadUrl: url("/settings/privacy/exports/sample"), expiresAt: "2026-10-25T14:30:00Z" },
    accountDeletionScheduled: { deleteAt: "2026-11-17T00:00:00Z", cancelUrl: url("/settings/account/deletion") },
    accountDeletionCompleted: { deletedAt: at },
    payoutSent: {
      amountCents: 123_456,
      currency: "EUR",
      sentAt: at,
      reference: "PO-2026-10-0042",
      earningsUrl: url("/dashboard/earnings"),
    },
    chargebackNotice: {
      kind: "chargeback",
      amountCents: 499,
      currency: "EUR",
      occurredAt: at,
      reference: "CB-7731",
      earningsUrl: url("/dashboard/earnings"),
    },
    governanceVoteOpened: {
      proposalTitle: v.proposalTitle,
      closesAt: "2026-11-01T18:00:00Z",
      voteUrl: url("/coop/proposals/sample"),
      unsubscribeUrl: url("/api/email/unsubscribe?list=governance&token=sample"),
    },
    governanceResultPublished: {
      proposalTitle: v.proposalTitle,
      outcome: "passed",
      turnout: 0.412,
      resultUrl: url("/coop/proposals/sample"),
      unsubscribeUrl: url("/api/email/unsubscribe?list=governance&token=sample"),
    },
    councilReviewRequested: {
      proposalTitle: v.proposalTitle,
      reviewEndsAt: "2026-10-25T18:00:00Z",
      respondUrl: url("/coop/proposals/sample/council-response"),
    },
    goLiveDigest: {
      channels: [
        { name: v.channelName, title: v.contentTitle, url: url(`/${encodeURIComponent(v.channelName)}`) },
        { name: v.displayName, title: "", url: url("/sample_channel") },
      ],
      settingsUrl: url("/settings/notifications"),
      unsubscribeUrl: url("/api/email/unsubscribe?list=go_live&token=sample"),
    },
    dmcaNoticeReceived: {
      contentTitle: v.contentTitle,
      noticeRef: "DMCA-2026-0091",
      receivedAt: at,
      noticeUrl: url("/settings/copyright?notice=sample"),
    },
    dmcaNoticeDecided: {
      noticeRef: "DMCA-2026-0091",
      decision: "rejected",
      decidedAt: at,
      note: v.decisionNote,
      removedItems: 0,
      totalItems: 2,
    },
    dmcaCounterNoticeForwarded: {
      noticeRef: "DMCA-2026-0091",
      fullName: v.displayName,
      address: v.address,
      phone: "+1 555 0100",
      statement: v.statement,
      signature: `/s/ ${v.displayName}`,
      items: [url("/ada_plays/clip/sample")],
      receivedAt: at,
      restoreAfter: "2026-11-03T14:30:00Z",
    },
    contentRestored: { contentTitle: v.contentTitle, restoredAt: at, contentUrl: url("/videos/sample") },
    appealDecided: {
      appealRef: "AP-1207",
      kind: "moderation",
      outcome: "overturned",
      decidedAt: at,
      decisionUrl: url("/settings/appeals/sample"),
    },
    enforcementStatement: {
      statementRef: "SR-3F9A21C7",
      appliedAt: at,
      contentType: "broadcast",
      restrictionKind: "visibility",
      restrictionDetail: "restricted",
      endsAt: null,
      facts: { code: "classifier", category: "weapons", tier: "t1", threshold: 0.95, capturedAt: at },
      source: "own_initiative",
      automatedDetection: true,
      automatedDecision: "fully",
      groundKind: "terms",
      clauseTitleKey: "clause.safety.weapons",
      clauseRef: "safety.weapons@1",
      legalBasis: null,
      explanation:
        "Content that shows weapons in a way that threatens people or puts them at serious risk is not allowed.",
      redress: "If you think we got it wrong, you can appeal from your account's appeals page.",
      appealable: true,
      noticeIsDraft: true,
      appealsUrl: url("/settings/appeals"),
    },
  };
}
