// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The watch-room API as the drawer uses it (`watchRooms.*`, ADR 0017), injectable for tests, and
 * the invite landing: the link is the channel page with `?room=<id>&invite=<nonce>`.
 */
import type { WATCH_ROOM_REFUSALS } from "@commonair/contracts/dto";
import type * as D from "@commonair/contracts/dto";
import type { z } from "zod";
import { api } from "../../lib/api.ts";
import { reportClient, type ReportClient } from "../safety/client.ts";

export type WatchRoomDto = z.infer<typeof D.WatchRoom>;
export type WatchRoomInviteDto = z.infer<typeof D.WatchRoomInvite>;
export type WatchRoomJoinedDto = z.infer<typeof D.WatchRoomJoined>;
export type RoomRefusal = (typeof WATCH_ROOM_REFUSALS)[number];

export interface WatchRoomClient {
  create(channel: string): Promise<WatchRoomDto & { invite: WatchRoomInviteDto }>;
  get(id: string): Promise<WatchRoomDto>;
  invite(id: string): Promise<WatchRoomInviteDto>;
  join(id: string, nonce: string): Promise<WatchRoomJoinedDto>;
  leave(id: string): Promise<unknown>;
  close(id: string): Promise<unknown>;
  mine(): Promise<WatchRoomDto[]>;
  /** A fresh chat socket token for the signed-in member (`chat.connectToken`). */
  chatToken(): Promise<{ token: string; url: string }>;
  report: ReportClient["report"];
}

export const watchRoomClient = (): WatchRoomClient => ({
  create: (channel) => api().watchRooms.create({ channel }),
  get: (id) => api().watchRooms.get({ id }),
  invite: (id) => api().watchRooms.invite({ id }),
  join: (id, nonce) => api().watchRooms.join({ id, nonce }),
  leave: (id) => api().watchRooms.leave({ id }),
  close: (id) => api().watchRooms.close({ id }),
  mine: () => api().watchRooms.mine(),
  chatToken: () => api().chat.connectToken(),
  report: (input) => reportClient().report(input),
});

const REFUSALS: ReadonlySet<string> = new Set<RoomRefusal>([
  "room_age_band",
  "room_birth_date_unknown",
  "room_mature_minor",
  "room_mature_unconfirmed",
  "room_banned",
  "room_suspended",
  "room_blocked",
  "room_full",
  "room_closed",
  "room_invite_invalid",
  "room_not_live",
]);

/** The refusal code of a failed create or join (`PRECONDITION_FAILED`'s `requirement`), or null. */
export function refusalOf(err: unknown): RoomRefusal | null {
  if (typeof err !== "object" || err === null) return null;
  const data = (err as { data?: unknown }).data;
  const requirement =
    typeof data === "object" && data !== null ? (data as { requirement?: unknown }).requirement : undefined;
  if (typeof requirement === "string" && REFUSALS.has(requirement)) return requirement as RoomRefusal;
  // A suspended account is refused before the handler runs.
  const code = (err as { code?: unknown }).code;
  if (code === "FORBIDDEN") return "room_suspended";
  return null;
}

/** A chat notice code (`room_*`) as a refusal, or null for any other notice. */
export function refusalOfNotice(code: string): RoomRefusal | null {
  return REFUSALS.has(code) ? (code as RoomRefusal) : null;
}

export interface InviteParams {
  roomId: string;
  nonce: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

/** The invite in a channel page URL's query, or null when absent or malformed. */
export function inviteFromSearch(search: string): InviteParams | null {
  const q = new URLSearchParams(search);
  const roomId = q.get("room");
  const nonce = q.get("invite");
  if (!roomId || !nonce || !UUID.test(roomId) || !NONCE.test(nonce)) return null;
  return { roomId, nonce };
}

/** The same URL without the invite, so a reload or a shared address does not carry the nonce. */
export function withoutInvite(href: string): string {
  const url = new URL(href);
  url.searchParams.delete("room");
  url.searchParams.delete("invite");
  return url.pathname + (url.search ? url.search : "") + url.hash;
}

/**
 * The nonce a member presents when rejoining. An active member is admitted whatever the nonce, so a
 * member who has lost the invite (another tab, a reload) sends this placeholder of valid length.
 */
export const MEMBER_REJOIN_NONCE = "member-rejoin-0000";
