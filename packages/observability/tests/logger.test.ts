// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import { createLogger } from "../src/logger.ts";

test("writes JSON lines, filters by level, redacts secrets and PII", () => {
  const lines: string[] = [];
  const log = createLogger({ service: "t", level: "info", write: (l) => lines.push(l) });
  log.debug("hidden");
  log.info("hello", { userId: "u1", email: "a@b.c", nested: { streamKey: "live_x", ok: 1 } });
  log.child({ req: "r1" }).warn("child", { password: "p" });
  expect(lines).toHaveLength(2);
  const a = JSON.parse(lines[0]!);
  expect(a).toMatchObject({
    level: "info",
    msg: "hello",
    service: "t",
    userId: "u1",
    email: "[redacted]",
    nested: { streamKey: "[redacted]", ok: 1 },
  });
  expect(JSON.parse(lines[1]!)).toMatchObject({ req: "r1", password: "[redacted]", level: "warn" });
});

test("serializes errors", () => {
  const lines: string[] = [];
  createLogger({ service: "t", write: (l) => lines.push(l) }).error("boom", {
    err: new Error("bad"),
  });
  expect(JSON.parse(lines[0]!).err).toMatchObject({ name: "Error", message: "bad" });
});
