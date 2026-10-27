// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { trustedProxies } from "../src/env.ts";

describe("trustedProxies", () => {
  test("a bad entry is a startup error", () => {
    expect(trustedProxies(["10.0.0.0/8", "fd00::/8"])).toEqual(["10.0.0.0/8", "fd00::/8"]);
    expect(() => trustedProxies(["10.0.0.0/8", "bad"])).toThrow(/invalid CIDR/);
  });
});
