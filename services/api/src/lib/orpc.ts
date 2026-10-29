// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shared implementer. Every route file builds on `os`, which validates input
 * first, then runs one middleware driven by the procedure's `ProcedureMeta`:
 * resolve the caller, enforce access and token scopes, apply the rate limit.
 */
import { implement } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { contract, type ProcedureMeta } from "@commonair/contracts";
import { Slug } from "@commonair/contracts";
import { schema } from "@commonair/db";
import { sha256Hex } from "@commonair/tokens";
import type { Auth } from "../auth/index.ts";
import type { Deps } from "../deps.ts";
import { decideAccess, type AppCaller, type Caller, type ChannelRole } from "./access.ts";
import { bearerToken, resolveCaller } from "./caller.ts";
import { apiError, rateLimited } from "./errors.ts";
import { rateLimitKey } from "./ratelimit.ts";
import { resolveOverlayToken } from "../overlay/tokens.ts";

export interface RequestInfo {
  headers: Headers;
  url: URL;
  method: string;
  /** Client address after trusted-proxy resolution. Never stored or logged raw. */
  ip: string;
  /** hmac(AUTH_SECRET, ip): what we may store (integrity evidence). */
  ipHash: string;
  /** hmac of the rate-limit subject: the IPv4 address or the IPv6 /64. */
  rateLimitHash: string;
  userAgent: string | null;
}

export interface BaseContext {
  deps: Deps;
  auth: Auth;
  req: RequestInfo;
}

type ChannelRow = typeof schema.channels.$inferSelect;
type RelayRow = typeof schema.relayNodes.$inferSelect;

export interface ResolvedContext {
  caller: Caller | null;
  /** An app-only token (client credentials); `caller` is then null (ADR 0027 §1). */
  app: AppCaller | null;
  /** The channel named by `input.channel`, for owner/moderator procedures. */
  channel: ChannelRow | null;
  channelRoles: ChannelRole[];
  relay: RelayRow | null;
  overlayChannelId: string | null;
}

async function resolveRelay(deps: Deps, token: string | null): Promise<RelayRow | null> {
  if (!token) return null;
  const [row] = await deps.db
    .select()
    .from(schema.relayNodes)
    .where(eq(schema.relayNodes.tokenHash, await sha256Hex(token)))
    .limit(1);
  return row ?? null;
}

/** The overlay token of a request: OBS browser sources cannot set headers, so `?token=` too. */
export function overlayTokenOf(req: Pick<RequestInfo, "headers" | "url">): string | null {
  return bearerToken(req.headers) ?? req.url.searchParams.get("token");
}

/** The overlay token's channel, only while the token is unrevoked and unexpired (ADR 0021). */
async function resolveOverlay(deps: Deps, req: RequestInfo): Promise<string | null> {
  const token = overlayTokenOf(req);
  if (!token) return null;
  return (await resolveOverlayToken(deps.db, token, deps.now()))?.channelId ?? null;
}

async function resolveChannel(deps: Deps, slug: string, caller: Caller | null) {
  const [channel] = await deps.db.select().from(schema.channels).where(eq(schema.channels.slug, slug)).limit(1);
  if (!channel || !caller) return { channel: channel ?? null, roles: [] as ChannelRole[] };
  const roles = await deps.db
    .select({ role: schema.channelRoles.role })
    .from(schema.channelRoles)
    .where(and(eq(schema.channelRoles.channelId, channel.id), eq(schema.channelRoles.userId, caller.user.id)));
  return { channel, roles: roles.map((r) => r.role) };
}

const channelSlugOf = (input: unknown): string | null => {
  if (!input || typeof input !== "object") return null;
  const parsed = Slug.safeParse((input as { channel?: unknown }).channel);
  return parsed.success ? parsed.data : null;
};

// Validate input before the middleware so access decisions see parsed values (e.g. the channel slug).
export const base = implement(contract, {
  initialInputValidationIndex: Number.NEGATIVE_INFINITY,
}).$context<BaseContext>();

