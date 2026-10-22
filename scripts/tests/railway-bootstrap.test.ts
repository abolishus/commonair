// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { evidenceOpenEnv, evidenceSealEnv } from "../../packages/config/src/env.ts";
import { evidenceKeyPair, evidenceS3Settings, s3Settings } from "../railway-bootstrap.ts";

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

describe("railway-bootstrap evidence", () => {
  const main = s3Settings({
    endpoint: "https://storage.example.invalid",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    bucketName: "media-abc",
  });

  test("maps the evidence bucket's own key and name", () => {
    expect(
      evidenceS3Settings(
        {
          endpoint: "https://storage.example.invalid",
          accessKeyId: "EAK",
          secretAccessKey: "ESK",
          bucketName: "evidence-xyz",
        },
        main,
      ),
    ).toEqual({
      S3_EVIDENCE_ACCESS_KEY_ID: "EAK",
      S3_EVIDENCE_SECRET_ACCESS_KEY: "ESK",
      S3_BUCKET_EVIDENCE: "evidence-xyz",
    });
  });

  test("refuses an evidence bucket the shared endpoint settings cannot reach", () => {
    const creds = { accessKeyId: "EAK", secretAccessKey: "ESK", bucketName: "e" };
    expect(() => evidenceS3Settings({ ...creds, endpoint: "https://other.example.invalid" }, main)).toThrow(/differs/);
    expect(() =>
      evidenceS3Settings({ ...creds, endpoint: "https://storage.example.invalid", region: "eu" }, main),
    ).toThrow(/differs/);
    expect(() =>
      evidenceS3Settings({ ...creds, endpoint: "https://storage.example.invalid", urlStyle: "path" }, main),
    ).toThrow(/differs/);
  });

  test("generates a keypair the env schemas accept", async () => {
    const pair = await evidenceKeyPair(undefined, undefined);
    expect(evidenceSealEnv.parse(pair).EVIDENCE_PUBLIC_KEY).toBe(pair.EVIDENCE_PUBLIC_KEY);
    expect(evidenceOpenEnv.parse(pair).EVIDENCE_PRIVATE_KEY).toBe(pair.EVIDENCE_PRIVATE_KEY);
  });

  test("reuses both halves and refuses a lone half", async () => {
    expect(await evidenceKeyPair("pub", "priv")).toEqual({ EVIDENCE_PUBLIC_KEY: "pub", EVIDENCE_PRIVATE_KEY: "priv" });
    await expect(evidenceKeyPair("pub", undefined)).rejects.toThrow(/one half/);
    await expect(evidenceKeyPair(undefined, "priv")).rejects.toThrow(/one half/);
  });
});
