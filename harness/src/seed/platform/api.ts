// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-platform's API steps, signed in as the seeded owners: OAuth apps (and the admin's
 * suspension), real authorization-code grants with PKCE, a revoked grant, the bot and its token,
 * a device authorization, EventSub webhook subscriptions and the events that make deliveries, and
 * push subscriptions. These write their own `events` and `audit_log` rows, as any client's calls
 * would. Each user signs in once. Never logs a secret, token, code or verifier.
 */
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { OAUTH_PATHS, TokenResponse, pkceChallenge } from "@commonair/contracts/oauth";
import type { Scope } from "@commonair/contracts/scopes";
import { newWebhookSecret } from "../../e9/webhook.ts";
import type { Receiver } from "../../e9/receiver.ts";
import type { HarnessEnv } from "../../env.ts";
import { newHarnessSubscription } from "../../n1/ece.ts";
import type { PushReceiver } from "../../n1/push-receiver.ts";
import { type SignedInUser, UserFactory } from "../../users.ts";
import { sleep, waitFor } from "../../wait.ts";
import type { SeededUser } from "../types.ts";
import { type AppSpec, type PlatformPlan, type SubscriptionSpec, subscriptionCondition } from "./plan.ts";

/** The `auth` bucket is 10 per minute per address; a wait covers a full window. */
const RATE_LIMIT_WAIT_MS = 15_000;
const RATE_LIMIT_TRIES = 8;
const SETTLE_MS = 60_000;

/** Seconds to wait when `err` is a rate-limit refusal (oRPC RATE_LIMITED, an HTTP 429), else null. */
export function rateLimitWait(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; status?: unknown; data?: unknown; message?: unknown };
  const data = typeof e.data === "object" && e.data !== null ? (e.data as { retryAfterSeconds?: unknown }) : null;
  const after = typeof data?.retryAfterSeconds === "number" ? data.retryAfterSeconds : null;
  if (e.code === "RATE_LIMITED" || e.code === "TOO_MANY_REQUESTS" || e.status === 429) return after ?? 15;
  if (typeof e.message === "string" && /HTTP 429\b/.test(e.message)) return 15;
  return null;
}

/** Run `f`, waiting out rate limits; any other error names the user and step. */
export async function step<T>(who: string, what: string, f: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await f();
    } catch (err) {
      const wait = rateLimitWait(err);
      if (wait !== null && attempt < RATE_LIMIT_TRIES) {
        await sleep(Math.max(RATE_LIMIT_WAIT_MS, wait * 1000), signal);
        continue;
      }
      throw new Error(`seed-platform: ${what} as ${who} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Signs each seeded account in once (the shared password) and keeps the session. */
export class PlatformSessions {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;
  private readonly byHandle: Map<string, SeededUser>;

  constructor(
    env: HarnessEnv,
    private readonly password: string,
    users: readonly SeededUser[],
    private readonly signal?: AbortSignal,
  ) {
    this.byHandle = new Map(users.map((u) => [u.handle, u]));
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
    });
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      const u = this.byHandle.get(handle);
      if (!u) throw new Error(`seed-platform: no seeded user "${handle}" to sign in`);
      const creds = {
        username: u.username,
        displayName: u.username,
        email: u.email,
        password: this.password,
        birthDate: "",
      };
      p = step(handle, "sign in", () => this.factory.signIn(creds), this.signal);
      this.cache.set(handle, p);
    }
    return p;
  }

  get signedIn(): number {
    return this.cache.size;
  }
}

/** A registered app: never logged or reported with its secret. */
export interface CreatedApp {
  key: string;
  id: string;
  clientId: string;
  clientSecret: string | null;
  redirectUri: string;
  ownerHandle: string;
}

/** POST a form to an OAuth machine endpoint; the status and parsed body (never logged). */
export async function postForm(apiUrl: string, path: string, params: Record<string, string>) {
  const res = await fetch(new URL(path, apiUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // Not JSON: the status says enough.
  }
  if (res.status === 429) throw Object.assign(new Error(`${path}: HTTP 429`), { status: 429 });
  return { status: res.status, body };
}

/** An RFC 7636 verifier and its S256 challenge (from `crypto`: they are secrets). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  return { verifier, challenge: await pkceChallenge(verifier) };
}

/** Register every planned app (and rotate the planned secrets). */
export async function createApps(
  sessions: PlatformSessions,
  specs: readonly AppSpec[],
  signal?: AbortSignal,
): Promise<Map<string, CreatedApp>> {
  const out = new Map<string, CreatedApp>();
  for (const a of specs) {
    const u = await sessions.as(a.owner);
    const r = await step(
      a.owner,
      `register app ${a.key}`,
      () =>
        u.api.client.developer.apps.create({
          name: a.name,
          description: a.description,
          redirectUris: a.redirectUris,
          confidential: a.confidential,
        }),
      signal,
    );
    let secret = r.secret?.clientSecret ?? null;
    if (a.rotate && a.confidential) {
      const rotated = await step(a.owner, `rotate ${a.key}'s secret`, () =>
        u.api.client.developer.apps.rotateSecret({ id: r.app.id }),
      );
      secret = rotated.clientSecret;
    }
    out.set(a.key, {
      key: a.key,
      id: r.app.id,
      clientId: r.app.clientId,
      clientSecret: secret,
      redirectUri: a.redirectUris[0] ?? "",
      ownerHandle: a.owner,
    });
  }
  return out;
}

