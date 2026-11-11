// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D7.2 (/settings/security) on the server, against Mailpit: a change of email mails a confirmation
 * to the CURRENT address and changes nothing until both links are followed; a sign-in from a new
 * device mails `newSignIn` linking `/settings/security#sessions`, a known device does not; and a
 * member with two-step sign-in on finishes signing in with a TOTP code (the password step makes no
 * session and sends no new-device mail).
 */
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { SESSIONS_SETTINGS_PATH } from "@commonair/contracts/auth";
import { Jar, mailTo, signUpAndSignIn, startApi, waitFor, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
}, 60_000);
afterAll(async () => {
  await api?.stop();
});

const MAIL_WAIT_MS = 20_000;
vi.setConfig({ testTimeout: 90_000 });
const linkIn = (text: string) => /https?:\/\/\S+verify-email\?\S+/.exec(text)?.[0] ?? "";

const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

/** A request as a browser would send it: its own user agent and cookie jar. */
async function browserCall(jar: Jar, userAgent: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: "http://localhost:3000", "user-agent": userAgent };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar.cookies.size) headers.cookie = jar.header();
  const res = await fetch(`${api.url}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(res);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown> | null };
}

/** Every Mailpit message to `to` (newest first), subjects only. */
async function subjectsTo(to: string): Promise<string[]> {
  const res = await fetch(
    `${process.env.MAILPIT_API_URL ?? "http://localhost:8025"}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
  );
  const list = (await res.json()) as { messages?: { Subject: string }[] };
  return (list.messages ?? []).map((m) => m.Subject);
}

/** RFC 6238 (SHA-1, 6 digits, 30 s) from an otpauth URI's base32 secret. */
function totp(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac.at(-1) ?? 0) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("change email", () => {
  test("confirms with the current address first and changes only after both links", async () => {
    const me = await signUpAndSignIn(api);
    const newEmail = `new-${me.username}@test.invalid`;
    const r = await me.client.call("POST", "/api/auth/change-email", { newEmail, callbackURL: "/settings/security" });
    expect(r.status).toBe(200);

    const confirm = await waitFor(async () => {
      const m = await mailTo(me.email);
      return m && m.text.includes(newEmail) ? m : null;
    }, MAIL_WAIT_MS);
    const confirmLink = linkIn(confirm.text);
    expect(confirmLink.startsWith(api.deps.site.publicUrl)).toBe(true);
    expect(await subjectsTo(newEmail)).toEqual([]);
    const [before] = await api.db.db.execute<{ email: string }>(sql`select email from users where id = ${me.userId}`);
    expect(before?.email).toBe(me.email);

    // The confirmation's link (on the public origin) sends the verification to the new address.
    const step1 = await fetch(confirmLink.replace(api.deps.site.publicUrl, api.url), { redirect: "manual" });
    expect(step1.status).toBeLessThan(400);
    expect(new URL(step1.headers.get("location") ?? "/", api.deps.site.publicUrl).pathname).toBe("/settings/security");
    const verify = await waitFor(() => mailTo(newEmail), MAIL_WAIT_MS);
    const [between] = await api.db.db.execute<{ email: string }>(sql`select email from users where id = ${me.userId}`);
    expect(between?.email).toBe(me.email);

    const step2 = await fetch(linkIn(verify.text).replace(api.deps.site.publicUrl, api.url), { redirect: "manual" });
    expect(step2.status).toBeLessThan(400);
    const [after] = await api.db.db.execute<{ email: string; email_verified: boolean }>(
      sql`select email, email_verified from users where id = ${me.userId}`,
    );
    expect(after).toMatchObject({ email: newEmail, email_verified: true });
  });

  test("an address another account uses answers the same and mails nothing", async () => {
    const me = await signUpAndSignIn(api);
    const other = await signUpAndSignIn(api);
    const before = (await subjectsTo(me.email)).length;
    const r = await me.client.call("POST", "/api/auth/change-email", { newEmail: other.email });
    expect(r.status).toBe(200);
    await Bun.sleep(1_500);
    expect((await subjectsTo(me.email)).length).toBe(before);
  });
});

