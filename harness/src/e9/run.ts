// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `developer-platform` scenario's run state and step contract (docs/testing/e9-selectors.md,
 * ADR 0027): the actors, what one step leaves for the next (`E9State`), the step shape every unit's
 * module exports, the selection rule, and `authorizeOverApi`, so any step that needs a live grant
 * gets one without importing another unit's step module. Owned by the orchestrator: units send a
 * contract request instead of editing it.
 */
import type { Logger } from "@commonair/observability";
import { OAUTH_PATHS, TokenResponse, pkceChallenge } from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import type { BrowserFleet } from "../browser-viewer.ts";
import type { HarnessEnv } from "../env.ts";
import type { Via } from "../money.ts";
import type { Platform } from "../platform.ts";
import type { ScenarioContext } from "../scenario.ts";
import type { SignedInUser } from "../users.ts";
import { parseSteps } from "../e8/steps.ts";
import type { E8Streamer } from "../e8/kit.ts";
import type { Receiver } from "./receiver.ts";

/** A registered app as the steps use it (step 1 creates both). */
export interface E9App {
  id: string;
  clientId: string;
  /** Null for a public client. Never logged or reported. */
  clientSecret: string | null;
  redirectUri: string;
}

/** A user's live grant: the newest tokens of one authorization. Never logged or reported. */
export interface Grant {
  userId: string;
  accessToken: string;
  refreshToken: string;
  scopes: Scope[];
}

/** What steps leave for later steps. Every field but the receiver is set by the step that owns it. */
export interface E9State {
  /** Step 1. Redirect URI `${receiver.callbackUrl}`. */
  confidentialApp?: E9App;
  /** Step 1. */
  publicApp?: E9App;
  /** Step 2: the streamer's grant of the confidential app (step 5 revokes it; re-authorize after). */
  grant?: Grant;
  /** Step 2: a client-credentials token of the confidential app. Never logged or reported. */
  appToken?: string;
  /** Step 4: the confidential app's `channel.follow` webhook subscription (steps 7 and 8 use it). */
  followSubscriptionId?: string;
  receiver: Receiver;
}

export interface E9Run {
  ctx: ScenarioContext;
  platform: Platform;
  log: Logger;
  env: HarnessEnv;
  via: Via;
  actors: {
    /** Registers the apps (steps 1 and 7). */
    developer: SignedInUser;
    /** Authorizes the apps; their channel is the subscriptions' broadcaster. */
    streamer: E8Streamer;
    /** Follows and chats. */
    viewer: SignedInUser;
    /** Suspends apps (steps 7 and 8). */
    admin: SignedInUser;
  };
  state: E9State;
  /** Set when `via=web` and a selected web step will run. */
  browser?: BrowserFleet;
}

export const E9_STEP_NUMBERS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
export type E9StepNumber = (typeof E9_STEP_NUMBERS)[number];

/** What every step module exports as `step` (the owning unit flips `ready` and implements `run`). */
export interface E9Step {
  name: string;
  /** The unit that owns the module, e.g. `E9-apps`. */
  owner: string;
  ready: boolean;
  /** Steps whose state this one reads; it runs only when they are ready and selected. */
  needs: number[];
  /** Only meaningful in a browser: skipped with `via=api`. */
  webOnly?: true;
  run(run: E9Run): Promise<void>;
}

/** A not-merged step module's `run`. */
export function notMerged(owner: string): () => Promise<void> {
  return () => Promise.reject(new Error(`${owner} not merged`));
}

/** `--set steps=` (numbers, ranges `1-3`, `all`/empty for all eight). */
export function parseE9Steps(value: string): E9StepNumber[] {
  return parseSteps(value, E9_STEP_NUMBERS, []);
}

export interface E9Plan {
  run: E9StepNumber[];
  skipped: { step: E9StepNumber; reason: string }[];
}

/**
 * In order: a step runs when it is ready, not `webOnly` under `via=api`, and every step it needs
 * runs too (so a need that is pending, skipped or not selected skips it, transitively). Everything
 * else is reported as pending, so `full` stays green while units are in flight.
 */
export function planE9Steps(
  selected: readonly E9StepNumber[],
  steps: Readonly<Record<E9StepNumber, Pick<E9Step, "owner" | "ready" | "needs" | "webOnly">>>,
  via: Via,
): E9Plan {
  const runs = new Set<number>();
  const plan: E9Plan = { run: [], skipped: [] };
  for (const n of [...selected].sort((a, b) => a - b)) {
    const s = steps[n];
    if (!s.ready) plan.skipped.push({ step: n, reason: `pending: ${s.owner} not merged` });
    else if (s.webOnly && via === "api") plan.skipped.push({ step: n, reason: "web only (via=api)" });
    else {
      const missing = s.needs.filter((m) => !runs.has(m));
      if (missing.length > 0)
        plan.skipped.push({ step: n, reason: `needs step${missing.length > 1 ? "s" : ""} ${missing.join(", ")}` });
      else {
        runs.add(n);
        plan.run.push(n);
      }
    }
  }
  return plan;
}

/** RFC 7636 verifier: 64 characters from the unreserved set. */
function newVerifier(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(48));
  return Buffer.from(bytes).toString("base64url");
}

/**
 * The authorization-code flow over the API, no browser: PKCE `S256`, the actor's session approves
 * through `developer.oauth.decide`, the `code` is read from the returned `redirectTo`, then
 * `POST OAUTH_PATHS.token`. Steps that need a live grant (5 revokes the streamer's) call this.
 */
export async function authorizeOverApi(
  run: Pick<E9Run, "env">,
  opts: { app: E9App; actor: SignedInUser; scopes: readonly Scope[] },
): Promise<Grant> {
  const verifier = newVerifier();
  const state = crypto.randomUUID();
  const { redirectTo } = await opts.actor.api.client.developer.oauth.decide({
    clientId: opts.app.clientId,
    redirectUri: opts.app.redirectUri,
    scope: opts.scopes.join(" "),
    state,
    codeChallenge: await pkceChallenge(verifier),
    codeChallengeMethod: "S256",
    approve: true,
  });
  const back = new URL(redirectTo);
  const error = back.searchParams.get("error");
  if (error) throw new Error(`authorize: the app was sent back error=${error}`);
  if (back.searchParams.get("state") !== state) throw new Error("authorize: state did not round-trip");
  const code = back.searchParams.get("code");
  if (!code) throw new Error("authorize: no code on the redirect");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: opts.app.redirectUri,
    client_id: opts.app.clientId,
    code_verifier: verifier,
  });
  if (opts.app.clientSecret !== null) form.set("client_secret", opts.app.clientSecret);
  const res = await fetch(new URL(OAUTH_PATHS.token, run.env.HARNESS_API_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form,
  });
  // Never the body: it carries the tokens on success and nothing useful beyond the code otherwise.
  if (!res.ok) throw new Error(`token endpoint answered HTTP ${res.status}`);
  const token = TokenResponse.parse(await res.json());
  if (!token.refresh_token) throw new Error("token endpoint issued no refresh token for a code grant");
  return {
    userId: opts.actor.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    scopes: token.scope.split(" ").filter(Boolean) as Scope[],
  };
}
