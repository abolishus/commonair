// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The room's own chat socket (ADR 0017, decision (r)). A room is not a channel: it never joins the
 * channel's chat, so it has its own connection, authenticated like the chat panel's (a fresh
 * `chat.connectToken` per connect), that sends `room.join` with the room token `watchRooms.join`
 * returned. Every 2 s it reports this member's playhead (`room.sync`); it hands `room.*` frames and
 * `room_*` notices to the drawer. Unexpected closes reconnect with backoff and a fresh room token.
 * Socket, tokens and timers are injected so the protocol is unit-testable.
 */
import { ServerFrame } from "@commonair/contracts/chat";
import { backoffDelay } from "../../chat/backoff.ts";
import type { SocketLike } from "../../chat/connection.ts";
import { playbackMode, playheadWallclock } from "../../player/media-clock.ts";

export type RoomFrame = Extract<ServerFrame, { op: "room.state" | "room.message" | "room.sync" | "room.closed" }>;
export type RoomMessageFrame = Extract<ServerFrame, { op: "room.message" }>["message"];

export interface RoomConnectionDeps {
  /** The member's chat socket token and URL. */
  getChatToken: () => Promise<{ token: string; url: string }>;
  /** A fresh room token (the API re-checks the member at every call). */
  getRoomToken: () => Promise<string>;
  createSocket: (url: string) => SocketLike;
  /** This member's playhead and mode; defaults to the channel's media clock. */
  playhead?: () => { at: Date | null; mode: "live" | "dvr" };
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setRepeat?: (fn: () => void, ms: number) => unknown;
  clearRepeat?: (handle: unknown) => void;
}

export interface RoomConnectionEvents {
  onStatus: (status: "connecting" | "open" | "closed") => void;
  onFrame: (frame: RoomFrame) => void;
  /** A notice or error the server sent (a `room_*` refusal, a rate limit, a filter). */
  onNotice: (code: string) => void;
}

const OPEN = 1;
export const SYNC_REPORT_MS = 2000;

export class RoomConnection {
  private socket: SocketLike | null = null;
  private attempt = 0;
  private stopped = false;
  private reconnect: unknown = null;
  private ping: unknown = null;
  private report: unknown = null;
  private nonce = 0;

  constructor(
    readonly channel: string,
    readonly roomId: string,
    private readonly deps: RoomConnectionDeps,
    private readonly events: RoomConnectionEvents,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const s = this.socket;
    this.socket = null;
    if (s && s.readyState === OPEN) s.send(JSON.stringify({ op: "room.part", roomId: this.roomId }));
    s?.close(1000, "bye");
    this.events.onStatus("closed");
  }

  /** Send a room message; false when the socket is not open. */
  send(body: string): boolean {
    return this.write({ op: "room.send", roomId: this.roomId, body, nonce: `m${++this.nonce}` });
  }

  private write(frame: Record<string, unknown>): boolean {
    const s = this.socket;
    if (!s || s.readyState !== OPEN) return false;
    s.send(JSON.stringify(frame));
    return true;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms);
  }
  private clearTimer(h: unknown): void {
    if (h !== null) (this.deps.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(h);
  }
  private setRepeat(fn: () => void, ms: number): unknown {
    return (this.deps.setRepeat ?? ((f, m) => setInterval(f, m)))(fn, ms);
  }
  private clearRepeat(h: unknown): void {
    if (h !== null) (this.deps.clearRepeat ?? ((x) => clearInterval(x as ReturnType<typeof setInterval>)))(h);
  }

  private clearTimers(): void {
    this.clearTimer(this.reconnect);
    this.reconnect = null;
    this.clearRepeat(this.ping);
    this.ping = null;
    this.clearRepeat(this.report);
    this.report = null;
  }

  private async connect(): Promise<void> {
    this.events.onStatus("connecting");
    let chat: { token: string; url: string };
    let roomToken: string;
    try {
      [chat, roomToken] = await Promise.all([this.deps.getChatToken(), this.deps.getRoomToken()]);
    } catch {
      // The room refused this member (ended, removed): the drawer learns why from the API call.
      if (!this.stopped) this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    const url = new URL(chat.url);
    url.searchParams.set("token", chat.token);
    const socket = this.deps.createSocket(url.toString());
    this.socket = socket;
    socket.addEventListener("message", (ev) => this.onMessage(String(ev.data), roomToken));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      this.events.onStatus("closed");
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const delay = backoffDelay(this.attempt++);
    this.reconnect = this.setTimer(() => void this.connect(), delay);
  }

  private onMessage(raw: string, roomToken: string): void {
    let frame: ServerFrame;
    try {
      const parsed = ServerFrame.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      frame = parsed.data;
    } catch {
      return;
    }
    switch (frame.op) {
      case "welcome":
        this.attempt = 0;
        this.write({ op: "room.join", roomId: this.roomId, token: roomToken, nonce: "join" });
        this.ping = this.setRepeat(() => this.write({ op: "ping" }), Math.max(5000, frame.heartbeatMs / 2));
        this.report = this.setRepeat(() => this.reportPlayhead(), SYNC_REPORT_MS);
        return;
      case "notice":
        this.events.onNotice(frame.code);
        return;
      case "error":
        this.events.onNotice(frame.code);
        return;
      case "room.state":
        this.events.onStatus("open");
        if (frame.roomId === this.roomId) this.events.onFrame(frame);
        return;
      case "room.message":
      case "room.sync":
        if (frame.roomId === this.roomId) this.events.onFrame(frame);
        return;
      case "room.closed":
        if (frame.roomId !== this.roomId) return;
        this.events.onFrame(frame);
        this.stop();
        return;
      default:
        return;
    }
  }

  private reportPlayhead(): void {
    const p = this.deps.playhead?.() ?? { at: playheadWallclock(this.channel), mode: playbackMode(this.channel) };
    if (!p.at) return;
    this.write({ op: "room.sync", roomId: this.roomId, playheadWallclock: p.at.toISOString(), mode: p.mode });
  }
}
