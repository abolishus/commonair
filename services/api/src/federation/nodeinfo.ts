// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * NodeInfo 2.1 (ADR 0030 decision 2): software name and version, `activitypub`, and whether
 * registrations are open. `usage` carries no counts: nothing about how many people use the
 * instance is published (decision 9).
 */
import { SITE, type InstanceSite } from "@commonair/config/site";

export const NODEINFO_SCHEMA = "http://nodeinfo.diaspora.software/ns/schema/2.1";
export const NODEINFO_PROFILE = `application/json; profile="${NODEINFO_SCHEMA}#"`;

export function nodeinfoLinks(site: Pick<InstanceSite, "publicUrl">) {
  return { links: [{ rel: NODEINFO_SCHEMA, href: `${site.publicUrl}/nodeinfo/2.1` }] };
}

export function nodeinfo(site: Pick<InstanceSite, "publicUrl" | "name" | "sourceUrl">, version: string) {
  return {
    version: "2.1",
    software: {
      // The schema allows [a-z0-9-] only.
      name: SITE.slug,
      version,
      repository: site.sourceUrl,
      homepage: site.publicUrl,
    },
    protocols: ["activitypub"],
    services: { inbound: [], outbound: [] },
    // Sign-up is always open (age and ALTCHA gates apply; there is no invite-only mode).
    openRegistrations: true,
    // Required by the schema; deliberately empty.
    usage: { users: {} },
    metadata: { nodeName: site.name },
  };
}