/** The admin suspends the planned apps (revokes their tokens and subscriptions). */
export async function suspendApps(
  sessions: PlatformSessions,
  specs: readonly AppSpec[],
  apps: ReadonlyMap<string, CreatedApp>,
): Promise<number> {
  let n = 0;
  for (const a of specs) {
    if (!a.suspend) continue;
    const app = apps.get(a.key);
    if (!app) throw new Error(`seed-platform: app ${a.key} was not created`);
    const admin = await sessions.as("admin");
    const reason = a.suspend;
    await step("admin", `suspend app ${a.key}`, () => admin.api.client.developer.admin.suspend({ id: app.id, reason }));
    n++;
  }
  return n;
}

/** Consent through `developer.oauth.decide`, then the token endpoint: one code and one token family. */
export async function authorize(
  env: HarnessEnv,
  user: SignedInUser,
  app: CreatedApp,
  scopes: readonly Scope[],
  signal?: AbortSignal,
): Promise<{ accessToken: string }> {
  const pkce = await pkcePair();
  const state = crypto.randomUUID();
  const { redirectTo } = await step(user.username, `authorize ${app.key}`, () =>
    user.api.client.developer.oauth.decide({
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      scope: scopes.join(" "),
      state,
      codeChallenge: pkce.challenge,
      codeChallengeMethod: "S256",
      approve: true,
    }),
  );
  const back = new URL(redirectTo);
  const code = back.searchParams.get("code");
  if (back.searchParams.get("state") !== state || !code)
    throw new Error(
      `seed-platform: authorizing ${app.key} did not come back with a code (${back.searchParams.get("error") ?? "no error"})`,
    );
  const form: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: app.redirectUri,
    client_id: app.clientId,
    code_verifier: pkce.verifier,
  };
  if (app.clientSecret !== null) form.client_secret = app.clientSecret;
  const res = await step(
    user.username,
    `exchange ${app.key}'s code`,
    () => postForm(env.HARNESS_API_URL, OAUTH_PATHS.token, form),
    signal,
  );
  if (res.status !== 200)
    throw new Error(`seed-platform: the token endpoint answered HTTP ${res.status} for ${app.key}`);
  return { accessToken: TokenResponse.parse(res.body).access_token };
}

