// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { HoldUsageError, parseHoldArgs } from "../src/holds/cli.ts";

const ID = "0192f0c4-7d2a-7c3e-9a1b-2c3d4e5f6a7b";

describe("parseHoldArgs", () => {
  test("help", () => {
    expect(parseHoldArgs([])).toBeNull();
    expect(parseHoldArgs(["--help"])).toBeNull();
  });
  test("list", () => {
    expect(parseHoldArgs(["list"])).toEqual({ kind: "list" });
    expect(() => parseHoldArgs(["list", "x"])).toThrow(HoldUsageError);
  });
  test("release needs a uuid and a reason", () => {
    expect(parseHoldArgs(["release", ID, "--reason", "preservation", "over"])).toEqual({
      kind: "release",
      id: ID,
      reason: "preservation over",
    });
    expect(() => parseHoldArgs(["release", "nope", "--reason", "x"])).toThrow(/uuid/);
    expect(() => parseHoldArgs(["release", ID])).toThrow(/--reason/);
    expect(() => parseHoldArgs(["release", ID, "--reason", "  "])).toThrow(/--reason/);
    expect(() => parseHoldArgs(["release", ID, "--reason", "x".repeat(2001)])).toThrow(/2000/);
  });
  test("unknown command", () => {
    expect(() => parseHoldArgs(["delete", ID])).toThrow(/unknown command/);
  });
});
