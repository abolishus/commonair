// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The origin entry point's env and its refusal to start half-configured. */
import { describe, expect, test } from "vite-plus/test";
import { EnvError } from "@commonair/config";
import { loadOriginEnv, serveOrigin } from "../src/main.ts";

const required = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:1/db",
  VALKEY_URL: "redis://127.0.0.1:1",
  INTERNAL_API_SECRET: "i".repeat(32),
  MEDIA_INTERNAL_PASSWORD: "m".repeat(32),
  PLAYBACK_SIGNING_KEY: "k",
  S3_ENDPOINT: "http://127.0.0.1:1",
  S3_ACCESS_KEY_ID: "a",
  S3_SECRET_ACCESS_KEY: "s",
};

describe("loadOriginEnv", () => {
  test("the origin's defaults: port 3003, 512 MB cache, 2 h DVR cap, no CDN, issuance on", () => {
    const env = loadOriginEnv(required);
    expect(env).toMatchObject({
      ORIGIN_PORT: 3003,
      ORIGIN_CACHE_MB: 512,
      DVR_MAX_WINDOW_SECONDS: 7200,
      CDN_PROVIDER: "none",
      ORIGIN_ISSUANCE_ENABLED: true,
      MEDIAMTX_HLS_URL: "http://localhost:8888",
      S3_BUCKET_MEDIA: "commonair-media",
      TRUSTED_PROXY_CIDRS: [],
    });
  });

  test("blank values fall back to defaults; settings are parsed", () => {
    const env = loadOriginEnv({
      ...required,
      ORIGIN_PORT: "4100",
      DVR_MAX_WINDOW_SECONDS: "0",
      TRUSTED_PROXY_CIDRS: "10.89.0.0/16,fd00::/8",
      ORIGIN_CACHE_MB: "",
    });
    expect(env).toMatchObject({
      ORIGIN_PORT: 4100,
      DVR_MAX_WINDOW_SECONDS: 0,
      TRUSTED_PROXY_CIDRS: ["10.89.0.0/16", "fd00::/8"],
      ORIGIN_CACHE_MB: 512,
    });
  });

  test.each([
    ["no signing key", { PLAYBACK_SIGNING_KEY: undefined }],
    ["no database", { DATABASE_URL: undefined }],
    ["no S3 credentials", { S3_ACCESS_KEY_ID: undefined }],
    ["a ':' in the media password", { MEDIA_INTERNAL_PASSWORD: `${"m".repeat(31)}:` }],
    ["DVR cap above a day", { DVR_MAX_WINDOW_SECONDS: "86401" }],
    ["a privileged port", { ORIGIN_PORT: "80" }],
  ])("refuses %s", (_name, over) => {
    expect(() => loadOriginEnv({ ...required, ...over })).toThrow(EnvError);
  });
});

test("CDN_PROVIDER=origin-pull without CDN_BASE_URL refuses to start, before connecting anything", async () => {
  const env = loadOriginEnv({ ...required, CDN_PROVIDER: "origin-pull" });
  await expect(serveOrigin(env)).rejects.toThrow("CDN_PROVIDER=origin-pull requires CDN_BASE_URL");
});
