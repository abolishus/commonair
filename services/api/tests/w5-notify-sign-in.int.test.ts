// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (w5-notify): the "new sign-in" email. Through the mailer seam (`createAuth` with
 * a MemoryMailer and its own background, drained before each check) and end to end through the
 * API and Mailpit: a password sign-in mails once; a refresh, a sign-in from an already signed-in
 * browser, a second sign-in within 10 minutes, a two-step member's password step and a sign-up
 * mail nothing.
 */
import { MemoryMailer } from "@commonair/email";
import { schema } from "@commonair/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { authBackground } from "../src/auth/background.ts";
import { createAuth } from "../src/auth/index.ts";
import { NEW_SIGN_IN_WINDOW_SECONDS, newSignInKey } from "../src/auth/new-sign-in.ts";
import { client, Jar, MAILPIT_API, signUpAndSignIn, startApi, waitFor, type TestApi } from "./harness.ts";

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

/** Every Mailpit subject to `to`. */
async function subjectsTo(to: string): Promise<string[]> {
  const res = await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  const list = (await res.json()) as { messages?: { Subject: string }[] };
  return (list.messages ?? []).map((m) => m.Subject);
}

function seam() {
  const mailer = new MemoryMailer({ site: api.deps.site });
  const background = authBackground(api.deps.logger);
  const auth = createAuth({ ...api.deps, mailer }, { background });
  const call = async (jar: Jar, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: "http://localhost:3000", "user-agent": FIREFOX_LINUX };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (jar.cookies.size) headers.cookie = jar.header();
    const res = await auth.handler(
      new Request(`${api.url}/api/auth${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    jar.absorb(res);
    return res;
  };
  const signIn = (jar: Jar, m: { email: string; password: string }) =>
    call(jar, "POST", "/sign-in/email", { email: m.email, password: m.password });
  const newSignIns = async (email: string) => {
    await background.drain();
    return mailer.to(email).filter((m) => m.template === "newSignIn");
  };
  return { mailer, call, signIn, newSignIns };
}

describe("the new sign-in email", () => {
  test("a password sign-in sends one, with the time, the device and the security page", async () => {
    const m = await signUpAndSignIn(api);
    const s = seam();
    const res = await s.signIn(new Jar(), m);
    expect(res.status).toBe(200);
    const [mail, ...more] = await s.newSignIns(m.email);
    expect(more).toEqual([]);
    expect(mail?.subject).toBe(`New sign-in to your ${api.deps.site.name} account`);
    expect(mail?.text).toMatch(/UTC \(just now\)/);
    expect(mail?.text).toContain("Firefox · Linux");
    expect(mail?.text).toContain(`Sign out everywhere else ${api.deps.site.publicUrl}/settings/security#sessions`);
    // No unsubscribe: it is security mail.
    expect(mail?.headers["List-Unsubscribe"]).toBeUndefined();
    const ttl = await api.deps.valkey.ttl(newSignInKey(m.userId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(NEW_SIGN_IN_WINDOW_SECONDS);
  });

  test("a second sign-in within 10 minutes sends none", async () => {
    const m = await signUpAndSignIn(api);
    const s = seam();
    expect((await s.signIn(new Jar(), m)).status).toBe(200);
    expect((await s.signIn(new Jar(), m)).status).toBe(200);
    expect(await s.newSignIns(m.email)).toHaveLength(1);
  });

  test("a refresh, or a sign-in from a browser already signed in, sends none", async () => {
    const m = await signUpAndSignIn(api);
    const s = seam();
    const jar = new Jar();
    for (const [k, v] of m.client.jar.cookies) jar.cookies.set(k, v);
    expect((await s.call(jar, "GET", "/get-session")).status).toBe(200);
    expect((await s.signIn(jar, m)).status).toBe(200);
    expect(await s.newSignIns(m.email)).toEqual([]);
    expect(await api.deps.valkey.exists(newSignInKey(m.userId))).toBe(0);
  });

  test("a stale session cookie does not count as signed in", async () => {
    const m = await signUpAndSignIn(api);
    const s = seam();
    const jar = new Jar();
    for (const [k, v] of m.client.jar.cookies) jar.cookies.set(k, v);
    await api.db.db.delete(schema.sessions).where(eq(schema.sessions.userId, m.userId));
    expect((await s.signIn(jar, m)).status).toBe(200);
    expect(await s.newSignIns(m.email)).toHaveLength(1);
  });

  test("a two-step member's password step sends none", async () => {
    const m = await signUpAndSignIn(api);
    await api.db.db.update(schema.users).set({ twoFactorEnabled: true }).where(eq(schema.users.id, m.userId));
    const s = seam();
    const res = await s.signIn(new Jar(), m);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(await s.newSignIns(m.email)).toEqual([]);
  });

  test("through the API: sign-up sends none, a later sign-in reaches Mailpit once", async () => {
    const m = await signUpAndSignIn(api);
    // The sign-up's verification and the sign-in of the same browser are not new sign-ins.
    await Bun.sleep(1_000);
    expect((await subjectsTo(m.email)).filter((x) => /new sign-in/i.test(x))).toEqual([]);
    const fresh = client(api);
    expect((await fresh.call("POST", "/api/auth/sign-in/email", { email: m.email, password: m.password })).status).toBe(
      200,
    );
    const subject = await waitFor(async () => (await subjectsTo(m.email)).find((x) => /new sign-in/i.test(x)), 10_000);
    expect(subject).toBe(`New sign-in to your ${api.deps.site.name} account`);
    expect((await fresh.call("POST", "/api/auth/sign-in/email", { email: m.email, password: m.password })).status).toBe(
      200,
    );
    await Bun.sleep(1_000);
    expect((await subjectsTo(m.email)).filter((x) => /new sign-in/i.test(x))).toHaveLength(1);
  });
});
