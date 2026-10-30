// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { sourceLink, type InstanceSite } from "@commonair/config/site";
import { CONSENT_CATEGORIES, PLACEHOLDER_PATTERN, schema, type Executor } from "@commonair/db";

const { legalDocuments, legalAcceptances } = schema;

type LegalRow = typeof legalDocuments.$inferSelect;
export type LegalKind = LegalRow["kind"];

export interface CurrentDocument {
  id: string;
  kind: LegalKind;
  version: string;
}

/**
 * "Newest" for legal documents: latest `publishedAt`; on a tie a final text beats a draft
 * (false sorts first); only then the version label, compared as text.
 */
const NEWEST_FIRST = [
  desc(legalDocuments.publishedAt),
  asc(legalDocuments.isDraft),
  desc(legalDocuments.version),
] as const;

/**
 * The newest published version of every kind (`publishedAt <= now`). A version scheduled for
 * the future stays invisible until its date, so acceptance never targets unpublished text.
 */
export async function latestDocuments(db: Executor, now: Date): Promise<LegalRow[]> {
  return db
    .selectDistinctOn([legalDocuments.kind])
    .from(legalDocuments)
    .where(lte(legalDocuments.publishedAt, now))
    .orderBy(asc(legalDocuments.kind), ...NEWEST_FIRST);
}

/** The current document of one kind, or a specific published version of it. */
export async function findDocument(
  db: Executor,
  kind: LegalKind,
  version: string | undefined,
  now: Date,
): Promise<LegalRow | null> {
  const [row] = await db
    .select()
    .from(legalDocuments)
    .where(
      and(
        eq(legalDocuments.kind, kind),
        lte(legalDocuments.publishedAt, now),
        version === undefined ? undefined : eq(legalDocuments.version, version),
      ),
    )
    .orderBy(...NEWEST_FIRST)
    .limit(1);
  return row ?? null;
}

/** The newest published version of each document kind that requires acceptance. */
export async function currentRequiredDocuments(db: Executor, now: Date): Promise<CurrentDocument[]> {
  const rows = await latestDocuments(db, now);
  return rows.filter((r) => r.requiresAcceptance).map(({ id, kind, version }) => ({ id, kind, version }));
}

export async function pendingDocuments(db: Executor, userId: string, now: Date): Promise<CurrentDocument[]> {
  const current = await currentRequiredDocuments(db, now);
  if (current.length === 0) return [];
  const accepted = await db
    .select({ documentId: legalAcceptances.documentId })
    .from(legalAcceptances)
    .where(
      and(
        eq(legalAcceptances.userId, userId),
        inArray(
          legalAcceptances.documentId,
          current.map((c) => c.id),
        ),
      ),
    );
  const done = new Set(accepted.map((a) => a.documentId));
  return current.filter((c) => !done.has(c.id));
}

/** Record acceptance of the given documents (ignores ids that are not current required documents). */
export async function recordAcceptances(
  db: Executor,
  userId: string,
  documentIds: readonly string[],
  now: Date,
): Promise<{ accepted: string[]; missing: CurrentDocument[] }> {
  const current = await currentRequiredDocuments(db, now);
  const wanted = new Set(documentIds);
  const accepted = current.filter((c) => wanted.has(c.id)).map((c) => c.id);
  if (accepted.length > 0)
    await db
      .insert(legalAcceptances)
      .values(accepted.map((documentId) => ({ userId, documentId, acceptedAt: now })))
      .onConflictDoNothing();
  return { accepted, missing: current.filter((c) => !wanted.has(c.id)) };
}

/** The chat retention figures the privacy policy states (`chatEnv`, ADR 0012 amendment 1 decision 6). */
export interface LegalChatRetention {
  CHAT_RETENTION_DAYS: number;
  CHAT_REPLAY_MAX_DAYS: number;
}

/** Values for the `{{placeholders}}` legal texts may use, from this instance's identity and env. */
export function legalVariables(site: InstanceSite, minAge: number, chat: LegalChatRetention): Record<string, string> {
  const vars: Record<string, string> = {
    instanceName: site.name,
    publicUrl: site.publicUrl,
    sourceUrl: sourceLink(site),
    minAge: String(minAge),
    chatRetentionDays: String(chat.CHAT_RETENTION_DAYS),
    chatReplayMaxDays: String(chat.CHAT_REPLAY_MAX_DAYS),
  };
  for (const [k, v] of Object.entries(site.contacts)) vars[`contacts.${k}`] = v;
  return vars;
}

/**
 * Fill placeholders. An unknown one is left as written so a typo in an operator-edited
 * document shows up instead of silently vanishing.
 */
export function renderLegalText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER_PATTERN, (whole, key: string) => vars[key] ?? whole);
}

// Storage categories the cookie policy names (CONSENT_CATEGORIES). `essential` is always on: a
// stored record says so whatever the client sent.
const MAX_ECHOED_KEY = 32;

export type ConsentCheck = { ok: true; choices: Record<string, boolean> } | { ok: false; reason: string };

export function normalizeConsentChoices(choices: Record<string, boolean>): ConsentCheck {
  const known = new Set<string>(CONSENT_CATEGORIES);
  const unknown = Object.keys(choices).filter((k) => !known.has(k));
  // Keys are client-supplied: echo at most a few, each truncated, so the error stays small.
  if (unknown.length > 0)
    return {
      ok: false,
      reason: `Unknown consent categories: ${unknown
        .slice(0, 5)
        .map((k) => k.slice(0, MAX_ECHOED_KEY))
        .join(", ")}`,
    };
  const out: Record<string, boolean> = {};
  for (const c of CONSENT_CATEGORIES) out[c] = c === "essential" ? true : choices[c] === true;
  return { ok: true, choices: out };
}
