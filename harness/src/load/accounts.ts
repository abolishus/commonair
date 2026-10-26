// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Streamer accounts for the load test on a real instance. A real install sees every request from
 * the generator as one client address (Caddy trusts no forwarded header), and its `auth` bucket
 * allows 10 auth writes (sign-up, sign-in) per address per minute
 * (`services/api/src/lib/ratelimit.ts`). So, without weakening any default:
 *
 * - auth writes are **paced** under the limit (`HARNESS_LOAD_AUTH_PER_MINUTE`), and a 429 waits
 *   for its `retryAfterSeconds` and tries again;
 * - accounts are **reused** across runs on one instance (`HARNESS_LOAD_ACCOUNTS_FILE`): a second
 *   sweep step or run signs in (one auth write) instead of signing up (two, plus a mail).
 *
 * With neither set, sign-up is exactly `Platform.signUp`, as before.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { Logger } from "@commonair/observability";
import type { Platform } from "../platform.ts";
import { AuthError, type SignedInUser, type UserCredentials } from "../users.ts";
import { mapLimit } from "./async.ts";

export interface PaceRule {
  max: number;
  windowMs: number;
}

/** The instance's `auth` bucket, plus a second of margin for clock skew between the two hosts. */
export const AUTH_PACE_WINDOW_MS = 61_000;

/** How long until another hit fits under `rule`, given the hits already made. Pure. */
export function paceDelayMs(hits: readonly number[], rule: PaceRule, nowMs: number): number {
  const live = hits.filter((t) => t > nowMs - rule.windowMs).sort((a, b) => a - b);
  if (live.length < rule.max) return 0;
  const blocking = live[live.length - rule.max] as number;
  return Math.max(0, blocking + rule.windowMs - nowMs);
}

/** A sliding-window pacer shared by every auth write this process makes. */
export class AuthPacer {
  private hits: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly rule: PaceRule,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  static perMinute(n: number): AuthPacer {
    return new AuthPacer({ max: Math.max(1, Math.floor(n)), windowMs: AUTH_PACE_WINDOW_MS });
  }

  /** Resolves when one more auth write may go out (and records it). Callers are served in order. */
  take(): Promise<void> {
    const turn = this.queue.then(async () => {
      for (;;) {
        const wait = paceDelayMs(this.hits, this.rule, this.now());
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      const t = this.now();
      this.hits = [...this.hits.filter((h) => h > t - this.rule.windowMs), t];
    });
    this.queue = turn.catch(() => undefined);
    return turn;
  }
}

/** Seconds to wait after a 429 from the auth routes (their body carries `retryAfterSeconds`). Pure. */
export function retryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof AuthError) || err.status !== 429) return null;
  const m = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(err.message);
  return m?.[1] ? Number(m[1]) : 60;
}

/** Run an auth write under the pacer; a 429 waits as told and tries again (up to `attempts`). */
export async function pacedAuth<T>(
  pacer: AuthPacer | null,
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 5;
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let i = 1; ; i++) {
    await pacer?.take();
    try {
      return await fn();
    } catch (err) {
      const after = retryAfterSeconds(err);
      if (after === null || i >= attempts) throw err;
      await sleep(after * 1000 + 500);
    }
  }
}

/** The accounts file: credentials per instance (keyed by the API URL). Test accounts only. */
export interface AccountsFile {
  version: 1;
  instances: Record<string, UserCredentials[]>;
}

const isCreds = (v: unknown): v is UserCredentials => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return ["username", "displayName", "email", "password", "birthDate"].every((k) => typeof o[k] === "string");
};

/** Parse the file; anything unreadable is an empty file (it is a cache, not a source of truth). Pure. */
export function parseAccountsFile(text: string | null): AccountsFile {
  const empty: AccountsFile = { version: 1, instances: {} };
  if (!text) return empty;
  try {
    const v = JSON.parse(text) as { version?: unknown; instances?: unknown };
    if (v.version !== 1 || typeof v.instances !== "object" || v.instances === null) return empty;
    const instances: Record<string, UserCredentials[]> = {};
    for (const [k, list] of Object.entries(v.instances as Record<string, unknown>)) {
      if (Array.isArray(list)) instances[k] = list.filter(isCreds);
    }
    return { version: 1, instances };
  } catch {
    return empty;
  }
}

