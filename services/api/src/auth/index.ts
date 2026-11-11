// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * better-auth on our plural tables with UUIDv7 ids. Signup gates (ALTCHA, age,
 * username rules, legal acceptance) run before anything is written; the user's
 * channel is created inside the signup transaction.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { admin, magicLink, twoFactor, username } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { and, desc, eq, sql } from "drizzle-orm";
import { ALTCHA_FIELD, AUTH_BASE_PATH, AUTH_ROUTES, SECURITY_SETTINGS_PATH } from "@commonair/contracts/auth";
import { SIGNUP_INTENTS, type SignupIntent } from "@commonair/contracts/enums";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { publishUserControl } from "../lib/control.ts";
import { instanceMediaBase, isInstanceMediaRef } from "../lib/media-ref.ts";
import { isCommittedUpload, keyOfRef } from "../moderation/committed.ts";
import { recordAcceptances, currentRequiredDocuments } from "../lib/legal.ts";
import { appUrl, publicLink, sendNotice } from "../mail.ts";
import { verifyAltcha } from "./altcha.ts";
import { authBackground, type AuthBackground } from "./background.ts";
import { withVerificationCallback } from "./callback.ts";
import { ageProblem, usernameProblem } from "./identity.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const authTx = new AsyncLocalStorage<Tx>();

/**
 * better-auth's Drizzle adapter opens its own transactions (`db.transaction`). This view of the
 * database exposes each such transaction to our hooks, so rows we add (the channel, legal
 * acceptances) commit or roll back with the user row.
 */
function transactionAwareDb(db: Database): Database {
  const view = Object.create(db) as Database;
  view.transaction = ((fn: (tx: Tx) => Promise<unknown>, config?: Parameters<Database["transaction"]>[1]) =>
    db.transaction((tx) => authTx.run(tx, () => fn(tx)), config)) as Database["transaction"];
  return view;
}
const currentExecutor = (db: Database): Executor => authTx.getStore() ?? db;

/** Create the signup's channel (slug = username). Idempotent: one channel per owner. */
export async function ensureChannel(db: Executor, user: { id: string; username: string; name: string }) {
  await db
    .insert(schema.channels)
    .values({ ownerId: user.id, slug: user.username, displayName: user.name.slice(0, 40) || user.username })
    .onConflictDoNothing({ target: schema.channels.ownerId });
}

const bodyOf = (ctx: { body?: unknown } | null | undefined): Record<string, unknown> =>
  ctx?.body && typeof ctx.body === "object" ? (ctx.body as Record<string, unknown>) : {};

const localeOf = (u: Record<string, unknown>) => (typeof u.locale === "string" ? u.locale : undefined);

/** Never written through better-auth after the row exists. */
const IMMUTABLE_USER_FIELDS = new Set([
  "birthDate",
  "accountType",
  "botOwnerId",
  "botVerified",
  "username",
  "signupIntent",
]);

/**
 * `?intent=` at sign-up (D2.8), kept only when it is one of SIGNUP_INTENTS. Anything else (a
 * stale link, a typo, a non-string) is stored as null rather than refusing the sign-up.
 */
export function normalizeSignupIntent(value: unknown): SignupIntent | null {
  return typeof value === "string" && (SIGNUP_INTENTS as readonly string[]).includes(value)
    ? (value as SignupIntent)
    : null;
}
/** All a member may change about themselves through `/update-user` (the rest has its own flows). */
const SELF_WRITABLE_USER_FIELDS = new Set(["name", "image", "updatedAt"]);

/** better-auth sees paths relative to its base path. */
const SIGN_UP_PATH = AUTH_ROUTES.signUp.slice(AUTH_BASE_PATH.length);
const bad = (code: string, message: string) => new APIError("BAD_REQUEST", { code, message });

/**
 * Social sign-in only proves identity; nothing reads the provider's tokens afterwards, so they are
 * never stored (the `accounts_discard_provider_tokens` trigger enforces the same in Postgres).
 */
