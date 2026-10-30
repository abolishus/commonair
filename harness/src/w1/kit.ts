// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The W1 scenarios' run state (`timeline-sync`, `surge-guard`; docs/testing/w1-selectors.md) and
 * the contexts the three extended scenarios (`e4b-money`, `e2e-social`, `integrity-basic`) hand
 * their W1 extension steps. Owned by the orchestrator: units send a contract request instead of
 * editing it.
 */
import { INTERNAL_ROUTES, type OpsJobResult } from "@commonair/contracts/internal";
import { createDb, type Database } from "@commonair/db";
import type { ApiClient } from "../api/client.ts";
import type { ChatClient } from "../chat-client.ts";
import { RenditionSampler } from "../clock-skew-io.ts";
import { OpsHooks, OpsHooksOff, type OpsJob } from "../e6/ops.ts";
import { grantRole } from "../money-db.ts";
import type { Provider, Via } from "../money.ts";
import type { Platform } from "../platform.ts";
import { internalSecret } from "../safety-io.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SocialActor } from "../social.ts";
import type { StripeWebhook } from "../stripe.ts";
import type { Streamer } from "../streamer.ts";
import type { SignedInUser } from "../users.ts";
import type { Viewer } from "../viewer.ts";
import { waitFor } from "../wait.ts";

const ROLE_CLI_TIMEOUT_MS = 30_000;
const LIVE_TIMEOUT_MS = 30_000;
/** How long the ladder may take to start once the viewers cross the threshold (clock-skew's bound). */
const LADDER_TIMEOUT_MS = 5 * 60_000;
/** Above `TRANSCODE_VIEWER_THRESHOLD` (default 50), as clock-skew forces it. */
export const DEFAULT_LADDER_VIEWERS = 60;

export interface W1Streamer {
  user: SignedInUser;
  channel: string;
  channelId: string;
  /** The RTMP test pattern; stopped when the scenario ends. */
  encoder: Streamer;
}

export interface W1Hooks {
  /** Run one `OPS_TICK_JOBS` job now through `POST /internal/ops/tick` and return its counts. */
  ops(job: OpsJob): Promise<OpsJobResult>;
  /** The underlying hook client (`tickRan`, `tickUntil`, the tick log). */
  readonly client: OpsHooks;
}

export interface W1Run {
  ctx: ScenarioContext;
  /** The admin's API client (`admin.api.client`). */
  api: ApiClient;
  admin: SignedInUser;
  /** Live on the RTMP test pattern (720p, so the ladder has rungs to make once forced). */
  streamer: W1Streamer;
  /** Signed-in viewers (API users; open a browser or a chat socket per step). */
  viewers: SignedInUser[];
  /** Owner connection (outbox, audit and backdating checks); closed when the scenario ends. */
  db: Database;
  databaseUrl: string;
  via: Via;
  hooks: W1Hooks;
  /**
   * Hold the channel above the transcode threshold with HTTP viewers until a rung other than
   * `source` is advertised (the ladder runs). Idempotent; the viewers stop when the scenario ends.
   */
  forceLadder(viewers?: number): Promise<void>;
}

/** The ops hook with a 404 that names the override to start (W1 jobs run only through it). */
export function w1Hooks(hooks: OpsHooks): W1Hooks {
  return {
    client: hooks,
    async ops(job) {
      try {
        return await hooks.tick(job);
      } catch (err) {
        if (err instanceof OpsHooksOff)
          throw new Error(
            `${INTERNAL_ROUTES.opsTick} answered 404 for ${job}: start the harness stack with harness/compose.e6.yaml (OPS_TEST_HOOKS=true for api and worker)`,
          );
        throw err;
      }
    },
  };
}

/** The ops hook for an extension step, from the scenario's environment (throws without the secret). */
export function w1HooksFor(ctx: ScenarioContext): W1Hooks {
  const secret = internalSecret(ctx.env);
  if (secret === undefined) throw new Error("INTERNAL_API_SECRET is not set (the ops test hook needs it)");
  const ops = new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  ctx.defer(() => ctx.data("w1.opsTicks", ops.ticks));
  return w1Hooks(ops);
}

