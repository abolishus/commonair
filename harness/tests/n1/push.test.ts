// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 4's pure checks (N1-push): the push headers and the decrypted payload's shape. */
import { describe, expect, test } from "vite-plus/test";
import { parseGoLivePush, pushHeaderProblems, step } from "../../src/n1/push.ts";

const te = new TextEncoder();

describe("step 4 module", () => {
  test("is N1-push's, needs no other step and requires webPush", () => {
    expect(step.owner).toBe("N1-push");
    expect(step.needs).toEqual([]);
    expect(step.requires).toEqual(["webPush"]);
    expect(step.webOnly).toBeUndefined();
  });
});

describe("pushHeaderProblems", () => {
  const ok = {
    "content-encoding": "aes128gcm",
    ttl: "3600",
    urgency: "normal",
    topic: "AbCdEfGhIjKlMnOpQrStUv",
    authorization: "vapid t=a.b.c, k=d",
  };

  test("none for what the worker sends", () => {
    expect(pushHeaderProblems(ok)).toEqual([]);
  });

  test("each missing or malformed header is named", () => {
    expect(pushHeaderProblems({ ...ok, "content-encoding": "aesgcm" })).toHaveLength(1);
    const { ttl: _ttl, ...noTtl } = ok;
    expect(pushHeaderProblems(noTtl)[0]).toMatch(/TTL/);
    expect(pushHeaderProblems({ ...ok, ttl: "0" })[0]).toMatch(/TTL/);
    expect(pushHeaderProblems({ ...ok, authorization: "WebPush abc" })[0]).toMatch(/vapid/);
    expect(pushHeaderProblems({ ...ok, urgency: "urgent" })[0]).toMatch(/Urgency/);
    expect(pushHeaderProblems({ ...ok, topic: "has space" })[0]).toMatch(/Topic/);
    expect(pushHeaderProblems({})).toHaveLength(3);
  });
});

describe("parseGoLivePush", () => {
  const enc = (v: unknown) => te.encode(JSON.stringify(v));

  test("exactly the contract's PushPayload", () => {
    expect(parseGoLivePush(enc({ v: 1, type: "go_live", slug: "abc", title: "" }))).toEqual({
      v: 1,
      type: "go_live",
      slug: "abc",
      title: "",
    });
  });

  test("refuses extra fields (nothing else may reach the vendor), other versions and bad JSON", () => {
    expect(() => parseGoLivePush(enc({ v: 1, type: "go_live", slug: "a", title: "t", email: "x" }))).toThrow(/exactly/);
    expect(() => parseGoLivePush(enc({ v: 2, type: "go_live", slug: "a", title: "t" }))).toThrow(/v=2/);
    expect(() => parseGoLivePush(enc({ v: 1, type: "go_live", slug: "a", title: "x".repeat(141) }))).toThrow(
      /malformed/,
    );
    expect(() => parseGoLivePush(enc([1]))).toThrow(/not an object/);
    expect(() => parseGoLivePush(te.encode("{"))).toThrow(SyntaxError);
  });
});
