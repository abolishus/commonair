// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Integration-test harness: a throwaway database (the API connects as the
 * least-privilege app role), a unique Valkey key prefix, Mailpit for mail, and
 * the API itself served in-process on a random port.
 */
import { solveChallenge, type Challenge } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/sha";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createLogger } from "@commonair/observability";
import { createValkey } from "@commonair/service";
import { generateSigningKey, randomSecret } from "@commonair/tokens";
import { buildDeps, createApp, loadApiEnv, type ApiApp, type Deps } from "../src/index.ts";
import { DEFAULT_RATE_LIMITS } from "../src/lib/ratelimit.ts";

export const VALKEY_URL = process.env.VALKEY_URL ?? "redis://localhost:6379";
export const MAILPIT_API = process.env.MAILPIT_API_URL ?? "http://localhost:8025";

export interface TestApi {
  url: string;
  deps: Deps;
  app: ApiApp;
  db: TestDatabase;
  internalSecret: string;
  keyPrefix: string;
  stop(): Promise<void>;
}

export async function startApi(opts: { rateLimits?: Partial<Deps["rateLimits"]>; fetch?: typeof fetch } = {}): Promise<TestApi> {
  const db = await createTestDatabase();
  const { pkcs8B64 } = await generateSigningKey();
  const internalSecret = randomSecret("", 32);
  const keyPrefix = `test:${crypto.randomUUID()}:`;
  let app: ApiApp | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req, srv) => (app ? app.fetch(req, srv) : new Response("starting", { status: 503 })),
  });
  const url = `http://127.0.0.1:${server.port}`;
  const env = loadApiEnv({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.API_TEST_LOG ? "debug" : "error",
    PUBLIC_URL: "http://localhost:3000",
    API_PUBLIC_URL: url,
    DATABASE_URL: db.appUrl,
    VALKEY_URL,
    INTERNAL_API_SECRET: internalSecret,
    AUTH_SECRET: randomSecret("", 32),
    AUTH_TRUSTED_ORIGINS: "http://localhost:3000",
    ALTCHA_HMAC_KEY: randomSecret("", 32),
    S3_ENDPOINT: "http://localhost:3900",
    S3_ACCESS_KEY_ID: "GK0123456789abcdef01234567",
    S3_SECRET_ACCESS_KEY: "0".repeat(64),
    PLAYBACK_SIGNING_KEY: pkcs8B64,
    SMTP_HOST: process.env.SMTP_HOST ?? "localhost",
    SMTP_PORT: process.env.SMTP_PORT ?? "1025",
    MAIL_FROM: "Test <noreply@test.invalid>",
  });
  const built = await buildDeps(env, {
    logger: createLogger({ service: "api-test", write: process.env.API_TEST_LOG ? (l) => console.error(l) : () => {} }),
    valkeyKeyPrefix: keyPrefix,
    overrides: {
      rateLimits: { ...DEFAULT_RATE_LIMITS, default: { max: 10_000, windowMs: 60_000 }, auth: { max: 1000, windowMs: 60_000 }, write: { max: 1000, windowMs: 60_000 }, ...opts.rateLimits },
      probes: {},
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    },
  });
  app = createApp(built.deps);
  return {
    url,
    deps: built.deps,
    app,
    db,
    internalSecret,
    keyPrefix,
    async stop() {
      await server.stop(true);
      await built.close();
      await db.drop();
    },
  };
}

/** A dedicated subscriber connection (pub/sub channels are not key-prefixed). */
export function subscriber() {
  return createValkey(VALKEY_URL, { name: "api-test-sub" });
}

export async function solveAltcha(api: TestApi): Promise<string> {
  const challenge = (await (await fetch(`${api.url}/api/auth/altcha-challenge`)).json()) as Challenge;
  const solution = await solveChallenge({ challenge, deriveKey });
  if (!solution) throw new Error("could not solve altcha");
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
}

/** A cookie jar good enough for one better-auth session. */
export class Jar {
  cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair?.indexOf("=") ?? -1;
      if (!pair || i < 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === "" || /max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export interface Client {
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; res: Response }>;
  jar: Jar;
}

/** REST client against /api (cookie session or bearer token). */
export function client(api: TestApi, auth: { jar?: Jar; bearer?: string } = {}): Client {
  const jar = auth.jar ?? new Jar();
  return {
    jar,
    async call(method, path, body) {
      const headers: Record<string, string> = { origin: "http://localhost:3000" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
      else if (jar.cookies.size) headers.cookie = jar.header();
      const res = await fetch(`${api.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      jar.absorb(res);
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // keep text
      }
      return { status: res.status, body: parsed as never, res };
    },
  };
}

export const uniqueName = (p = "u") => `${p}${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;

export async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 5000, stepMs = 100): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await Bun.sleep(stepMs);
  }
}

/** Latest Mailpit message to `to`, with its text body. */
export async function mailTo(to: string): Promise<{ subject: string; text: string } | null> {
  const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  if (!res.ok) return null;
  const list = (await res.json()) as { messages?: { ID: string; Subject: string }[] };
  const m = list.messages?.[0];
  if (!m) return null;
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${m.ID}`)).json()) as { Text: string };
  return { subject: m.Subject, text: full.Text };
}

/** Sign up through better-auth with the ALTCHA and age gates, verify the email, sign in. */
export async function signUpAndSignIn(api: TestApi, opts: { username?: string; birthDate?: string } = {}) {
  const username = opts.username ?? uniqueName();
  const email = `${username}@test.invalid`;
  const password = `pw-${crypto.randomUUID()}`;
  const c = client(api);
  const up = await c.call("POST", "/api/auth/sign-up/email", {
    email,
    password,
    name: username,
    username,
    birthDate: opts.birthDate ?? "1990-05-05",
    altcha: await solveAltcha(api),
  });
  if (up.status !== 200) throw new Error(`signup failed: ${up.status} ${JSON.stringify(up.body)}`);
  const mail = await waitFor(() => mailTo(email));
  const link = /https?:\/\/\S+verify-email\?token=\S+/.exec(mail.text)?.[0];
  if (!link) throw new Error("no verification link");
  const verify = await fetch(link, { redirect: "manual" });
  c.jar.absorb(verify);
  const signIn = await c.call("POST", "/api/auth/sign-in/email", { email, password });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${JSON.stringify(signIn.body)}`);
  const me = await c.call<{ id: string }>("GET", "/api/me");
  return { client: c, username, email, password, userId: me.body.id };
}
