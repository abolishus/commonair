// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.surge.*` (ADR 0015 decision 6): surge-guard state and the moderator override. The override
 * is TTL'd Valkey state (`KEYS.surgeOverride`), not a settings write; every override writes an
 * `audit_log` row and the begin/end outbox event in one transaction, with the key written as its
 * last statement, and the `surge` frame is published after the commit.
 */
import { eq } from "drizzle-orm";
import { surgeRaidOf, type SurgeRaidInfo } from "@commonair/interact";
import { KEYS, SurgeOverride } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { schema } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { publishControl } from "../lib/control.ts";
import { precondition } from "../lib/errors.ts";
import { os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { apiMetrics } from "../metrics.ts";

/**
 * The begin-without-end marker the worker shares: set on a begin, cleared on an end, so a lapsed
 * key still gets its `expired` end event.
 */
const surgeOpenKey = KEYS.surgeOpen;
const SURGE_OPEN_TTL_SECONDS = 2 * 86_400;
/** The key outlives `until` by a minute so chat reopens on its own if the worker dies. */
const TTL_GRACE_SECONDS = 60;

type SurgeStateDto = {
  state: "off" | "on" | "suppressed";
  since: string | null;
  until: string | null;
  by: { id: string; username: string } | null;
  unavailable: boolean;
  raid?: { fromChannel: string; verifiedCount: number } | null;
};

const OFF: SurgeStateDto = { state: "off", since: null, until: null, by: null, unavailable: false };

function parseOverride(raw: string | null): SurgeOverride | null {
  if (raw === null) return null;
  try {
    const parsed = SurgeOverride.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The stored value: `SurgeOverride`, plus the raid the worker stores beside it (`surgeRaidOf`) and,
 * once a moderator's start has kept that raid, `raidUntil`: the end of the raid's own surge window
 * (`RAID_RULES.surgeMinutes` from the raid: the `until` the raid left), so a moderator's later
 * extension never stretches the raid past it. A new raid writes a fresh value without it.
 */
type StoredSurge = SurgeOverride & { raid?: SurgeRaidInfo; raidUntil?: string };

/** The raid a start keeps: the stored one, while now is inside its window plus the carry's grace. */
export function keptRaid(
  raw: string | null,
  stored: SurgeOverride | null,
  now: Date,
): { raid: SurgeRaidInfo; raidUntil: string } | null {
  const raid = surgeRaidOf(raw);
  if (!raid || raw === null || stored?.state !== "on") return null;
  let raidUntil = stored.until;
  try {
    const v = (JSON.parse(raw) as { raidUntil?: unknown }).raidUntil;
    if (typeof v === "string" && !Number.isNaN(Date.parse(v))) raidUntil = v;
  } catch {
    return null;
  }
  // The carry lasts the raid's surge plus the key's grace minute (`raidCarryTtlSeconds`).
  return Date.parse(raidUntil) + TTL_GRACE_SECONDS * 1000 > now.getTime() ? { raid, raidUntil } : null;
}

async function dto(deps: Deps, o: SurgeOverride | null): Promise<SurgeStateDto> {
  if (!o) return OFF;
  let by: SurgeStateDto["by"] = null;
  if (o.by) {
    const [u] = await deps.db
      .select({ id: schema.users.id, username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, o.by));
    by = u ?? null;
  }
  return { state: o.state, since: o.since, until: o.until, by, unavailable: false };
}

export const chatSurge = {
  state: os.chat.surge.state.handler(async ({ context }) => {
    const c = requireChannel(context);
    let raw: string | null;
    try {
      raw = await context.deps.valkey.get(KEYS.surgeOverride(c.id));
    } catch (err) {
      // The gate fails open while Valkey is unreadable; the mod banner says so (decision 1).
      context.deps.logger.warn("surge state unavailable", { channelId: c.id, err });
      return { ...OFF, unavailable: true };
    }
    const o = parseOverride(raw);
    // Batch 7 decision (w): the raid holding chat (the worker stores it beside the override), named
    // only while its own window lasts, not through a later extension of the surge.
    return { ...(await dto(context.deps, o)), raid: keptRaid(raw, o, new Date())?.raid ?? null };
  }),

  override: os.chat.surge.override.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const c = requireChannel(context);
    if (deps.env.CHAT_SURGE_GUARD !== "on")
      throw precondition("surge_guard_off", "The surge guard is not enabled on this instance");
    // As `chatSettingsOf` in routes/chat.ts (not imported: that module composes this one).
    const parsed = ChannelChatSettings.safeParse(c.chatSettings);
    const settings = (parsed.success ? parsed.data : ChannelChatSettings.parse({})).surgeGuard;
    const [raw, marked] = await Promise.all([
      deps.valkey.get(KEYS.surgeOverride(c.id)),
      deps.valkey.exists(surgeOpenKey(c.id)).then((n) => n === 1),
    ]);
    const stored = parseOverride(raw);
    // The job scans enabled channels only, so a manual `on` elsewhere would never get its cooldown
    // end. Ending stays open while anything is left over from before the guard was turned off.
    if (!settings.enabled && (input.action === "start" || (stored === null && !marked)))
      throw precondition("surge_guard_disabled", "The surge guard is not enabled for this channel");

    // Pair begins and ends on the same state the job uses: the marker says a begin has no end yet.
    // A marker without a key means the key lapsed before the job recorded it: record that first.
    const lapsed = marked && stored === null;
    const now = new Date();
    // A key whose `until` passed is surge mode that ended (the job records the end), kept only
    // for the TTL's grace minute: a start then begins afresh, with its own begin event.
    const live = stored?.state === "on" && Date.parse(stored.until) > now.getTime();
    const open = !lapsed && (marked || live);
    const fresh = new Date(now.getTime() + settings.cooldownMinutes * 60_000).toISOString();
    // A start keeps the raid the surge holds chat for while its window lasts; an end drops it.
    const raid = input.action === "start" ? keptRaid(raw, stored, now) : null;
    // Starting while already on extends only: `since` (the chatted-before exemption) and `by` stay.
    const base: SurgeOverride =
      input.action === "start" && stored && live
        ? {
            state: stored.state,
            since: stored.since,
            by: stored.by,
            until: Date.parse(fresh) > Date.parse(stored.until) ? fresh : stored.until,
          }
        : {
            state: input.action === "start" ? "on" : "suppressed",
            since: now.toISOString(),
            until: fresh,
            by: caller.user.id,
          };
    // Outside its window the raid is dropped, so the stored value (and the worker's end reason) stops
    // naming it.
    const next: StoredSurge = raid ? { ...base, ...raid } : base;
    const ttl = Math.max(1, Math.ceil((Date.parse(next.until) - now.getTime()) / 1000)) + TTL_GRACE_SECONDS;

    await deps.db.transaction(async (tx) => {
      if (lapsed) {
        await emit(tx, "chat.surge.end", c.id, { reason: "expired", by_user_id: null }, now);
        await audit(tx, {
          actorType: "system",
          actorId: null,
          action: "chat.surge.end",
          subjectType: "channel",
          subjectId: c.id,
          channelId: c.id,
          details: { reason: "expired" },
        });
      }
      await audit(tx, {
        actorType: "moderator",
        actorId: caller.user.id,
        action: "chat.surge.override",
        subjectType: "channel",
        subjectId: c.id,
        channelId: c.id,
        details: { action: input.action },
      });
      // A begin or an end only when the state actually changes, so begins and ends pair up.
      if (input.action === "start" && !open)
        await emit(
          tx,
          "chat.surge.begin",
          c.id,
          { trigger: "moderator", until: next.until, by_user_id: caller.user.id },
          now,
        );
      if (input.action === "end" && open)
        await emit(tx, "chat.surge.end", c.id, { reason: "moderator", by_user_id: caller.user.id }, now);
      // Last: a Valkey failure rolls the records back with it.
      await deps.valkey.set(KEYS.surgeOverride(c.id), JSON.stringify(next), "EX", ttl);
    });
    try {
      if (input.action === "start") await deps.valkey.set(surgeOpenKey(c.id), "1", "EX", SURGE_OPEN_TTL_SECONDS);
      else await deps.valkey.del(surgeOpenKey(c.id));
    } catch (err) {
      deps.logger.warn("surge marker write failed", { channelId: c.id, err });
    }
    await publishControl(deps, c.id, { op: "surge", channel: c.slug, state: next.state, until: next.until });
    apiMetrics.surgeOverrides.add(1, { action: input.action });
    return dto(deps, next);
  }),
};
