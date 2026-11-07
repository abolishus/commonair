// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The integration helpers' failure diagnostics: what a timed-out wait reports. */
import { expect, test } from "vite-plus/test";
import { eventually, recordingLogger } from "./helpers.ts";

test("eventually returns the first truthy value", async () => {
  let n = 0;
  expect(await eventually(() => (++n >= 3 ? n : 0), 1_000)).toBe(3);
});

test("a timed-out wait reports elapsed time, polls and the described state", async () => {
  const err = await eventually(
    () => false,
    60,
    async () => ({ lines: 5 }),
  ).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  const message = (err as Error).message;
  expect(message).toMatch(/^condition not met in time \(\d+ ms, \d+ polls; state: \{"lines":5\}\)$/);
  const [, ms, polls] = /\((\d+) ms, (\d+) polls/.exec(message) ?? [];
  expect(Number(ms)).toBeGreaterThanOrEqual(60);
  expect(Number(polls)).toBeGreaterThanOrEqual(2);
});

test("without describe the message has no state; a throwing describe is reported, not rethrown", async () => {
  const plain = (await eventually(() => null, 0).catch((e: unknown) => e)) as Error;
  expect(plain.message).toMatch(/^condition not met in time \(\d+ ms, \d+ polls\)$/);
  const broken = (await eventually(
    () => null,
    0,
    () => {
      throw new Error("valkey down");
    },
  ).catch((e: unknown) => e)) as Error;
  expect(broken.message).toMatch(/; describe failed: Error: valkey down\)$/);
});

test("recordingLogger keeps warn and above, parsed, and at most 200 entries", () => {
  const { logger, entries } = recordingLogger("chat-test");
  logger.info("ignored");
  logger.debug("ignored");
  logger.warn("held", { channelId: "c1" });
  logger.error("hook failed");
  expect(entries.map((e) => [e.level, e.msg])).toEqual([
    ["warn", "held"],
    ["error", "hook failed"],
  ]);
  expect(entries[0]).toMatchObject({ service: "chat-test", channelId: "c1" });
  for (let i = 0; i < 250; i++) logger.warn(`w${i}`);
  expect(entries).toHaveLength(200);
  expect(entries.at(-1)?.msg).toBe("w249");
  expect(entries[0]?.msg).toBe("w50");
});
