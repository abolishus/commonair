// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as E from "@commonair/contracts/enums";
import { bigint, pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "../ids.ts";

/** Columns are camelCase in TS and snake_case in SQL (`casing: "snake_case"`). */
export const id = () =>
  uuid()
    .primaryKey()
    .$defaultFn(() => uuidv7());
export const ts = () => timestamp({ withTimezone: true, mode: "date" });
export const createdAt = () => ts().notNull().defaultNow();
export const updatedAt = () =>
  ts()
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
/** Money is always integer minor units (cents). */
export const cents = () => bigint({ mode: "number" });

export const accountType = pgEnum("account_type", E.ACCOUNT_TYPES);
export const platformRole = pgEnum("platform_role", E.PLATFORM_ROLES);
export const channelRole = pgEnum("channel_role", E.CHANNEL_ROLES);
export const userLevel = pgEnum("user_level", E.USER_LEVELS);
export const ingestProtocol = pgEnum("ingest_protocol", E.INGEST_PROTOCOLS);
export const deliverySource = pgEnum("delivery_source", E.DELIVERY_SOURCES);
export const vodStatus = pgEnum("vod_status", E.VOD_STATUSES);
export const visibility = pgEnum("visibility", E.VISIBILITIES);
export const clipStatus = pgEnum("clip_status", E.CLIP_STATUSES);
export const simulcastPlatform = pgEnum("simulcast_platform", E.SIMULCAST_PLATFORMS);
export const simulcastStatus = pgEnum("simulcast_status", E.SIMULCAST_STATUSES);
export const sessionVerdict = pgEnum("session_verdict", E.SESSION_VERDICTS);
export const relayStatus = pgEnum("relay_status", E.RELAY_STATUSES);
export const receiptStatus = pgEnum("receipt_status", E.RECEIPT_STATUSES);
export const wordFilterAction = pgEnum("word_filter_action", E.WORD_FILTER_ACTIONS);
export const subscriptionStatus = pgEnum("subscription_status", E.SUBSCRIPTION_STATUSES);
export const paymentProvider = pgEnum("payment_provider", E.PAYMENT_PROVIDERS);
export const paymentKind = pgEnum("payment_kind", E.PAYMENT_KINDS);
export const paymentStatus = pgEnum("payment_status", E.PAYMENT_STATUSES);
export const disputeKind = pgEnum("dispute_kind", E.DISPUTE_KINDS);
export const disputeStatus = pgEnum("dispute_status", E.DISPUTE_STATUSES);
export const payoutStatus = pgEnum("payout_status", E.PAYOUT_STATUSES);
export const ledgerAccountType = pgEnum("ledger_account_type", E.LEDGER_ACCOUNT_TYPES);
export const memberClass = pgEnum("member_class", E.MEMBER_CLASSES);
export const membershipStatus = pgEnum("membership_status", E.MEMBERSHIP_STATUSES);
export const membershipBasis = pgEnum("membership_basis", E.MEMBERSHIP_BASES);
export const shareStatus = pgEnum("share_status", E.SHARE_STATUSES);
export const proposalKind = pgEnum("proposal_kind", E.PROPOSAL_KINDS);
export const proposalStatus = pgEnum("proposal_status", E.PROPOSAL_STATUSES);
export const voteChoice = pgEnum("vote_choice", E.VOTE_CHOICES);
export const councilStance = pgEnum("council_stance", E.COUNCIL_STANCES);
export const electionStatus = pgEnum("election_status", E.ELECTION_STATUSES);
export const patronageStatus = pgEnum("patronage_status", E.PATRONAGE_STATUSES);
export const integritySubject = pgEnum("integrity_subject", E.INTEGRITY_SUBJECTS);
export const integrityDecision = pgEnum("integrity_decision", E.INTEGRITY_DECISIONS);
export const appealKind = pgEnum("appeal_kind", E.APPEAL_KINDS);
export const appealStatus = pgEnum("appeal_status", E.APPEAL_STATUSES);
export const actorType = pgEnum("actor_type", E.ACTOR_TYPES);
export const reportSubject = pgEnum("report_subject", E.REPORT_SUBJECTS);
export const reportReason = pgEnum("report_reason", E.REPORT_REASONS);
export const reportStatus = pgEnum("report_status", E.REPORT_STATUSES);
export const modAction = pgEnum("mod_action", E.MOD_ACTIONS);
export const modScope = pgEnum("mod_scope", E.MOD_SCOPES);
export const dmcaStatus = pgEnum("dmca_status", E.DMCA_STATUSES);
export const legalDocumentKind = pgEnum("legal_document_kind", E.LEGAL_DOCUMENT_KINDS);
export const exportKind = pgEnum("export_kind", E.EXPORT_KINDS);
export const jobStatus = pgEnum("job_status", E.JOB_STATUSES);
export const deletionStatus = pgEnum("deletion_status", E.DELETION_STATUSES);
export const eventTransport = pgEnum("event_transport", E.EVENT_TRANSPORTS);
export const subscriptionState = pgEnum("event_subscription_state", E.SUBSCRIPTION_STATES);
export const deliveryStatus = pgEnum("delivery_status", E.DELIVERY_STATUSES);
export const pollStatus = pgEnum("poll_status", E.POLL_STATUSES);
export const predictionStatus = pgEnum("prediction_status", E.PREDICTION_STATUSES);
export const raidStatus = pgEnum("raid_status", E.RAID_STATUSES);
export const alertType = pgEnum("alert_type", E.ALERT_TYPES);
export const goalType = pgEnum("goal_type", E.GOAL_TYPES);
export const songRequestStatus = pgEnum("song_request_status", E.SONG_REQUEST_STATUSES);
export const notificationType = pgEnum("notification_type", E.NOTIFICATION_TYPES);
export const incidentStatus = pgEnum("incident_status", E.INCIDENT_STATUSES);
export const componentStatus = pgEnum("component_status", E.COMPONENT_STATUSES);