/** The planned grants, then the planned revocations. */
export async function seedGrants(
  env: HarnessEnv,
  sessions: PlatformSessions,
  plan: Pick<PlatformPlan, "grants">,
  apps: ReadonlyMap<string, CreatedApp>,
  signal?: AbortSignal,
): Promise<{ granted: number; revoked: number }> {
  let granted = 0;
  let revoked = 0;
  for (const g of plan.grants) {
    const app = apps.get(g.appKey);
    if (!app) throw new Error(`seed-platform: app ${g.appKey} was not created`);
    const u = await sessions.as(g.user);
    await authorize(env, u, app, g.scopes, signal);
    granted++;
    if (g.revoke) {
      await step(g.user, `revoke ${g.appKey}`, () => u.api.client.developer.grants.revoke({ appId: app.id }));
      revoked++;
    }
  }
  return { granted, revoked };
}

/** A device authorization started through the API (the 10-minute one), with its user code. */
export async function startDevice(env: HarnessEnv, app: CreatedApp, scopes: readonly Scope[], signal?: AbortSignal) {
  const params: Record<string, string> = { client_id: app.clientId, scope: scopes.join(" ") };
  if (app.clientSecret !== null) params.client_secret = app.clientSecret;
  const res = await step(
    "device",
    "start a device authorization",
    () => postForm(env.HARNESS_API_URL, OAUTH_PATHS.device, params),
    signal,
  );
  if (res.status !== 200 || typeof res.body.user_code !== "string")
    throw new Error(`seed-platform: device authorization answered HTTP ${res.status}`);
  return { userCode: res.body.user_code, expiresIn: Number(res.body.expires_in) };
}

/** developer's bot account and a personal token for it. */
export async function seedBot(sessions: PlatformSessions, bot: PlatformPlan["bot"]): Promise<{ botId: string }> {
  const u = await sessions.as(bot.owner);
  const created = await step(bot.owner, "create the bot account", () =>
    u.api.client.me.bots.create({ username: bot.username, displayName: bot.displayName }),
  );
  await step(bot.owner, "mint the bot's token", () =>
    u.api.client.me.bots.createToken({ botId: created.id, scopes: bot.scopes, expiresInDays: bot.expiresInDays }),
  );
  return { botId: created.id };
}

// ------------------------------------------------------------------------ eventsub

export interface CreatedSubscription {
  key: string;
  id: string;
  target: SubscriptionSpec["target"];
}

/** Callback URL for a subscription's target. */
export interface Callbacks {
  receiver: Receiver;
  flaky: Receiver;
  /** A port nothing listens on, as the stack reaches this machine. */
  closedUrl: string;
}

const callbackOf = (spec: SubscriptionSpec, cb: Callbacks) =>
  spec.target === "receiver" ? cb.receiver.url : spec.target === "flaky" ? cb.flaky.url : cb.closedUrl;

/** Subscribe each planned webhook as `developer` for its app, and wait for the live ones to verify. */
export async function subscribe(
  sessions: PlatformSessions,
  specs: readonly SubscriptionSpec[],
  apps: ReadonlyMap<string, CreatedApp>,
  ids: ReadonlyMap<string, string>,
  cb: Callbacks,
  signal?: AbortSignal,
): Promise<CreatedSubscription[]> {
  const out: CreatedSubscription[] = [];
  for (const s of specs) {
    const app = apps.get(s.appKey);
    if (!app) throw new Error(`seed-platform: app ${s.appKey} was not created`);
    const owner = await sessions.as(app.ownerHandle);
    const broadcaster = ids.get(s.broadcaster);
    if (!broadcaster) throw new Error(`seed-platform: no user id for ${s.broadcaster}`);
    const created = await step(
      app.ownerHandle,
      `subscribe ${s.key} (${s.type}; http callbacks need EVENTSUB_ALLOW_INSECURE_CALLBACKS=true, harness/compose.e9.yaml)`,
      () =>
        owner.api.client.developer.events.subscribe({
          type: s.type,
          version: "1",
          condition: subscriptionCondition(s.type, broadcaster),
          transport: { method: "webhook", callback: callbackOf(s, cb), secret: newWebhookSecret() },
          appId: app.id,
        }),
    );
    out.push({ key: s.key, id: created.id, target: s.target });
  }
  const owner = await sessions.as("developer");
  for (const s of out.filter((x) => x.target !== "closed")) {
    await waitFor(
      `subscription ${s.key} enabled`,
      async () => {
        const page = await owner.api.client.developer.events.list({ limit: 100 });
        const hit = page.items.find((x) => x.id === s.id);
        if (hit?.status === "failed") throw new Error(`subscription ${s.key} failed verification`);
        return hit?.status === "enabled" || null;
      },
      { timeoutMs: SETTLE_MS, intervalMs: 500, signal },
    );
  }
  return out;
}

