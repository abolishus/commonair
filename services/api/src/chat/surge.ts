// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `chat.surge.*` (ADR 0015 decision 6): surge-guard state and the moderator override. The override
 * is TTL'd Valkey state (`KEYS.surgeOverride`), not a settings write; every override writes an
 * `audit_log` row and the begin/end outbox event in one transaction, with the key written as its
 * last statement, and the `surge` frame is published after the commit.
 */
import { eq } from "drizzle-orm";
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
 * The worker's begin-without-end marker (services/worker/src/chat-gate/state.ts `surgeOpenKey`):
 * set on a begin, cleared on an end, so a lapsed key still gets its `expired` end event. Keep in step.
 */
const surgeOpenKey = (channelId: string): string => `surge-open:${channelId}`;
const SURGE_OPEN_TTL_SECONDS = 2 * 86_400;
/** The key outlives `until` by a minute so chat reopens on its own if the worker dies. */
const TTL_GRACE_SECONDS = 60;

type SurgeStateDto = {
  state: "off" | "on" | "suppressed";
  since: string | null;
  until: string | null;
  by: { id: string; username: string } | null;
  unavailable: boolean;
};

const OFF: SurgeStateDto = { state: "off", since: null, until: null, by: null, unavailable: false };

async function readOverride(deps: Deps, channelId: string): Promise<SurgeOverride | null> {
  const raw = await deps.valkey.get(KEYS.surgeOverride(channelId));
  if (raw === null) return null;
  try {
    const parsed = SurgeOverride.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
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
    let o: SurgeOverride | null;
    try {
      o = await readOverride(context.deps, c.id);
    } catch (err) {
      // The gate fails open while Valkey is unreadable; the mod banner says so (decision 1).
      context.deps.logger.warn("surge state unavailable", { channelId: c.id, err });
      return { ...OFF, unavailable: true };
    }
    return dto(context.deps, o);
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
    // The job scans enabled channels only: a manual `on` elsewhere would never get its cooldown end.
    if (!settings.enabled)
      throw precondition("surge_guard_disabled", "The surge guard is not enabled for this channel");

    const now = new Date();
    const until = new Date(now.getTime() + settings.cooldownMinutes * 60_000);
    const next: SurgeOverride = {
      state: input.action === "start" ? "on" : "suppressed",
      since: now.toISOString(),
      until: until.toISOString(),
      by: caller.user.id,
    };
    const ttl = Math.ceil((until.getTime() - now.getTime()) / 1000) + TTL_GRACE_SECONDS;
    const wasOn = (await readOverride(deps, c.id))?.state === "on";

    await deps.db.transaction(async (tx) => {
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
      if (input.action === "start" && !wasOn)
        await emit(
          tx,
          "chat.surge.begin",
          c.id,
          { trigger: "moderator", until: next.until, by_user_id: caller.user.id },
          now,
        );
      if (input.action === "end" && wasOn)
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
    return {
      state: next.state,
      since: next.since,
      until: next.until,
      by: { id: caller.user.id, username: caller.user.username },
      unavailable: false,
    };
  }),
};
