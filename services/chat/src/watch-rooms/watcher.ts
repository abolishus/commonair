// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keeps rooms consistent with the platform from bus events, not polling (ADR 0017 decisions 2–3):
 *
 * - `stream.offline` → the channel's open rooms end (`broadcast_ended`);
 * - `channel.update` → the channel's `minor` rooms whose broadcast is now mature end (`mature`);
 * - `channel.ban` (a ban or timeout) → the user leaves the channel's open rooms (`room.kick`
 *   `banned`; the host's room ends with `moderation`);
 * - `BUS.userControl` `suspended` / `deleted` → when the user is banned or deleted now, they leave
 *   every open room (`suspended`).
 *
 * Every chat instance runs it on its own subscriber connection (the shared bus gives one handler
 * per channel, and `BUS.events` already has the core's). The database updates are conditional, so
 * only the instance that changed a row publishes the `BUS.roomControl` message every instance acts on.
 */
import { BUS, BusEvent, UserControlMessage, type RoomControlMessage } from "@commonair/contracts";
import type { ValkeyClient } from "@commonair/service";
import type { WatchRoomDeps } from "../core.ts";
import { errorFields } from "../errors.ts";
import { endRoom, openRoomsOfMember, openRoomsOnChannel, platformBanned, removeMember } from "./db.ts";

type Publish = (msg: RoomControlMessage) => Promise<void>;

export class RoomWatcher {
  private sub: ValkeyClient | null = null;
  private readonly prefix: string;

  constructor(
    private readonly d: Pick<WatchRoomDeps, "db" | "valkey" | "bus" | "logger">,
    private readonly publish: Publish,
  ) {
    const control = d.bus.names.roomControl();
    this.prefix = control.slice(0, control.length - BUS.roomControl.length);
  }

  private get eventsChannel(): string {
    return this.d.bus.names.events();
  }
  private get userControlChannel(): string {
    return this.prefix + BUS.userControl;
  }

  async start(): Promise<void> {
    const sub = this.d.valkey.duplicate();
    this.sub = sub;
    sub.on("message", (channel: string, raw: string) => {
      void this.onMessage(channel, raw).catch((err: unknown) =>
        this.d.logger.warn("room watcher failed", { ...errorFields(err), channel }),
      );
    });
    await sub.subscribe(this.eventsChannel, this.userControlChannel);
  }

  async stop(): Promise<void> {
    const sub = this.sub;
    this.sub = null;
    if (sub) await sub.quit().catch(() => sub.disconnect());
  }

  /** Exposed for tests: handle one bus message as if it arrived. */
  async onMessage(channel: string, raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return;
    }
    if (channel === this.userControlChannel) {
      const msg = UserControlMessage.safeParse(json);
      if (!msg.success || !msg.data.userId) return;
      if (msg.data.reason !== "suspended" && msg.data.reason !== "deleted") return;
      if (!(await platformBanned(this.d.db, msg.data.userId))) return;
      await this.removeEverywhere(msg.data.userId, null, "suspended");
      return;
    }
    if (channel !== this.eventsChannel) return;
    const ev = BusEvent.safeParse(json);
    if (!ev.success || !ev.data.channelId) return;
    const channelId = ev.data.channelId;
    switch (ev.data.type) {
      case "stream.offline":
        for (const id of await openRoomsOnChannel(this.d.db, channelId)) await this.end(id, "broadcast_ended");
        return;
      case "channel.update":
        for (const id of await openRoomsOnChannel(this.d.db, channelId, { minorOnMature: true }))
          await this.end(id, "mature");
        return;
      case "channel.ban": {
        const userId = ev.data.payload["user_id"];
        if (typeof userId === "string") await this.removeEverywhere(userId, channelId, "banned");
        return;
      }
    }
  }

  private async end(roomId: string, reason: "broadcast_ended" | "mature"): Promise<void> {
    if (await endRoom(this.d.db, roomId, reason)) {
      this.d.logger.info("watch room ended", { roomId, reason });
      await this.publish({ op: "room.close", roomId, reason });
    }
  }

  private async removeEverywhere(userId: string, channelId: string | null, reason: "banned" | "suspended") {
    for (const roomId of await openRoomsOfMember(this.d.db, userId, channelId ?? undefined)) {
      const changed = await removeMember(this.d.db, roomId, userId);
      if (changed === "ended") await this.publish({ op: "room.close", roomId, reason: "moderation" });
      else if (changed === "kicked") await this.publish({ op: "room.kick", roomId, userId, reason });
      if (changed) this.d.logger.info("watch room member removed", { roomId, userId, reason });
    }
  }
}
