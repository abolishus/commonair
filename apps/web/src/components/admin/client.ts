// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calls the E7 admin pages make (egress, incidents, integrity flags), as small interfaces:
 * the routes pass the real API, tests pass stubs.
 */
import type * as D from "@commonair/contracts/dto";
import type {
  DELIVERY_SOURCES,
  INCIDENT_STATUSES,
  INTEGRITY_DECISIONS,
  INTEGRITY_SUBJECTS,
} from "@commonair/contracts/enums";
import type { z } from "zod";
import { api } from "../../lib/api.ts";

export type EgressReportDto = z.infer<typeof D.EgressReport>;
export type StatusSummaryDto = z.infer<typeof D.StatusSummary>;
export type IncidentDto = StatusSummaryDto["incidents"][number];
export type IntegrityFlagDto = z.infer<typeof D.IntegrityFlag>;
export type DeliverySource = (typeof DELIVERY_SOURCES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IntegritySubject = (typeof INTEGRITY_SUBJECTS)[number];
export type IntegrityDecision = (typeof INTEGRITY_DECISIONS)[number];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface EgressClient {
  report(range: { from: string; to: string }): Promise<EgressReportDto>;
}
export const egressClient = (): EgressClient => ({ report: (range) => api().admin.egress(range) });

export interface IncidentInput {
  id?: string;
  title: string;
  status: IncidentStatus;
  components: string[];
  body: string;
}
export interface IncidentsClient {
  status(): Promise<StatusSummaryDto>;
  write(input: IncidentInput): Promise<{ id: string }>;
}
export const incidentsClient = (): IncidentsClient => ({
  status: () => api().instance.status(),
  write: (input) => api().admin.incidents(input),
});

export interface FlagFilters {
  subjectType?: IntegritySubject;
  decision?: IntegrityDecision;
  channel?: string;
}
export interface IntegrityClient {
  flags(filters: FlagFilters, cursor?: string): Promise<Page<IntegrityFlagDto>>;
  decide(input: { id: string; decision: "excluded" | "allowed"; reason: string }): Promise<IntegrityFlagDto>;
}
const PAGE = 50;
export const integrityClient = (): IntegrityClient => ({
  flags: (filters, cursor) => api().integrity.flags({ ...filters, limit: PAGE, cursor }),
  decide: (input) => api().integrity.decide(input),
});
