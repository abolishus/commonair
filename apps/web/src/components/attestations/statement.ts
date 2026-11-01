// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure helpers for the attestation views (ADR 0014). The page never trusts a payload it decodes
 * here: figures shown before verification are labelled as the statement's claim, and the verifier
 * result (`integrity.attestations.verify`) is what says whether it holds.
 */
import type { AttestationEntry } from "@commonair/contracts/dto";

export interface Envelope {
  payload: string;
  signature: string;
}

/** The figures a statement carries (ADR 0014 decision 2), integers only. */
export interface StatementFigures {
  origin: string;
  seq: number;
  kind: string;
  periodStart: string;
  periodEnd: string;
  signedAt: string;
  peakVerifiedConcurrent: number;
  verifiedViewerSeconds: number;
  durationSeconds: number;
  unverifiedViewerSeconds: number;
  excludedViewerSeconds: number;
}

const FIGURES = [
  "peakVerifiedConcurrent",
  "verifiedViewerSeconds",
  "durationSeconds",
  "unverifiedViewerSeconds",
  "excludedViewerSeconds",
  "seq",
] as const;
const TEXTS = ["origin", "kind", "periodStart", "periodEnd", "signedAt"] as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The figures of a parsed statement (the verifier's `statement`), or null when one is missing. */
export function figuresOf(s: unknown): StatementFigures | null {
  if (!isRecord(s)) return null;
  for (const k of FIGURES) if (typeof s[k] !== "number" || !Number.isSafeInteger(s[k])) return null;
  for (const k of TEXTS) if (typeof s[k] !== "string") return null;
  return s as unknown as StatementFigures;
}

/** Decode a base64url payload's JSON (unverified); null when it is not one. */
export function decodePayload(payload: string): StatementFigures | null {
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return figuresOf(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    return null;
  }
}

/** Average verified viewers over the broadcast, derived by the reader (the statement has no floats). */
export const averageViewers = (f: Pick<StatementFigures, "verifiedViewerSeconds" | "durationSeconds">): number =>
  f.durationSeconds > 0 ? f.verifiedViewerSeconds / f.durationSeconds : 0;

/** The host an origin names, for showing the signing instance prominently; the origin itself if unparsable. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const isEnvelope = (v: unknown): v is Envelope =>
  isRecord(v) && typeof v.payload === "string" && typeof v.signature === "string";

export type VerifierInput = { envelope: Envelope } | { bundle: Envelope[] };

/** Bundles the verifier accepts at most (the contract's limit). */
export const MAX_BUNDLE = 2000;

/**
 * What the verifier page was given, as the API's input: one envelope (`{payload, signature}`), an
 * entry as the API serves it (`{envelope, …}`), a list of either, or a window bundle
 * (`{entries, keys}`). Null for anything else.
 */
export function parseVerifierInput(text: string): VerifierInput | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const one = (x: unknown): Envelope | null => {
    if (isEnvelope(x)) return { payload: x.payload, signature: x.signature };
    if (isRecord(x) && isEnvelope(x.envelope)) return { payload: x.envelope.payload, signature: x.envelope.signature };
    return null;
  };
  const list = Array.isArray(v) ? v : isRecord(v) && Array.isArray(v.entries) ? v.entries : null;
  if (list) {
    const envs = list.map(one);
    if (envs.length === 0 || envs.length > MAX_BUNDLE || envs.some((e) => e === null)) return null;
    return { bundle: envs as Envelope[] };
  }
  const single = one(v);
  return single ? { envelope: single } : null;
}

/** The JSON an owner copies for a sponsor: the signed envelope exactly as stored. */
export const envelopeJson = (e: Pick<AttestationEntry, "envelope">): string =>
  JSON.stringify({ payload: e.envelope.payload, signature: e.envelope.signature });

/** Verifier problems the page explains; anything else falls back to the generic reason. */
export const PROBLEMS = [
  "malformed",
  "non_canonical",
  "bad_signature",
  "kid_mismatch",
  "unknown_kid",
  "compromised_kid",
  "wrong_origin",
  "chain_break",
  "superseded",
] as const;
export type Problem = (typeof PROBLEMS)[number];
export const isProblem = (p: string | null): p is Problem => p !== null && (PROBLEMS as readonly string[]).includes(p);
