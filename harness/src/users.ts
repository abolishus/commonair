// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Simulated users signing up through the real auth flow: fetch an ALTCHA challenge, solve it,
 * sign up with a birth date and the current legal documents, click the verification link from
 * Mailpit, sign in. Usernames are unique per run so every scenario is idempotent against a
 * long-lived stack.
 */
import { AUTH_ROUTES } from "@commonair/contracts/auth";
import type { Me } from "@commonair/contracts/dto";
import { solveAltcha } from "./altcha.ts";
import { type Api, type ApiClientOptions, createApi } from "./api/client.ts";
import { CookieJar } from "./api/cookies.ts";
import { Mailpit, findTokenLink } from "./mailpit.ts";

/** better-auth's HTTP surface as services/api mounts it (outside the oRPC contract). */
export { AUTH_ROUTES };

export const ALTCHA_HEADER = "x-altcha";
export const DEFAULT_PASSWORD_LENGTH = 24;

const SLUG_MAX = 25;

/** Unique, contract-valid (`[a-z0-9_]{3,25}`) usernames: `<prefix>_<run tag><counter>`. */
export class UsernameFactory {
  private counter = 0;
  readonly runTag: string;

  constructor(runTag = Math.random().toString(36).slice(2, 7)) {
    this.runTag =
      runTag
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 6) || "run";
  }

  next(prefix = "user"): string {
    const n = (this.counter++).toString(36);
    const clean = prefix.toLowerCase().replace(/[^a-z0-9_]/g, "") || "user";
    const suffix = `_${this.runTag}${n}`;
    const head = clean.slice(0, Math.max(1, SLUG_MAX - suffix.length));
    const name = `${head}${suffix}`;
    return name.length >= 3 ? name : `${name}xx`.slice(0, 3);
  }
}

export interface UserCredentials {
  username: string;
  displayName: string;
  email: string;
  password: string;
  birthDate: string;
}

export interface SignedInUser extends UserCredentials {
  id: string;
  api: Api;
  me: Me;
}

export class AuthError extends Error {
  constructor(
    public readonly step: string,
    public readonly status: number,
    body: string,
  ) {
    super(`${step} failed: HTTP ${status}${body ? ` ${body.slice(0, 300)}` : ""}`);
    this.name = "AuthError";
  }
}

export interface UserFactoryOptions {
  apiUrl: string;
  /** Web app origin, sent as Origin (better-auth's trusted origin). */
  webOrigin: string;
  mailpitUrl: string;
  /** Mailpit basic auth (`user:password`), when its API is protected. */
  mailpitAuth?: string;
  emailDomain: string;
  names?: UsernameFactory;
  /** Builds API clients; the platform passes one that routes through the forwarding proxy. */
  apiFactory?: (opts: Omit<ApiClientOptions, "baseUrl"> & { baseUrl?: string }) => Api;
}

export interface SignUpOptions {
  prefix?: string;
  displayName?: string;
  /** ISO date; defaults to an adult. Pass a recent date to exercise the 13+ gate. */
  birthDate?: string;
  /** Skip clicking the verification link (to test unverified behaviour). */
  verifyEmail?: boolean;
  clientIp?: string;
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(DEFAULT_PASSWORD_LENGTH));
  return `Hx9!${Buffer.from(bytes).toString("base64url").slice(0, DEFAULT_PASSWORD_LENGTH)}`;
}

export class UserFactory {
  readonly names: UsernameFactory;
  readonly mailpit: Mailpit;

  constructor(private readonly opts: UserFactoryOptions) {
    this.names = opts.names ?? new UsernameFactory();
    this.mailpit = new Mailpit(opts.mailpitUrl, opts.mailpitAuth);
  }

  private api(extra: Partial<ApiClientOptions> = {}): Api {
    const make = this.opts.apiFactory ?? ((o) => createApi({ baseUrl: this.opts.apiUrl, ...o }));
    return make({ origin: this.opts.webOrigin, jar: new CookieJar(), ...extra });
  }

  credentials(opts: SignUpOptions = {}): UserCredentials {
    const username = this.names.next(opts.prefix);
    return {
      username,
      displayName: opts.displayName ?? username,
      email: `${username}@${this.opts.emailDomain}`,
      password: randomPassword(),
      birthDate: opts.birthDate ?? "1990-06-15",
    };
  }