describe("new sign-in mail", () => {
  test("a new device mails newSignIn with the sessions anchor; the same device does not", async () => {
    const me = await signUpAndSignIn(api);
    const firefox = new Jar();
    const first = await browserCall(firefox, FIREFOX_LINUX, "POST", "/api/auth/sign-in/email", {
      email: me.email,
      password: me.password,
    });
    expect(first.status).toBe(200);
    const mail = await waitFor(async () => {
      const m = await mailTo(me.email);
      return m && m.text.includes("#sessions") ? m : null;
    }, MAIL_WAIT_MS);
    expect(mail.text).toContain(new URL(SESSIONS_SETTINGS_PATH, `${api.deps.site.publicUrl}/`).toString());
    expect(mail.text).toContain("Firefox · Linux");
    expect(mail.text).not.toContain("rv:140.0");

    const count = (await subjectsTo(me.email)).length;
    const again = await browserCall(new Jar(), FIREFOX_LINUX, "POST", "/api/auth/sign-in/email", {
      email: me.email,
      password: me.password,
    });
    expect(again.status).toBe(200);
    await Bun.sleep(1_500);
    expect((await subjectsTo(me.email)).length).toBe(count);
  });
});

describe("two-step sign-in", () => {
  test("enable with a code, then a sign-in needs the code; the password step sends no mail", async () => {
    const me = await signUpAndSignIn(api);
    const enable = await me.client.call<{ totpURI: string; backupCodes: string[] }>(
      "POST",
      "/api/auth/two-factor/enable",
      { password: me.password },
    );
    expect(enable.status).toBe(200);
    expect(enable.body.backupCodes).toHaveLength(10);
    const secret = new URL(enable.body.totpURI).searchParams.get("secret") ?? "";
    const on = await me.client.call("POST", "/api/auth/two-factor/verify-totp", { code: totp(secret) });
    expect(on.status).toBe(200);
    const meNow = await me.client.call<{ twoFactorEnabled: boolean }>("GET", "/api/me");
    expect(meNow.body.twoFactorEnabled).toBe(true);
    // The "two-step sign-in is on" notice, linking the security page.
    const notice = await waitFor(async () => {
      const m = await mailTo(me.email);
      return m && /two-step sign-in is on/i.test(m.subject) ? m : null;
    }, MAIL_WAIT_MS);
    expect(notice.text).toContain(`${api.deps.site.publicUrl}/settings/security`);

    const phone = new Jar();
    const before = (await subjectsTo(me.email)).length;
    const password = await browserCall(phone, SAFARI_IPHONE, "POST", "/api/auth/sign-in/email", {
      email: me.email,
      password: me.password,
    });
    expect(password.body).toMatchObject({ twoFactorRedirect: true });
    // Not signed in yet: the password step's session is gone.
    expect((await browserCall(phone, SAFARI_IPHONE, "GET", "/api/me")).status).not.toBe(200);
    const wrong = await browserCall(phone, SAFARI_IPHONE, "POST", "/api/auth/two-factor/verify-totp", {
      code: "000000" === totp(secret) ? "111111" : "000000",
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const code = await browserCall(phone, SAFARI_IPHONE, "POST", "/api/auth/two-factor/verify-totp", {
      code: totp(secret),
    });
    expect(code.status).toBe(200);
    expect((await browserCall(phone, SAFARI_IPHONE, "GET", "/api/me")).status).toBe(200);
    // One new-device mail, for the code step's session only.
    await waitFor(async () => ((await subjectsTo(me.email)).length === before + 1 ? true : null), MAIL_WAIT_MS);
    await Bun.sleep(1_000);
    expect((await subjectsTo(me.email)).length).toBe(before + 1);
  });
});