export const PROVIDER_TOKEN_FIELDS = ["accessToken", "refreshToken", "idToken"] as const;
export function withoutProviderTokens<T extends Record<string, unknown>>(account: T): T {
  const out: Record<string, unknown> = { ...account };
  for (const k of PROVIDER_TOKEN_FIELDS) if (k in out) out[k] = null;
  return out as T;
}
/** better-auth endpoints that return or use stored provider tokens; with none stored, they are closed. */
export const PROVIDER_TOKEN_PATHS = new Set(["/get-access-token", "/refresh-token", "/account-info"]);

export function createAuth(deps: Deps, opts: { background?: AuthBackground } = {}) {
  const { env, db, site, mailer, logger } = deps;
  const background = opts.background ?? authBackground(logger);
  const minAge = env.AUTH_MIN_AGE;
  const twoFactorEnabling = new WeakSet<object>();
  const banClearing = new WeakSet<object>();

  const social: Record<string, { clientId: string; clientSecret: string; disableImplicitSignUp: true }> = {};
  const providers = [
    ["discord", env.OAUTH_DISCORD_CLIENT_ID, env.OAUTH_DISCORD_CLIENT_SECRET],
    ["twitch", env.OAUTH_TWITCH_CLIENT_ID, env.OAUTH_TWITCH_CLIENT_SECRET],
    ["github", env.OAUTH_GITHUB_CLIENT_ID, env.OAUTH_GITHUB_CLIENT_SECRET],
  ] as const;
  // OAuth signs in and links existing accounts; new accounts go through the gated email signup.
  for (const [id, clientId, clientSecret] of providers)
    if (clientId && clientSecret) social[id] = { clientId, clientSecret, disableImplicitSignUp: true };

  const publicUrl = new URL(site.publicUrl);
  const mediaBase = instanceMediaBase(env);
  /** One of the member's own channel avatar uploads (key or media-bucket URL). */
  const ownAvatarKey = async (ref: string, userId: string | undefined) => {
    const [c] = userId
      ? await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.ownerId, userId))
      : [];
    if (!c || !isInstanceMediaRef(ref, mediaBase, `channels/${c.id}/avatar/`)) return null;
    const key = keyOfRef(ref, mediaBase);
    if (!key || !(await isCommittedUpload(deps, currentExecutor(db), ref, c.id, "avatar"))) return null;
    return key;
  };
  const VERIFY_MINUTES = 60;
  const RESET_MINUTES = 60;
  const MAGIC_MINUTES = 10;

  return betterAuth({
    appName: site.name,
    baseURL: env.API_PUBLIC_URL,
    basePath: AUTH_BASE_PATH,
    secret: env.AUTH_SECRET,
    trustedOrigins: [site.publicUrl, ...env.AUTH_TRUSTED_ORIGINS],
    telemetry: { enabled: false },
    // Our Valkey limiter covers /api/auth (see http.ts); better-auth's own is in-memory per process.
    rateLimit: { enabled: false },
    database: drizzleAdapter(transactionAwareDb(db), {
      provider: "pg",
      transaction: true,
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
        twoFactor: schema.twoFactors,
        passkey: schema.passkeys,
      },
    }),
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: "commonair",
      ipAddress: { disableIpTracking: true },
      // Anything better-auth defers runs after the response; see background.ts.
      backgroundTasks: { handler: (task) => background.handler(task) },
    },
    user: {
      additionalFields: {
        birthDate: { type: "string", required: false, input: true, returned: false },
        accountType: { type: "string", required: false, input: false, defaultValue: "human" },
        locale: { type: "string", required: false, input: false },
        signupIntent: {
          type: "string",
          required: false,
          input: true,
          returned: false,
          transform: { input: (v) => normalizeSignupIntent(v) },
        },
      },
      // D7.2: a verified member's change mails a confirmation to the CURRENT address first; its
      // link mails a verification to the new address, and only that second link changes the email.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          background.mail("changeEmailConfirm", () =>
            mailer.send(
              "changeEmailConfirm",
              {
                newEmail,
                confirmUrl: publicLink(site, withVerificationCallback(url, site.publicUrl)),
                expiresInMinutes: VERIFY_MINUTES,
                locale: localeOf(user as unknown as Record<string, unknown>),
              },
              user.email,
            ),
          );
        },
      },
    },
    session: { expiresIn: 30 * 86_400, updateAge: 86_400 },
    // Provider tokens are discarded (withoutProviderTokens), so there is nothing to refresh on sign-in.
    account: { updateAccountOnSignIn: false },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_MINUTES * 60,
      // Each auth mail returns before SMTP answers; see background.ts.
      sendResetPassword: async ({ user, url }) => {
        background.mail("passwordReset", () =>
          mailer.send(
            "passwordReset",
            { resetUrl: publicLink(site, url), expiresInMinutes: RESET_MINUTES, locale: localeOf(user) },
            user.email,
          ),
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFY_MINUTES * 60,
      sendVerificationEmail: async ({ user, url }) => {
        background.mail("verifyEmail", () =>
          mailer.send(
            "verifyEmail",
            {
              displayName: user.name,
              verifyUrl: publicLink(site, withVerificationCallback(url, site.publicUrl)),
              expiresInMinutes: VERIFY_MINUTES,
              locale: localeOf(user),
            },
            user.email,
          ),
        );
      },
    },
    socialProviders: social,
    plugins: [
      username({
        minUsernameLength: 3,
        maxUsernameLength: 25,
        usernameValidator: (name) => usernameProblem(name) === null,
        // The username is also the channel slug and the MediaMTX path: it never changes.
        immutableUsername: true,
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        roles: { user: userAc, moderator: userAc, treasurer: userAc, admin: adminAc },
      }),
      twoFactor({ issuer: site.name, backupCodeOptions: { amount: 10, length: 12 } }),
      magicLink({
        // Magic links sign existing members in; they never create accounts (no age gate on that path).
        disableSignUp: true,
        expiresIn: MAGIC_MINUTES * 60,
        sendMagicLink: async ({ email, url }) => {
          background.mail("magicLink", () =>
            mailer.send("magicLink", { signInUrl: publicLink(site, url), expiresInMinutes: MAGIC_MINUTES }, email),
          );
        },
      }),
      passkey({ rpID: publicUrl.hostname, rpName: site.name, origin: site.publicUrl }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // The admin plugin stays for its schema and banned-user sign-in checks, but its endpoints
        // (ban, set-role, impersonate, remove-user, …) skip our audit log and safeguards such as
        // "never remove the last administrator". Staff use the audited /api/admin procedures.
        if (ctx.path.startsWith("/admin/") || PROVIDER_TOKEN_PATHS.has(ctx.path))
          throw new APIError("NOT_FOUND", { message: "Not found" });
        if (ctx.path !== SIGN_UP_PATH) return;
        const body = bodyOf(ctx);
        const altcha = await verifyAltcha(body[ALTCHA_FIELD], { hmacKey: env.ALTCHA_HMAC_KEY, valkey: deps.valkey });
        if (altcha) throw bad("ALTCHA_FAILED", `Proof-of-work check failed (${altcha})`);
        const nameProblem = usernameProblem(typeof body.username === "string" ? body.username : "");
        // A separate code, because the web maps errors by code and a format hint would mislead.
        if (nameProblem === "reserved")
          throw bad("USERNAME_RESERVED", "This username is reserved for a page on this site; choose another");
        if (nameProblem) throw bad("INVALID_USERNAME", "Usernames are 3–25 lowercase letters, digits or underscores");
        const age = ageProblem(body.birthDate, minAge, deps.now());
        if (age === "too_young") throw bad("TOO_YOUNG", `You must be at least ${minAge} to join`);
        if (age) throw bad("INVALID_BIRTH_DATE", "A valid birth date (YYYY-MM-DD) is required");
        const required = await currentRequiredDocuments(db, deps.now());
        const accepted = Array.isArray(body.acceptedDocumentIds) ? body.acceptedDocumentIds : [];
        const missing = required.filter((d) => !accepted.includes(d.id));
        if (missing.length > 0)
          throw bad("LEGAL_ACCEPTANCE_REQUIRED", `Accept the current ${missing.map((d) => d.kind).join(", ")}`);
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Applies to every creation path (email signup, OAuth, admin), not only the HTTP gate above.
          before: async (user) => {
            const name = typeof user.username === "string" ? user.username : "";
            const problem = usernameProblem(name);
            if (problem === "reserved") throw bad("USERNAME_RESERVED", "This username is reserved; choose another");
            if (problem) throw bad("INVALID_USERNAME", "A valid username is required");
            const age = ageProblem(user.birthDate, minAge, deps.now());
            if (age === "too_young") throw bad("TOO_YOUNG", `You must be at least ${minAge} to join`);
            if (age) throw bad("INVALID_BIRTH_DATE", "A valid birth date is required");
            // A new account has no uploads yet, and provider profile pictures are third-party URLs.
            return {
              data: {
                ...user,
                image: null,
                username: name.toLowerCase(),
                accountType: "human",
                role: "user",
                signupIntent: normalizeSignupIntent(user.signupIntent),
              },
            };
          },
          after: async (user) => {
            // Normally done inside the transaction (account.create.before); this is the safety net.
            await ensureChannel(db, { id: user.id, username: String(user.username), name: user.name });
          },
        },
        update: {
          before: async (data, ctx) => {
            // Identity fields are fixed after signup: a birth date edit would let a minor unlock
            // mature content. No better-auth path may change it; staff corrections go through
            // our own audited procedures.
            if (Object.keys(data).some((k) => IMMUTABLE_USER_FIELDS.has(k)))
              throw bad("FIELD_NOT_ALLOWED", "This field cannot be changed");
            if (ctx?.path === "/update-user") {
              const refused = Object.keys(data).filter(
                (k) => data[k] !== undefined && !SELF_WRITABLE_USER_FIELDS.has(k),
              );
              if (refused.length > 0) throw bad("FIELD_NOT_ALLOWED", "This field cannot be changed");
            }
            if (typeof data.image === "string") {
              const key = await ownAvatarKey(data.image, ctx?.context.session?.user.id);
              if (!key) throw bad("INVALID_IMAGE", "The profile image must be one of your uploads");
              // Store the canonical key so the database guard can serialize every write with
              // NCII removal, even though this Better Auth update hook is not transactional.
              data.image = key;
            }
            if (data.twoFactorEnabled === true && ctx) twoFactorEnabling.add(ctx);
            // Decision (g): the admin plugin clears a lapsed ban at sign-in through this update.
            if (data.banned === false && ctx) banClearing.add(ctx);
          },
          after: async (user, ctx) => {
            // Only the update that cleared a ban (marked in `before`). Better Auth runs the sign-in's
            // clear inside the endpoint, so `ctx` is set; other user updates take no locks here.
            if (ctx && banClearing.has(ctx)) {
              banClearing.delete(ctx);
              if (user.banned !== true) await recordLapsedWithRetry(db, user.id, deps.now(), logger);
            }
            // Chat and IRC cache display names and avatars.
            if (ctx?.path === "/update-user")
              await publishUserControl(deps, { op: "invalidate", userId: user.id, reason: "profile_changed" });
            if (!ctx || !twoFactorEnabling.has(ctx) || user.twoFactorEnabled !== true) return;
            twoFactorEnabling.delete(ctx);
            await sendNotice(logger, "twoFactorEnabled", () =>
              mailer.send(
                "twoFactorEnabled",
                { changedAt: deps.now(), securityUrl: appUrl(site, SECURITY_SETTINGS_PATH), locale: localeOf(user) },
                user.email,
              ),
            );
          },
        },
      },
      account: {
        create: {
          // Runs inside the signup transaction, after the user row exists.
          before: async (account, ctx) => {
            const tx = currentExecutor(db);
            const [user] = await tx
              .select({ id: schema.users.id, username: schema.users.username, name: schema.users.name })
              .from(schema.users)
              .where(eq(schema.users.id, account.userId));
            const data = withoutProviderTokens(account);
            if (!user) return { data };
            await ensureChannel(tx, user);
            await recordAccountCreated(tx, user.id, deps.now());
            const ids = bodyOf(ctx).acceptedDocumentIds;
            if (Array.isArray(ids))
              await recordAcceptances(
                tx,
                user.id,
                ids.filter((i): i is string => typeof i === "string"),
                deps.now(),
              );
            return { data };
          },
        },
        update: {
          before: async (data) => ({ data: withoutProviderTokens(data) }),
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The `account.created` outbox row (D2.8), written in the sign-up transaction. better-auth runs
 * `user.create.after` only after the transaction commits, so the row is written from
 * `account.create.before` instead, which runs in that transaction once the user row exists. A
 * user's first linked account marks a new account; linking a second provider later finds the
 * earlier one and writes nothing. Id and intent only (no PII).
 */
export async function recordAccountCreated(tx: Executor, userId: string, now: Date): Promise<boolean> {
  const [existing] = await tx
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.userId, userId))
    .limit(1);
  if (existing) return false;
  const [user] = await tx
    .select({ intent: schema.users.signupIntent })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user) return false;
  await emit(tx, "account.created", null, { user_id: userId, intent: user.intent ?? null }, now);
  return true;
}

