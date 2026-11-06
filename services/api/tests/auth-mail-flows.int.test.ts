// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * better-auth's mail flows and social configuration (auth/index.ts) end to end against Mailpit:
 * a password reset and a magic link each mail a link on this instance's public URL (never the API's
 * own origin), a magic link never creates an account, and a social provider exists only when both
 * its client id and secret are set.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createAuth } from "../src/auth/index.ts";
import { client, mailTo, signUpAndSignIn, startApi, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

/** Mail goes out after the response; CI under load can take a while to deliver it to Mailpit. */
const MAIL_WAIT_MS = 20_000;
// Room for two mail waits in one test.
vi.setConfig({ testTimeout: 60_000 });
const linkIn = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

describe("mail flows", () => {
  test("a password reset mails a link on the public URL", async () => {
    const me = await signUpAndSignIn(api);
    const r = await client(api).call("POST", "/api/auth/request-password-reset", {
      email: me.email,
      redirectTo: `${api.deps.site.publicUrl}/reset`,
    });
    expect(r.status).toBe(200);
    const mail = await waitFor(async () => {
      const m = await mailTo(me.email);
      return m && /reset/i.test(m.text) && !/verify-email/.test(m.text) ? m : null;
    }, MAIL_WAIT_MS);
    expect(linkIn(mail.text).startsWith(api.deps.site.publicUrl)).toBe(true);
  });

  test("a magic link mails a sign-in link to a member, and nothing for an unknown address", async () => {
    const me = await signUpAndSignIn(api);
    const r = await client(api).call("POST", "/api/auth/sign-in/magic-link", {
      email: me.email,
      callbackURL: `${api.deps.site.publicUrl}/`,
    });
    expect(r.status).toBe(200);
    const mail = await waitFor(async () => {
      const m = await mailTo(me.email);
      return m && /magic-link/.test(m.text) ? m : null;
    }, MAIL_WAIT_MS);
    const link = linkIn(mail.text);
    expect(link.startsWith(api.deps.site.publicUrl)).toBe(true);
    // An unknown address gets a link too (no account enumeration), but following it never makes
    // an account (disableSignUp).
    const stranger = `nobody-${crypto.randomUUID().slice(0, 8)}@test.invalid`;
    await client(api).call("POST", "/api/auth/sign-in/magic-link", { email: stranger });
    const strangerMail = await waitFor(() => mailTo(stranger), MAIL_WAIT_MS);
    const verify = await fetch(linkIn(strangerMail.text).replace(api.deps.site.publicUrl, api.url), {
      redirect: "manual",
    });
    expect(verify.status).toBeGreaterThanOrEqual(300);
    const [row] = await api.db.db.execute<{ n: number }>(
      // Raw count: no user row for the stranger, whatever the link did.
      sql`select count(*)::int as n from users where email = ${stranger}`,
    );
    expect(row?.n).toBe(0);
  });
});

describe("social providers", () => {
  test("a provider exists only with both its client id and secret", async () => {
    const ok = createAuth({
      ...api.deps,
      env: { ...api.deps.env, OAUTH_GITHUB_CLIENT_ID: "gh-id", OAUTH_GITHUB_CLIENT_SECRET: "gh-secret" },
    });
    const half = createAuth({
      ...api.deps,
      env: { ...api.deps.env, OAUTH_DISCORD_CLIENT_ID: "dc-id", OAUTH_DISCORD_CLIENT_SECRET: undefined },
    });
    const ask = (auth: ReturnType<typeof createAuth>, provider: string) =>
      auth.handler(
        new Request(`${api.deps.env.API_PUBLIC_URL}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: api.deps.site.publicUrl },
          body: JSON.stringify({ provider, callbackURL: `${api.deps.site.publicUrl}/` }),
        }),
      );
    const gh = await ask(ok, "github");
    expect(gh.status).toBe(200);
    expect(((await gh.json()) as { url?: string }).url).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize/);
    expect((await ask(half, "discord")).status).not.toBe(200);
  });
});
