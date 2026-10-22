// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What every E6 scenario sets up the same way: `--set via=web|api`, `DATABASE_URL`, the ops test
 * hook, signed-in web sessions (screenshotted on failure with secrets blanked), a treasurer for
 * manual tips and subscriptions, and the object-storage buckets read for "is it gone" checks.
 */
import { join } from "node:path";
import type { Contract } from "@commonair/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import type { ApiClient } from "../api/client.ts";
import { DEFAULT_USER_AGENT } from "../api/client.ts";
import { ApiSupporter, ApiTreasurer } from "../money-actors.ts";
import { grantRole } from "../money-db.ts";
import { parseVia, type Via } from "../money.ts";
import { playerBundles } from "../player-server.ts";
import { DEFAULT_REPORT_DIR } from "../report.ts";
import { type MediaBucketConfig, internalSecret, mediaBucketConfig } from "../safety-io.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";
import { signInViaUi } from "../web/flows.ts";
import { ROUTES, TEST_IDS as T } from "../web/selectors.ts";
import { WebSession, byTestId } from "../web/session.ts";
import { OpsHooks } from "./ops.ts";
import { E6_TEST_IDS as E, etid } from "./selectors.ts";

export const UI_TIMEOUT_MS = 20_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;

/** Inputs whose value is a secret: blanked before any failure screenshot. */
export const REDACT_SELECTORS = [
  etid(E.simulcastKey),
  etid(E.overlayUrlValue),
  etid(E.overlayUrl),
  etid(E.exportDownload),
  etid(T.streamKey),
] as const;

export interface Kit {
  ctx: ScenarioContext;
  via: Via;
  databaseUrl: string;
  ops: OpsHooks;
  ui: { timeoutMs: number; signal: AbortSignal };
  /** A web session; signed in through the UI when `user` is given. */
  webSession(label: string, user?: SignedInUser): Promise<WebSession>;
  anon(): ApiClient;
  /** Mark the scenario finished without failure (no failure screenshots). */
  done(): void;
}

/**
 * Parse `via`, require `DATABASE_URL` and the internal secret (hard assertions), and register the
 * cleanups: close every web session, screenshot them first unless `done()` was called.
 */
export async function setupKit(ctx: ScenarioContext): Promise<Kit> {
  const via = parseVia(ctx.param("via", "web"));
  ctx.data("via", via);
  const databaseUrl = ctx.env.DATABASE_URL;
  ctx.assert(
    "DATABASE_URL is set (role CLI and DB checks; run from the repo root so Bun loads .env)",
    databaseUrl !== undefined,
  );
  const secret = internalSecret(ctx.env);
  ctx.assert(
    "INTERNAL_API_SECRET is set (ops test hook; HARNESS_INTERNAL_API_SECRET or the repo .env)",
    secret !== undefined,
  );
  // The assertions above throw when unmet; these narrow the types.
  if (databaseUrl === undefined || secret === undefined) throw new Error("unreachable");
  const ops = new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  const sessions: WebSession[] = [];
  const state = { failed: true };
  ctx.defer(async () => {
    ctx.data("opsTicks", ops.ticks);
    if (state.failed) {
      const dir = join(ctx.env.HARNESS_REPORT_DIR ?? DEFAULT_REPORT_DIR, `${ctx.runId}-${ctx.name}`);
      const files = (await Promise.all(sessions.map((s) => s.screenshotAll(dir, REDACT_SELECTORS)))).flat();
      if (files.length > 0) ctx.data("screenshots", files);
    }
    await Promise.allSettled(sessions.map((s) => s.close()));
  });
  let probe: string | null = null;
  const kit: Kit = {
    ctx,
    via,
    databaseUrl,
    ops,
    ui: { timeoutMs: UI_TIMEOUT_MS, signal: ctx.signal },
    done() {
      state.failed = false;
    },
    anon: () => ctx.platform.api().client,
    async webSession(label, user) {
      probe ??= (await playerBundles()).probe;
      const session = await WebSession.open({
        fleet: ctx.platform.fleet,
        engine: "chromium",
        webUrl: ctx.env.HARNESS_WEB_URL,
        probeScript: probe,
        label,
        log: ctx.log,
      });
      sessions.push(session);
      if (user) {
        await ctx.step(`${label}: sign in through the web UI`, async () => {
          const page = await session.goto(ROUTES.signin);
          await signInViaUi(page, user, UI_TIMEOUT_MS, ctx.signal);
          await byTestId(page, T.navUser, { username: user.username }).waitFor({ timeout: UI_TIMEOUT_MS });
        });
      }
      return session;
    },
  };
  return kit;
}

// ---------------------------------------------------------------- roles and money

/** Sign up an account, grant it a platform role with the operator CLI and sign in again. */
export async function staffAccount(kit: Kit, prefix: string, role: string): Promise<SignedInUser> {
  const { ctx } = kit;
  const account = await ctx.step(`sign up ${role} (API)`, () => ctx.platform.signUp({ prefix }));
  await ctx.step(`grant the ${role} role (operator CLI)`, () =>
    grantRole(kit.databaseUrl, account.username, role, ROLE_CLI_TIMEOUT_MS),
  );
  return ctx.step(`${role}: sign in again to pick up the role`, () => ctx.platform.users.signIn(account));
}

