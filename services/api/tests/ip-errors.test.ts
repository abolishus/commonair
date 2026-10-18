// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ORPCError, ValidationError } from "@orpc/server";
import { describe, expect, test } from "vite-plus/test";
import { assertSafeDetails } from "../src/events/audit.ts";
import { pgCode, toClientError } from "../src/lib/errors.ts";
import { clientIp, inCidr, parseIp } from "../src/lib/ip.ts";
import { relayUrlProblem } from "../src/routes/relays.ts";
import { checkFilterPattern } from "../src/routes/chat.ts";

describe("ip", () => {
  test("parses v4, v6 and v4-mapped v6", () => {
    expect(parseIp("1.2.3.4")?.v).toBe(4);
    expect(parseIp("::1")?.v).toBe(6);
    expect(parseIp("::ffff:10.0.0.1")).toEqual(parseIp("10.0.0.1"));
    expect(parseIp("2001:db8::1")?.v).toBe(6);
    expect(parseIp("999.1.1.1")).toBeNull();
    expect(parseIp("not-an-ip")).toBeNull();
  });
  test("cidr matching", () => {
    expect(inCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(inCidr("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(inCidr("2001:db8::5", "2001:db8::/32")).toBe(true);
    expect(inCidr("10.1.2.3", "2001:db8::/32")).toBe(false);
    expect(inCidr("10.1.2.3", "10.1.2.3")).toBe(true);
  });
  test("X-Forwarded-For is trusted only from trusted proxies", () => {
    const trusted = ["10.0.0.0/8"];
    expect(clientIp("203.0.113.9", "1.1.1.1", trusted)).toBe("203.0.113.9");
    expect(clientIp("10.0.0.2", "198.51.100.7", trusted)).toBe("198.51.100.7");
    // Spoofed leftmost entries are skipped: the first untrusted hop from the right wins.
    expect(clientIp("10.0.0.2", "6.6.6.6, 198.51.100.7, 10.0.0.3", trusted)).toBe("198.51.100.7");
    expect(clientIp("10.0.0.2", "garbage", trusted)).toBe("10.0.0.2");
    expect(clientIp("10.0.0.2", null, trusted)).toBe("10.0.0.2");
  });
});

describe("error mapping", () => {
  test("validation errors become BAD_REQUEST with issues", () => {
    const err = new ORPCError("BAD_REQUEST", {
      cause: new ValidationError({ message: "x", issues: [{ message: "too short", path: ["name"] }] }),
    });
    const mapped = toClientError(err);
    expect(mapped.code).toBe("BAD_REQUEST");
    expect(mapped.data).toEqual({ issues: [{ path: ["name"], message: "too short" }] });
  });
  test("unique violations become CONFLICT; other errors hide details", () => {
    const pg = Object.assign(new Error("duplicate key value violates unique constraint \"users_username_uq\""), {
      code: "23505",
    });
    const wrapped = new Error("Failed query: insert into users ...", { cause: pg });
    expect(pgCode(wrapped)).toBe("23505");
    expect(toClientError(wrapped).code).toBe("CONFLICT");
    expect(toClientError(wrapped).message).not.toContain("users");
    const internal = toClientError(new Error("select * from secrets"));
    expect(internal.code).toBe("INTERNAL_SERVER_ERROR");
    expect(internal.message).not.toContain("secrets");
  });
});

test("audit details refuse personal data and free text", () => {
  expect(() => assertSafeDetails({ id: "0192e3a4-0000-7000-8000-000000000000", n: 3, role: "moderator" })).not.toThrow();
  expect(() => assertSafeDetails({ email: "someone@example.invalid" })).toThrow();
  expect(() => assertSafeDetails({ note: "x".repeat(100) })).toThrow();
});

test("relay URLs: no credentials; public https in production", () => {
  expect(relayUrlProblem("https://relay.example.invalid", true)).toBeNull();
  expect(relayUrlProblem("http://relay.example.invalid", true)).not.toBeNull();
  expect(relayUrlProblem("http://127.0.0.1:8080", false)).toBeNull();
  expect(relayUrlProblem("https://127.0.0.1", true)).not.toBeNull();
  expect(relayUrlProblem("https://10.1.2.3", true)).not.toBeNull();
  expect(relayUrlProblem("https://user:pw@relay.example.invalid", false)).not.toBeNull();
  expect(relayUrlProblem("ftp://relay.example.invalid", false)).not.toBeNull();
});

test("word filter regexes must compile and avoid catastrophic patterns", () => {
  expect(() => checkFilterPattern("bad(word)?", true)).not.toThrow();
  expect(() => checkFilterPattern("(a+)+", true)).toThrow();
  expect(() => checkFilterPattern("(", true)).toThrow();
  expect(() => checkFilterPattern("(", false)).not.toThrow();
  expect(() => checkFilterPattern("(a)\\1", true)).toThrow();
});