/** Set up a W1 run: admin, a live streamer, signed-in viewers, the database and the ops hook. */
export async function newW1Run(
  ctx: ScenarioContext,
  opts: { via: Via; prefix: string; viewers?: number },
): Promise<W1Run> {
  const databaseUrl = ctx.env.DATABASE_URL;
  if (databaseUrl === undefined)
    throw new Error("DATABASE_URL is not set (outbox, audit and retention checks; run from the repo root)");
  const secret = internalSecret(ctx.env);
  if (secret === undefined) throw new Error("INTERNAL_API_SECRET is not set (the ops test hook needs it)");

  const p = ctx.platform;
  const signedUp = await ctx.step("sign up admin", () => p.signUp({ prefix: `${opts.prefix}adm` }));
  await ctx.step("grant admin (operator CLI)", () =>
    grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const admin = await ctx.step("admin: sign in again to pick up the role", () => p.users.signIn(signedUp));

  const user = await ctx.step("sign up streamer", () => p.signUp({ prefix: `${opts.prefix}str` }));
  const channel = user.me.channelSlug ?? user.username;
  const info = await user.api.client.channels.get({ channel });
  await user.api.client.channels.update({ channel, vodEnabled: true });
  const encoder = await p.streamerFor(user, { protocol: "rtmp", width: 1280, height: 720, bitrateKbps: 2500 });
  ctx.defer(() => encoder.stop());
  await ctx.step("streamer: publish the RTMP test pattern", () => encoder.start());
  await ctx.step("streamer: channel goes live", () => p.waitForLive(channel, true, LIVE_TIMEOUT_MS));

  const count = opts.viewers ?? 3;
  const viewers = await ctx.step(`sign up ${count} viewers`, () =>
    Promise.all(Array.from({ length: count }, () => p.signUp({ prefix: `${opts.prefix}v` }))),
  );

  const handle = createDb({ url: databaseUrl, max: 2, applicationName: "commonair-harness-w1" });
  ctx.defer(() => handle.close());
  const ops = new OpsHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal);
  ctx.defer(() => ctx.data("opsTicks", ops.ticks));

  let ladder: Promise<void> | null = null;
  const forceLadder = (n = DEFAULT_LADDER_VIEWERS): Promise<void> => {
    ladder ??= startLadder(ctx, p, channel, n);
    return ladder;
  };

  return {
    ctx,
    api: admin.api.client,
    admin,
    streamer: { user, channel, channelId: info.id, encoder },
    viewers,
    db: handle.db,
    databaseUrl,
    via: opts.via,
    hooks: w1Hooks(ops),
    forceLadder,
  };
}

async function startLadder(ctx: ScenarioContext, p: Platform, channel: string, n: number): Promise<void> {
  const sampler = new RenditionSampler({ api: p.api().client, channel, log: p.log });
  ctx.defer(() => sampler.stop());
  await sampler.start();
  const since = Date.now();
  const viewers: Viewer[] = await ctx.step(`${n} HTTP viewers cross the transcode threshold`, () =>
    p.openViewers(channel, { http: n }),
  );
  for (const v of viewers) ctx.defer(() => v.stop());
  await ctx.step("the ladder starts", () =>
    waitFor(`${channel} rungs sampled`, async () => sampler.renditionsSince(since).some((r) => r !== "source"), {
      timeoutMs: LADDER_TIMEOUT_MS,
      intervalMs: 2_000,
      signal: ctx.signal,
    }).catch((err: unknown) => {
      throw new Error(`${(err as Error).message}; sampler ${JSON.stringify(sampler.status())}`);
    }),
  );
}

// ------------------------------------------------------------ extension contexts

/** One payment `e4b-money` made: its id and its provider reference (manual `CA-…`, Stripe PaymentIntent). */
export interface ExtensionPayment {
  paymentId: string;
  reference: string;
}

/** What `e4b-money` hands its W1 extension steps (`breakdown`, `reconciliation`, `fraud-hold`). */
export interface MoneyExtension {
  ctx: ScenarioContext;
  via: Via;
  provider: Provider;
  databaseUrl: string;
  channel: string;
  currency: string;
  streamer: SignedInUser;
  /** Has the `treasurer` role. */
  treasurer: SignedInUser;
  /** The payers: A subscribed, gifted and tipped (anonymously); B and C received the gifts. */
  payers: { a: SignedInUser; b: SignedInUser; c: SignedInUser };
  /** The confirmed payments. */
  payments: { sub: ExtensionPayment; gift: ExtensionPayment; tip: ExtensionPayment };
  /** The tip was refunded in full. */
  refunded: ExtensionPayment;
  /** The subscription payment was charged back (Stripe: a dispute opened and closed lost). */
  chargedBack: ExtensionPayment;
  /** Stripe's signed-event sender when `provider` is `stripe`, else null. */
  stripe: StripeWebhook | null;
  /** The ops hook (`money-reconcile`, `money-fraud-scan`). */
  hooks: W1Hooks;
}

/** What `e2e-social` hands its W1 extension steps (`flood`, `block`). The channel is still live. */
export interface SocialExtension {
  ctx: ScenarioContext;
  via: Via;
  channel: string;
  streamer: SignedInUser;
  fan: SignedInUser;
  troll: SignedInUser;
  /** The three people's chat (web pages or API sockets, per `via`). */
  actors: { streamer: SocialActor; fan: SocialActor; troll: SocialActor };
  /** A fresh chat socket (signed in as `user`, or anonymous) for bots and observers. */
  chat(user?: SignedInUser): Promise<ChatClient>;
}

/** What `integrity-basic` hands its W1 extension step (`data-mode`). The channel is still live. */
export interface IntegrityExtension {
  ctx: ScenarioContext;
  channel: string;
  streamer: SignedInUser;
  /** The browser launcher and viewer helpers (`openViewers`, `fleet`, `api`, `residential`). */
  platform: Platform;
  /** For session verdicts; undefined when the harness cannot reach the database. */
  databaseUrl: string | undefined;
  /** The honest viewers already watching (their count is the scenario's expected audience). */
  honest: readonly Viewer[];
}
