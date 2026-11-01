// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rehearsal mode (W2-rehearsal, batch 6 decisions (f), (g)): arm and disarm
 * (`KEYS.rehearsalArmed`), invitees (`rehearsal_invitees`, at most five followers), the report
 * (`KEYS.rehearsalReport`, written by the worker's driver) and the invitee-gated watch token. The
 * media gate that turns an armed publish into a `kind = 'rehearsal'` broadcast is
 * `../media/hooks.ts` (read-only here).
 *
 * Which arm is current: a started rehearsal's session marker (`KEYS.rehearsalSession`, written by
 * `mediaReady` with the arm that started it) wins over the arm key; both carry the same arm id
 * while a rehearsal runs. A reconnect inside the arm's TTL or the session's grace rehearses again
 * under the same arm, so the arm's invitees are matched by arm id, not only by broadcast id.
 */
import { and, count, desc, eq, isNull, or } from "drizzle-orm";
import { REHEARSAL_RULES } from "@commonair/contracts/enums";
import { KEYS, REHEARSAL_REPORT_TTL_SECONDS, RehearsalArm, mediaPath } from "@commonair/contracts/internal";
import { PLAYBACK_TOKEN_TTL_SECONDS, type PlaybackClaims } from "@commonair/contracts/tokens";
import { RehearsalReport, type RehearsalStatus, type RehearsalWatch } from "@commonair/contracts/dto";
import { schema, uuidv7 } from "@commonair/db";
import { hmacHex, signPlaybackToken } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { isSuspended } from "../lib/caller.ts";
import { channelBySlug, iso } from "../lib/dto.ts";
import { apiError, notFound, pgCode, precondition } from "../lib/errors.ts";
import { afterBroadcastEnded, endBroadcastInTx } from "../moderation/live.ts";
import { HEARTBEAT_INTERVAL_MS, matureGate, playlistUrl } from "../routes/playback.ts";
import { confirmedAdult } from "../routes/me.ts";

const { broadcasts, follows, playbackSessions, rehearsalInvitees, users } = schema;
type ChannelRow = typeof schema.channels.$inferSelect;
type BroadcastRow = typeof schema.broadcasts.$inferSelect;

/** An owner procedure's caller: the channel the owner middleware resolved and the owner's id. */
export interface RehearsalActor {
  deps: Deps;
  channel: ChannelRow;
  userId: string;
  /** A browser session, not an app's user token: rehearsal is the owner's own (app tokens are refused). */
  session: boolean;
}

/** The request facts a watch session records (as `playback.start` does). */
export interface WatchRequest {
  ipHash: string;
  userAgent: string | null;
}

// ------------------------------------------------------------------ pure state machine

export type RehearsalState = RehearsalStatus["state"];
export type ArmRefusal = "suspended" | "live" | "rehearsing" | "armed";

export interface ArmFacts {
  suspended: boolean;
  live: boolean;
  rehearsing: boolean;
  /** The arm key or a started rehearsal's session marker exists (the next publish rehearses). */
  armed: boolean;
}

/** Why `arm` is refused, or null when it may arm. Order: the most fundamental reason first. */
export function armRefusal(f: ArmFacts): ArmRefusal | null {
  if (f.suspended) return "suspended";
  if (f.live) return "live";
  if (f.rehearsing) return "rehearsing";
  if (f.armed) return "armed";
  return null;
}

export function stateOf(f: { rehearsing: boolean; armed: boolean }): RehearsalState {
  if (f.rehearsing) return "rehearsing";
  return f.armed ? "armed" : "idle";
}

/** When the 30-minute cap ends a rehearsal that started at `startedAt`. */
export const capEndsAt = (startedAt: Date) => new Date(startedAt.getTime() + REHEARSAL_RULES.maxDurationSeconds * 1000);

export type InviteRefusal = "not_follower" | "invitee_limit";
export interface InviteeFacts {
  exists: boolean;
  deleted: boolean;
  suspended: boolean;
  isOwner: boolean;
  /** Follows the channel and the follow is not excluded by integrity. */
  follows: boolean;
  alreadyInvited: boolean;
  invitedCount: number;
}

/**
 * Whether the user may be added. `"ok"` adds, `"noop"` is an idempotent re-add. Every ineligible
 * user (missing, deleted, suspended, the owner, not a follower) gets the same `not_follower`, so the
 * picker cannot probe accounts.
 */