/**
 * Decision (g): a lapsed ban cleared at sign-in writes `channel.suspension {suspended: false}` for
 * each of the user's channels it leaves unsuspended, exactly once. The suspension being undone is
 * the channel's latest `channel.suspension` event: one is owed only while that event still says
 * `suspended: true` and the channel is no longer suspended. The channel rows are locked first, as
 * the `ban-expiry` sweep's `withSuspensionState` locks them, so the sweep, a second sign-in and
 * this path serialize, and whichever comes second finds the unsuspension written. A channel
 * suspended in its own right stays suspended (no event), as does a user with no channel. Each
 * event comes with its `audit_log` row (`user.ban_lapsed`, actor `system`, `via: "sign_in"`) in
 * the same transaction.
 *
 * The hook is not transactional: `banned = false` is already committed when it runs. Retry once,
 * then log at error level; the `ban-expiry` sweep's `recoverLostUnsuspensions` (worker) writes an
 * event lost here within 5 minutes, since it looks for channels whose latest `channel.suspension`
 * is still `true` while nothing suspends them.
 */
export async function recordLapsedWithRetry(
  db: Database,
  userId: string,
  now: Date,
  logger: Pick<Deps["logger"], "warn" | "error">,
): Promise<number | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await recordLapsedUnsuspension(db, userId, now);
    } catch (err) {
      const errorName = (err as Error).name;
      if (attempt >= 2) {
        logger.error("lapsed ban unsuspension failed", { errorName, attempts: attempt });
        return null;
      }
      logger.warn("lapsed ban unsuspension failed, retrying", { errorName });
    }
  }
}

