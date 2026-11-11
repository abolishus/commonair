// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calls the admin console's home, audit log and user pages make (overhaul wave 4, D7.5), as a
 * small interface: the routes pass the real API, tests pass stubs.
 */
import type { AdminOverview, AdminUserView, ModerationCase } from "@commonair/contracts/dto";
import type * as D from "@commonair/contracts/dto";
import type { z } from "zod";
import { api } from "../../lib/api.ts";

export type AdminOverviewDto = AdminOverview;
export type AdminQueueCountDto = AdminOverview["queues"][number];
export type AdminUserViewDto = AdminUserView;
export type AuditEntryDto = z.infer<typeof D.AuditEntry>;

export interface AuditFilters {
  actorId?: string;
  subjectType?: string;
  subjectId?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ConsoleClient {
  overview(): Promise<AdminOverviewDto>;
  auditLog(filters: AuditFilters, cursor?: string): Promise<Page<AuditEntryDto>>;
  user(username: string): Promise<AdminUserViewDto>;
  revealEmail(username: string, reason: string): Promise<{ email: string }>;
  suspend(input: {
    username: string;
    target: "user" | "channel";
    suspended: boolean;
    reason: string;
    clauseId?: string;
  }): Promise<unknown>;
  assign(id: string, assigneeId: string | null): Promise<ModerationCase>;
  /** Usernames for user ids (actors in the audit log); unknown ids are absent. */
  userNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
}

export const AUDIT_PAGE = 50;
const LOOKUP_MAX = 64;

async function userNames(ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
  const unique = [...new Set(ids)];
  const names = new Map<string, string>();
  for (let i = 0; i < unique.length; i += LOOKUP_MAX) {
    const rows = await api().safety.users.lookup({ ids: unique.slice(i, i + LOOKUP_MAX) });
    for (const r of rows) names.set(r.id, r.username);
  }
  return names;
}

export const consoleClient = (): ConsoleClient => ({
  overview: () => api().admin.overview(),
  auditLog: (filters, cursor) => api().safety.auditLog({ ...filters, limit: AUDIT_PAGE, cursor }),
  user: (username) => api().admin.user({ username }),
  revealEmail: (username, reason) => api().admin.revealEmail({ username, reason }),
  suspend: (input) => api().safety.suspend(input),
  assign: (id, assigneeId) => api().moderation.assign({ id, assigneeId }),
  userNames,
});
