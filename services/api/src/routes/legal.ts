// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `legal.*`: the published legal documents, rendered for this instance, and cookie/storage
 * consent records. Documents carry `{{placeholders}}` (instance name, contacts) so the same
 * text serves every instance; drafts pending lawyer review are flagged with `isDraft`.
 */
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { iso } from "../lib/dto.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import {
  findDocument,
  latestDocuments,
  legalVariables,
  normalizeConsentChoices,
  renderLegalText,
} from "../lib/legal.ts";
import { os } from "../lib/orpc.ts";

type LegalRow = typeof schema.legalDocuments.$inferSelect;

function toDto(deps: Deps, row: LegalRow) {
  const vars = legalVariables(deps.site, deps.env.AUTH_MIN_AGE);
  return {
    id: row.id,
    kind: row.kind,
    version: row.version,
    title: renderLegalText(row.title, vars),
    body: renderLegalText(row.body, vars),
    isDraft: row.isDraft,
    requiresAcceptance: row.requiresAcceptance,
    publishedAt: iso(row.publishedAt),
  };
}

export const legal = {
  current: os.legal.current.handler(async ({ context }) => {
    const { deps } = context;
    const rows = await latestDocuments(deps.db, deps.now());
    return rows.map((r) => toDto(deps, r));
  }),

  get: os.legal.get.handler(async ({ context, input }) => {
    const { deps } = context;
    const row = await findDocument(deps.db, input.kind, input.version, deps.now());
    if (!row) throw notFound("Legal document not found");
    return toDto(deps, row);
  }),

  consent: os.legal.consent.handler(async ({ context, input }) => {
    const { deps, caller } = context;
    if (!caller && !input.anonymousId) throw badRequest("anonymousId is required when signed out");
    const policy = await findDocument(deps.db, "cookies", undefined, deps.now());
    if (!policy || policy.version !== input.policyVersion)
      throw badRequest("policyVersion is not the current cookie policy");
    const checked = normalizeConsentChoices(input.choices);
    if (!checked.ok) throw badRequest(checked.reason);
    await deps.db.insert(schema.consentRecords).values({
      userId: caller?.user.id ?? null,
      // A signed-in record never stores the cookie id: keeping both would link a visitor's
      // pre-sign-in browsing identity to their account.
      anonymousId: caller ? null : (input.anonymousId ?? null),
      choices: checked.choices,
      policyVersion: policy.version,
      createdAt: deps.now(),
    });
    return { ok: true as const };
  }),
};
