// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "vite-plus/test";
import {
  displayPrefix,
  findLeakedKeys,
  isStreamKeySecret,
  newStreamKeySecret,
  obsStreamKey,
  redactKeys,
} from "../src/lib/streamkeys.ts";

test("new secrets are live_ + 43 base64url chars and unique", () => {
  const a = newStreamKeySecret();
  const b = newStreamKeySecret();
  expect(a).toMatch(/^live_[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(b);
  expect(isStreamKeySecret(a)).toBe(true);
  expect(displayPrefix(a)).toBe(a.slice(0, 12));
  expect(displayPrefix(a).startsWith("live_")).toBe(true);
});

test("OBS stream key is <slug>?key=<secret>", () => {
  const s = newStreamKeySecret();
  expect(obsStreamKey("alice", s)).toBe(`alice?key=${s}`);
});

test("scanner finds keys in free text, URLs and OBS form; dedupes", () => {
  const s = newStreamKeySecret();
  const t = newStreamKeySecret();
  const text = `my key is ${s}! also rtmp://host/live/alice?key=${s} and (${t})`;
  expect(findLeakedKeys(text).sort()).toEqual([s, t].sort());
});

test("scanner ignores near misses", () => {
  const s = newStreamKeySecret();
  expect(findLeakedKeys(s.slice(0, -1))).toEqual([]); // too short
  expect(findLeakedKeys(`${s}x`)).toEqual([]); // embedded in a longer token
  expect(findLeakedKeys(`x${s}`)).toEqual([]);
  expect(findLeakedKeys("live_ is a prefix, live_short too")).toEqual([]);
  expect(findLeakedKeys("")).toEqual([]);
});

test("redaction removes every key", () => {
  const s = newStreamKeySecret();
  const out = redactKeys(`a ${s} b ${s}`);
  expect(out).not.toContain(s);
  expect(findLeakedKeys(out)).toEqual([]);
});
