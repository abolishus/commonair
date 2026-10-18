// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { uuidv7, uuidv7Time } from "../src/ids.ts";

describe("uuidv7", () => {
  test("is a valid v7 UUID with RFC 9562 variant", () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  test("encodes the timestamp and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(uuidv7Time(a)).toBe(1_700_000_000_000);
    expect(a < b).toBe(true);
  });
});
