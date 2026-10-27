// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { corsFromEnv, corsXml, parseOrigins, putBucketCors, putBucketCorsRequest } from "../garage/cors.ts";

const KEYS = { S3_ACCESS_KEY_ID: "GK0123456789abcdef01234567", S3_SECRET_ACCESS_KEY: "s".repeat(64) };

describe("parseOrigins", () => {
  test("a comma-separated list of bare origins", () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins("")).toEqual([]);
    expect(parseOrigins(" http://localhost:3100 , https://dev.example.org ")).toEqual([
      "http://localhost:3100",
      "https://dev.example.org",
    ]);
  });

  test.each(["localhost:3000", "http://localhost:3000/", "http://localhost:3000/app", "ftp://x.example.org", "*"])(
    "%s is refused",
    (o) => {
      expect(() => parseOrigins(o)).toThrow("is not an origin");
    },
  );
});

test("the rule allows presigned PUT, GET and HEAD from each origin", () => {
  const xml = corsXml(["http://localhost:3100", "http://localhost:3000"]);
  expect(xml).toContain(
    "<AllowedOrigin>http://localhost:3100</AllowedOrigin><AllowedOrigin>http://localhost:3000</AllowedOrigin>",
  );
  for (const m of ["PUT", "GET", "HEAD"]) expect(xml).toContain(`<AllowedMethod>${m}</AllowedMethod>`);
  expect(xml).toContain("<AllowedHeader>*</AllowedHeader>");
});

describe("corsFromEnv", () => {
  test("nothing without GARAGE_CORS_ORIGINS (self-host installs never set it)", () => {
    expect(corsFromEnv(KEYS)).toBeNull();
    expect(corsFromEnv({ ...KEYS, GARAGE_CORS_ORIGINS: "" })).toBeNull();
  });

  test("defaults: Garage on the compose network, region garage, the media bucket", () => {
    expect(corsFromEnv({ ...KEYS, GARAGE_CORS_ORIGINS: "http://localhost:3100" })).toEqual({
      endpoint: "http://garage:3900",
      region: "garage",
      accessKeyId: KEYS.S3_ACCESS_KEY_ID,
      secretAccessKey: KEYS.S3_SECRET_ACCESS_KEY,
      bucket: "commonair-media",
      origins: ["http://localhost:3100"],
    });
  });

  test("the main key is required", () => {
    expect(() => corsFromEnv({ GARAGE_CORS_ORIGINS: "http://localhost:3100" })).toThrow(
      "S3_ACCESS_KEY_ID is required with GARAGE_CORS_ORIGINS",
    );
  });
});

describe("putBucketCorsRequest", () => {
  const input = {
    endpoint: "http://garage:3900",
    region: "garage",
    accessKeyId: KEYS.S3_ACCESS_KEY_ID,
    secretAccessKey: KEYS.S3_SECRET_ACCESS_KEY,
    bucket: "commonair-media",
    origins: ["http://localhost:3100"],
    now: new Date("2026-10-27T03:55:36.123Z"),
  };

  test("a path-style PUT ?cors signed with SigV4 for the bucket's region", async () => {
    const req = putBucketCorsRequest(input);
    expect(req.method).toBe("PUT");
    expect(req.url).toBe("http://garage:3900/commonair-media?cors");
    expect(req.headers.get("x-amz-date")).toBe("20261027T035536Z");
    expect(req.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=GK0123456789abcdef01234567\/20261027\/garage\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    const body = await req.text();
    expect(body).toBe(corsXml(input.origins));
    expect(req.headers.get("x-amz-content-sha256")).toBe(new Bun.CryptoHasher("sha256").update(body).digest("hex"));
  });

  test("the signature depends on the secret and the time, and is stable for both", () => {
    const sig = (i: typeof input) => putBucketCorsRequest(i).headers.get("authorization")?.split("Signature=")[1];
    expect(sig(input)).toBe(sig(input));
    expect(sig({ ...input, secretAccessKey: "t".repeat(64) })).not.toBe(sig(input));
    expect(sig({ ...input, now: new Date("2026-10-27T03:55:37Z") })).not.toBe(sig(input));
  });

  test("a refusal from the store is an error naming the bucket", async () => {
    const refuse = (async () => new Response("AccessDenied", { status: 403 })) as unknown as typeof fetch;
    await expect(putBucketCors(input, refuse)).rejects.toThrow(
      "PutBucketCors on commonair-media: HTTP 403 AccessDenied",
    );
  });
});
