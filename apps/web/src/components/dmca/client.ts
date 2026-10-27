// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The DMCA calls the pages make (E7-dmca), as small interfaces: routes pass the real API, tests
 * pass stubs. Claimant and counter-notice details live only in component state.
 */
import type * as D from "@commonair/contracts/dto";
import type { DMCA_STATUSES } from "@commonair/contracts/enums";
import { api } from "../../lib/api.ts";
import type { LegalDoc } from "../legal-document-link.tsx";

export type DmcaStatus = (typeof DMCA_STATUSES)[number];
export type DmcaNoticeDto = D.DmcaNotice;
export type DmcaNoticeItemDto = D.DmcaNoticeItem;
export type DmcaCounterNoticeDto = D.DmcaCounterNotice;
export type DmcaNoticeForOwnerDto = D.DmcaNoticeForOwner;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface DmcaSubmitInput {
  claimantName: string;
  claimantEmail: string;
  claimantAddress: string;
  claimantPhone?: string;
  copyrightedWork: string;
  infringingUrls: string[];
  goodFaithStatement: true;
  accuracyStatement: true;
  signature: string;
  altcha: string;
}

export interface DmcaNoticeClient {
  submit(input: DmcaSubmitInput): Promise<{ id: string }>;
  /** The instance's DMCA policy (seeded legal document), or null when there is none. */
  policy(): Promise<LegalDoc | null>;
}
export const dmcaNoticeClient = (): DmcaNoticeClient => ({
  submit: (input) => api().safety.dmca.submit(input),
  policy: async () => (await api().legal.current()).find((d) => d.kind === "dmca_policy") ?? null,
});

export interface CounterInput {
  id: string;
  fullName: string;
  address: string;
  phone: string;
  itemIds: string[];
  statement: string;
  goodFaithStatement: true;
  consentToJurisdiction: true;
  signature: string;
}

export interface CopyrightClient {
  mine(): Promise<DmcaNoticeForOwnerDto[]>;
  counter(input: CounterInput): Promise<{ restoreAfter: string }>;
}
export const copyrightClient = (): CopyrightClient => ({
  mine: () => api().safety.dmca.mine(),
  counter: (input) => api().safety.dmca.counter(input),
});

export interface DmcaQueueClient {
  queue(status: DmcaStatus, cursor?: string): Promise<Page<DmcaNoticeDto>>;
  action(input: { id: string; decision: "actioned" | "rejected"; note: string }): Promise<DmcaNoticeDto>;
  suitFiled(input: { id: string; note: string }): Promise<DmcaNoticeDto>;
}
const PAGE = 50;
export const dmcaQueueClient = (): DmcaQueueClient => ({
  queue: (status, cursor) => api().safety.dmca.queue({ status, limit: PAGE, cursor }),
  action: (input) => api().safety.dmca.action(input),
  suitFiled: (input) => api().safety.dmca.suitFiled(input),
});
