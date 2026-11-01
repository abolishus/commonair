// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The raw ActivityPub and discovery routes (ADR 0030): WebFinger, NodeInfo, the actor document,
 * its outbox and followers collections, and the per-channel and shared inboxes. `http.ts` matches
 * the paths (`../raw-routes.ts`), checks the method, strips cookies and answers 404 itself while
 * `FEDERATION_ENABLED` is false, so this module is reached only with the flag on.
 *
 * Nothing here makes an outbound request: key fetches, verification and deliveries are the
 * worker's (decision 5).
 */
import { KEYS } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";
import type { BaseContext } from "../lib/orpc.ts";
import type { FederationRoute } from "../raw-routes.ts";
import { actorInputOf, buildActorDocument, wantsActivityJson } from "./actor.ts";
import { followersCollection, outboxCollection } from "./collections.ts";
import { ACTIVITY_JSON_UTF8, actorUrl, channelPageUrl, federatedChannel } from "./ids.ts";
import { checkInbox, inboxSeams, recordInboxOutcome } from "./inbox.ts";
import { NODEINFO_PROFILE, nodeinfo, nodeinfoLinks } from "./nodeinfo.ts";
import { JRD_JSON, webfinger } from "./webfinger.ts";

const NO_STORE = { "cache-control": "no-store" };
/** Public documents change rarely (a rotated key arrives by `Update` anyway). */
const SHORT_CACHE = { "cache-control": "public, max-age=60" };

const error = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ code, message }, { status, headers: { ...NO_STORE, ...headers } });

const document = (body: unknown, contentType: string, headers: Record<string, string> = SHORT_CACHE) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": contentType, vary: "accept", ...headers },
  });

const NOT_FOUND = () => error(404, "NOT_FOUND", "Not found");
const GONE = () => error(410, "GONE", "This actor was deleted");

/**
 * Every federation GET counts against the caller's address (by its hash). Remote servers fetch on
 * behalf of all their users from a few addresses, so the allowance is five times the default bucket.
 */
async function limitGet(deps: Deps, rateLimitHash: string): Promise<Response | null> {
  const nowMs = deps.now().getTime();
  const rl = await deps.rateLimitStore.hit(
    KEYS.rateLimit("federation", `get:${rateLimitHash}`),
    { max: deps.rateLimits.default.max * 5, windowMs: deps.rateLimits.default.windowMs },
    nowMs,
    `${nowMs}:${crypto.randomUUID()}`,
  );
  if (rl.allowed) return null;
  return error(429, "RATE_LIMITED", "Too many requests", { "retry-after": String(rl.retryAfterSeconds) });
}

async function inbox(deps: Deps, req: Request, channelId: string | null): Promise<Response> {
  if (channelId) {
    const found = await federatedChannel(deps, channelId);
    if (found.state === "missing") return NOT_FOUND();
    if (found.state === "gone") return GONE();
  }
  const url = new URL(req.url);
  const outcome = await checkInbox(req, `${url.pathname}${url.search}`, inboxSeams(deps, channelId));
  recordInboxOutcome(outcome);
  if (outcome.kind === "refused")
    return error(
      outcome.status,
      outcome.reason.toUpperCase(),
      "Refused",
      outcome.retryAfterSeconds !== undefined ? { "retry-after": String(outcome.retryAfterSeconds) } : {},
    );
  return new Response(null, { status: 202, headers: NO_STORE });
}

export async function federationHttp(ctx: BaseContext, req: Request, route: FederationRoute): Promise<Response> {
  const { deps } = ctx;
  if (route.kind === "inbox") return inbox(deps, req, route.channelId);
  if (route.kind === "sharedInbox") return inbox(deps, req, null);

  const limited = await limitGet(deps, ctx.req.rateLimitHash);
  if (limited) return limited;

  switch (route.kind) {
    case "webfinger": {
      const jrd = await webfinger(deps, ctx.req.url.searchParams.get("resource"));
      if (!jrd) return NOT_FOUND();
      // WebFinger is read cross-origin by web clients (RFC 7033 §5).
      return document(jrd, JRD_JSON, { ...SHORT_CACHE, "access-control-allow-origin": "*" });
    }
    case "nodeinfoLinks":
      return document(nodeinfoLinks(deps.site), "application/json", {
        ...SHORT_CACHE,
        "access-control-allow-origin": "*",
      });
    case "nodeinfo":
      return document(nodeinfo(deps.site, deps.version), NODEINFO_PROFILE, {
        ...SHORT_CACHE,
        "access-control-allow-origin": "*",
      });
    case "actor":
    case "outbox":
    case "followers": {
      const found = await federatedChannel(deps, route.channelId);
      if (found.state === "missing") return NOT_FOUND();
      if (found.state === "gone") return GONE();
      if (route.kind === "actor") {
        if (!wantsActivityJson(req.headers.get("accept")))
          return new Response(null, {
            status: 303,
            headers: { location: channelPageUrl(deps.site, found.channel.slug), vary: "accept", ...NO_STORE },
          });
        return document(buildActorDocument(deps.site, actorInputOf(deps, found)), ACTIVITY_JSON_UTF8);
      }
      const actor = actorUrl(deps.site, found.channel.id);
      if (route.kind === "followers")
        return document(await followersCollection(deps, actor, found.channel.id), ACTIVITY_JSON_UTF8);
      return document(
        await outboxCollection(deps, actor, found.channel.id, ctx.req.url.searchParams),
        ACTIVITY_JSON_UTF8,
      );
    }
  }
}
