// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { instanceSite, loadEnv, coreEnv } from "@commonair/config/env";
import { MemoryMailer } from "@commonair/email";
import {
  appUrl,
  isTransientMailError,
  mailboxOf,
  publicLink,
  recipientLimitedMailer,
  retryingMailer,
  sendNotice,
} from "../src/mail.ts";
import type { Mailer } from "@commonair/email";
import { memoryRateLimitStore } from "../src/lib/ratelimit.ts";
import { createLogger } from "@commonair/observability";

const site = instanceSite(loadEnv(coreEnv, { PUBLIC_URL: "https://air.example.invalid" }));

test("better-auth links are re-homed onto the public origin with path and query intact", () => {
  expect(publicLink(site, "http://localhost:3001/api/auth/verify-email?token=abc&callbackURL=%2F")).toBe(
    "https://air.example.invalid/api/auth/verify-email?token=abc&callbackURL=%2F",
  );
  expect(publicLink(site, "http://api.internal:3001/api/auth/x#frag")).toBe("https://air.example.invalid/api/auth/x");
  expect(appUrl(site, "/settings/security")).toBe("https://air.example.invalid/settings/security");
});

test("re-homed links pass the email package's link policy", async () => {
  const mailer = new MemoryMailer({ site });
  await mailer.send(
    "verifyEmail",
    {
      displayName: "A",
      verifyUrl: publicLink(site, "http://localhost:3001/api/auth/verify-email?token=t"),
      expiresInMinutes: 60,
    },
    "a@test.invalid",
  );
  expect(mailer.to("a@test.invalid")[0]?.text).toContain("https://air.example.invalid/api/auth/verify-email?token=t");
});

test("notice failures are logged, not thrown", async () => {
  const lines: string[] = [];
  await sendNotice(createLogger({ service: "t", write: (l) => lines.push(l) }), "x", async () => {
    throw new Error("smtp down");
  });
  expect(lines.join("")).toContain("mail send failed");
});

test("mail is capped per recipient; over the cap it is dropped silently", async () => {
  const inner = new MemoryMailer({ site });
  const warnings: unknown[] = [];
  const store = memoryRateLimitStore();
  let now = 1_000_000;
  const logger = createLogger({ service: "t", write: () => {} });
  const mailer = recipientLimitedMailer(inner, {
    secret: "s".repeat(32),
    store: () => store,
    rule: () => ({ max: 2, windowMs: 60_000 }),
    now: () => new Date(now),
    logger: { ...logger, warn: (...a: unknown[]) => void warnings.push(a) } as typeof logger,
  });
  const send = (to: string) =>
    mailer.send("magicLink", { signInUrl: "https://air.example.invalid/x", expiresInMinutes: 10 }, to);
  await send("victim@test.invalid");
  await send("VICTIM@test.invalid"); // same mailbox, different spelling
  expect(await send("victim@test.invalid")).toBe("");
  await send("other@test.invalid");
  expect(inner.sent.map((m) => m.to.trim().toLowerCase())).toEqual([
    "victim@test.invalid",
    "victim@test.invalid",
    "other@test.invalid",
  ]);
  expect(warnings).toHaveLength(1);
  expect(JSON.stringify(warnings)).not.toContain("victim");
  now += 60_001;
  await send("victim@test.invalid");
  expect(inner.sent).toHaveLength(4);
});

test("mailboxOf folds tags, case and Gmail dots", () => {
  expect(mailboxOf(" Victim+promo@Example.Test ")).toBe("victim@example.test");
  expect(mailboxOf("v.i.c.t.i.m+x@googlemail.com")).toBe("victim@gmail.com");
  expect(mailboxOf("V.ictim@GMAIL.com")).toBe("victim@gmail.com");
  // Dots matter elsewhere.
  expect(mailboxOf("first.last@example.test")).toBe("first.last@example.test");
  expect(mailboxOf("+only@example.test")).toBe("+only@example.test");
  expect(mailboxOf("not-an-address")).toBe("not-an-address");
});

test("the cap is per mailbox and per template", async () => {
  const inner = new MemoryMailer({ site });
  const store = memoryRateLimitStore();
  const mailer = recipientLimitedMailer(inner, {
    secret: "s".repeat(32),
    store: () => store,
    rule: () => ({ max: 2, windowMs: 60_000 }),
    now: () => new Date(0),
    logger: createLogger({ service: "t", write: () => {} }),
  });
  const magic = (to: string) =>
    mailer.send("magicLink", { signInUrl: "https://air.example.invalid/x", expiresInMinutes: 10 }, to);
  await magic("victim+1@gmail.com");
  await magic("v.ictim+2@googlemail.com");
  expect(await magic("VICTIM@gmail.com")).toBe(""); // same mailbox: capped
  expect(inner.sent).toHaveLength(2);
  // A flood of magic links does not block the password reset.
  await mailer.send(
    "passwordReset",
    { resetUrl: "https://air.example.invalid/reset", expiresInMinutes: 60 },
    "victim@gmail.com",
  );
  expect(inner.sent).toHaveLength(3);
});

