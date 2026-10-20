// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  ALL_ENV_SCHEMAS,
  EnvError,
  coreEnv,
  evidenceOpenEnv,
  evidenceSealEnv,
  instanceSite,
  loadEnv,
  moderationEnv,
  paymentsEnv,
} from "../src/env.ts";
import { SITE, sourceLink } from "../src/site.ts";

const examplePath = fileURLToPath(new URL("../../../.env.example", import.meta.url));

function exampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const line of readFileSync(examplePath, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m?.[1]) keys.add(m[1]);
  }
  return keys;
}

describe("env", () => {
  test(".env.example documents every variable in every schema, and nothing else", () => {
    const schemaKeys = new Set(Object.values(ALL_ENV_SCHEMAS).flatMap((s) => Object.keys(s.shape)));
    const documented = exampleKeys();
    expect([...schemaKeys].filter((k) => !documented.has(k))).toEqual([]);
    expect([...documented].filter((k) => !schemaKeys.has(k))).toEqual([]);
  });

  test("empty strings fall back to defaults", () => {
    const env = loadEnv(coreEnv, { INSTANCE_NAME: "", PUBLIC_URL: "" });
    expect(env.INSTANCE_NAME).toBe(SITE.name);
    expect(env.PUBLIC_URL).toBe("http://localhost:3000");
  });

  test("reports every invalid variable at once", () => {
    const run = () => loadEnv(coreEnv, { NODE_ENV: "staging", PUBLIC_URL: "not a url" });
    expect(run).toThrow(EnvError);
    const issues = (() => {
      try {
        run();
        return [];
      } catch (e) {
        return (e as EnvError).issues;
      }
    })();
    expect(issues.map((i) => String(i.path[0])).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "NODE_ENV",
      "PUBLIC_URL",
    ]);
  });

  test("moderation config fails closed and cannot switch the pipeline off", () => {
    const d = loadEnv(moderationEnv, {});
    expect(d).toMatchObject({
      MODERATION_SAMPLE_SECONDS: 10,
      MODERATION_CLASSIFIER: "onnx",
      MODERATION_TEST_HOOKS: false,
    });
    expect(Object.keys(moderationEnv.shape).some((k) => /ENABLED|DISABLE|OFF/.test(k))).toBe(false);
    for (const v of ["0", "1", "61", "abc"])
      expect(() => loadEnv(moderationEnv, { MODERATION_SAMPLE_SECONDS: v })).toThrow(EnvError);
    expect(loadEnv(moderationEnv, { MODERATION_SAMPLE_SECONDS: "2" }).MODERATION_SAMPLE_SECONDS).toBe(2);
    expect(() => loadEnv(moderationEnv, { MODERATION_CLASSIFIER: "none" })).toThrow(EnvError);
    expect(() => loadEnv(moderationEnv, { MODERATION_CLASSIFIER: "scripted" })).toThrow(/MODERATION_TEST_HOOKS/);
    expect(
      loadEnv(moderationEnv, { MODERATION_CLASSIFIER: "scripted", MODERATION_TEST_HOOKS: "true" })
        .MODERATION_CLASSIFIER,
    ).toBe("scripted");
  });

  test("evidence keys must be a real X25519 keypair encoding", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as {
      publicKey: CryptoKey;
      privateKey: CryptoKey;
    };
    const pub = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
    const priv = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
    expect(loadEnv(evidenceSealEnv, { EVIDENCE_PUBLIC_KEY: pub }).EVIDENCE_PUBLIC_KEY).toBe(pub);
    expect(loadEnv(evidenceOpenEnv, { EVIDENCE_PRIVATE_KEY: priv }).EVIDENCE_PRIVATE_KEY).toBe(priv);
    expect(() => loadEnv(evidenceSealEnv, {})).toThrow(EnvError);
    expect(() => loadEnv(evidenceSealEnv, { EVIDENCE_PUBLIC_KEY: priv })).toThrow(EnvError);
    expect(() => loadEnv(evidenceSealEnv, { EVIDENCE_PUBLIC_KEY: "not base64!" })).toThrow(EnvError);
    expect(() => loadEnv(evidenceOpenEnv, { EVIDENCE_PRIVATE_KEY: pub })).toThrow(EnvError);
    const ed = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as {
      publicKey: CryptoKey;
      privateKey: CryptoKey;
    };
    const edPriv = Buffer.from(await crypto.subtle.exportKey("pkcs8", ed.privateKey)).toString("base64");
    expect(() => loadEnv(evidenceOpenEnv, { EVIDENCE_PRIVATE_KEY: edPriv })).toThrow(EnvError);
  });

  test("refuses live Stripe keys", () => {
    expect(() => loadEnv(paymentsEnv, { STRIPE_SECRET_KEY: "sk_live_abc" })).toThrow(EnvError);
    expect(loadEnv(paymentsEnv, { STRIPE_SECRET_KEY: "sk_test_abc" }).STRIPE_SECRET_KEY).toBe("sk_test_abc");
    expect(loadEnv(paymentsEnv, {}).PAYMENTS_PROVIDER).toBe("manual");
  });

  test("instanceSite applies contact overrides and strips trailing slashes", () => {
    const site = instanceSite(
      loadEnv(coreEnv, {
        PUBLIC_URL: "https://stream.example.org/",
        CONTACT_EMAIL: "hi@example.org",
      }),
    );
    expect(site.publicUrl).toBe("https://stream.example.org");
    expect(site.contacts.general).toBe("hi@example.org");
    expect(site.contacts.security).toBe(SITE.contacts.security);
  });

  test("non-flagship production instances must set their own contacts", () => {
    expect(() => loadEnv(coreEnv, { NODE_ENV: "production" })).toThrow(/SECURITY_EMAIL/);
    expect(() => loadEnv(coreEnv, { NODE_ENV: "production", INSTANCE_IS_FLAGSHIP: "true" })).not.toThrow();
    const contacts = {
      CONTACT_EMAIL: "a@x.test",
      SECURITY_EMAIL: "b@x.test",
      ABUSE_EMAIL: "c@x.test",
      DMCA_EMAIL: "d@x.test",
      PRIVACY_EMAIL: "e@x.test",
    };
    expect(() => loadEnv(coreEnv, { NODE_ENV: "production", ...contacts })).not.toThrow();
  });

  test("noreply defaults to the instance's own host unless flagship or overridden", () => {
    expect(instanceSite(loadEnv(coreEnv, { PUBLIC_URL: "https://air.example.org" })).contacts.noreply).toBe(
      "noreply@air.example.org",
    );
    expect(instanceSite(loadEnv(coreEnv, { INSTANCE_IS_FLAGSHIP: "true" })).contacts.noreply).toBe(
      SITE.contacts.noreply,
    );
    expect(instanceSite(loadEnv(coreEnv, { NOREPLY_EMAIL: "bot@x.test" })).contacts.noreply).toBe("bot@x.test");
  });

  test("sourceLink points at the exact commit", () => {
    expect(sourceLink({ sourceUrl: SITE.repository.url, sourceCommit: "abc123" })).toBe(
      `${SITE.repository.url}/tree/abc123`,
    );
    expect(sourceLink({ sourceUrl: `${SITE.repository.url}/`, sourceCommit: "unknown" })).toBe(SITE.repository.url);
  });
});
