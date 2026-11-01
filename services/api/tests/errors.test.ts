// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `notImplemented()` keeps answering 501 once no route uses it (batch 6 built the last stubs), so a
 * later unit's stub still maps to NOT_IMPLEMENTED rather than a 500.
 */
import { ORPCError } from "@orpc/server";
import { describe, expect, test } from "vite-plus/test";
import { notImplemented, toClientError } from "../src/lib/errors.ts";

describe("notImplemented", () => {
  test("throws NOT_IMPLEMENTED with status 501, and the client sees the same", () => {
    let thrown: unknown;
    try {
      notImplemented();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ORPCError);
    const e = thrown as ORPCError<string, unknown>;
    expect(e.code).toBe("NOT_IMPLEMENTED");
    expect(e.status).toBe(501);
    const client = toClientError(e);
    expect(client.code).toBe("NOT_IMPLEMENTED");
    expect(client.status).toBe(501);
  });
});
