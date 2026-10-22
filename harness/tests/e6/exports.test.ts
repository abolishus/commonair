// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The export download helper: statuses, bodies, and network errors without the presigned URL. */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { download } from "../../src/e6/exports.ts";

describe("download", () => {
  let server: ReturnType<typeof Bun.serve>;
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).searchParams.has("X-Amz-Signature")
          ? new Response(new Uint8Array([0x50, 0x4b, 5, 6]))
          : new Response("denied", { status: 403 }),
    });
  });
  afterAll(() => server.stop(true));

  test("200 returns the body, anything else only the status", async () => {
    const ok = await download(`http://localhost:${server.port}/k.zip?X-Amz-Signature=abc`);
    expect(ok.status).toBe(200);
    expect(ok.bytes?.byteLength).toBe(4);
    expect(await download(`http://localhost:${server.port}/k.zip`)).toEqual({ status: 403, bytes: null });
  });

  test("a network error never carries the signed URL", async () => {
    const url = "http://localhost:1/exports/u/e.zip?X-Amz-Signature=deadbeefsecret";
    const err = await download(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^download failed \(/);
    expect((err as Error).message).not.toContain("deadbeefsecret");
  });
});
