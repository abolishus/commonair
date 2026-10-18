// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { instanceSite, loadEnv, coreEnv } from "@commonair/config/env";
import { MemoryMailer } from "@commonair/email";
import { appUrl, publicLink, recipientLimitedMailer, sendNotice } from "../src/mail.ts";
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