export function inviteDecision(f: InviteeFacts): "ok" | "noop" | InviteRefusal {
  if (!f.exists || f.deleted || f.suspended || f.isOwner || !f.follows) return "not_follower";
  if (f.alreadyInvited) return "noop";
  if (f.invitedCount >= REHEARSAL_RULES.maxInvitees) return "invitee_limit";
  return "ok";
}

/** A watch token's expiry: the normal playback lifetime, never past the rehearsal's cap. */
export function watchExpiry(iatSeconds: number, startedAt: Date): number {
  return Math.min(iatSeconds + PLAYBACK_TOKEN_TTL_SECONDS, Math.floor(capEndsAt(startedAt).getTime() / 1000));
}

// ------------------------------------------------------------------ reads

function parseArm(raw: string | null | undefined, ownerId: string): RehearsalArm | null {
  if (!raw) return null;
  try {
    const arm = RehearsalArm.parse(JSON.parse(raw));
    return arm.ownerId === ownerId ? arm : null;
  } catch {
    return null;
  }
}

interface ArmKeys {
  arm: RehearsalArm | null;
  session: RehearsalArm | null;
  /** Milliseconds the arm key (else the session marker) still lives; null without either. */
  ttlMs: number | null;
}

async function readArmKeys(deps: Deps, channel: ChannelRow): Promise<ArmKeys> {
  const [armRaw, sessionRaw] = await deps.valkey.mget(
    KEYS.rehearsalArmed(channel.id),
    KEYS.rehearsalSession(channel.id),
  );
  const arm = parseArm(armRaw, channel.ownerId);
  const session = parseArm(sessionRaw, channel.ownerId);
  let ttlMs: number | null = null;
  if (arm) ttlMs = await deps.valkey.pttl(KEYS.rehearsalArmed(channel.id));
  else if (session) ttlMs = await deps.valkey.pttl(KEYS.rehearsalSession(channel.id));
  return { arm, session, ttlMs: ttlMs !== null && ttlMs > 0 ? ttlMs : null };
}

async function openRehearsal(deps: Deps, channelId: string): Promise<BroadcastRow | null> {
  const [b] = await deps.db
    .select()
    .from(broadcasts)
    .where(and(eq(broadcasts.channelId, channelId), eq(broadcasts.kind, "rehearsal"), isNull(broadcasts.endedAt)))
    .orderBy(desc(broadcasts.startedAt))
    .limit(1);
  return b ?? null;
}

async function isLive(deps: Deps, channel: ChannelRow): Promise<boolean> {
  if (!channel.liveBroadcastId) return false;
  const [b] = await deps.db
    .select({ endedAt: broadcasts.endedAt })
    .from(broadcasts)
    .where(eq(broadcasts.id, channel.liveBroadcastId));
  return b !== undefined && b.endedAt === null;
}

/** The arm a rehearsal broadcast ran under, from the invitees it carried (when no key says so). */
async function armOfBroadcast(deps: Deps, broadcastId: string): Promise<string | null> {
  const [r] = await deps.db
    .select({ armId: rehearsalInvitees.armId })
    .from(rehearsalInvitees)
    .where(eq(rehearsalInvitees.broadcastId, broadcastId))
    .limit(1);
  return r?.armId ?? null;
}

async function inviteesOf(deps: Deps, armId: string | null): Promise<RehearsalStatus["invitees"]> {
  if (!armId) return [];
  const rows = await deps.db
    .select({ id: users.id, username: users.username, displayName: users.name })
    .from(rehearsalInvitees)
    .innerJoin(users, eq(users.id, rehearsalInvitees.userId))
    .where(eq(rehearsalInvitees.armId, armId))
    .orderBy(rehearsalInvitees.createdAt);
  return rows;
}

interface Current {
  keys: ArmKeys;
  open: BroadcastRow | null;
  armId: string | null;
}

async function current(deps: Deps, channel: ChannelRow): Promise<Current> {
  const [keys, open] = await Promise.all([readArmKeys(deps, channel), openRehearsal(deps, channel.id)]);
  const armId = keys.session?.armId ?? keys.arm?.armId ?? (open ? await armOfBroadcast(deps, open.id) : null) ?? null;
  return { keys, open, armId };
}

async function statusFrom(deps: Deps, c: Current): Promise<RehearsalStatus> {
  const armed = c.keys.arm !== null || c.keys.session !== null;
  const state = stateOf({ rehearsing: c.open !== null, armed });
  const now = deps.now().getTime();
  return {
    state,
    armId: state === "idle" ? null : c.armId,
    armExpiresAt: state === "armed" && c.keys.ttlMs !== null ? iso(new Date(now + c.keys.ttlMs)) : null,
    broadcastId: c.open?.id ?? null,
    endsAt: c.open ? iso(capEndsAt(c.open.startedAt)) : null,
    invitees: state === "idle" ? [] : await inviteesOf(deps, c.armId),
  };
}

