// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chat tokens for a caller: what `chat.connectToken` hands browsers, and what the REST relay
 * presents to the chat service. A session gets every chat scope; an OAuth token only the chat
 * scopes it was granted, and keeps its app so chat applies bot limits. Suspended or anonymous
 * callers read only.
 */
import type { Scope } from "@commonair/contracts/scopes";
import { signChatToken } from "@commonair/tokens";
import type { Deps } from "../deps.ts";
import type { Caller } from "../lib/access.ts";

export const CHAT_SCOPES: Scope[] = ["chat:read", "chat:edit", "moderator:manage:chat"];

export function chatScopesFor(caller: Caller | null): Scope[] {
  if (!caller || caller.user.suspended) return ["chat:read"];
  if (caller.kind === "session") return CHAT_SCOPES;
  return CHAT_SCOPES.filter((s) => s === "chat:read" || caller.scopes.includes(s));
}

/** Sign a chat token for `caller` that expires `ttlSeconds` from now. */
export async function chatTokenFor(
  deps: Pick<Deps, "env" | "now">,
  caller: Caller | null,
  ttlSeconds: number,
): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(deps.now().getTime() / 1000) + ttlSeconds;
  const token = await signChatToken(deps.env.INTERNAL_API_SECRET, {
    v: 1,
    uid: caller?.user.id ?? null,
    app: caller?.kind === "token" ? caller.appId : null,
    scopes: chatScopesFor(caller),
    exp,
  });
  return { token, exp };
}
