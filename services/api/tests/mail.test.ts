// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { instanceSite, loadEnv, coreEnv } from "@commonair/config/env";
import { MemoryMailer } from "@commonair/email";
import { appUrl, publicLink, sendNotice } from "../src/mail.ts";
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