function requireSession(a: RehearsalActor): void {
  if (!a.session) throw apiError("FORBIDDEN", "Rehearsals are managed from a signed-in browser session");
}

async function ownerSuspended(deps: Deps, channel: ChannelRow): Promise<boolean> {
  if (channel.suspendedAt) return true;
  const [owner] = await deps.db.select().from(users).where(eq(users.id, channel.ownerId));
  return !owner || owner.deletedAt !== null || isSuspended(owner, deps.now());
}

// ------------------------------------------------------------------ procedures

export async function armRehearsal(a: RehearsalActor): Promise<RehearsalStatus> {
  requireSession(a);
  const { deps, channel } = a;
  const [suspended, live, c] = await Promise.all([
    ownerSuspended(deps, channel),
    isLive(deps, channel),
    current(deps, channel),
  ]);
  const refusal = armRefusal({
    suspended,
    live,
    rehearsing: c.open !== null,
    armed: c.keys.arm !== null || c.keys.session !== null,
  });
  if (refusal) throw precondition(refusal, refusalMessage[refusal]);

  const now = deps.now();
  const arm: RehearsalArm = { armId: uuidv7(now.getTime()), ownerId: channel.ownerId, armedAt: iso(now) };
  const key = KEYS.rehearsalArmed(channel.id);
  let set = false;
  try {
    await deps.db.transaction(async (tx) => {
      await emit(
        tx,
        "rehearsal.armed",
        channel.id,
        {
          channel_id: channel.id,
          arm_id: arm.armId,
          expires_at: iso(new Date(now.getTime() + REHEARSAL_RULES.armTtlSeconds * 1000)),
        },
        now,
      );
      await audit(tx, {
        actorType: "user",
        actorId: a.userId,
        action: "rehearsal.arm",
        subjectType: "channel",
        subjectId: channel.id,
        channelId: channel.id,
        details: { armId: arm.armId },
      });
      // NX inside the transaction: of two concurrent arms one sets the key, the other rolls back.
      set = (await deps.valkey.set(key, JSON.stringify(arm), "EX", REHEARSAL_RULES.armTtlSeconds, "NX")) === "OK";
      if (!set) throw precondition("armed", refusalMessage.armed);
    });
  } catch (err) {
    // The key without its event and audit row would arm silently: take it back.
    if (set) await deps.valkey.del(key).catch(() => 0);
    throw err;
  }
  return statusFrom(deps, await current(deps, channel));
}

const refusalMessage: Record<ArmRefusal, string> = {
  suspended: "This channel is suspended",
  live: "End the live stream before rehearsing",
  rehearsing: "A rehearsal is already running",
  armed: "A rehearsal is already armed",
};

export async function disarmRehearsal(a: RehearsalActor): Promise<RehearsalStatus> {
  requireSession(a);
  const { deps, channel } = a;
  const c = await current(deps, channel);
  // Idempotent: nothing armed or running, nothing written.
  if (!c.keys.arm && !c.keys.session && !c.open) return statusFrom(deps, c);
  const now = deps.now();
  // An open rehearsal without any key (both lapsed) still needs an arm id for the event.
  const armId = c.armId ?? c.open?.id ?? uuidv7(now.getTime());
  // Refuse the encoder's automatic reconnect before the kick (decision (f)); afterBroadcastEnded
  // sets it again. Then no key can turn the next publish into a rehearsal.
  if (c.open) await deps.valkey.set(KEYS.rehearsalKicked(channel.id), "1", "EX", REHEARSAL_RULES.kickCooldownSeconds);
  await deps.valkey.del(KEYS.rehearsalArmed(channel.id), KEYS.rehearsalSession(channel.id));
  const ended = await deps.db.transaction(async (tx) => {
    const e = c.open ? await endBroadcastInTx(tx, channel.id, c.open.id, now) : null;
    await emit(
      tx,
      "rehearsal.ended",
      channel.id,
      { channel_id: channel.id, arm_id: armId, broadcast_id: c.open?.id ?? null, reason: "disarmed" },
      now,
    );
    await audit(tx, {
      actorType: "user",
      actorId: a.userId,
      action: "rehearsal.disarm",
      subjectType: "channel",
      subjectId: channel.id,
      channelId: channel.id,
      details: { armId, broadcastId: c.open?.id ?? null },
    });
    return e;
  });
  await afterBroadcastEnded(deps, ended);
  return statusFrom(deps, await current(deps, channel));
}

