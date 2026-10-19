// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Seed legal documents. The bodies are Markdown files next to this module (each package
 * directory is copied whole into the images, so the migrate job can read them). Instance
 * identity is never written into the text: bodies carry `{{placeholders}}` that the API
 * renders from the instance env at read time.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { LEGAL_DOCUMENT_KINDS } from "@commonair/contracts/enums";

export type LegalDocumentKind = (typeof LEGAL_DOCUMENT_KINDS)[number];

/** The draft set shipped with the software, pending lawyer review. */
export const LEGAL_SEED_VERSION = "2026-10-18-draft";
/**
 * Fixed rather than the seed's clock: the migrate job and the API run on different hosts,
 * and a database clock ahead of the API's would hide fresh rows (`publishedAt <= now`).
 */
export const LEGAL_SEED_PUBLISHED_AT = new Date("2026-10-18T00:00:00Z");

/** Every placeholder a seed document may use. The API must render all of them. */
export const LEGAL_PLACEHOLDERS = [
  "instanceName",
  "publicUrl",
  "sourceUrl",
  "minAge",
  "contacts.general",
  "contacts.security",
  "contacts.abuse",
  "contacts.dmca",
  "contacts.privacy",
  "contacts.governance",
  "contacts.conduct",
] as const;
export type LegalPlaceholder = (typeof LEGAL_PLACEHOLDERS)[number];

export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z][A-Za-z0-9.]*)\s*\}\}/g;

/** Optional storage categories named in the cookie policy; `essential` is always on. */
export const CONSENT_CATEGORIES = ["essential", "preferences"] as const;

export interface LegalSeedDocument {
  kind: LegalDocumentKind;
  version: string;
  title: string;
  body: string;
  isDraft: boolean;
  requiresAcceptance: boolean;
  publishedAt: Date;
}

const SEED_META: readonly Omit<LegalSeedDocument, "body" | "version" | "isDraft" | "publishedAt">[] = [
  { kind: "terms", title: "Terms of service", requiresAcceptance: true },
  { kind: "privacy", title: "Privacy policy", requiresAcceptance: true },
  { kind: "guidelines", title: "Community guidelines", requiresAcceptance: true },
  { kind: "cookies", title: "Cookie and storage policy", requiresAcceptance: false },
  { kind: "dmca_policy", title: "Copyright (DMCA) policy", requiresAcceptance: false },
];

/** Drop the leading SPDX comment: licensing metadata, not document text. */
export function stripSpdxHeader(markdown: string): string {
  return markdown.replace(/^\s*<!--[\s\S]*?-->\s*/, "").trimEnd() + "\n";
}

function readBody(kind: LegalDocumentKind): string {
  const path = fileURLToPath(new URL(`./${kind}.md`, import.meta.url));
  return stripSpdxHeader(readFileSync(path, "utf8"));
}

/** The seed documents, one per kind, read from disk on each call. */
export function legalSeedDocuments(): LegalSeedDocument[] {
  return SEED_META.map((m) => ({
    ...m,
    version: LEGAL_SEED_VERSION,
    isDraft: true,
    publishedAt: LEGAL_SEED_PUBLISHED_AT,
    body: readBody(m.kind),
  }));
}
