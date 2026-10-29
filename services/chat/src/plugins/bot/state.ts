// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Per-channel bot state, loaded lazily and cached per part (config, commands, timers, variables).
 * `BUS.botControl` drops one part of one channel; a TTL is the backstop for a lost message. The
 * cache is bounded and channels no longer hosted on this instance are evicted.
 */
import { and, eq } from "drizzle-orm";
import type { BOT_CONTROL_SCOPES } from "@commonair/contracts/enums";
import { BotConfig } from "@commonair/contracts/shapes";
import { schema, type Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { UserLevel } from "./levels.ts";
import { indexCommands } from "./parse.ts";

export type BotScope = (typeof BOT_CONTROL_SCOPES)[number];

export interface ChannelBotConfig {
  botUserId: string;
  config: BotConfig;
}

export interface CommandDef {
  id: string;
  name: string;
  aliases: string[];
  response: string;
  userLevel: UserLevel;
  cooldownSeconds: number;
  costPoints: number;
}

export interface CommandSet {
  /** Enabled commands by name and alias. */
  index: ReadonlyMap<string, CommandDef>;
  /** Enabled commands, by name. */
  list: readonly CommandDef[];
}

export interface TimerDef {
  id: string;
  message: string;
  intervalMinutes: number;
  minChatLines: number;
}

export const STATE_TTL_MS = 60_000;
/** Channels kept per part; the oldest entry goes first past it. */
export const STATE_MAX_CHANNELS = 2_000;

interface Entry<T> {
  value: T;
  at: number;
}

/** One cached part: TTL, bound, in-flight dedupe, and a generation so a drop beats a slow load. */
export class PartCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly generation = new Map<string, number>();

  constructor(
    private readonly load: (channelId: string) => Promise<T>,
    private readonly opts: { ttlMs: number; max: number; now: () => number },
  ) {}

  async get(channelId: string): Promise<T> {
    const hit = this.entries.get(channelId);
    if (hit && this.opts.now() - hit.at < this.opts.ttlMs) return hit.value;
    const pending = this.inflight.get(channelId);
    if (pending) return pending;
    const gen = this.generation.get(channelId) ?? 0;
    const p = this.load(channelId)
      .then((value) => {
        if ((this.generation.get(channelId) ?? 0) === gen) this.put(channelId, value);
        return value;
      })
      .finally(() => {
        if (this.inflight.get(channelId) === p) this.inflight.delete(channelId);
      });
    this.inflight.set(channelId, p);
    return p;
  }

  drop(channelId: string): void {
    this.entries.delete(channelId);
    this.inflight.delete(channelId);
    this.generation.set(channelId, (this.generation.get(channelId) ?? 0) + 1);
  }

  /** Forget every channel not in `keep`. */
  retain(keep: ReadonlySet<string>): void {
    for (const id of this.entries.keys()) if (!keep.has(id)) this.entries.delete(id);
    for (const id of this.generation.keys()) if (!keep.has(id) && !this.inflight.has(id)) this.generation.delete(id);
  }

  get size(): number {
    return this.entries.size;
  }

  private put(channelId: string, value: T): void {
    this.entries.delete(channelId);
    this.entries.set(channelId, { value, at: this.opts.now() });
    while (this.entries.size > this.opts.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

export class BotState {
  readonly config: PartCache<ChannelBotConfig | null>;
  readonly commands: PartCache<CommandSet>;
  readonly timers: PartCache<readonly TimerDef[]>;
  readonly variables: PartCache<ReadonlyMap<string, string>>;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    opts: { ttlMs?: number; max?: number; now?: () => number } = {},
  ) {
    const o = { ttlMs: opts.ttlMs ?? STATE_TTL_MS, max: opts.max ?? STATE_MAX_CHANNELS, now: opts.now ?? Date.now };
    this.config = new PartCache((id) => this.loadConfig(id), o);
    this.commands = new PartCache((id) => this.loadCommands(id), o);
    this.timers = new PartCache((id) => this.loadTimers(id), o);
    this.variables = new PartCache((id) => this.loadVariables(id), o);
  }

  drop(channelId: string, scope: BotScope): void {
    this.part(scope).drop(channelId);
  }

  retain(keep: ReadonlySet<string>): void {
    for (const scope of ["config", "commands", "timers", "variables"] as const) this.part(scope).retain(keep);
  }

  private part(scope: BotScope): { drop(id: string): void; retain(keep: ReadonlySet<string>): void } {
    switch (scope) {
      case "config":
        return this.config;
      case "commands":
        return this.commands;
      case "timers":
        return this.timers;
      case "variables":
        return this.variables;
    }
  }

  /** Null when the bot is off in the channel: no row, disabled, or no bot account yet. */
  private async loadConfig(channelId: string): Promise<ChannelBotConfig | null> {
    const t = schema.botConfigs;
    const [row] = await this.db
      .select({ enabled: t.enabled, config: t.config, botUserId: t.botUserId })
      .from(t)
      .where(eq(t.channelId, channelId))
      .limit(1);
    if (!row || !row.enabled || !row.botUserId) return null;
    const parsed = BotConfig.safeParse(row.config);
    if (!parsed.success) {
      // A malformed row (written before a contract change) runs on the defaults rather than not at all.
      this.logger.warn("bot config invalid; using defaults", { channelId });
      return { botUserId: row.botUserId, config: BotConfig.parse({}) };
    }
    return { botUserId: row.botUserId, config: parsed.data };
  }

  private async loadCommands(channelId: string): Promise<CommandSet> {
    const t = schema.botCommands;
    const rows = await this.db
      .select({
        id: t.id,
        name: t.name,
        aliases: t.aliases,
        response: t.response,
        userLevel: t.userLevel,
        cooldownSeconds: t.cooldownSeconds,
        costPoints: t.costPoints,
      })
      .from(t)
      .where(and(eq(t.channelId, channelId), eq(t.enabled, true)))
      .orderBy(t.name);
    return { index: indexCommands(rows), list: rows };
  }

  private async loadTimers(channelId: string): Promise<readonly TimerDef[]> {
    const t = schema.botTimers;
    return this.db
      .select({ id: t.id, message: t.message, intervalMinutes: t.intervalMinutes, minChatLines: t.minChatLines })
      .from(t)
      .where(and(eq(t.channelId, channelId), eq(t.enabled, true)))
      .orderBy(t.id);
  }

  private async loadVariables(channelId: string): Promise<ReadonlyMap<string, string>> {
    const t = schema.botVariables;
    const rows = await this.db.select({ name: t.name, value: t.value }).from(t).where(eq(t.channelId, channelId));
    return new Map(rows.map((r) => [r.name, r.value]));
  }
}
