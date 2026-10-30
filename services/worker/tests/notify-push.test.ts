// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Web push send outcomes and the `Topic` header (ADR 0028 decision 6). Pure parts only. */
import { describe, expect, test } from "vite-plus/test";
import { classifyPushResult, pushTopic } from "../src/notify/push/send.ts";
import type { PostResult } from "../src/webhooks/http.ts";

const answer = (status: number): PostResult => ({
  ok: true,
  status,
  body: "",
  latencyMs: 1,
  truncated: false,
  headers: {},
});
const failure = (error: string, rejected: boolean): PostResult => ({ ok: false, error, latencyMs: 1, rejected });

describe("classifyPushResult", () => {
  test.each([
    [201, "success"],
    [202, "success"],
    [200, "success"],
    [404, "expired"],
    [410, "expired"],
    [413, "too_large"],
    [429, "retry"],
    [500, "retry"],
    [502, "retry"],
    [503, "retry"],
    [400, "refused"],
    [401, "refused"],
    [403, "refused"],
    [301, "refused"],
  ] as const)("HTTP %i → %s", (status, verdict) => {
    expect(classifyPushResult(answer(status))).toBe(verdict);
  });

  test("network errors and timeouts retry", () => {
    expect(classifyPushResult(failure("ECONNREFUSED: connect", false))).toBe("retry");
    expect(classifyPushResult(failure("timeout after 10000 ms", false))).toBe("retry");
  });

  test("an address the guard refuses for good is unsendable; a failed lookup may work later", () => {
    expect(classifyPushResult(failure("address is private", true))).toBe("unsendable");
    expect(classifyPushResult(failure("scheme must be https", true))).toBe("unsendable");
    expect(classifyPushResult(failure("credentials in URL", true))).toBe("unsendable");
    expect(classifyPushResult(failure("host does not resolve", true))).toBe("retry");
    expect(classifyPushResult(failure("callback resolution failed", true))).toBe("retry");
  });
});

describe("pushTopic", () => {
  test("22 base64url characters, stable per channel, different across channels", async () => {
    const a = await pushTopic("0192f0a0-0000-7000-8000-000000000001");
    const b = await pushTopic("0192f0a0-0000-7000-8000-000000000002");
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await pushTopic("0192f0a0-0000-7000-8000-000000000001")).toBe(a);
    expect(b).not.toBe(a);
  });
});