/** Make events the subscriptions cover: follows, title changes (and back), test events. */
export async function triggerEvents(
  sessions: PlatformSessions,
  plan: Pick<PlatformPlan, "triggers">,
  subs: readonly CreatedSubscription[],
  s1Slug: string,
  signal?: AbortSignal,
): Promise<{ follows: number; titleChanges: number; tests: number }> {
  let follows = 0;
  for (const h of plan.triggers.followers) {
    const u = await sessions.as(h);
    await step(h, "follow streamer1", () => u.api.client.channels.follow({ channel: s1Slug, notify: true }), signal);
    follows++;
  }
  const s1 = await sessions.as("streamer1");
  const original = (await s1.api.client.channels.get({ channel: s1Slug })).title;
  let titleChanges = 0;
  for (let i = 0; i < plan.triggers.titleChanges; i++) {
    const title = i === plan.triggers.titleChanges - 1 ? original : `${original} (rerun ${i + 1})`.slice(0, 140);
    await step(
      "streamer1",
      "change the title",
      () => s1.api.client.channels.update({ channel: s1Slug, title }),
      signal,
    );
    titleChanges++;
  }
  const dev = await sessions.as("developer");
  let tests = 0;
  for (const s of subs.filter((x) => x.target === "receiver"))
    for (let i = 0; i < plan.triggers.testEvents; i++) {
      await step(
        "developer",
        `send a test event to ${s.key}`,
        () => dev.api.client.developer.events.sendTest({ id: s.id }),
        signal,
      );
      tests++;
    }
  return { follows, titleChanges, tests };
}

/** Wait until every live subscription has at least one logged delivery. */
export async function waitDeliveries(
  sessions: PlatformSessions,
  subs: readonly CreatedSubscription[],
  signal?: AbortSignal,
): Promise<void> {
  const dev = await sessions.as("developer");
  for (const s of subs.filter((x) => x.target !== "closed"))
    await waitFor(
      `deliveries logged for ${s.key}`,
      async () => (await dev.api.client.developer.events.deliveries({ id: s.id, limit: 10 })).items.length > 0 || null,
      { timeoutMs: SETTLE_MS * 2, intervalMs: 1_000, signal },
    );
}

// ---------------------------------------------------------------------------- push

/** Register viewer1's browsers at the local push sink (`WEB_PUSH_ALLOW_INSECURE_ENDPOINTS`). */
export async function seedPush(
  sessions: PlatformSessions,
  plan: Pick<PlatformPlan, "push">,
  sink: PushReceiver,
): Promise<number> {
  let n = 0;
  for (const p of plan.push) {
    const u = await sessions.as(p.user);
    const made = await newHarnessSubscription(sink.endpoint(p.sinkId));
    await step(p.user, "register a push subscription", () =>
      u.api.client.notifications.push.subscribe({ endpoint: made.endpoint, keys: made.keys }),
    );
    n++;
  }
  return n;
}

/** The exact fix for a stack without web push. */
export const PUSH_FIX =
  "web push is off or has no VAPID keys: run `bun scripts/init-env.ts --merge` (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY) and start the stack with WEB_PUSH_ENABLED=true and WEB_PUSH_ALLOW_INSECURE_ENDPOINTS=true (harness/compose.n1.yaml) on api and worker";
