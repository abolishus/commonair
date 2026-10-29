// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Receive events over the EventSub WebSocket with a user token: subscribe within 10 seconds of the
 * welcome, resubscribe after a reconnect from scratch (`onNewSession`), and stop on 4008 (the user
 * revoked the app: authorize again). `session_reconnect` hand-overs keep the session and its
 * subscriptions; the client follows them on its own.
 *
 *   COMMONAIR_URL=https://your.instance COMMONAIR_TOKEN=… BROADCASTER_ID=… bun examples/eventsub-websocket.ts
 *
 * The token needs `chat:read` for chat messages (follows need no scope). Use `refreshingToken`
 * (see device-flow-chat-bot.ts) as `getToken` for a long-running bot: a refresh never ends a session.
 */
import { connectEventSub, createClient, subscribe, type SubscribeOptions } from "@commonair/sdk";

const baseUrl = process.env.COMMONAIR_URL ?? "http://localhost:3001";
const token = process.env.COMMONAIR_TOKEN ?? "";
const broadcaster = process.env.BROADCASTER_ID ?? "";
const me = process.env.USER_ID ?? broadcaster;
if (!token || !broadcaster) throw new Error("set COMMONAIR_TOKEN and BROADCASTER_ID");

const client = createClient({ baseUrl, token });
const wanted: Omit<SubscribeOptions, "sessionId">[] = [
  { type: "channel.follow", condition: { broadcaster_user_id: broadcaster } },
  { type: "channel.chat.message", condition: { broadcaster_user_id: broadcaster, user_id: me } },
];
const subscribeAll = async (sessionId: string) => {
  for (const w of wanted) await subscribe(client, { ...w, sessionId });
  console.warn(`subscribed on session ${sessionId}`);
};

const session = await connectEventSub({
  baseUrl,
  onNewSession: subscribeAll,
  onError: (e) => console.warn(e.message),
});
await subscribeAll(session.sessionId);

session.onNotification((n) => {
  if (n.subscriptionType === "channel.follow") console.warn(`new follower: ${String(n.event.user_name)}`);
  else console.warn(n.subscriptionType, n.event);
});
session.onRevocation((r) => console.warn(`revoked: ${r.subscriptionType} (${r.status})`));

const closed = await session.closed;
console.warn(
  closed.reauthorize ? "The authorization was revoked: authorize again." : `closed (${closed.name ?? closed.code})`,
);