export const os = base.use(async ({ context, next, procedure }, input) => {
  const { deps, auth, req } = context;
  const meta = procedure["~orpc"].meta as ProcedureMeta;
  const write = (procedure["~orpc"].route.method ?? "POST") !== "GET";

  let caller: Caller | null = null;
  let app: AppCaller | null = null;
  let relay: RelayRow | null = null;
  let overlayChannelId: string | null = null;
  let channel: ChannelRow | null = null;
  let channelRoles: ChannelRole[] = [];

  if (meta.access === "relay") relay = await resolveRelay(deps, bearerToken(req.headers));
  else if (meta.access === "overlay") overlayChannelId = await resolveOverlay(deps, req);
  else {
    const resolved = await resolveCaller(deps, auth, req.headers);
    // A bad bearer on a public endpoint is ignored (the endpoint does not need identity).
    if (resolved.invalidBearer && meta.access !== "public")
      throw apiError("UNAUTHORIZED", "Invalid or expired access token");
    caller = resolved.caller;
    app = resolved.app;
  }

  const slug = meta.access === "owner" || meta.access === "moderator" ? channelSlugOf(input) : null;
  if (slug) {
    const r = await resolveChannel(deps, slug, caller);
    channel = r.channel;
    channelRoles = r.roles;
  }

  const decision = decideAccess({
    meta,
    caller,
    app,
    write,
    machineCredential: relay !== null || overlayChannelId !== null,
    channel: slug
      ? { exists: channel !== null, ownerId: channel?.ownerId ?? null, callerRoles: channelRoles }
      : undefined,
  });
  if (!decision.ok) throw apiError(decision.code, decision.message);

  const bucket = meta.rateLimit ?? "default";
  // ADR 0027 §4: an app's user token is its own subject, so one app cannot spend a user's
  // allowance for every other app and the user's own session.
  const appId = caller?.kind === "token" ? caller.appId : (app?.appId ?? null);
  const subject = caller
    ? caller.kind === "token" && caller.appId
      ? `g:${caller.appId}:${caller.user.id}`
      : `u:${caller.user.id}`
    : app
      ? `a:${app.appId}`
      : relay
        ? `r:${relay.id}`
        : `ip:${req.rateLimitHash}`;
  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    rateLimitKey(bucket, subject),
    deps.rateLimits[bucket],
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (!rl.allowed) throw rateLimited(rl.retryAfterSeconds);
  if (appId) {
    const all = await deps.rateLimitStore.hit(
      rateLimitKey("app", `app:${appId}`),
      deps.rateLimits.app,
      nowMs,
      `${nowMs}:${crypto.randomUUID()}`,
    );
    if (!all.allowed) throw rateLimited(all.retryAfterSeconds);
  }

  return next({
    context: { caller, app, channel, channelRoles, relay, overlayChannelId } satisfies ResolvedContext,
  });
});

export type Ctx = BaseContext & ResolvedContext;

/** Narrowing helpers for handlers whose middleware already guaranteed these. */
export function requireCaller(ctx: Pick<ResolvedContext, "caller">): Caller {
  if (!ctx.caller) throw apiError("UNAUTHORIZED", "Sign in required");
  return ctx.caller;
}
/** `developer.events.*`: a user (session or user token) or an app acting with an app token. */
export function requireActor(
  ctx: Pick<ResolvedContext, "caller" | "app">,
): { kind: "user"; caller: Caller } | { kind: "app"; app: AppCaller } {
  if (ctx.caller) return { kind: "user", caller: ctx.caller };
  if (ctx.app) return { kind: "app", app: ctx.app };
  throw apiError("UNAUTHORIZED", "Sign in required");
}
export function requireChannel(ctx: Pick<ResolvedContext, "channel">): ChannelRow {
  if (!ctx.channel) throw apiError("NOT_FOUND", "Channel not found");
  return ctx.channel;
}
