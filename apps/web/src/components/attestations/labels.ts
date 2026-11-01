// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Message keys for attestation kinds, exclusion categories and verifier problems (literals only). */
import type { ATTESTATION_KINDS, ExclusionCategory } from "@commonair/contracts/enums";
import type { MessageKey } from "../../i18n/index.ts";
import type { Problem } from "./statement.ts";

export const KIND_KEYS: Record<(typeof ATTESTATION_KINDS)[number], MessageKey> = {
  broadcast: "attestations.entry.kind.broadcast",
  supersede: "attestations.entry.kind.supersede",
  reissue: "attestations.entry.kind.reissue",
};

/** A kind the page shows; an unknown one (a newer statement version) reads as an original. */
export const kindKey = (k: string): MessageKey =>
  k === "supersede" || k === "reissue" ? KIND_KEYS[k] : KIND_KEYS.broadcast;

export const CATEGORY_KEYS: Record<ExclusionCategory, MessageKey> = {
  datacenter: "attestations.category.datacenter",
  privacy_relay: "attestations.category.privacy_relay",
  concurrency: "attestations.category.concurrency",
  automation: "attestations.category.automation",
  playback_pattern: "attestations.category.playback_pattern",
  other: "attestations.category.other",
};

export const PROBLEM_KEYS: Record<Problem | "unknown", MessageKey> = {
  malformed: "attestations.verify.problem.malformed",
  non_canonical: "attestations.verify.problem.non_canonical",
  bad_signature: "attestations.verify.problem.bad_signature",
  kid_mismatch: "attestations.verify.problem.kid_mismatch",
  unknown_kid: "attestations.verify.problem.unknown_kid",
  compromised_kid: "attestations.verify.problem.compromised_kid",
  wrong_origin: "attestations.verify.problem.wrong_origin",
  chain_break: "attestations.verify.problem.chain_break",
  superseded: "attestations.verify.problem.superseded",
  unknown: "attestations.verify.problem.unknown",
};
