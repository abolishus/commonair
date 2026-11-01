// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The federation pages' calls (`federation.*`, ADR 0030) behind small interfaces, so tests pass
 * fakes. The DTOs mirror `@commonair/contracts/dto` (`FederationSettings`, `FederationFollower`,
 * `FederationDomainBlock`); the default clients below assign the real API's answers to them, so
 * a contract change that breaks the mirror fails the type check.
 */
import { api } from "../../lib/api.ts";

export interface FederationSettingsDto {
  /** The channel's own switch. */
  enabled: boolean;
  /** `FEDERATION_ENABLED` on this instance. */
  instanceEnabled: boolean;
  /** `@slug@domain` while federated. */
  handle: string | null;
  actorId: string | null;
  followers: number;
}

export interface FederationFollowerDto {
  id: string;
  /** The remote actor id (a URL). Shown as text only, never fetched or linked. */
  actor: string;
  handle: string | null;
  domain: string;
  createdAt: string;
}

export interface FederationFollowerPage {
  items: FederationFollowerDto[];
  nextCursor: string | null;
}

export interface FederationBlockDto {
  domain: string;
  createdBy: { id: string; username: string } | null;
  createdAt: string;
}

export interface FederationClient {
  get(channel: string): Promise<FederationSettingsDto>;
  update(channel: string, enabled: boolean): Promise<FederationSettingsDto>;
  followers(channel: string, cursor: string | null): Promise<FederationFollowerPage>;
  removeFollower(channel: string, id: string): Promise<void>;
}

export interface FederationAdminClient {
  blocks(): Promise<FederationBlockDto[]>;
  addBlock(domain: string): Promise<FederationBlockDto>;
  removeBlock(domain: string): Promise<void>;
  /** Rotates every channel's actor key; resolves to how many were rotated. */
  rotateAll(): Promise<number>;
}

/** Followers per page. */
export const FOLLOWERS_PAGE_SIZE = 25;

export const federationClient = (): FederationClient => ({
  get: async (channel) => api().federation.settings.get({ channel }),
  update: async (channel, enabled) => api().federation.settings.update({ channel, enabled }),
  followers: async (channel, cursor) =>
    api().federation.followers.list({ channel, limit: FOLLOWERS_PAGE_SIZE, ...(cursor ? { cursor } : {}) }),
  removeFollower: async (channel, id) => {
    await api().federation.followers.remove({ channel, id });
  },
});

export const federationAdminClient = (): FederationAdminClient => ({
  blocks: async () => api().federation.admin.blocks.list(),
  addBlock: async (domain) => api().federation.admin.blocks.add({ domain }),
  removeBlock: async (domain) => {
    await api().federation.admin.blocks.remove({ domain });
  },
  rotateAll: async () => (await api().federation.admin.keys.rotate({})).rotated,
});

/** The contract's domain rule (`federation.admin.blocks.add`), plus the 63-character label cap. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type BlockDomainCheck =
  | { ok: true; domain: string }
  | { ok: false; error: "invalid" }
  | { ok: false; error: "duplicate"; domain: string }
  | { ok: false; error: "covered"; domain: string; by: string };

/**
 * Normalize what an admin typed into a block domain and check it against the list. Accepts a
 * pasted URL or `*.domain` (a block already covers subdomains) and internationalized names (as
 * their ASCII form). A domain an existing block already covers (itself or a parent) is refused.
 */
export function checkBlockDomain(input: string, existing: readonly string[]): BlockDomainCheck {
  let s = input.trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(s)) {
    try {
      s = new URL(s).hostname;
    } catch {
      return { ok: false, error: "invalid" };
    }
  }
  s = s.replace(/^\*\./, "").replace(/\.$/, "");
  if (s !== "" && !DOMAIN.test(s) && !/[\s/:?#@\\[\]]/.test(s)) {
    // An internationalized name: the URL parser gives its ASCII (punycode) form.
    try {
      s = new URL(`http://${s}`).hostname;
    } catch {
      return { ok: false, error: "invalid" };
    }
  }
  if (s.length < 3 || s.length > 253 || !DOMAIN.test(s) || s.split(".").some((label) => label.length > 63))
    return { ok: false, error: "invalid" };
  for (const d of existing) {
    if (d === s) return { ok: false, error: "duplicate", domain: s };
    if (s.endsWith(`.${d}`)) return { ok: false, error: "covered", domain: s, by: d };
  }
  return { ok: true, domain: s };
}

/** What a follower row shows: the handle, or the actor URL as text when the handle is unknown. */
export const followerLabel = (f: FederationFollowerDto): string => f.handle ?? f.actor;
