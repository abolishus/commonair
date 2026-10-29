// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The project's identity: name, flagship domain, and contact addresses.
 *
 * This is the ONLY file in the codebase allowed to contain these literals.
 * `scripts/check-domains.ts` fails the build if they appear anywhere else.
 * Self-hosted instances override the instance-facing values (public URL,
 * instance name, contacts) through environment variables; see `env.ts` and
 * `instanceSite()`. The project identity itself (source repository, trademark
 * holder) stays fixed so the AGPL source link always points somewhere real.
 */
export const SITE = {
  name: "CommonAir",
  slug: "commonair",
  tagline: "Live streaming, owned by the people who make it.",
  domain: "commonair.tv",
  url: "https://commonair.tv",
  repository: {
    owner: "abolishus",
    name: "commonair",
    url: "https://github.com/abolishus/commonair",
  },
  npmScope: "@commonair",
  containerRegistry: "ghcr.io/abolishus",
  contacts: {
    general: "hello@commonair.tv",
    security: "security@commonair.tv",
    abuse: "abuse@commonair.tv",
    dmca: "dmca@commonair.tv",
    privacy: "privacy@commonair.tv",
    governance: "governance@commonair.tv",
    conduct: "conduct@commonair.tv",
    noreply: "noreply@commonair.tv",
  },
} as const;

export type Site = typeof SITE;

/** Literals that must never appear outside this module (enforced by check-domains). */
export const PROTECTED_LITERALS: readonly string[] = [SITE.domain, ...Object.values(SITE.contacts)];

export interface InstanceSite {
  /** Display name of this instance (defaults to the project name). */
  name: string;
  /** Public origin of the web app, no trailing slash. */
  publicUrl: string;
  /** Contact addresses shown to users of this instance. */
  contacts: Record<keyof Site["contacts"], string>;
  /** Source repository URL for the AGPL §13 "Source" link. */
  sourceUrl: string;
  /** Exact commit this instance runs. */
  sourceCommit: string;
  /** True when this instance is the co-op's flagship deployment. */
  isFlagship: boolean;
  /** `INSTANCE_DEFAULT_LOCALE`: the language for users and visitors who have not chosen one. */
  defaultLocale: string;
}

/** Link to the exact commit this instance runs (AGPL §13). */
export function sourceLink(site: Pick<InstanceSite, "sourceUrl" | "sourceCommit">): string {
  const base = site.sourceUrl.replace(/\/+$/, "");
  if (site.sourceCommit === "" || site.sourceCommit === "unknown") return base;
  return `${base}/tree/${site.sourceCommit}`;
}
