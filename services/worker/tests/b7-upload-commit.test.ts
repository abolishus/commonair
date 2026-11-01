// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The worker's client for `INTERNAL_ROUTES.uploadCommit` (decision (p)), against a fake API. */
import { INTERNAL_ROUTES, INTERNAL_SECRET_HEADER } from "@commonair/contracts/internal";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { commitUpload, UploadCommitError, uploadCommitOptions } from "../src/b7/upload-commit.ts";

const SECRET = "test-internal-secret-0123456789abcdef";
type Seen = { path: string; secret: string | null; body: unknown };
const seen: Seen[] = [];
let reply: (body: Record<string, unknown>) => Response = () => Response.json({ ok: true, key: "k", url: "u" });
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      seen.push({ path: new URL(req.url).pathname, secret: req.headers.get(INTERNAL_SECRET_HEADER), body });
      return reply(body);
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/`;
});
afterAll(async () => {
  await server.stop(true);
});

const body = {
  channelId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  key: "incoming/abc/emote.png",
  purpose: "emote" as const,
};

describe("commitUpload", () => {
  test("posts the body with the internal secret and returns the published key", async () => {
    seen.length = 0;
    reply = () => Response.json({ ok: true, key: "emotes/x.png", url: "https://cdn.test/emotes/x.png" });
    const r = await commitUpload(body, { baseUrl, secret: SECRET });
    expect(r).toEqual({ ok: true, key: "emotes/x.png", url: "https://cdn.test/emotes/x.png" });
    expect(seen).toEqual([{ path: INTERNAL_ROUTES.uploadCommit, secret: SECRET, body }]);
  });

  test("a refusal is a result, not an error", async () => {
    reply = () => Response.json({ ok: false, code: "upload_rejected" });
    expect(await commitUpload(body, { baseUrl, secret: SECRET })).toEqual({ ok: false, code: "upload_rejected" });
  });

  test("an error status, a malformed answer or an unreachable API throws", async () => {
    reply = () => Response.json({ error: "unauthorized" }, { status: 401 });
    await expect(commitUpload(body, { baseUrl, secret: "wrong" })).rejects.toMatchObject({
      name: "UploadCommitError",
      status: 401,
    });
    reply = () => Response.json({ ok: true });
    await expect(commitUpload(body, { baseUrl, secret: SECRET })).rejects.toBeInstanceOf(UploadCommitError);
    await expect(
      commitUpload(body, { baseUrl: "http://127.0.0.1:9", secret: SECRET, timeoutMs: 2_000 }),
    ).rejects.toMatchObject({ status: null });
  });

  test("an invalid body never leaves the worker", async () => {
    seen.length = 0;
    await expect(commitUpload({ ...body, purpose: "avatar" as never }, { baseUrl, secret: SECRET })).rejects.toThrow(
      /purpose|invalid/i,
    );
    expect(seen).toEqual([]);
  });

  test("options come from API_INTERNAL_URL and INTERNAL_API_SECRET", () => {
    expect(uploadCommitOptions({ API_INTERNAL_URL: "http://api:3001", INTERNAL_API_SECRET: SECRET })).toEqual({
      baseUrl: "http://api:3001",
      secret: SECRET,
    });
    expect(() => uploadCommitOptions({ API_INTERNAL_URL: "http://api:3001" })).toThrow(/INTERNAL_API_SECRET/);
  });
});