export async function recordLapsedUnsuspension(db: Database, userId: string, now: Date): Promise<number> {
  const { channels, users, events } = schema;
  return db.transaction(async (tx) => {
    const owned = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(eq(channels.ownerId, userId))
      .orderBy(channels.id)
      .for("update", { of: channels });
    let written = 0;
    for (const c of owned) {
      const [state] = await tx
        .select({
          // The rule of `channel.suspension` (events/media-state.ts) as of now.
          suspended: sql<boolean>`(${channels.suspendedAt} is not null or (${users.banned} and (${users.banExpires} is null or ${users.banExpires} > ${now.toISOString()}::timestamptz)))`,
        })
        .from(channels)
        .innerJoin(users, eq(users.id, channels.ownerId))
        .where(eq(channels.id, c.id));
      if (!state || state.suspended) continue;
      const [last] = await tx
        .select({ suspended: sql<boolean | null>`(${events.payload}->>'suspended')::boolean` })
        .from(events)
        .where(and(eq(events.channelId, c.id), eq(events.type, "channel.suspension")))
        .orderBy(desc(events.occurredAt), desc(events.id))
        .limit(1);
      if (last?.suspended !== true) continue;
      await emit(tx, "channel.suspension", c.id, { channel_id: c.id, suspended: false }, now);
      // Ids and enums only (append-only row, ADR 0004). A lift has no statement of reasons.
      await audit(tx, {
        actorType: "system",
        actorId: null,
        action: "user.ban_lapsed",
        subjectType: "user",
        subjectId: userId,
        channelId: c.id,
        details: { userId, via: "sign_in" },
      });
      written++;
    }
    return written;
  });
}