/** The file with `creds` appended for `instance` (replacing an entry with the same username). Pure. */
export function withAccount(file: AccountsFile, instance: string, creds: UserCredentials): AccountsFile {
  const list = (file.instances[instance] ?? []).filter((c) => c.username !== creds.username);
  return { version: 1, instances: { ...file.instances, [instance]: [...list, creds] } };
}

/** The file without `username` for `instance` (an account the instance no longer knows). Pure. */
export function withoutAccount(file: AccountsFile, instance: string, username: string): AccountsFile {
  const list = (file.instances[instance] ?? []).filter((c) => c.username !== username);
  return { version: 1, instances: { ...file.instances, [instance]: list } };
}

/** Reads and writes the accounts file, one write at a time, mode 0600. */
export class AccountStore {
  private file: AccountsFile = { version: 1, instances: {} };
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    readonly instance: string,
  ) {}

  async load(): Promise<UserCredentials[]> {
    const text = await readFile(this.path, "utf8").catch(() => null);
    this.file = parseAccountsFile(text);
    return [...(this.file.instances[this.instance] ?? [])];
  }

  add(creds: UserCredentials): Promise<void> {
    this.file = withAccount(this.file, this.instance, creds);
    return this.flush();
  }

  remove(username: string): Promise<void> {
    this.file = withoutAccount(this.file, this.instance, username);
    return this.flush();
  }

  private flush(): Promise<void> {
    const snapshot = JSON.stringify(this.file, null, 2);
    this.writes = this.writes.then(async () => {
      await writeFile(this.path, `${snapshot}\n`, { mode: 0o600 });
      await chmod(this.path, 0o600);
    });
    return this.writes;
  }
}

export interface ProvisionOptions {
  pacer: AuthPacer | null;
  store: AccountStore | null;
  log?: Logger;
  prefix?: string;
  concurrency?: number;
  /** Usernames already in use by this run (a growing fleet): never handed out again. */
  exclude?: ReadonlySet<string>;
}

/** Sign up with every auth write paced. */
async function pacedSignUp(p: Platform, pacer: AuthPacer | null, prefix: string): Promise<SignedInUser> {
  const creds = p.users.credentials({ prefix });
  const api = p.api();
  await pacedAuth(pacer, () => p.users.register(api, creds));
  await p.users.verifyEmail(api, creds.email);
  return pacedAuth(pacer, () => p.users.signIn(creds, api));
}

/**
 * `count` signed-in streamer accounts: reused from the store first (sign-in), the rest signed up
 * and added to it. Without a pacer and a store this is `Platform.signUp` for each, as before.
 */
export async function provisionStreamers(p: Platform, count: number, opts: ProvisionOptions): Promise<SignedInUser[]> {
  const prefix = opts.prefix ?? "load";
  const concurrency = opts.concurrency ?? 4;
  if (!opts.pacer && !opts.store) {
    return mapLimit(Array.from({ length: count }), concurrency, () => p.signUp({ prefix }));
  }
  const cached = opts.store
    ? (await opts.store.load()).filter((c) => !opts.exclude?.has(c.username)).slice(0, count)
    : [];
  const reused = await mapLimit(cached, concurrency, async (creds) => {
    try {
      return await pacedAuth(opts.pacer, () => p.users.signIn(creds));
    } catch (err) {
      // The instance was reinstalled or the account removed: forget it and sign up instead.
      if (err instanceof AuthError && (err.status === 401 || err.status === 403)) {
        await opts.store?.remove(creds.username);
        return null;
      }
      throw err;
    }
  });
  const users = reused.filter((u): u is SignedInUser => u !== null);
  opts.log?.info("load accounts", { reused: users.length, toCreate: count - users.length });
  const fresh = await mapLimit(Array.from({ length: count - users.length }), concurrency, async () => {
    const u = await pacedSignUp(p, opts.pacer, prefix);
    await opts.store?.add({
      username: u.username,
      displayName: u.displayName,
      email: u.email,
      password: u.password,
      birthDate: u.birthDate,
    });
    return u;
  });
  return [...users, ...fresh];
}