export async function rehearsalStatus(a: RehearsalActor): Promise<RehearsalStatus> {
  requireSession(a);
  return statusFrom(a.deps, await current(a.deps, a.channel));
}

export async function inviteToRehearsal(
  a: RehearsalActor,
  input: { username: string; remove: boolean },
): Promise<RehearsalStatus> {
  requireSession(a);
  const { deps, channel } = a;
  const c = await current(deps, channel);
  if (!c.armId || (!c.keys.arm && !c.keys.session && !c.open))
    throw precondition("not_armed", "Arm a rehearsal before inviting anyone");
  const armId = c.armId;
  const [user] = await deps.db.select().from(users).where(eq(users.username, input.username.toLowerCase()));

  if (input.remove) {
    if (user)
      await deps.db.transaction(async (tx) => {
        const gone = await tx
          .delete(rehearsalInvitees)
          .where(and(eq(rehearsalInvitees.armId, armId), eq(rehearsalInvitees.userId, user.id)))
          .returning({ userId: rehearsalInvitees.userId });
        if (gone.length > 0)
          await audit(tx, {
            actorType: "user",
            actorId: a.userId,
            action: "rehearsal.invitee.remove",
            subjectType: "user",
            subjectId: user.id,
            channelId: channel.id,
            details: { armId },
          });
      });
    return statusFrom(deps, c);
  }

  const [follow] = user
    ? await deps.db
        .select({ excludedAt: follows.excludedAt })
        .from(follows)
        .where(and(eq(follows.followerId, user.id), eq(follows.channelId, channel.id)))
    : [];
  const [invited] = user
    ? await deps.db
        .select({ userId: rehearsalInvitees.userId })
        .from(rehearsalInvitees)
        .where(and(eq(rehearsalInvitees.armId, armId), eq(rehearsalInvitees.userId, user.id)))
    : [];
  const [n] = await deps.db.select({ n: count() }).from(rehearsalInvitees).where(eq(rehearsalInvitees.armId, armId));
  const decision = inviteDecision({
    exists: user !== undefined,
    deleted: user !== undefined && user.deletedAt !== null,
    suspended: user ? isSuspended(user, deps.now()) : false,
    isOwner: user?.id === channel.ownerId,
    follows: follow !== undefined && follow.excludedAt === null,
    alreadyInvited: invited !== undefined,
    invitedCount: n?.n ?? 0,
  });
  if (decision === "not_follower") throw precondition("not_follower", "Only followers of this channel can be invited");
  if (decision === "invitee_limit")
    throw precondition("invitee_limit", `A rehearsal has at most ${REHEARSAL_RULES.maxInvitees} invitees`);
  if (decision === "ok" && user)
    try {
      await deps.db.transaction(async (tx) => {
        const added = await tx
          .insert(rehearsalInvitees)
          .values({ armId, channelId: channel.id, userId: user.id, broadcastId: c.open?.id ?? null })
          .onConflictDoNothing()
          .returning({ userId: rehearsalInvitees.userId });
        if (added.length > 0)
          await audit(tx, {
            actorType: "user",
            actorId: a.userId,
            action: "rehearsal.invitee.add",
            subjectType: "user",
            subjectId: user.id,
            channelId: channel.id,
            details: { armId },
          });
      });
    } catch (err) {
      // The trigger serializes the count of five (a concurrent add raced this one).
      if (pgCode(err) === "23514")
        throw precondition("invitee_limit", `A rehearsal has at most ${REHEARSAL_RULES.maxInvitees} invitees`);
      throw err;
    }
  return statusFrom(deps, await current(deps, channel));
}

/** A report with nothing in it yet: the broadcast started and the driver has not written. */
function blankReport(b: BroadcastRow, now: Date): RehearsalReport {
  const zero = { wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 };
  return {
    broadcastId: b.id,
    startedAt: iso(b.startedAt),
    endedAt: b.endedAt ? iso(b.endedAt) : null,
    endReason: null,
    chat: { accepted: 0, held: zero, rejected: zero },
    ingest: [],
    moderation: { samples: 0, flagged: false },
    inviteesWatched: [],
    updatedAt: iso(now),
  };
}

