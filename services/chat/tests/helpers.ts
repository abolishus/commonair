// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Integration-test helpers: seeding, chat instances, and a frame-recording WebSocket client. */
import { ChannelChatSettings, type ServerFrame } from "@commonair/contracts";
import { schema, uuidv7, type Database } from "@commonair/db";
import { createLogger } from "@commonair/observability";
import { randomSecret, sha256Hex, signChatToken } from "@commonair/tokens";
import { startChatService, type ChatService, type ChatServiceOptions } from "../src/server.ts";

export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
export const SECRET = randomSecret("", 32);
export const quietLogger = createLogger({ service: "chat-int", level: "fatal" });

export interface Isolation {
  keyPrefix: string;
  busPrefix: string;
}
export const isolation = (): Isolation => {
  const tag = crypto.randomUUID();
  return { keyPrefix: `test:${tag}:`, busPrefix: `test:${tag}:` };
};

export function startInstance(
  db: Database,
  iso: Isolation,
  over: Partial<ChatServiceOptions> = {},
): Promise<ChatService> {
  return startChatService({
    port: 0,
    hostname: "127.0.0.1",
    db,
    valkeyUrl: VALKEY_URL,
    internalSecret: SECRET,
    logger: quietLogger,
    ...iso,
    ...over,
  });
}

let seq = 0;
export async function createUser(
  db: Database,
  over: Partial<typeof schema.users.$inferInsert> = {},
): Promise<{ id: string; username: string }> {
  const n = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  const username = over.username ?? `u_${n}`.slice(0, 25);
  const id = uuidv7();
  await db.insert(schema.users).values({
    id,
    name: username,
    email: `${username}@example.test`,
    emailVerified: true,
    username,
    createdAt: new Date(Date.now() - 30 * 86_400_000),
    ...over,
  });
  return { id, username };
}

export async function createChannel(
  db: Database,
  owner: { id: string; username: string },
  settings: Partial<ChannelChatSettings> = {},
): Promise<{ id: string; slug: string }> {
  const id = uuidv7();
  await db.insert(schema.channels).values({
    id,
    ownerId: owner.id,
    slug: owner.username,
    displayName: owner.username,
    chatSettings: ChannelChatSettings.parse({
      slowModeSeconds: 0,
      followersOnlyMinutes: null,
      subscribersOnly: false,
      emoteOnly: false,
      minAccountAgeDays: 0,
      requireVerifiedEmail: true,
      linksAllowed: true,
      ...settings,
    }),
  });
  return { id, slug: owner.username };
}

export const FULL_SCOPES = ["chat:read", "chat:edit", "moderator:manage:chat"];

export const chatToken = (uid: string | null, scopes: string[] = FULL_SCOPES) =>
  signChatToken(SECRET, { v: 1, uid, app: null, scopes, exp: Math.floor(Date.now() / 1000) + 300 });

export async function createOauthToken(db: Database, userId: string, scopes: string[]): Promise<string> {
  const token = randomSecret("cat_", 24);
  await db.insert(schema.oauthTokens).values({
    userId,
    scopes,
    accessTokenHash: await sha256Hex(token),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return token;
}

/** A WebSocket client that records every frame and can wait for one. */
export class Client {
  readonly frames: ServerFrame[] = [];
  /** Rooms this client joined; `say`/`command` join first, since the server requires it. */
  readonly joined = new Set<string>();
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const frame = JSON.parse(String(ev.data)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(frame)) return true;
        w.resolve(frame);
        return false;
      });
    });
    ws.addEventListener("close", (ev) => {
      this.closed = { code: ev.code, reason: ev.reason };
    });
  }

  static async connect(svc: ChatService, auth: { token?: string; bearer?: string } = {}): Promise<Client> {
    const url = new URL(svc.wsUrl);
    if (auth.token) url.searchParams.set("token", auth.token);
    // Bun's WebSocket accepts `{ headers }`; the DOM lib typing (needed for WebCrypto types) does not know it.
    const options = auth.bearer ? { headers: { Authorization: `Bearer ${auth.bearer}` } } : undefined;
    const ws = new WebSocket(url.toString(), options as unknown as string[] | undefined);
    const client = new Client(ws);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket connection failed")), { once: true });
    });
    await client.waitFor((f) => f.op === "welcome");
    return client;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  waitFor<T extends ServerFrame["op"]>(
    pred: (f: ServerFrame) => boolean,
    timeoutMs = 3000,
    { includePast = true } = {},
  ): Promise<Extract<ServerFrame, { op: T }>> {
    if (includePast) {
      const past = this.frames.find(pred);
      if (past) return Promise.resolve(past as Extract<ServerFrame, { op: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for frame; got ${JSON.stringify(this.frames.slice(-5))}`)),
        timeoutMs,
      );
      this.waiters.push({
        pred,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f as Extract<ServerFrame, { op: T }>);
        },
      });
    });
  }

  async join(channel: string): Promise<Extract<ServerFrame, { op: "joined" }>> {
    this.send({ op: "join", channel });
    const joined = await this.waitFor<"joined">((f) => f.op === "joined" && f.channel === channel, 3000, {
      includePast: false,
    });
    this.joined.add(channel);
    return joined;
  }

  /** Send a chat message and resolve with its ack (and the notice, if any, that preceded it). */
  async say(channel: string, body: string, extra: Record<string, unknown> = {}) {
    if (!this.joined.has(channel)) await this.join(channel);
    const nonce = crypto.randomUUID();
    const start = this.frames.length;
    this.send({ op: "send", channel, body, nonce, ...extra });
    const ack = await this.waitFor<"ack">((f) => f.op === "ack" && f.nonce === nonce, 3000, { includePast: false });
    const notice = this.frames.slice(start).find((f) => f.op === "notice") as
      | Extract<ServerFrame, { op: "notice" }>
      | undefined;
    return { ack, notice: notice ?? null };
  }

  /** Run a command frame and resolve with the resulting notice. */
  async command(channel: string, command: string, args: string[] = []) {
    if (!this.joined.has(channel)) await this.join(channel);
    const start = this.frames.length;
    this.send({ op: "command", channel, command, args });
    await this.waitFor((f) => f.op === "notice" && this.frames.indexOf(f) >= start, 5000, { includePast: false });
    return this.frames.slice(start).find((f) => f.op === "notice") as Extract<ServerFrame, { op: "notice" }>;
  }

  /** True if no frame matching `pred` arrives within `ms`. */
  async never(pred: (f: ServerFrame) => boolean, ms = 300): Promise<boolean> {
    await Bun.sleep(ms);
    return !this.frames.some(pred);
  }

  close(): void {
    this.ws.close();
  }
}

/** Poll until `fn` returns a truthy value. */
export async function eventually<T>(fn: () => Promise<T> | T, timeoutMs = 3000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}
