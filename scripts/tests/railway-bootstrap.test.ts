// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { s3Settings } from "../railway-bootstrap.ts";

describe("railway-bootstrap s3Settings", () => {
  test("maps camelCase credentials and points every bucket setting at the one bucket", () => {
    const s = s3Settings({
      endpoint: "https://storage.example.invalid",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      bucketName: "media-abc",
      region: "auto",
      urlStyle: "virtual-hosted",
    });
    expect(s).toEqual({
      S3_ENDPOINT: "https://storage.example.invalid",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: "AK",
      S3_SECRET_ACCESS_KEY: "SK",
      S3_FORCE_PATH_STYLE: "false",
      S3_BUCKET_MEDIA: "media-abc",
      S3_BUCKET_EXPORTS: "media-abc",
      S3_BUCKET_BACKUPS: "media-abc",
    });
  });

  test("accepts env-style keys, path-style addressing and a missing region", () => {
    const s = s3Settings({
      AWS_ENDPOINT_URL: "https://s3.example.invalid",
      AWS_ACCESS_KEY_ID: "AK",
      AWS_SECRET_ACCESS_KEY: "SK",
      BUCKET: "b",
      FORCE_PATH_STYLE: true,
    });
    expect(s.S3_ENDPOINT).toBe("https://s3.example.invalid");
    expect(s.S3_FORCE_PATH_STYLE).toBe("true");
    expect(s.S3_REGION).toBe("auto");
    expect(s.S3_BUCKET_MEDIA).toBe("b");
  });

  test("refuses credentials it cannot recognize, naming only the keys", () => {
    expect(() => s3Settings({ endpoint: "https://x.invalid", token: "secret-value" })).toThrow(
      /unrecognized bucket credentials \(keys: endpoint, token\)/,
    );
    expect(() => s3Settings({ endpoint: "https://x.invalid", token: "secret-value" })).not.toThrow(/secret-value/);
  });
});
