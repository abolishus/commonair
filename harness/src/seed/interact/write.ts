// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-interact's direct inserts, as the app role: the plain tables only (bot config, commands,
 * timers and variables, song requests, past polls and their votes, past raids, goals, alert
 * configs) and the finished playback sessions points accrual reads. Rows have the shapes the API
 * writes. No `events` rows: demo data must not fan out. Every multi-row insert is chunked
 * (`CHUNK` rows) and checks the abort signal between chunks.
 */
import { createHash } from "node:crypto";
import { type DbHandle, schema, uuidv7 } from "@commonair/db";
import type { InteractPlan } from "./plan.ts";

export const CHUNK = 1_000;
/** What the seeded sessions say they are (never a real browser's agent string). */
export const SEED_USER_AGENT = "CommonAir-demo-seed/1 (seed-interact)";

export interface InteractIds {
  /** Handle → user id. */
  users: ReadonlyMap<string, string>;
  /** Owner handle → channel id. */
  channels: ReadonlyMap<string, string>;
}

export interface WriteOptions {
  signal?: AbortSignal;
}

function need(m: ReadonlyMap<string, string>, key: string, what: string): string {
  const v = m.get(key);
  if (!v) throw new Error(`seed-interact: no ${what} for "${key}"`);
  return v;
}

