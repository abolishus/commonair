// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { S3Error, createS3Storage } from "../src/index.ts";

function fake(handler: (req: Request) => Response) {
  const calls: Request[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    calls.push(req);
    return handler(req);
  }) as typeof fetch;
  return { calls, f };
}

const base = {
  endpoint: "http://garage:3900",
  region: "garage",
  accessKeyId: "GK0123",
  secretAccessKey: "s".repeat(64),
  forcePathStyle: true,
};

describe("S3 storage", () => {
  test("signs path-style requests with SigV4", async () => {
    const { calls, f } = fake(() => new Response(null, { status: 200 }));
    const s = createS3Storage({ ...base, fetch: f });
    await s.put("media", "vods/a b.m3u8", "x", { contentType: "application/vnd.apple.mpegurl" });
    expect(calls[0]!.url).toBe("http://garage:3900/media/vods/a%20b.m3u8");
    expect(calls[0]!.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=GK0123\/\d{8}\/garage\/s3\/aws4_request/,
    );
  });

  test("returns null on 404 and maps S3 errors", async () => {
    const { f } = fake((req) =>
      req.url.includes("missing")
        ? new Response("", { status: 404 })
        : new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 }),
    );
    const s = createS3Storage({ ...base, fetch: f });
    expect(await s.get("media", "missing")).toBeNull();
    expect(await s.head("media", "missing")).toBeNull();
    await expect(s.put("media", "x", "y")).rejects.toThrow(S3Error);
    await expect(s.put("media", "x", "y")).rejects.toMatchObject({
      code: "AccessDenied",
      status: 403,
    });
  });

  test("lists across continuation pages", async () => {
    let page = 0;
    const { f } = fake(() => {
      page++;
      const body =
        page === 1
          ? "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken><Contents><Key>a&amp;b</Key><Size>3</Size><ETag>&quot;e1&quot;</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>"
          : "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>c</Key><Size>5</Size><ETag>&quot;e2&quot;</ETag><LastModified>2026-01-01T00:00:00Z</LastModified></Contents></ListBucketResult>";
      return new Response(body);
    });
    const s = createS3Storage({ ...base, fetch: f });
    const keys: string[] = [];
    for await (const o of s.list("media", "")) keys.push(`${o.key}:${o.size}:${o.etag}`);
    expect(keys).toEqual(['a&b:3:"e1"', 'c:5:"e2"']);
  });

  test("presigns against the public endpoint", async () => {
    const s = createS3Storage({ ...base, publicEndpoint: "https://s3.example.invalid" });
    const u = new URL(
      await s.presignGet("exports", "u/1.zip", {
        expiresSeconds: 600,
        filename: 'my "export".zip',
      }),
    );
    expect(u.origin).toBe("https://s3.example.invalid");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.searchParams.get("response-content-disposition")).toBe('attachment; filename="my _export_.zip"');
  });
});