/** Fails with the given errors in turn, then delivers to `inner`. */
function flaky(inner: Mailer, errors: unknown[]): Mailer & { calls: number } {
  const m = {
    calls: 0,
    async send(...args: Parameters<Mailer["send"]>) {
      m.calls++;
      const err = errors.shift();
      if (err !== undefined) throw err;
      return inner.send(...args);
    },
    close: () => inner.close(),
  };
  return m as Mailer & { calls: number };
}
const smtpError = (fields: Record<string, unknown>) => Object.assign(new Error("smtp"), fields);
const quietLogger = () => createLogger({ service: "t", write: () => {} });
const verify = (mailer: Mailer) =>
  mailer.send(
    "verifyEmail",
    { displayName: "A", verifyUrl: "https://air.example.invalid/api/auth/verify-email?token=t", expiresInMinutes: 60 },
    "new@test.invalid",
  );

test("only failures before the server accepted anything are transient", () => {
  expect(isTransientMailError(smtpError({ code: "EDNS", command: "CONN" }))).toBe(true);
  expect(isTransientMailError(smtpError({ code: "ETIMEDOUT", command: "CONN" }))).toBe(true);
  expect(isTransientMailError(smtpError({ code: "EENVELOPE", responseCode: 451 }))).toBe(true);
  expect(isTransientMailError(smtpError({ code: "EENVELOPE", responseCode: 550 }))).toBe(false);
  expect(isTransientMailError(smtpError({ code: "EAUTH", command: "AUTH PLAIN", responseCode: 535 }))).toBe(false);
  // A socket dropped after DATA may already have delivered: sending again could duplicate.
  expect(isTransientMailError(smtpError({ code: "ESOCKET", command: "DATA" }))).toBe(false);
  expect(isTransientMailError(new Error("plain"))).toBe(false);
  expect(isTransientMailError(undefined)).toBe(false);
  expect(isTransientMailError("EDNS")).toBe(false);
});

test("a transient failure is retried after each delay until the mail goes out", async () => {
  const inner = new MemoryMailer({ site });
  const dns = smtpError({ code: "EDNS", command: "CONN" });
  const mailer = flaky(inner, [dns, dns]);
  const slept: number[] = [];
  const lines: string[] = [];
  const retrying = retryingMailer(mailer, {
    logger: createLogger({ service: "t", write: (l) => lines.push(l) }),
    delaysMs: [5, 7, 9],
    sleep: async (ms) => void slept.push(ms),
  });
  expect(await verify(retrying)).toMatch(/^<.+>$/);
  expect(mailer.calls).toBe(3);
  expect(slept).toEqual([5, 7]);
  expect(inner.to("new@test.invalid")).toHaveLength(1);
  expect(lines.join("")).toContain("mail send failed; retrying");
  expect(lines.join("")).not.toContain("new@test.invalid");
});

test("retries stop when the delays run out, with the last error", async () => {
  const errors = [1, 2, 3].map((n) => smtpError({ code: "EDNS", command: "CONN", n }));
  const mailer = flaky(new MemoryMailer({ site }), [...errors]);
  const retrying = retryingMailer(mailer, { logger: quietLogger(), delaysMs: [1, 1], sleep: async () => {} });
  await expect(verify(retrying)).rejects.toBe(errors[2]);
  expect(mailer.calls).toBe(3);
});

test("a permanent failure is not retried", async () => {
  const rejected = smtpError({ code: "EENVELOPE", responseCode: 550 });
  const mailer = flaky(new MemoryMailer({ site }), [rejected]);
  const slept: number[] = [];
  const retrying = retryingMailer(mailer, {
    logger: quietLogger(),
    delaysMs: [1, 1],
    sleep: async (ms) => void slept.push(ms),
  });
  await expect(verify(retrying)).rejects.toBe(rejected);
  expect(mailer.calls).toBe(1);
  expect(slept).toEqual([]);
});

test("with no delays the retrying mailer sends once", async () => {
  const dns = smtpError({ code: "EDNS", command: "CONN" });
  const mailer = flaky(new MemoryMailer({ site }), [dns]);
  await expect(verify(retryingMailer(mailer, { logger: quietLogger(), delaysMs: [] }))).rejects.toBe(dns);
  expect(mailer.calls).toBe(1);
});