/** A safety end says that and nothing more (feature-wins §4.11). */
export function redactForSafety(r: RehearsalReport): RehearsalReport {
  if (r.endReason !== "safety") return r;
  const zero = { wordFilter: 0, link: 0, duplicate: 0, rateLimit: 0, other: 0 };
  return {
    ...r,
    chat: { accepted: 0, held: zero, rejected: zero },
    ingest: [],
    moderation: { samples: 0, flagged: false },
    inviteesWatched: [],
  };
}

export async function rehearsalReport(a: RehearsalActor, broadcastId: string | undefined): Promise<RehearsalReport> {
  requireSession(a);
  const { deps, channel } = a;
  const now = deps.now();
  const keptSince = new Date(now.getTime() - REHEARSAL_REPORT_TTL_SECONDS * 1000);
  const [b] = await deps.db
    .select()
    .from(broadcasts)
    .where(
      and(
        eq(broadcasts.channelId, channel.id),
        eq(broadcasts.kind, "rehearsal"),
        broadcastId ? eq(broadcasts.id, broadcastId) : undefined,
      ),
    )
    .orderBy(desc(broadcasts.startedAt))
    .limit(1);
  // Kept 24 h after the end (or the start, while it runs).
  if (!b || (b.endedAt ?? b.startedAt) < keptSince) throw notFound("No rehearsal report");
  const raw = await deps.valkey.get(KEYS.rehearsalReport(b.id));
  if (raw) {
    try {
      const parsed = RehearsalReport.safeParse(JSON.parse(raw));
      if (parsed.success && parsed.data.broadcastId === b.id) return redactForSafety(parsed.data);
    } catch {
      // An unreadable report reads as not written yet.
    }
    deps.logger.warn("unreadable rehearsal report", { broadcastId: b.id });
  }
  return blankReport(b, now);
}

/** `user` access (the owner or an invitee), so the channel arrives as its slug. */
export async function watchRehearsal(
  deps: Deps,
  userId: string,
  input: { channel: string; deviceId: string },
  req: WatchRequest,
): Promise<RehearsalWatch> {
  const c = await channelBySlug(deps, input.channel);
  // One answer for no channel, a suspended one, no rehearsal and "not invited": nothing to probe.
  const nothing = () => notFound("No rehearsal to watch");
  if (!c || c.suspendedAt) throw nothing();
  const b = await openRehearsal(deps, c.id);
  if (!b) throw nothing();
  const nowSeconds = Math.floor(deps.now().getTime() / 1000);
  const exp = watchExpiry(nowSeconds, b.startedAt);
  if (exp <= nowSeconds) throw nothing();
  if (userId !== c.ownerId) {
    const sessionArm = parseArm(await deps.valkey.get(KEYS.rehearsalSession(c.id)), c.ownerId);
    const [inv] = await deps.db
      .select({ userId: rehearsalInvitees.userId })
      .from(rehearsalInvitees)
      .innerJoin(follows, and(eq(follows.followerId, rehearsalInvitees.userId), eq(follows.channelId, c.id)))
      .where(
        and(
          eq(rehearsalInvitees.channelId, c.id),
          eq(rehearsalInvitees.userId, userId),
          isNull(follows.excludedAt),
          sessionArm
            ? or(eq(rehearsalInvitees.broadcastId, b.id), eq(rehearsalInvitees.armId, sessionArm.armId))
            : eq(rehearsalInvitees.broadcastId, b.id),
        ),
      )
      .limit(1);
    if (!inv) throw nothing();
  }
  if ((b.mature || c.mature) && !(await confirmedAdult(deps, userId))) throw matureGate();

  const sid = uuidv7();
  const path = mediaPath(c.slug);
  // Origin only: never a relay, the CDN or P2P (the origin serves `rb` tokens from the open
  // rehearsal; relays and the CDN see the channel as offline).
  await deps.db.insert(playbackSessions).values({
    id: sid,
    channelId: c.id,
    broadcastId: b.id,
    userId,
    deviceHash: await hmacHex(deps.env.AUTH_SECRET, `device:${input.deviceId}`),
    ipHash: req.ipHash,
    userAgent: req.userAgent?.slice(0, 256) ?? null,
    assignedSource: "origin",
    startedAt: deps.now(),
    fingerprint: { rehearsal: true },
  });
  const claims: PlaybackClaims = { v: 1, sid, cid: c.id, path, src: "origin", rb: b.id, iat: nowSeconds, exp };
  const token = await signPlaybackToken(deps.signingKey, claims);
  return {
    sessionId: sid,
    playlistUrl: playlistUrl(deps.env.PLAYBACK_PUBLIC_URL.replace(/\/+$/, ""), path, token),
    token,
    expiresAt: iso(new Date(exp * 1000)),
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  };
}
