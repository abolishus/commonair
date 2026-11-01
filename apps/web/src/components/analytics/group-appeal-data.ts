// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the "Appeal this group" action knows (decision (m)): the owner's group appeals from
 * `appeals.mine`, shared by every excluded-group row of the page through one small store per
 * client, so one request serves all rows and a new appeal updates them all. The server enforces
 * the limits; this only says them in advance.
 */
import type * as D from "@commonair/contracts/dto";
import { type ExclusionCategory, GROUP_APPEAL_RULES } from "@commonair/contracts/enums";
import * as React from "react";
import type { z } from "zod";
import { api } from "../../lib/api.ts";

export type Appeal = z.infer<typeof D.Appeal>;

const DAY_MS = 86_400_000;
export const GROUP_APPEAL_WINDOW_MS = GROUP_APPEAL_RULES.windowDays * DAY_MS;

export interface GroupAppealClient {
  mine: () => Promise<Appeal[]>;
  create: (q: { broadcastId: string; category: ExclusionCategory; body: string }) => Promise<Appeal>;
}

export const groupAppealClient = (): GroupAppealClient => ({
  mine: () => api().appeals.mine(),
  create: (q) =>
    api().appeals.create({
      kind: "integrity",
      subjectType: "exclusion_group",
      subjectId: q.broadcastId,
      category: q.category,
      body: q.body,
    }),
});

/** `group-appeal-open` `data-state`. */
export type GroupAppealState = "available" | "appealed" | "limited";

export interface GroupAppealView {
  state: GroupAppealState;
  /** This group's own appeal (its status is the decided result), or null. */
  own: Appeal | null;
  /**
   * The broadcast's group appeal (any category), newest first, so a row of another category can
   * say which group was appealed and how it was decided: an overturn drops its own group's row.
   */
  broadcastAppeal: Appeal | null;
  /** Appeals left on the channel in the rolling window. */
  remaining: number;
  /** When the next one frees up (ISO), while none is left. */
  nextAt: string | null;
}

/**
 * The action's state for one group: `appealed` once the broadcast has any group appeal (one per
 * broadcast, any category and status), `limited` while the window is full, otherwise `available`.
 * `mine` lists only the caller's appeals, and only a channel's owner can appeal its groups, so the
 * caller's group appeals are the channel's.
 */
export function groupAppealView(
  appeals: readonly Appeal[],
  q: { broadcastId: string; category: ExclusionCategory; now: number },
): GroupAppealView {
  const groups = appeals.filter((a) => a.subjectType === "exclusion_group");
  const own = groups.find((a) => a.subjectId === q.broadcastId && a.exclusionCategory === q.category) ?? null;
  const broadcastAppeal =
    groups
      .filter((a) => a.subjectId === q.broadcastId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  const inWindow = groups
    .map((a) => Date.parse(a.createdAt))
    .filter((t) => t > q.now - GROUP_APPEAL_WINDOW_MS)
    .sort((a, b) => a - b);
  const remaining = Math.max(0, GROUP_APPEAL_RULES.perChannel - inWindow.length);
  const freeing = remaining === 0 ? inWindow[inWindow.length - GROUP_APPEAL_RULES.perChannel] : undefined;
  const nextAt = freeing === undefined ? null : new Date(freeing + GROUP_APPEAL_WINDOW_MS).toISOString();
  const state: GroupAppealState = broadcastAppeal ? "appealed" : remaining === 0 ? "limited" : "available";
  return { state, own, broadcastAppeal, remaining, nextAt };
}

/** `retryAfterSeconds` of a RATE_LIMITED refusal, or null for any other error. */
export function rateLimitedFor(err: unknown): number | null {
  if (typeof err !== "object" || err === null || (err as { code?: unknown }).code !== "RATE_LIMITED") return null;
  const s = (err as { data?: { retryAfterSeconds?: unknown } }).data?.retryAfterSeconds;
  return typeof s === "number" ? s : 0;
}

interface Snapshot {
  appeals: Appeal[] | null;
  failed: boolean;
}

class GroupAppealStore {
  private snapshot: Snapshot = { appeals: null, failed: false };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  constructor(private readonly client: GroupAppealClient) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  get = (): Snapshot => this.snapshot;
  private set(s: Snapshot) {
    this.snapshot = s;
    for (const l of this.listeners) l();
  }
  /**
   * One request for every row: `force` reloads while the last list stays on screen, so a page
   * visited again shows decisions made since (the store outlives the page).
   */
  load(force = false): void {
    if (this.loading || (!force && this.snapshot.appeals !== null)) return;
    this.loading = this.client
      .mine()
      .then((appeals) => this.set({ appeals, failed: false }))
      .catch(() => this.set({ appeals: this.snapshot.appeals, failed: true }))
      .finally(() => {
        this.loading = null;
      });
  }
  add(a: Appeal): void {
    this.set({ appeals: [a, ...(this.snapshot.appeals ?? []).filter((x) => x.id !== a.id)], failed: false });
  }
  async create(q: Parameters<GroupAppealClient["create"]>[0]): Promise<Appeal> {
    const a = await this.client.create(q);
    this.add(a);
    return a;
  }
}

const stores = new WeakMap<GroupAppealClient, GroupAppealStore>();
let defaultClient: GroupAppealClient | null = null;

/** The shared store for `client` (the app's default client when none is given). */
export function useGroupAppeals(client?: GroupAppealClient) {
  const c = client ?? (defaultClient ??= groupAppealClient());
  let store = stores.get(c);
  if (!store) {
    store = new GroupAppealStore(c);
    stores.set(c, store);
  }
  const s = store;
  const snapshot = React.useSyncExternalStore(s.subscribe, s.get, s.get);
  React.useEffect(() => s.load(true), [s]);
  return {
    ...snapshot,
    reload: () => s.load(true),
    create: (q: Parameters<GroupAppealClient["create"]>[0]) => s.create(q),
  };
}
