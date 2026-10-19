// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { instanceSite, loadEnv, coreEnv } from "@commonair/config/env";
import { MemoryMailer } from "@commonair/email";
import { appUrl, mailboxOf, publicLink, recipientLimitedMailer, sendNotice } from "../src/mail.ts";
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