  /** Full signup: ALTCHA → sign-up → verification email → sign-in. */
  async signUp(opts: SignUpOptions = {}): Promise<SignedInUser> {
    const creds = this.credentials(opts);
    const api = this.api({ clientIp: opts.clientIp });
    await this.register(api, creds);
    if (opts.verifyEmail !== false) await this.verifyEmail(api, creds.email);
    return this.signIn(creds, api);
  }

  /** POST the signup form (with a solved ALTCHA and the current legal documents). */
  async register(api: Api, creds: UserCredentials): Promise<void> {
    const challengeRes = await api.fetch(new Request(`${api.baseUrl}${AUTH_ROUTES.altchaChallenge}`));
    if (!challengeRes.ok) throw new AuthError("altcha challenge", challengeRes.status, await challengeRes.text());
    const altcha = await solveAltcha(await challengeRes.json());
    const documents = await api.client.legal.current().catch(() => []);
    const res = await api.fetch(
      new Request(`${api.baseUrl}${AUTH_ROUTES.signUp}`, {
        method: "POST",
        headers: { "content-type": "application/json", [ALTCHA_HEADER]: altcha },
        body: JSON.stringify({
          email: creds.email,
          password: creds.password,
          name: creds.displayName,
          username: creds.username,
          birthDate: creds.birthDate,
          altcha,
          acceptedDocumentIds: documents.filter((d) => d.requiresAcceptance).map((d) => d.id),
        }),
      }),
    );
    if (!res.ok) throw new AuthError("sign-up", res.status, await res.text());
  }

  /**
   * Follow the verification link from Mailpit as API calls through this user's client. The link
   * points at `PUBLIC_URL` (the web app, which proxies `/api/*`) or the public API; either way
   * its `/api/` path goes straight to the API. Stops once a redirect leaves `/api/` (the landing
   * page on the web app): the token check and session are done by then.
   */
  async verifyEmail(api: Api, email: string): Promise<void> {
    const message = await this.mailpit.waitForMessage(email, (m) => findTokenLink(m) !== null);
    const link = findTokenLink(message);
    if (!link) throw new Error("verification email has no link");
    const origins = {
      api: new URL(this.opts.apiUrl).origin,
      web: this.opts.webOrigin,
      client: new URL(api.baseUrl).origin,
    };
    let url = verificationHop(new URL(link), origins);
    if (!url) throw new Error("verification link is not an /api/ link on the web or API origin");
    for (let hop = 0; hop < 5; hop++) {
      const res = await api.fetch(new Request(url, { redirect: "manual" }));
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = verificationHop(new URL(location, url), origins);
        if (!next) return;
        url = next;
        continue;
      }
      if (!res.ok) throw new AuthError("verify email", res.status, await res.text());
      return;
    }
    throw new Error("verification link redirected too many times");
  }

  /** Sign in with email + password, using `api`'s jar or a fresh one. */
  async signIn(creds: UserCredentials, api: Api = this.api()): Promise<SignedInUser> {
    const res = await api.fetch(
      new Request(`${api.baseUrl}${AUTH_ROUTES.signIn}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: creds.email, password: creds.password }),
      }),
    );
    if (!res.ok) throw new AuthError("sign-in", res.status, await res.text());
    const me = await api.client.me.get();
    return { ...creds, id: me.id, api, me };
  }

  async signOut(user: SignedInUser): Promise<void> {
    const res = await user.api.fetch(new Request(`${user.api.baseUrl}${AUTH_ROUTES.signOut}`, { method: "POST" }));
    if (!res.ok) throw new AuthError("sign-out", res.status, await res.text());
  }
}

/**
 * Where the harness sends one hop of the verification flow: `/api/` paths on the API, web or
 * client origin go to the client's API base (which may be the forwarding proxy); anything else
 * (a page on the web app, another host) ends the API part, so null.
 */
export function verificationHop(target: URL, origins: { api: string; web: string; client: string }): URL | null {
  if (!target.pathname.startsWith("/api/")) return null;
  if (![origins.api, origins.web, origins.client].includes(target.origin)) return null;
  return new URL(`${target.pathname}${target.search}`, origins.client);
}
