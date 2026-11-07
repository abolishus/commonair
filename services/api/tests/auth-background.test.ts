// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { createLogger } from "@commonair/observability";
import { authBackground } from "../src/auth/background.ts";

function collecting() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({ service: "t", write: (l) => lines.push(JSON.parse(l) as Record<string, unknown>) });
  return { lines, logger };
}

test("handler tracks a task until it settles and drain waits for it", async () => {
  const { logger } = collecting();
  const bg = authBackground(logger);
  const task = Promise.withResolvers<void>();
  bg.handler(task.promise);
  expect(bg.pending()).toBe(1);
  let drained = false;
  const draining = bg.drain().then(() => (drained = true));
  await Promise.resolve();
  expect(drained).toBe(false);
  task.resolve();
  await draining;
  expect(drained).toBe(true);
  expect(bg.pending()).toBe(0);
});

test("drain with nothing pending resolves at once", async () => {
  const bg = authBackground(collecting().logger);
  await bg.drain();
  expect(bg.pending()).toBe(0);
});

test("a rejected task is logged by error name and code only, and leaves the set", async () => {
  const { lines, logger } = collecting();
  const bg = authBackground(logger);
  bg.handler(Promise.reject(Object.assign(new TypeError("for a@test.invalid"), { code: "EX" })));
  bg.handler(Promise.reject("a@test.invalid"));
  await bg.drain();
  expect(bg.pending()).toBe(0);
  const failed = lines.filter((l) => l.msg === "auth background task failed");
  expect(failed).toHaveLength(2);
  expect(failed[0]).toMatchObject({ err: "TypeError", code: "EX" });
  expect(failed[1]).toMatchObject({ err: "string" });
  expect(JSON.stringify(lines)).not.toContain("a@test.invalid");
});

test("mail returns before the send settles and tracks it until it does", async () => {
  const { lines, logger } = collecting();
  const bg = authBackground(logger);
  const gate = Promise.withResolvers<void>();
  let started = 0;
  expect(
    bg.mail("verifyEmail", () => {
      started++;
      return gate.promise;
    }),
  ).toBeUndefined();
  expect(bg.pending()).toBe(1);
  await Promise.resolve();
  expect(started).toBe(1);
  gate.resolve();
  await bg.drain();
  expect(bg.pending()).toBe(0);
  expect(lines).toHaveLength(0);
});

test("a failed mail is logged with the template and SMTP codes only, never the address", async () => {
  const { lines, logger } = collecting();
  const bg = authBackground(logger);
  const smtp = Object.assign(new Error("550 <who@test.invalid> rejected"), {
    code: "EENVELOPE",
    command: "RCPT TO",
    responseCode: 550,
  });
  bg.mail("passwordReset", async () => {
    throw smtp;
  });
  // A send that throws before returning a promise is caught the same way.
  bg.mail("magicLink", () => {
    throw null;
  });
  await bg.drain();
  expect(bg.pending()).toBe(0);
  const byTemplate = (t: string) => lines.find((l) => l.template === t);
  expect(lines).toHaveLength(2);
  expect(byTemplate("passwordReset")).toMatchObject({
    msg: "auth mail failed",
    err: "Error",
    code: "EENVELOPE",
    command: "RCPT TO",
    responseCode: 550,
  });
  expect(byTemplate("magicLink")).toMatchObject({ msg: "auth mail failed", err: "object" });
  expect(JSON.stringify(lines)).not.toContain("who@test.invalid");
});
