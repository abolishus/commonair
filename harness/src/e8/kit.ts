// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The E8 scenarios' run state (`interact`, `channel-bot`; docs/testing/e8-selectors.md): an
 * admin, a streamer, a second streamer to raid, three signed-in viewers, the database (outbox and
 * ledger checks) and the interactivity test hook. Owned by the orchestrator: units send a
 * contract request instead of editing it.
 */
import {
  INTERNAL_ROUTES,
  INTERNAL_SECRET_HEADER,
  type InteractJobName,
  InteractJobResult,
} from "@commonair/contracts/internal";
import { createDb, type Database } from "@commonair/db";
import type { ApiClient } from "../api/client.ts";
import { grantRole } from "../money-db.ts";
import type { Via } from "../money.ts";
import { internalSecret } from "../safety-io.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { waitFor } from "../wait.ts";

/** How long the API waits for a job (30 s) plus slack for the round trip. */
const TICK_TIMEOUT_MS = 45_000;
const ROLE_CLI_TIMEOUT_MS = 30_000;
export const API_SETTLE_MS = 30_000;

export interface E8Streamer {
  user: SignedInUser;
  channel: string;
  channelId: string;
}

export interface InteractHooks {
  /** Run one `INTERACT_JOBS` job now through `POST /internal/interact/tick` and return its counts. */
  tick(job: InteractJobName): Promise<InteractJobResult>;
}

export interface E8Run {
  ctx: ScenarioContext;
  /** The admin's API client (`admin.api.client`). */
  api: ApiClient;
  admin: SignedInUser;
  streamer: E8Streamer;
  /** A second streamer: the raid target. */
  target: E8Streamer;
  viewers: SignedInUser[];
  via: Via;
  /** Owner connection (outbox, ledger and accrual checks); closed when the scenario ends. */
  db: Database;
  hooks: InteractHooks;
}

export class InteractHooksOff extends Error {
  constructor() {
    super(
      `${INTERNAL_ROUTES.interactTick} answered 404: the interactivity test hook is off (start the harness stack with harness/compose.e8.yaml, INTERACT_TEST_HOOKS=true for api and worker)`,
    );
    this.name = "InteractHooksOff";
  }
}

/** The hook client: one POST per tick, behind the internal secret. */
export function interactHooks(apiUrl: string, secret: string, signal?: AbortSignal): InteractHooks {
  return {
    async tick(job) {
      const timeout = AbortSignal.timeout(TICK_TIMEOUT_MS);
      const res = await fetch(new URL(INTERNAL_ROUTES.interactTick, apiUrl), {
        method: "POST",
        headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: secret },
        body: JSON.stringify({ job }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (res.status === 404) throw new InteractHooksOff();
      if (!res.ok) throw new Error(`${INTERNAL_ROUTES.interactTick} (${job}) answered HTTP ${res.status}`);
      return InteractJobResult.parse(await res.json());
    },
  };
}

/** A signed-up streamer and their channel (the same shape as `safety-run.ts` `newStreamer`). */
export async function newE8Streamer(ctx: ScenarioContext, prefix: string): Promise<E8Streamer> {
  const user = await ctx.platform.signUp({ prefix });
  const channel = user.me.channelSlug ?? user.username;
  const c = await user.api.client.channels.get({ channel });
  return { user, channel, channelId: c.id };
}

/** Wait until `channel` is live (the same rule as `safety-run.ts` `waitLive`). */
export async function waitLive(ctx: ScenarioContext, channel: string): Promise<number> {
  await waitFor(
    `${channel} live`,
    async () => (await ctx.platform.api().client.channels.get({ channel })).live !== null,
    {
      timeoutMs: API_SETTLE_MS,
      intervalMs: 250,
      signal: ctx.signal,
    },
  );
  return Date.now();
}

/** Set up an E8 run: users, roles, the database handle and the hook client. */
export async function newE8Run(ctx: ScenarioContext, opts: { via: Via; prefix: string }): Promise<E8Run> {
  const databaseUrl = ctx.env.DATABASE_URL;
  if (databaseUrl === undefined)
    throw new Error("DATABASE_URL is not set (outbox and ledger checks; run from the repo root so Bun loads .env)");
  const secret = internalSecret(ctx.env);
  if (secret === undefined) throw new Error("INTERNAL_API_SECRET is not set (the interactivity test hook needs it)");

  const p = ctx.platform;
  const signedUp = await ctx.step("sign up admin", () => p.signUp({ prefix: `${opts.prefix}adm` }));
  await ctx.step("grant admin (operator CLI)", () =>
    grantRole(databaseUrl, signedUp.username, "admin", ROLE_CLI_TIMEOUT_MS),
  );
  const admin = await ctx.step("admin: sign in again to pick up the role", () => p.users.signIn(signedUp));
  const streamer = await ctx.step("sign up streamer", () => newE8Streamer(ctx, `${opts.prefix}str`));
  const target = await ctx.step("sign up raid target", () => newE8Streamer(ctx, `${opts.prefix}tgt`));
  const viewers = await ctx.step("sign up three viewers", () =>
    Promise.all([0, 1, 2].map(() => p.signUp({ prefix: `${opts.prefix}v` }))),
  );

  const handle = createDb({ url: databaseUrl, max: 2, applicationName: "commonair-harness-e8" });
  ctx.defer(() => handle.close());

  return {
    ctx,
    api: admin.api.client,
    admin,
    streamer,
    target,
    viewers,
    via: opts.via,
    db: handle.db,
    hooks: interactHooks(ctx.env.HARNESS_API_URL, secret, ctx.signal),
  };
}
