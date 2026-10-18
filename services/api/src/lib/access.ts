// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Access control driven by `ProcedureMeta`. The decision is a pure function so
 * every access level and token rule is unit-tested without HTTP or a database;
 * the middleware (lib/orpc.ts) only gathers the facts.
 */
import type { Access, ProcedureMeta } from "@commonair/contracts";
import type { Scope } from "@commonair/contracts/scopes";
import type { CHANNEL_ROLES, PLATFORM_ROLES } from "@commonair/contracts/enums";

export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type ChannelRole = (typeof CHANNEL_ROLES)[number];

export interface CallerUser {
  id: string;
  username: string;
  role: PlatformRole;
  accountType: "human" | "bot";
  /** `users.banned` (platform suspension) still in force. */
  suspended: boolean;
}

export type Caller =
  | { kind: "session"; user: CallerUser; sessionId: string }
  | { kind: "token"; user: CallerUser; tokenId: string; appId: string | null; scopes: Scope[]; expiresAt: Date };

export interface AccessFacts {
  meta: ProcedureMeta;
  caller: Caller | null;
  /** Whether the procedure changes state (non-GET); suspended users may still read. */
  write: boolean;
  /** For owner/moderator procedures: the channel named in the input, if the input names one. */
  channel?: { exists: boolean; ownerId: string | null; callerRoles: ChannelRole[] } | undefined;
  /** For relay/overlay procedures: whether the presented credential resolved. */
  machineCredential?: boolean;
}

export type AccessDecision =
  | { ok: true }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND"; message: string };

const deny = (code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND", message: string): AccessDecision => ({
  ok: false,
  code,
  message,
});

/** Token scope rule from ProcedureMeta: undefined = session only, [] = any token, else all listed. */
export function tokenAllowed(meta: ProcedureMeta, granted: readonly Scope[]): AccessDecision {
  if (meta.scopes === undefined) return deny("FORBIDDEN", "This endpoint is not available to access tokens");
  const missing = meta.scopes.filter((s) => !granted.includes(s));
  if (missing.length > 0) return deny("FORBIDDEN", `Token is missing scopes: ${missing.join(", ")}`);
  return { ok: true };
}

const PLATFORM_LEVELS: Partial<Record<Access, readonly PlatformRole[]>> = {
  admin: ["admin"],
  treasurer: ["treasurer"],
  "platform-moderator": ["moderator", "admin"],
};

export function decideAccess(f: AccessFacts): AccessDecision {
  const { access } = f.meta;
  if (access === "public") return { ok: true };
  if (access === "relay" || access === "overlay")
    return f.machineCredential ? { ok: true } : deny("UNAUTHORIZED", `A valid ${access} token is required`);

  const caller = f.caller;
  if (!caller) return deny("UNAUTHORIZED", "Sign in required");
  // Bots act only through tokens, so a bot session is always an anomaly.
  if (caller.kind === "session" && caller.user.accountType === "bot")
    return deny("FORBIDDEN", "Bot accounts authenticate with tokens");
  if (caller.kind === "token") {
    const t = tokenAllowed(f.meta, caller.scopes);
    if (!t.ok) return t;
  }
  if (f.write && caller.user.suspended) return deny("FORBIDDEN", "Your account is suspended");

  const roles = PLATFORM_LEVELS[access];
  if (roles) return roles.includes(caller.user.role) ? { ok: true } : deny("FORBIDDEN", "Insufficient platform role");

  if (access === "owner" || access === "moderator") {
    // Procedures addressed by a resource id (not a channel) resolve the channel in the handler.
    if (!f.channel) return { ok: true };
    if (!f.channel.exists) return deny("NOT_FOUND", "Channel not found");
    const isOwner = f.channel.ownerId === caller.user.id;
    const allowed: readonly ChannelRole[] = access === "owner" ? ["editor"] : ["editor", "moderator"];
    if (isOwner || f.channel.callerRoles.some((r) => allowed.includes(r))) return { ok: true };
    return deny(
      "FORBIDDEN",
      access === "owner" ? "Only the channel owner or an editor may do this" : "Moderators only",
    );
  }
  return { ok: true };
}

/** Channel-level authority for handlers that resolve the channel themselves. */
export function channelAuthority(
  caller: Caller | null,
  channel: { ownerId: string },
  roles: readonly ChannelRole[],
): "owner" | "editor" | "moderator" | null {
  if (!caller) return null;
  if (channel.ownerId === caller.user.id) return "owner";
  if (roles.includes("editor")) return "editor";
  if (roles.includes("moderator")) return "moderator";
  return null;
}
