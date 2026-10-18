// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat WebSocket client speaking the contract's `ClientFrame` / `ServerFrame` protocol. Every
 * incoming frame is validated with the contract schema, so protocol drift fails scenarios loudly.
 */
import { type ClientFrame, ServerFrame } from "@commonair/contracts";
import type { Logger } from "@commonair/observability";
import type { ApiClient } from "./api/client.ts";
import { TimeoutError } from "./wait.ts";

type Frame = ServerFrame;

/** Bun's WebSocket also accepts request headers (browsers cannot); bots use that for bearer auth. */
const BunWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
type FrameOf<Op extends Frame["op"]> = Extract<Frame, { op: Op }>;

export interface ChatConnectOptions {
  /** Full WebSocket URL including `?token=` for browser-style auth. */
  url: string;
  /** Server-to-server style auth (`Authorization: Bearer`), e.g. bots with OAuth tokens. */
  bearer?: string;
  log?: Logger;
  /** Frames kept for inspection. */
  history?: number;
  connectTimeoutMs?: number;
}

export class ChatProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatProtocolError";
  }
}

export class ChatClient {
  readonly frames: Frame[] = [];
  welcome: FrameOf<"welcome"> | null = null;
  private listeners = new Set<(f: Frame) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private nonce = 0;
  private closed = false;
  readonly invalidFrames: string[] = [];

  private constructor(
    private readonly ws: WebSocket,
    private readonly opts: ChatConnectOptions,
  ) {}

  /** Connect and wait for the `welcome` frame. */
  static async connect(opts: ChatConnectOptions): Promise<ChatClient> {
    const ws = opts.bearer
      ? new BunWebSocket(opts.url, { headers: { authorization: `Bearer ${opts.bearer}` } })
      : new WebSocket(opts.url);
    const client = new ChatClient(ws, opts);
    ws.addEventListener("message", (ev) => client.onMessage(ev.data));
    ws.addEventListener("close", () => client.onClose());
    const timeoutMs = opts.connectTimeoutMs ?? 10_000;
    // Listen before the socket opens: the server may send `welcome` immediately.
    const welcome = client.next("welcome", () => true, timeoutMs);
    welcome.catch(() => undefined);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TimeoutError("chat websocket open", timeoutMs)), timeoutMs);
        ws.addEventListener("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new Error("chat websocket failed to connect"));
        });
      });
      client.welcome = await welcome;
    } catch (err) {
      client.close();
      throw err;
    }
    const interval = Math.max(1_000, Math.floor(client.welcome.heartbeatMs / 2));
    client.pingTimer = setInterval(() => {
      if (client.isOpen) client.raw({ op: "ping" });
    }, interval);
    return client;
  }

  /** Get a chat token from the API (anonymous or signed-in, per the client's jar) and connect. */
  static async connectWithApi(api: ApiClient, log?: Logger): Promise<ChatClient> {
    const { token, url } = await api.chat.connectToken();
    const u = new URL(url);
    u.searchParams.set("token", token);
    return ChatClient.connect({ url: u.toString(), log });
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.invalidFrames.push(text.slice(0, 200));
      return;
    }
    const result = ServerFrame.safeParse(parsed);
    if (!result.success) {
      this.invalidFrames.push(text.slice(0, 200));
      this.opts.log?.warn("invalid chat frame", { issues: result.error.issues.slice(0, 3) });
      return;
    }
    this.frames.push(result.data);
    if (this.frames.length > (this.opts.history ?? 500)) this.frames.shift();
    for (const l of this.listeners) l(result.data);
  }

  private onClose(): void {
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  onFrame(listener: (f: Frame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Wait for the next frame of a type matching `predicate` (frames already received are not considered). */
  next<Op extends Frame["op"]>(
    op: Op,
    predicate: (f: FrameOf<Op>) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<FrameOf<Op>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new TimeoutError(`chat frame ${op}`, timeoutMs));
      }, timeoutMs);
      const off = this.onFrame((f) => {
        if (f.op === "error" && op !== "error") {
          clearTimeout(timer);
          off();
          reject(new ChatProtocolError(`${f.code}: ${f.message}`));
          return;
        }
        if (f.op === op && predicate(f as FrameOf<Op>)) {
          clearTimeout(timer);
          off();
          resolve(f as FrameOf<Op>);
        }
      });
    });
  }

  /** Wait until some frame (past or future) matches. */
  async waitFor<Op extends Frame["op"]>(
    op: Op,
    predicate: (f: FrameOf<Op>) => boolean,
    timeoutMs = 10_000,
  ): Promise<FrameOf<Op>> {
    const seen = this.frames.find((f): f is FrameOf<Op> => f.op === op && predicate(f as FrameOf<Op>));
    return seen ?? this.next(op, predicate, timeoutMs);
  }

  raw(frame: ClientFrame | { op: "ping"; nonce?: string }): void {
    if (!this.isOpen) throw new ChatProtocolError("chat connection is closed");
    this.ws.send(JSON.stringify(frame));
  }

  async join(channel: string): Promise<FrameOf<"joined">> {
    const joined = this.next("joined", (f) => f.channel === channel);
    this.raw({ op: "join", channel });
    return joined;
  }

  async part(channel: string): Promise<void> {
    const parted = this.next("parted", (f) => f.channel === channel);
    this.raw({ op: "part", channel });
    await parted;
  }

  /** Send a message and wait for the server's ack (id null + held=false means rejected; see notices). */
  async send(
    channel: string,
    body: string,
    opts: { replyToId?: string; isAction?: boolean } = {},
  ): Promise<FrameOf<"ack">> {
    const nonce = `n${++this.nonce}`;
    const ack = this.next("ack", (f) => f.nonce === nonce);
    this.raw({ op: "send", channel, body, nonce, isAction: opts.isAction ?? false, replyToId: opts.replyToId });
    return ack;
  }

  /** Fire-and-forget send (spam bots do not wait for acks). */
  sendNoWait(channel: string, body: string): void {
    this.raw({ op: "send", channel, body, isAction: false, nonce: `n${++this.nonce}` });
  }

  async command(channel: string, command: string, args: string[] = []): Promise<FrameOf<"notice">> {
    const notice = this.next("notice", (f) => f.channel === channel || f.channel === null);
    this.raw({ op: "command", channel, command, args, nonce: `n${++this.nonce}` });
    return notice;
  }

  messages(channel?: string): FrameOf<"message">[] {
    return this.frames.filter(
      (f): f is FrameOf<"message"> => f.op === "message" && (!channel || f.channel === channel),
    );
  }

  close(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (!this.closed) this.ws.close(1000, "bye");
    this.closed = true;
  }
}