export interface ConfirmedPayment {
  paymentId: string;
  /** When the treasurer's confirm returned (ms epoch). */
  confirmedAt: number;
}

/** Confirm a manual payment by its reference, retrying while the treasurer's list catches up. */
export async function confirmByReference(kit: Kit, treasurer: ApiTreasurer, reference: string): Promise<number> {
  await waitFor(`treasurer finds ${reference}`, () => treasurer.find(reference), {
    timeoutMs: 30_000,
    intervalMs: 1_000,
    signal: kit.ctx.signal,
  });
  await treasurer.confirm(reference);
  return Date.now();
}

/** A tip through the manual adapter, confirmed by the treasurer. */
export async function confirmedTip(
  kit: Kit,
  treasurer: ApiTreasurer,
  from: SignedInUser,
  channel: string,
  tip: { cents: number; message: string; anonymous?: boolean },
): Promise<ConfirmedPayment> {
  const supporter = new ApiSupporter(from.username, from.api.client);
  const c = await supporter.checkout(channel, {
    kind: "tip",
    cents: tip.cents,
    message: tip.message,
    anonymous: tip.anonymous ?? false,
  });
  if (!c.reference) throw new Error("the tip checkout has no manual reference (is PAYMENTS_PROVIDER=manual?)");
  return { paymentId: c.paymentId, confirmedAt: await confirmByReference(kit, treasurer, c.reference) };
}

/** A tier subscription through the manual adapter, confirmed by the treasurer. */
export async function confirmedSubscription(
  kit: Kit,
  treasurer: ApiTreasurer,
  from: SignedInUser,
  channel: string,
  tier: 1 | 2 | 3,
): Promise<ConfirmedPayment> {
  const supporter = new ApiSupporter(from.username, from.api.client);
  const c = await supporter.checkout(channel, { kind: "sub", tier });
  if (!c.reference) throw new Error("the subscription checkout has no manual reference");
  return { paymentId: c.paymentId, confirmedAt: await confirmByReference(kit, treasurer, c.reference) };
}

/** Give a channel three tiers so it can be subscribed to. */
export async function setTiers(owner: SignedInUser, channel: string): Promise<void> {
  const support = await owner.api.client.money.support({ channel });
  const currency = support.currency;
  await owner.api.client.money.setTiers({
    channel,
    tiers: [
      { tier: 1, name: "Tier 1", benefits: "harness tier 1", price: { cents: 499, currency } },
      { tier: 2, name: "Tier 2", benefits: "harness tier 2", price: { cents: 999, currency } },
      { tier: 3, name: "Tier 3", benefits: "harness tier 3", price: { cents: 2499, currency } },
    ],
  });
}

// ---------------------------------------------------------------- object storage

/** The exports bucket: the media bucket's credentials with `S3_BUCKET_EXPORTS` (repo `.env`). */
export function exportsBucketConfig(
  kit: Pick<Kit, "ctx">,
  env: Record<string, string | undefined> = process.env,
): MediaBucketConfig | null {
  const media = mediaBucketConfig(kit.ctx.env);
  if (!media) return null;
  return { ...media, bucket: env.S3_BUCKET_EXPORTS?.trim() || "commonair-exports" };
}

// ---------------------------------------------------------------- URLs and token clients

/** `url`'s path and query on `base`'s origin (public URLs the harness host reaches elsewhere). */
export function rebaseHttp(url: string, base: string): string {
  const u = new URL(url);
  return new URL(`${u.pathname}${u.search}${u.hash}`, new URL(base).origin).toString();
}

export type TokenMode = "bearer" | "query";

/**
 * An API client that presents an overlay token the way OBS would (`?token=` on every request) or
 * as a bearer, and nothing else (no cookies). Used to prove the token grants nothing but its
 * overlay.
 */
export function tokenClient(apiUrl: string, token: string, mode: TokenMode, origin?: string): ApiClient {
  const base = apiUrl.replace(/\/+$/, "");
  const link = new RPCLink({
    url: `${base}/rpc`,
    fetch: async (request: Request) => {
      const u = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("user-agent", DEFAULT_USER_AGENT);
      if (origin) headers.set("origin", origin);
      if (mode === "query") u.searchParams.set("token", token);
      else headers.set("authorization", `Bearer ${token}`);
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
      return fetch(u, { method: request.method, headers, body, signal: AbortSignal.timeout(15_000) });
    },
  });
  return createORPCClient<ContractRouterClient<Contract>>(link);
}

/** The token value from an overlay URL (`?token=`); throws when absent. */
export function tokenOf(overlayUrl: string): string {
  const t = new URL(overlayUrl).searchParams.get("token");
  if (!t) throw new Error("overlay URL has no token");
  return t;
}

// ---------------------------------------------------------------- chat

/** Send one chat message as `user` in `channel` over the chat socket; returns its id. */
export async function chatOnce(kit: Kit, user: SignedInUser, channel: string, body: string): Promise<string> {
  const client = await kit.ctx.platform.chat(user);
  try {
    await client.join(channel);
    const ack = await client.send(channel, body);
    if (!ack.id || ack.held) throw new Error(`chat message not accepted (held=${ack.held})`);
    return ack.id;
  } finally {
    client.close();
  }
}
