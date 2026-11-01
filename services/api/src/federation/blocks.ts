// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Domain block matching (ADR 0030 decision 7): a block on `example.social` covers that host and
 * every subdomain (`a.example.social`), never a look-alike (`badexample.social`). Hosts and
 * blocks compare lower-case without a trailing dot.
 */
import { schema, type Executor } from "@commonair/db";
import { inArray, or, sql } from "drizzle-orm";

const { federationDomainBlocks, federationFollowers } = schema;

export const normalizeDomain = (d: string) => d.trim().toLowerCase().replace(/\.$/, "");

/** `a.b.example` → `["a.b.example", "b.example", "example"]`: the blocks that would cover it. */
export function domainSuffixes(host: string): string[] {
  const labels = normalizeDomain(host).split(".").filter(Boolean);
  return labels.map((_, i) => labels.slice(i).join("."));
}

/** Pure form, for tests and callers that already hold the list. */
export function isBlockedBy(host: string, blocks: Iterable<string>): string | null {
  const set = new Set([...blocks].map(normalizeDomain));
  return domainSuffixes(host).find((s) => set.has(s)) ?? null;
}

/** The block covering `host`, if any. */
export async function blockFor(tx: Executor, host: string): Promise<string | null> {
  const suffixes = domainSuffixes(host);
  if (suffixes.length === 0) return null;
  const rows = await tx
    .select({ domain: federationDomainBlocks.domain })
    .from(federationDomainBlocks)
    .where(inArray(federationDomainBlocks.domain, suffixes));
  return isBlockedBy(
    host,
    rows.map((r) => r.domain),
  );
}

/** Followers on `domain` or a subdomain of it (SQL; `federation_followers.domain` is a host). */
export const followersOnDomain = (domain: string) => {
  const d = normalizeDomain(domain);
  return or(
    sql`lower(${federationFollowers.domain}) = ${d}`,
    sql`right(lower(${federationFollowers.domain}), ${d.length + 1}) = ${`.${d}`}`,
  );
};
