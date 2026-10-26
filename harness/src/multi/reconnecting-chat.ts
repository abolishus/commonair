// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A chat client that survives the loss of its instance, the way the web client does
 * (`apps/web/src/chat/connection.ts`): when the socket closes it waits `backoffDelay(attempt)`,
 * fetches a fresh URL (a new chat token) and connects again, joining its channel; the attempt
 * counter resets once joined. The harness `ChatClient` does not reconnect, so this wraps it.
 *
 * Standing in for the load balancer: `endpoints` are the chat instances in rotation, and a
 * reconnect after a close or a failed attempt goes to the next one (a balancer takes a dead
 * backend out of rotation). ChatClient exposes no close event, so the socket state is polled
 * every `pollMs`; that bounds how late a close is noticed.
 */
import type { ServerFrame } from "@commonair/contracts";
import type { Logger } from "@commonair/observability";
import { errorMessage } from "../redact.ts";
import { TimeoutError } from "../wait.ts";
import { backoffDelay } from "./backoff.ts";

export interface ChatLike {
  readonly isOpen: boolean;
  join(channel: string): Promise<unknown>;
  onFrame(listener: (f: ServerFrame) => void): () => void;
  close(): void;
}

export interface ReconnectingChatOptions<C extends ChatLike> {
  channel: string;
  endpoints: readonly string[];
  /** The endpoint the first connection uses (index into `endpoints`). */
  startAt?: number;
  /** A fresh connection URL for an endpoint (each connect gets a new token, like the web client). */
  urlFor: (endpoint: string) => Promise<string>;
  connect: (url: string) => Promise<C>;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  log?: Logger;
}

export interface ConnectionRecord {
  endpoint: string;
  connectedAt: number;
  closedAt: number | null;
}

export interface AttemptRecord {
  endpoint: string;
  at: number;
  ok: boolean;
  /** The backoff waited before this attempt (0 for the first). */
  waitedMs: number;
  error?: string;
}

type MessageFrame = Extract<ServerFrame, { op: "message" }>;

export class ReconnectingChat<C extends ChatLike = ChatLike> {
  readonly connections: ConnectionRecord[] = [];
  readonly attempts: AttemptRecord[] = [];
  readonly frames: ServerFrame[] = [];
  private readonly listeners = new Set<(f: ServerFrame) => void>();
  private readonly connectedWaiters = new Set<() => void>();
  private current: C | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: ReconnectingChatOptions<C>) {
    if (opts.endpoints.length === 0) throw new Error("ReconnectingChat needs at least one endpoint");
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /** The live client, or null between connections. */
  get client(): C | null {
    return this.current;
  }

  /** The endpoint of the open connection, or null. */
  get endpoint(): string | null {
    const last = this.connections.at(-1);
    return last && last.closedAt === null ? last.endpoint : null;
  }

  /** Start the connect loop; resolves once the first connection has joined. */
  async start(timeoutMs = 15_000): Promise<ConnectionRecord> {
    this.loop ??= this.run();
    return this.waitConnected(0, timeoutMs);
  }

  /** The first connection that joined at or after `since` (epoch ms). */
  waitConnected(since: number, timeoutMs: number): Promise<ConnectionRecord> {
    const find = () => this.connections.find((c) => c.connectedAt >= since);
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.connectedWaiters.delete(check);
        reject(new TimeoutError(`chat reconnect on ${this.opts.channel}`, timeoutMs));
      }, timeoutMs);
      const check = () => {
        const c = find();
        if (!c) return;
        clearTimeout(timer);
        this.connectedWaiters.delete(check);
        resolve(c);
      };
      this.connectedWaiters.add(check);
    });
  }

  onFrame(listener: (f: ServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Message frames received on this client's channel, across every connection. */
  messages(): MessageFrame["message"][] {
    return this.frames
      .filter((f): f is MessageFrame => f.op === "message" && f.channel === this.opts.channel)
      .map((f) => f.message);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.current?.close();
    await this.loop;
  }

  private async run(): Promise<void> {
    const { endpoints } = this.opts;
    let index = this.opts.startAt ?? 0;
    let attempt = 0;
    let waitedMs = 0;
    while (!this.stopped) {
      const endpoint = endpoints[index % endpoints.length] as string;
      let client: C | null = null;
      let off: (() => void) | null = null;
      try {
        client = await this.opts.connect(await this.opts.urlFor(endpoint));
        off = client.onFrame((f) => {
          this.frames.push(f);
          for (const l of this.listeners) l(f);
        });
        await client.join(this.opts.channel);
      } catch (err) {
        off?.();
        client?.close();
        this.attempts.push({ endpoint, at: this.now(), ok: false, waitedMs, error: errorMessage(err) });
        this.opts.log?.info("chat reconnect attempt failed", { endpoint, attempt });
        index++;
        waitedMs = backoffDelay(attempt++, {}, this.opts.random);
        if (!this.stopped) await this.sleep(waitedMs);
        continue;
      }
      this.attempts.push({ endpoint, at: this.now(), ok: true, waitedMs });
      attempt = 0;
      this.current = client;
      const record: ConnectionRecord = { endpoint, connectedAt: this.now(), closedAt: null };
      this.connections.push(record);
      for (const w of this.connectedWaiters) w();
      while (!this.stopped && client.isOpen) await this.sleep(this.opts.pollMs ?? 50);
      record.closedAt = this.now();
      off();
      this.current = null;
      if (this.stopped) break;
      this.opts.log?.info("chat connection lost; reconnecting", { endpoint });
      index++;
      waitedMs = backoffDelay(attempt++, {}, this.opts.random);
      await this.sleep(waitedMs);
    }
  }
}
