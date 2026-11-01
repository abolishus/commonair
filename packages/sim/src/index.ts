// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulated chat and viewers for rehearsal mode (batch 6 decision (h)), and the assembly of the
 * rehearsal checklist. Pure and clock-injected; the rehearsal driver in services/worker runs it.
 * Written for rehearsal: the harness keeps its own bots.
 */
export {
  BURST_BODY,
  chatScript,
  DEFAULT_BURST,
  DEFAULT_RATE,
  DEFAULT_VIEWERS,
  dueMessages,
  REPEATED_BODY,
  sampleableWords,
  SIM_MESSAGE_KINDS,
  type BurstOptions,
  type ChatScriptOptions,
  type SimMessage,
  type SimMessageKind,
} from "./chat.ts";
export { hashSeed, seededRandom, type Random } from "./random.ts";
export {
  BITRATE_DIP_FRACTION,
  CHAT_RULES,
  DEFAULT_SAMPLE_INTERVAL_MS,
  emptyTally,
  FPS_DIP_FRACTION,
  INGEST_CHECKS,
  ingestChecks,
  median,
  ruleOf,
  sumCounts,
  tally,
  type ChatOutcome,
  type ChatRule,
  type ChatTally,
  type Dip,
  type HealthSample,
  type IngestCheck,
  type IngestCheckName,
  type RuleCounts,
} from "./report.ts";
export { EARLY_VIEWERS, presentAt, viewerKey, viewers, type SimViewer, type ViewersOptions } from "./viewers.ts";
