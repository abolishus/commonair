// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer-platform` step 5 (E9-ws; docs/testing/e9-selectors.md, ADR 0027 §3): the EventSub
 * WebSocket against the API port. `session_welcome` (keepalive 10); with the streamer's grant
 * token, WebSocket subscriptions to `channel.chat.message`, `channel.follow`, `channel.poll.begin`
 * and `channel.points.change` (the last two are E8's EventSub delivery check); the viewer chats and
 * follows, the streamer starts a poll and rewards the viewer → one `notification` each;
 * `session_keepalive` after 10 idle seconds; a socket that never subscribes closes 4003; a fourth
 * bound session for the grant is refused; revoking the grant sends `revocation` per subscription
 * and closes 4008, and a chat socket opened with the same token closes too.
 */
import { EVENTSUB_WS_CLOSE, EVENTSUB_WS_PATH } from "@commonair/contracts/eventsub";
import type { PublicEventType, WsMessage } from "@commonair/contracts/events";
import { createApi } from "../api/client.ts";
import { ChatClient } from "../chat-client.ts";
import { waitFor } from "../wait.ts";
import { type E9Run, type E9Step } from "./run.ts";
import { openEventSub, type EventSubConnection } from "./ws-client.ts";

/** `ws(s)://<api>/eventsub/ws` from the API's http(s) URL (the harness talks to the API port). */
export function eventSubUrl(apiUrl: string, query: Record<string, string> = {}): string {
  const u = new URL(EVENTSUB_WS_PATH, apiUrl.replace(/^http/, "ws"));
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

export interface SubscriptionSpec {
  type: PublicEventType;
  condition: Record<string, string>;
}

/** The four subscriptions of the streamer's grant (chat reads as the streamer, Twitch-style). */
export function streamerSubscriptions(streamerId: string): SubscriptionSpec[] {
  return [
    { type: "channel.chat.message", condition: { broadcaster_user_id: streamerId, user_id: streamerId } },
    { type: "channel.follow", condition: { broadcaster_user_id: streamerId } },
    { type: "channel.poll.begin", condition: { broadcaster_user_id: streamerId } },
    { type: "channel.points.change", condition: { broadcaster_user_id: streamerId } },
  ];
}

/** The first message of `type` (and, for notifications, subscription type) matching `pred`, not in `seen`. */
export function findMessage(
  messages: readonly WsMessage[],
  type: WsMessage["metadata"]["message_type"],
  opts: {
    subscriptionType?: PublicEventType;
    pred?: (event: Record<string, unknown>) => boolean;
    seen?: ReadonlySet<WsMessage>;
  } = {},
): WsMessage | undefined {
  return messages.find(
    (m) =>
      m.metadata.message_type === type &&
      !opts.seen?.has(m) &&
      (opts.subscriptionType === undefined || m.metadata.subscription_type === opts.subscriptionType) &&
      (opts.pred === undefined || opts.pred(m.payload.event ?? {})),
  );
}

export const count = (
  messages: readonly WsMessage[],
  type: WsMessage["metadata"]["message_type"],
  subscriptionType?: PublicEventType,
): number =>
  messages.filter(
    (m) =>
      m.metadata.message_type === type &&
      (subscriptionType === undefined || m.metadata.subscription_type === subscriptionType),
  ).length;

const NOTIFY_MS = 20_000;
/** Keepalive 10 s, plus slack for the server's tick. */
const KEEPALIVE_WAIT_MS = 15_000;
/** `EVENTSUB_WS_SUBSCRIBE_WITHIN_SECONDS` (10) plus slack. */
const UNUSED_WAIT_MS = 20_000;

/** The error code of an oRPC refusal and its `requirement`, without the message text. */
function refusal(err: unknown): { code?: string; requirement?: string } {
  const e = err as { code?: unknown; data?: { requirement?: unknown } } | null;
  return {
    code: typeof e?.code === "string" ? e.code : undefined,
    requirement: typeof e?.data?.requirement === "string" ? e.data.requirement : undefined,
  };
}

async function run(r: E9Run): Promise<void> {
  const { ctx, env, state, actors } = r;
  const grant = state.grant;
  if (!grant) throw new Error("step 2 left no grant");
  const app = state.confidentialApp;
  if (!app) throw new Error("step 1 left no confidential app");
  const streamer = actors.streamer;
  const streamerId = streamer.user.id;
  const viewer = actors.viewer;
  // The grant's token, never logged: subscriptions are made by the app on the streamer's behalf.
  const bot = createApi({ baseUrl: env.HARNESS_API_URL, bearer: grant.accessToken }).client;
  const sockets: EventSubConnection[] = [];
  let chat: ChatClient | null = null;
  let grantChat: ChatClient | null = null;

  const open = async (): Promise<{ conn: EventSubConnection; sessionId: string; welcome: WsMessage }> => {
    const conn = await openEventSub(eventSubUrl(env.HARNESS_API_URL));
    sockets.push(conn);
    const welcome = await conn.next("session_welcome", 10_000);
    const sessionId = welcome.payload.session?.id;
    if (!sessionId) throw new Error("session_welcome without a session id");
    return { conn, sessionId, welcome };
  };
  const subscribe = (sessionId: string, spec: SubscriptionSpec) =>
    bot.developer.events.subscribe({
      type: spec.type,
      version: "1",
      condition: spec.condition,
      transport: { method: "websocket", sessionId },
    });
  const notified = (
    conn: EventSubConnection,
    what: string,
    subscriptionType: PublicEventType,
    pred: (event: Record<string, unknown>) => boolean,
  ) =>
    waitFor(`${what} as a notification`, () => findMessage(conn.messages, "notification", { subscriptionType, pred }), {
      timeoutMs: NOTIFY_MS,
      intervalMs: 100,
      signal: ctx.signal,
    });

  try {
    const main = await ctx.step("connect: session_welcome with keepalive 10", async () => {
      const o = await open();
      const s = o.welcome.payload.session;
      ctx.assert(
        "status connected, keepalive 10, no reconnect URL",
        s?.status === "connected" && s.keepalive_timeout_seconds === 10 && s.reconnect_url === null,
        { status: s?.status, keepalive: s?.keepalive_timeout_seconds },
      );
      return o;
    });

    const specs = streamerSubscriptions(streamerId);
    await ctx.step("subscribe chat, follow, poll begin and points change with the grant's token", async () => {
      for (const spec of specs) {
        const sub = await subscribe(main.sessionId, spec);
        ctx.assert(
          `${spec.type} enabled on the session`,
          sub.status === "enabled" &&
            sub.transport.method === "websocket" &&
            sub.transport.sessionId === main.sessionId,
          { id: sub.id, status: sub.status },
        );
      }
    });

    await ctx.step("the viewer chats → channel.chat.message", async () => {
      chat = await ChatClient.connectWithApi(viewer.api.client, r.log);
      await chat.join(streamer.channel);
      const text = `ws harness ${ctx.runId}`.slice(0, 200);
      await chat.send(streamer.channel, text);
      const n = await notified(main.conn, "the chat message", "channel.chat.message", (e) => {
        const message = e.message as { text?: unknown } | undefined;
        return e.chatter_user_id === viewer.id && message?.text === text;
      });
      ctx.assert("chat notification for the streamer's channel", n.payload.event?.broadcaster_user_id === streamerId);
    });

    await ctx.step("the viewer follows → channel.follow", async () => {
      // Step 4 may have followed already; a follow that inserts nothing emits nothing.
      await viewer.api.client.channels.unfollow({ channel: streamer.channel });
      await viewer.api.client.channels.follow({ channel: streamer.channel, notify: false });
      await notified(main.conn, "the follow", "channel.follow", (e) => e.user_id === viewer.id);
    });

    await ctx.step("the streamer starts a poll → channel.poll.begin", async () => {
      const poll = await streamer.user.api.client.interact.polls.create({
        channel: streamer.channel,
        title: `WS poll ${ctx.runId}`.slice(0, 60),
        choices: ["Yes", "No"],
        durationSeconds: 15,
        pointsPerExtraVote: 0,
      });
      await notified(main.conn, "the poll", "channel.poll.begin", (e) => e.id === poll.id);
      await streamer.user.api.client.interact.polls.end({ id: poll.id, status: "terminated" }).catch(() => undefined);
    });

    await ctx.step("the streamer rewards the viewer → channel.points.change", async () => {
      await streamer.user.api.client.bot.points.adjust({
        channel: streamer.channel,
        username: viewer.username,
        delta: 10,
        reason: "reward",
      });
      await notified(main.conn, "the points change", "channel.points.change", (e) => e.user_id === viewer.id);
    });

    ctx.assert(
      "one notification per action, nothing else",
      specs.every((s) => count(main.conn.messages, "notification", s.type) === 1),
      {
        counts: Object.fromEntries(specs.map((s) => [s.type, count(main.conn.messages, "notification", s.type)])),
      },
    );

    // Both waits take about 10 s: run them side by side.
    await Promise.all([
      ctx.step("session_keepalive after 10 idle seconds", async () => {
        const before = count(main.conn.messages, "session_keepalive");
        const started = Date.now();
        await waitFor("a new session_keepalive", () => count(main.conn.messages, "session_keepalive") > before, {
          timeoutMs: KEEPALIVE_WAIT_MS,
          intervalMs: 100,
          signal: ctx.signal,
        });
        ctx.assert("keepalive within the 10 s timeout", Date.now() - started <= 11_000, {
          ms: Date.now() - started,
        });
      }),
      ctx.step("a socket that never subscribes closes 4003", async () => {
        const unused = await open();
        const closed = await Promise.race([
          unused.conn.closed,
          Bun.sleep(UNUSED_WAIT_MS).then(() => ({ code: 0, reason: "still open" })),
        ]);
        ctx.assert("closed 4003", closed.code === EVENTSUB_WS_CLOSE.connectionUnused, closed);
      }),
    ]);

    await ctx.step("a fourth bound session for the grant is refused", async () => {
      const spec = specs[1] as SubscriptionSpec;
      for (const n of [2, 3]) {
        const o = await open();
        const sub = await subscribe(o.sessionId, spec);
        ctx.assert(`session ${n} binds`, sub.status === "enabled");
      }
      const fourth = await open();
      const err = await subscribe(fourth.sessionId, spec).then(
        () => null,
        (e: unknown) => e,
      );
      const r4 = refusal(err);
      ctx.assert(
        "refused: PRECONDITION_FAILED websocket_session_limit",
        r4.code === "PRECONDITION_FAILED" && r4.requirement === "websocket_session_limit",
        r4,
      );
      fourth.conn.close();
    });

    await ctx.step("revoking the grant: revocation per subscription, close 4008, the chat socket closes", async () => {
      const chatUrl = new URL((await viewer.api.client.chat.connectToken()).url);
      chatUrl.searchParams.delete("token");
      grantChat = await ChatClient.connect({ url: chatUrl.toString(), bearer: grant.accessToken, log: r.log });
      await streamer.user.api.client.developer.grants.revoke({ appId: app.id });

      const closed = await Promise.race([
        main.conn.closed,
        Bun.sleep(NOTIFY_MS).then(() => ({ code: 0, reason: "still open" })),
      ]);
      ctx.assert("main session closed 4008", closed.code === EVENTSUB_WS_CLOSE.authorizationRevoked, closed);
      const revoked = main.conn.messages.filter((m) => m.metadata.message_type === "revocation");
      ctx.assert(
        "one revocation per subscription, authorization_revoked",
        revoked.length === specs.length &&
          revoked.every((m) => m.payload.subscription?.status === "authorization_revoked") &&
          new Set(revoked.map((m) => m.metadata.subscription_type)).size === specs.length,
        { revocations: revoked.map((m) => m.metadata.subscription_type) },
      );
      const gc = grantChat;
      await waitFor("the grant's chat socket closes", () => !gc.isOpen, {
        timeoutMs: NOTIFY_MS,
        intervalMs: 200,
        signal: ctx.signal,
      });
      ctx.data("websocket", { sessionId: main.sessionId, revocations: revoked.length });
    });
  } finally {
    for (const s of sockets) s.close();
    (chat as ChatClient | null)?.close();
    (grantChat as ChatClient | null)?.close();
  }
}

export const step: E9Step = {
  name: "websocket",
  owner: "E9-ws",
  ready: true,
  needs: [2],
  run,
};
