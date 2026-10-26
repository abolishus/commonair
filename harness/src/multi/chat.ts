// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Chat sockets pinned to one chat instance, and sends classified by what the server answered. */
import type { NoticeCode } from "@commonair/contracts/chat";
import type { Logger } from "@commonair/observability";
import type { Api } from "../api/client.ts";
import { ChatClient } from "../chat-client.ts";
import { sleep } from "../wait.ts";
import { chatUrlOn } from "./replicas.ts";

/**
 * A fresh chat URL with token for `instance`: null = the instance the API advertises (chat-1),
 * else a replica base such as `ws://localhost:3102`.
 */
export async function chatUrlFor(api: Api, instance: string | null): Promise<string> {
  const { token, url } = await api.client.chat.connectToken();
  const u = new URL(instance === null ? url : chatUrlOn(instance, url));
  u.searchParams.set("token", token);
  return u.toString();
}

export async function connectOn(api: Api, instance: string | null, log?: Logger): Promise<ChatClient> {
  return ChatClient.connect({ url: await chatUrlFor(api, instance), log });
}

export interface SendOutcome {
  accepted: boolean;
  id: string | null;
  /** The notice that came with a rejection (msg_banned, msg_slowmode, …), if any. */
  code: NoticeCode | null;
  at: number;
}

/** Send and wait for the ack; the server sends a rejection's notice before its ack. */
export async function sendClassified(c: ChatClient, channel: string, body: string): Promise<SendOutcome> {
  const codes: NoticeCode[] = [];
  const off = c.onFrame((f) => {
    if (f.op === "notice" && (f.channel === channel || f.channel === null)) codes.push(f.code);
  });
  const at = Date.now();
  try {
    const ack = await c.send(channel, body);
    return { accepted: ack.id !== null && !ack.held, id: ack.id, code: codes[0] ?? null, at };
  } finally {
    off();
  }
}

export interface UntilRejected {
  /** First rejected send (epoch ms), or null when every send within the deadline was accepted. */
  rejectedAt: number | null;
  code: NoticeCode | null;
  /** Sends accepted before the first rejection. */
  acceptedBefore: SendOutcome[];
}

/**
 * Send every `intervalMs` until a send is rejected or `deadline` (epoch ms) passes. Bodies are
 * unique (`<prefix><n>`) so the duplicate filter never answers instead of the rule under test.
 */
export async function sendUntilRejected(
  c: ChatClient,
  channel: string,
  prefix: string,
  opts: { intervalMs: number; deadline: number; signal?: AbortSignal },
): Promise<UntilRejected> {
  const acceptedBefore: SendOutcome[] = [];
  for (let n = 0; ; n++) {
    const r = await sendClassified(c, channel, `${prefix}${n}`);
    if (!r.accepted) return { rejectedAt: r.at, code: r.code, acceptedBefore };
    acceptedBefore.push(r);
    if (Date.now() + opts.intervalMs > opts.deadline) return { rejectedAt: null, code: null, acceptedBefore };
    await sleep(opts.intervalMs, opts.signal);
  }
}