async function insertChunks<T>(rows: readonly T[], insert: (chunk: T[]) => Promise<unknown>, o: WriteOptions) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    o.signal?.throwIfAborted();
    await insert(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

/** A stable synthetic hash (hex SHA-256 of a label): the sessions' device and address hashes. */
export const syntheticHash = (label: string): string => createHash("sha256").update(label, "utf8").digest("hex");

/**
 * Every direct insert of the plan. Returns the rows written per table and the ids of the playback
 * sessions it wrote (the accrual waits for those).
 */
export async function writeInteractDirect(
  h: DbHandle,
  plan: InteractPlan,
  ids: InteractIds,
  o: WriteOptions = {},
): Promise<{ rows: Record<string, number>; sessionIds: string[] }> {
  const { db } = h;
  const user = (handle: string) => need(ids.users, handle, "user");
  const channel = (handle: string) => need(ids.channels, handle, "channel");
  const rows: Record<string, number> = {};

  // Bot configs linked to an existing bot account (bot1); the API saves them again afterwards.
  const linked = plan.bot.configs.filter((c) => c.botHandle !== null);
  rows.bot_configs = await insertChunks(
    linked,
    (chunk) =>
      db.insert(schema.botConfigs).values(
        chunk.map((c) => ({
          channelId: channel(c.owner),
          enabled: c.enabled,
          config: c.config,
          botUserId: c.botHandle ? user(c.botHandle) : null,
          updatedAt: plan.now,
        })),
      ),
    o,
  );
  rows.bot_commands = await insertChunks(
    plan.bot.commands,
    (chunk) =>
      db.insert(schema.botCommands).values(
        chunk.map((c) => ({
          id: uuidv7(c.createdAt.getTime()),
          channelId: channel(c.owner),
          name: c.name,
          aliases: c.aliases,
          response: c.response,
          userLevel: c.userLevel,
          cooldownSeconds: c.cooldownSeconds,
          costPoints: c.costPoints,
          enabled: c.enabled,
          useCount: c.useCount,
          createdAt: c.createdAt,
        })),
      ),
    o,
  );
  rows.bot_timers = await insertChunks(
    plan.bot.timers,
    (chunk) =>
      db.insert(schema.botTimers).values(
        chunk.map((t) => ({
          id: uuidv7(),
          channelId: channel(t.owner),
          name: t.name,
          message: t.message,
          intervalMinutes: t.intervalMinutes,
          minChatLines: t.minChatLines,
          enabled: t.enabled,
          lastFiredAt: t.lastFiredAt,
        })),
      ),
    o,
  );
  rows.bot_variables = await insertChunks(
    plan.bot.variables,
    (chunk) =>
      db
        .insert(schema.botVariables)
        .values(
          chunk.map((v) => ({ channelId: channel(v.owner), name: v.name, value: v.value, updatedAt: v.updatedAt })),
        ),
    o,
  );

  rows.song_requests = await insertChunks(
    plan.songRequests,
    (chunk) =>
      db.insert(schema.songRequests).values(
        chunk.map((s) => ({
          id: uuidv7(s.createdAt.getTime()),
          channelId: channel(s.owner),
          requesterId: user(s.requester),
          url: s.url,
          status: s.status,
          createdAt: s.createdAt,
        })),
      ),
    o,
  );

  // Past polls carry their final counts in `choices`, as `endPollInTx` leaves them.
  const pollRows = plan.polls.map((p) => {
    const choiceIds = p.choices.map(() => uuidv7(p.startedAt.getTime()));
    const counts = p.choices.map((_, i) => p.votes.filter((v) => v.choice === i).length);
    const last = p.votes.reduce<Date | null>((m, v) => (m === null || v.castAt > m ? v.castAt : m), null);
    return {
      spec: p,
      choiceIds,
      row: {
        id: uuidv7(p.startedAt.getTime()),
        channelId: channel(p.owner),
        title: p.title,
        choices: p.choices.map((title, i) => ({ id: choiceIds[i] ?? "", title, votes: counts[i] ?? 0 })),
        status: p.status,
        durationSeconds: p.durationSeconds,
        pointsPerExtraVote: 0,
        createdById: user(p.owner),
        startedAt: p.startedAt,
        endsAt: p.endsAt,
        endedAt: p.endedAt,
        changedAt: last,
        progressAt: last,
      },
    };
  });
  rows.polls = await insertChunks(pollRows, (chunk) => db.insert(schema.polls).values(chunk.map((x) => x.row)), o);
  const votes = pollRows.flatMap((x) =>
    x.spec.votes.map((v) => ({
      pollId: x.row.id,
      userId: user(v.voter),
      choiceId: x.choiceIds[v.choice] ?? "",
      votes: 1,
      pointsSpent: 0,
      castAt: v.castAt,
    })),
  );
  rows.poll_votes = await insertChunks(votes, (chunk) => db.insert(schema.pollVotes).values(chunk), o);

  rows.raids = await insertChunks(
    plan.raids,
    (chunk) =>
      db.insert(schema.raids).values(
        chunk.map((r) => {
          const executeAt = new Date(r.createdAt.getTime() + 30_000);
          return {
            id: uuidv7(r.createdAt.getTime()),
            fromChannelId: channel(r.from),
            toChannelId: channel(r.to),
            viewerCount: r.viewerCount,
            status: r.status,
            createdById: user(r.from),
            createdAt: r.createdAt,
            executeAt,
            executedAt: r.status === "completed" ? executeAt : null,
            canceledAt: r.status === "canceled" ? new Date(r.createdAt.getTime() + 10_000) : null,
            cancelReason: r.cancelReason,
          };
        }),
      ),
    o,
  );

  rows.goals = await insertChunks(
    plan.goals,
    (chunk) =>
      db.insert(schema.goals).values(
        chunk.map((g) => ({
          id: uuidv7(g.startedAt.getTime()),
          channelId: channel(g.owner),
          type: g.type,
          title: g.title,
          target: g.target,
          current: g.current,
          startedAt: g.startedAt,
          endedAt: g.endedAt,
        })),
      ),
    o,
  );

  rows.alert_configs = await insertChunks(
    plan.alerts,
    (chunk) =>
      db.insert(schema.alertConfigs).values(
        chunk.map((a) => ({
          channelId: channel(a.owner),
          type: a.type,
          enabled: a.enabled,
          template: { message: a.message, animation: a.animation, showMessage: true },
          minAmountCents: a.minAmountCents,
          durationMs: a.durationMs,
          updatedAt: plan.now,
        })),
      ),
    o,
  );

  // Finished, verified, signed-in sessions: what the worker's accrual credits. Synthetic hashes,
  // no broadcast (the watch happened before this seed's broadcasts), never a real address.
  const sessions = plan.watch.map((w, i) => ({
    id: uuidv7(w.startedAt.getTime()),
    channelId: channel(w.owner),
    broadcastId: null,
    userId: user(w.viewer),
    deviceHash: syntheticHash(`seed-interact:device:${w.owner}:${w.viewer}:${i}`),
    ipHash: syntheticHash(`seed-interact:ip:${w.viewer}`),
    userAgent: SEED_USER_AGENT,
    startedAt: w.startedAt,
    lastHeartbeatAt: w.endedAt,
    endedAt: w.endedAt,
    heartbeats: Math.floor(w.watchSeconds / 10),
    watchSeconds: w.watchSeconds,
    segmentsFetched: Math.floor(w.watchSeconds / 2),
    verdict: "verified" as const,
    verdictReasons: [],
    score: 0.95,
    scoredAt: w.scoredAt,
    playbackMode: "live" as const,
  }));
  rows.playback_sessions = await insertChunks(sessions, (chunk) => db.insert(schema.playbackSessions).values(chunk), o);

  return { rows, sessionIds: sessions.map((s) => s.id) };
}
