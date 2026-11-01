// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AttestationEntry, AttestationShareLink, AttestationVerifyResult } from "@commonair/contracts/dto";
import { api } from "../../lib/api.ts";
import { allPages } from "../analytics/client.ts";
import type { VerifierInput } from "./statement.ts";

type Page<T> = { items: T[]; nextCursor: string | null };

/** The `integrity.attestations.*` calls the owner panel makes, injectable for render tests. */
export interface AttestationsClient {
  list: (q: { channel: string }) => Promise<Page<AttestationEntry>>;
  shareLinks: (q: { channel: string }) => Promise<Page<AttestationShareLink>>;
  share: (q: { channel: string; id: string }) => Promise<AttestationShareLink>;
  revoke: (q: { channel: string; id: string }) => Promise<unknown>;
}

/** The public verifier's calls. */
export interface VerifierClient {
  verify: (input: VerifierInput) => Promise<AttestationVerifyResult>;
}

/** Entries and links one request lists (the contract's page maximum). */
const PAGE = 100;
/** Days a share link lasts (the contract allows 1–90). */
export const SHARE_DAYS = 30;

export function attestationsClient(): AttestationsClient {
  return {
    list: (q) =>
      allPages((cursor) => api().integrity.attestations.list({ channel: q.channel, limit: PAGE, cursor }), 10),
    shareLinks: (q) =>
      allPages((cursor) => api().integrity.attestations.shareLinks.list({ channel: q.channel, limit: PAGE, cursor })),
    share: (q) => api().integrity.attestations.share({ ...q, expiresInDays: SHARE_DAYS }),
    revoke: (q) => api().integrity.attestations.shareLinks.revoke(q),
  };
}

export function verifierClient(): VerifierClient {
  return {
    verify: (input) => api().integrity.attestations.verify(input),
  };
}
