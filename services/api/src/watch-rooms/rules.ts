// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Watch-room rules that need no database (ADR 0017 decision 3, decision (q)): the age band from a
 * birth date, the order of the join checks, and how the 0046 trigger's refusals map back to the
 * API's refusal codes. The trigger is the backstop; these give the clear, translated refusal first.
 */
import type { RoomAgeBand } from "@commonair/contracts/enums";
import type { WATCH_ROOM_REFUSALS } from "@commonair/contracts/dto";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import { ageOn, parseBirthDate } from "../auth/identity.ts";

export type RoomRefusal = (typeof WATCH_ROOM_REFUSALS)[number];

/**
 * The band on `now` (UTC calendar), or null for an unknown or invalid birth date (fail closed).
 * Matches `commonair_age_band` in 0046: adult at 18, null for a future date or one before 1900.
 */
export function ageBandOn(birthDate: string | null, now: Date): RoomAgeBand | null {
  const b = parseBirthDate(birthDate);
  if (!b) return null;
  const age = ageOn(b, now);
  if (age < 0) return null;
  return age >= 18 ? "adult" : "minor";
}

/** What a create or join check needs to know about the person. */
export interface PersonFacts {
  birthDate: string | null;
  matureConfirmed: boolean;
  /** `users.banned` in force, and whether it has an end (a suspension) or not (a ban). */
  platformBan: "none" | "banned" | "suspended";
  /** An active `chat_bans` row on the room's channel. */
  channelBanned: boolean;
}

/** What a create or join check needs to know about the room (or the room about to be made). */
export interface RoomFacts {
  /** The room's band; null while creating (the host's band becomes the room's). */
  band: RoomAgeBand | null;
  mature: boolean;
}

/**
 * The first refusal for a person against a room, in a fixed order (identity, bans, band, mature).
 * Blocks and capacity need the member list, so the caller checks them after this.
 */
export function personRefusal(p: PersonFacts, room: RoomFacts, now: Date): RoomRefusal | null {
  if (p.platformBan === "banned") return "room_banned";
  if (p.platformBan === "suspended") return "room_suspended";
  if (p.channelBanned) return "room_banned";
  const band = ageBandOn(p.birthDate, now);
  if (band === null) return "room_birth_date_unknown";
  if (room.mature && band === "minor") return "room_mature_minor";
  if (room.band !== null && band !== room.band) return "room_age_band";
  if (room.mature && !p.matureConfirmed) return "room_mature_unconfirmed";
  return null;
}

/** `users.banned` / `ban_expires` → the platform ban state on `now`. */
export function platformBanOf(banned: boolean, banExpires: Date | null, now: Date): PersonFacts["platformBan"] {
  if (!banned) return "none";
  if (banExpires === null) return "banned";
  return banExpires.getTime() > now.getTime() ? "suspended" : "none";
}

/** Whether a room with `activeMembers` has room for one more. */
export const hasPlace = (activeMembers: number): boolean => activeMembers < ROOM_LIMITS.maxMembers;

/**
 * The 0046 trigger's refusal (its message starts with the code) → the API's refusal code, or null
 * when the error is something else. `band` tells a minor's mature refusal from an adult's.
 */
export function triggerRefusal(err: unknown, band: RoomAgeBand | null): RoomRefusal | null {
  let e: unknown = err;
  for (let depth = 0; e && depth < 6; depth++) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") {
      if (message.includes("room_closed:")) return "room_closed";
      if (message.includes("room_full:")) return "room_full";
      if (message.includes("room_age_band: no valid birth date")) return "room_birth_date_unknown";
      if (message.includes("room_age_band:")) return "room_age_band";
      if (message.includes("room_mature:")) return band === "adult" ? "room_mature_unconfirmed" : "room_mature_minor";
      if (message.includes("watch room host has no valid birth date")) return "room_birth_date_unknown";
      if (message.includes("watch room on mature content")) {
        return band === "adult" ? "room_mature_unconfirmed" : "room_mature_minor";
      }
      if (message.includes("a watch room's band is its host's")) return "room_age_band";
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The chat token audience a room's members present on `room.join`. */
export const roomAudience = (roomId: string): string => `room:${roomId}`;
