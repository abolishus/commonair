// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `notifications` push receiver (harness/src/n1/push-receiver.ts). */
import { afterAll, describe, expect, test } from "vite-plus/test";
import { startPushReceiver } from "../../src/n1/push-receiver.ts";

const receiver = startPushReceiver({ webhookHost: "host.containers.internal" });
afterAll(() => receiver.close());
const local = (id: string) => `http://127.0.0.1:${receiver.port}/push/${id}`;

describe("push receiver", () => {
  test("endpoints are what the worker container reaches", () => {
    expect(receiver.origin).toBe(`http://host.containers.internal:${receiver.port}`);
    expect(receiver.endpoint("sub-1")).toBe(`${receiver.origin}/push/sub-1`);
    expect(() => receiver.endpoint("a/b")).toThrow("bad id");
  });

  test("records raw bytes and lower-case headers, answering 201 by default", async () => {
    const body = new Uint8Array([0, 1, 2, 250, 255]);
    const res = await fetch(local("a"), {
      method: "POST",
      headers: { "Content-Encoding": "aes128gcm", TTL: "60", Urgency: "normal" },
      body,
    });
    expect(res.status).toBe(201);
    const got = await receiver.waitFor((r) => r.id === "a", 1_000);
    expect([...got.body]).toEqual([...body]);
    expect(got.headers["content-encoding"]).toBe("aes128gcm");
    expect(got.headers.ttl).toBe("60");
    expect(got.status).toBe(201);
  });

  test("answers the status set for an id, after recording the body", async () => {
    receiver.setStatus("gone", 410);
    const waiting = receiver.waitFor((r) => r.id === "gone", 1_000);
    const res = await fetch(local("gone"), { method: "POST", body: new Uint8Array([7]) });
    expect(res.status).toBe(410);
    const got = await waiting;
    expect([...got.body]).toEqual([7]);
    expect(got.status).toBe(410);
    // Other ids keep the default.
    expect((await fetch(local("other"), { method: "POST", body: "x" })).status).toBe(201);
  });

  test("anything but POST /push/<id> is 404 and not recorded", async () => {
    const before = receiver.requests.length;
    expect((await fetch(local("a"))).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${receiver.port}/hook`, { method: "POST", body: "x" })).status).toBe(404);
    expect(receiver.requests.length).toBe(before);
  });

  test("waitFor times out", async () => {
    await expect(receiver.waitFor((r) => r.id === "never", 50)).rejects.toThrow("no matching request within 50 ms");
  });
});
