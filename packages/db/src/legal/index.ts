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
 * `enforcement_notice` has its own seed version (ADR 0019): a published version is immutable and
 * the seed never rewrites a row, so the skeleton seeded before W0-sor's text must not share a
 * version with that text. Bump this (not `LEGAL_SEED_VERSION`, which would make everyone re-accept
 * the terms) when the shipped notice changes and an older one may have reached a database.
 */
export const ENFORCEMENT_NOTICE_SEED_VERSION = "2026-10-27-draft";
/**
 * The terms reached databases at `LEGAL_SEED_VERSION`; the channel points clause (ADR 0026
 * decision 3: points have no cash value) is a new version, so every signed-in user is asked to
 * accept the terms again (same publishedAt, the version sorts later). Draft: counsel has not
 * reviewed the clause.
 */
export const TERMS_SEED_VERSION = "2026-10-29-points-draft";
/**
 * `privacy` took its own version for the peer-to-peer sections (ADR 0005 amendment 1) after
 * `LEGAL_SEED_VERSION` reached databases, and moved again for the channel-features paragraph
 * (ADR 0026). Each new version sorts after the accepted one, so every signed-in user is asked to
 * accept it again. Draft: counsel has not reviewed the paragraph.
 */
export const PRIVACY_SEED_VERSION = "2026-10-29-interact-draft";
/**
 * `cookies` took its own version for the peer-to-peer sections (ADR 0005 amendment 1) after
 * `LEGAL_SEED_VERSION` reached databases, and moved again for the language line in Preferences
 * (ADR 0029); the cookie policy needs no acceptance. Draft: counsel has not reviewed it.
 */
export const COOKIES_SEED_VERSION = "2026-10-29-i18n-draft";
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

type SeedMeta = Omit<LegalSeedDocument, "body" | "version" | "isDraft" | "publishedAt"> & {
  /** Defaults to `LEGAL_SEED_VERSION`. */
  version?: string;
};

const SEED_META: readonly SeedMeta[] = [
  { kind: "terms", title: "Terms of service", requiresAcceptance: true, version: TERMS_SEED_VERSION },
  { kind: "privacy", title: "Privacy policy", requiresAcceptance: true, version: PRIVACY_SEED_VERSION },
  { kind: "guidelines", title: "Community guidelines", requiresAcceptance: true },
  { kind: "cookies", title: "Cookie and storage policy", requiresAcceptance: false, version: COOKIES_SEED_VERSION },
  { kind: "dmca_policy", title: "Copyright (DMCA) policy", requiresAcceptance: false },
  {
    kind: "enforcement_notice",
    title: "Statements of reasons",
    requiresAcceptance: false,
    version: ENFORCEMENT_NOTICE_SEED_VERSION,
  },
];

/** The version the seed ships for `kind`. */
export function legalSeedVersion(kind: LegalDocumentKind): string {
  return SEED_META.find((m) => m.kind === kind)?.version ?? LEGAL_SEED_VERSION;
}

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
    version: legalSeedVersion(m.kind),
    isDraft: true,
    publishedAt: LEGAL_SEED_PUBLISHED_AT,
    body: readBody(m.kind),
  }));
}
