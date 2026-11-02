// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-safety's connections to the stack: one signed-in session per seeded account (the auth rate
 * limit is waited out, never bypassed), the moderation, analytics and DMCA test hooks, and the
 * ALTCHA solve the public forms need. Nothing here writes to the database directly.
 */
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import { DEMO_FIXTURES } from "@commonair/contracts/fixtures";
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { solveAltcha } from "../../altcha.ts";
import { createApi, type ApiClient } from "../../api/client.ts";
import type { HarnessEnv } from "../../env.ts";
import { AuthError, type SignedInUser, UserFactory } from "../../users.ts";
import { seedApiFactory } from "../clients.ts";
import { sleep } from "../../wait.ts";
import type { SeededUser } from "../types.ts";

/** Auth answers 429 past 10 sign-ins a minute per address; wait it out this many times at most. */
const SIGN_IN_ATTEMPTS = 30;

/** Seconds a 429 asks to wait (`data.retryAfterSeconds` in the body the error carries), else 6. Pure. */
export function retryAfterSeconds(message: string): number {
  const m = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(message);
  return m ? Math.max(1, Number(m[1])) : 6;
}

export class SafetySessions {
  private readonly cache = new Map<string, Promise<SignedInUser>>();
  private readonly factory: UserFactory;
  private readonly users: ReadonlyMap<string, SeededUser>;
  /** Seconds spent waiting for the auth rate limit (reported in the notes). */
  waitedSeconds = 0;

  constructor(
    private readonly env: HarnessEnv,
    private readonly password: string,
    users: readonly SeededUser[],
    private readonly signal: AbortSignal,
  ) {
    this.users = new Map(users.map((u) => [u.handle, u]));
    this.factory = new UserFactory({
      apiUrl: env.HARNESS_API_URL,
      webOrigin: new URL(env.HARNESS_WEB_URL).origin,
      mailpitUrl: env.HARNESS_MAILPIT_URL,
      mailpitAuth: env.HARNESS_MAILPIT_AUTH,
      emailDomain: DEMO_FIXTURES.emailDomain,
      apiFactory: seedApiFactory(env, "safety"),
    });
  }

  get signedIn(): number {
    return this.cache.size;
  }

  user(handle: string): SeededUser {
    const u = this.users.get(handle);
    if (!u) throw new Error(`seed-safety: no seeded user "${handle}"`);
    return u;
  }

  as(handle: string): Promise<SignedInUser> {
    let p = this.cache.get(handle);
    if (!p) {
      p = this.signIn(this.user(handle));
      this.cache.set(handle, p);
    }
    return p;
  }

  private async signIn(u: SeededUser): Promise<SignedInUser> {
    const creds = {
      username: u.username,
      displayName: u.username,
      email: u.email,
      password: this.password,
      birthDate: "",
    };
    for (let attempt = 1; ; attempt++) {
      this.signal.throwIfAborted();
      try {
        return await this.factory.signIn(creds);
      } catch (err) {
        if (err instanceof AuthError && err.status === 429 && attempt < SIGN_IN_ATTEMPTS) {
          const s = retryAfterSeconds(err.message);
          this.waitedSeconds += s;
          await sleep(s * 1000, this.signal);
          continue;
        }
        throw new Error(`seed-safety: sign-in as ${u.handle} failed: ${String(err)}`);
      }
    }
  }

  /** A signed-out client (the public forms). */
  anon(): { client: ApiClient; fetch: (r: Request) => Promise<Response>; baseUrl: string } {
    return createApi({ baseUrl: this.env.HARNESS_API_URL, origin: new URL(this.env.HARNESS_WEB_URL).origin });
  }

  /** A solved ALTCHA payload for one public form submission. */
  async altcha(): Promise<string> {
    const api = this.anon();
    const res = await api.fetch(new Request(`${api.baseUrl}${AUTH_ROUTES.altchaChallenge}`));
    if (!res.ok) throw new Error(`seed-safety: ALTCHA challenge answered HTTP ${res.status}`);
    return solveAltcha(await res.json());
  }
}

/** The analytics test hooks (`OPS_TEST_HOOKS`): a job run now, and the 24 h display bypass. */
export class AnalyticsHooks {
  constructor(
    private readonly apiUrl: string,
    private readonly secret: string,
    private readonly signal: AbortSignal,
  ) {}

  private async call(method: "PUT" | "POST", route: string, body: unknown, timeoutMs: number): Promise<Response> {
    const res = await fetch(new URL(route, this.apiUrl), {
      method,
      headers: { "content-type": "application/json", [INTERNAL_SECRET_HEADER]: this.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (res.status === 404)
      throw new Error(`seed-safety: ${route} answered 404: start the api and worker with OPS_TEST_HOOKS=true`);
    if (!res.ok) throw new Error(`seed-safety: ${route} answered HTTP ${res.status}`);
    return res;
  }

  async tick(job: "broadcast-rollup" | "integrity-attestation", broadcastId: string): Promise<Record<string, number>> {
    const res = await this.call("POST", INTERNAL_ROUTES.analyticsTick, { job, broadcastId }, 90_000);
    return (await res.json()) as Record<string, number>;
  }

  async bypass(channelId: string, enabled: boolean): Promise<void> {
    await this.call("PUT", INTERNAL_ROUTES.analyticsDisplayBypass, { channelId, enabled }, 10_000);
  }
}

/** Run `f`, naming the step and account in any error (common.md rule 9: fail loudly). */
export async function step<T>(signal: AbortSignal, who: string, what: string, f: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  try {
    return await f();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("seed-safety:")) throw err;
    throw new Error(`seed-safety: ${what} as ${who} failed: ${String(err)}`);
  }
}
