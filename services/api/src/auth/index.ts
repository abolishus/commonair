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
import { eq } from "drizzle-orm";
import { schema, uuidv7, type Database, type Executor } from "@commonair/db";
import type { Deps } from "../deps.ts";
import { instanceMediaPrefixes, isInstanceMediaRef } from "../lib/media-ref.ts";
import { recordAcceptances, currentRequiredDocuments } from "../lib/legal.ts";
import { appUrl, publicLink, sendNotice } from "../mail.ts";
import { verifyAltcha } from "./altcha.ts";
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
const IMMUTABLE_USER_FIELDS = new Set(["birthDate", "accountType", "botOwnerId", "botVerified", "username"]);
/** All a member may change about themselves through `/update-user` (the rest has its own flows). */
const SELF_WRITABLE_USER_FIELDS = new Set(["name", "image", "updatedAt"]);

/** A key prefix no storage key can have: only instance URLs pass. */
const NO_KEYS = "/";

const bad = (code: string, message: string) => new APIError("BAD_REQUEST", { code, message });

export function createAuth(deps: Deps) {
  const { env, db, site, mailer, logger } = deps;
  const minAge = env.AUTH_MIN_AGE;
  const twoFactorEnabling = new WeakSet<object>();

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
  const mediaPrefixes = instanceMediaPrefixes(env);
  /** An instance URL, or a key under the member's own channel avatar uploads. */
  const ownAvatarRef = async (ref: string, userId: string | undefined) => {
    const [c] = userId
      ? await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.ownerId, userId))
      : [];
    return isInstanceMediaRef(ref, mediaPrefixes, c ? `channels/${c.id}/avatar/` : NO_KEYS);
  };
  const VERIFY_MINUTES = 60;
  const RESET_MINUTES = 60;
  const MAGIC_MINUTES = 10;

  return betterAuth({
    appName: site.name,
    baseURL: env.API_PUBLIC_URL,
    basePath: "/api/auth",
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
    },
    user: {
      additionalFields: {
        birthDate: { type: "string", required: false, input: true, returned: false },
        accountType: { type: "string", required: false, input: false, defaultValue: "human" },
        locale: { type: "string", required: false, input: false, defaultValue: "en" },
      },
    },
    session: { expiresIn: 30 * 86_400, updateAge: 86_400 },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      maxPasswordLength: 256,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_MINUTES * 60,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send(
          "passwordReset",
          { resetUrl: publicLink(site, url), expiresInMinutes: RESET_MINUTES, locale: localeOf(user) },
          user.email,
        );
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFY_MINUTES * 60,
      sendVerificationEmail: async ({ user, url }) => {
        await mailer.send(
          "verifyEmail",
          {
            displayName: user.name,
            verifyUrl: publicLink(site, url),
            expiresInMinutes: VERIFY_MINUTES,
            locale: localeOf(user),
          },
          user.email,
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
          await mailer.send("magicLink", { signInUrl: publicLink(site, url), expiresInMinutes: MAGIC_MINUTES }, email);
        },
      }),
      passkey({ rpID: publicUrl.hostname, rpName: site.name, origin: site.publicUrl }),
    ],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // The admin plugin stays for its schema and banned-user sign-in checks, but its endpoints
        // (ban, set-role, impersonate, remove-user, …) skip our audit log and safeguards such as
        // "never remove the last administrator". Staff use the audited /api/admin procedures.
        if (ctx.path.startsWith("/admin/")) throw new APIError("NOT_FOUND", { message: "Not found" });
        if (ctx.path !== "/sign-up/email") return;
        const body = bodyOf(ctx);
        const altcha = await verifyAltcha(body.altcha, { hmacKey: env.ALTCHA_HMAC_KEY, valkey: deps.valkey });
        if (altcha) throw bad("ALTCHA_FAILED", `Proof-of-work check failed (${altcha})`);
        const nameProblem = usernameProblem(typeof body.username === "string" ? body.username : "");
        if (nameProblem)
          throw bad(
            "INVALID_USERNAME",
            nameProblem === "reserved"
              ? "This username is reserved"
              : "Usernames are 3–25 lowercase letters, digits or underscores",
          );
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
            if (usernameProblem(name)) throw bad("INVALID_USERNAME", "A valid username is required");
            const age = ageProblem(user.birthDate, minAge, deps.now());
            if (age === "too_young") throw bad("TOO_YOUNG", `You must be at least ${minAge} to join`);
            if (age) throw bad("INVALID_BIRTH_DATE", "A valid birth date is required");
            // Provider profile pictures are third-party URLs: drop them rather than embed them.
            const image =
              typeof user.image === "string" && isInstanceMediaRef(user.image, mediaPrefixes, NO_KEYS)
                ? user.image
                : null;
            return { data: { ...user, image, username: name.toLowerCase(), accountType: "human", role: "user" } };
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
            if (typeof data.image === "string" && !(await ownAvatarRef(data.image, ctx?.context.session?.user.id)))
              throw bad("INVALID_IMAGE", "The profile image must be one of your uploads");
            if (data.twoFactorEnabled === true && ctx) twoFactorEnabling.add(ctx);
          },
          after: async (user, ctx) => {
            if (!ctx || !twoFactorEnabling.has(ctx) || user.twoFactorEnabled !== true) return;
            twoFactorEnabling.delete(ctx);
            await sendNotice(logger, "twoFactorEnabled", () =>
              mailer.send(
                "twoFactorEnabled",
                { changedAt: deps.now(), securityUrl: appUrl(site, "/settings/security"), locale: localeOf(user) },
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
            if (!user) return;
            await ensureChannel(tx, user);
            const ids = bodyOf(ctx).acceptedDocumentIds;
            if (Array.isArray(ids))
              await recordAcceptances(
                tx,
                user.id,
                ids.filter((i): i is string => typeof i === "string"),
                deps.now(),
              );
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
