// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Export cooldown and link arithmetic (ADR 0021), and the `/healthz` adapter booleans. */
import { describe, expect, test } from "vite-plus/test";
import { EXPORT_COOLDOWN_SECONDS, EXPORT_TTL_SECONDS } from "@commonair/contracts/internal";
import { downloadLinkSeconds, exportCooldownRemaining, exportFilename } from "../src/privacy/exports.ts";
import { opsHealth } from "../src/ops/hooks.ts";
import type { Deps } from "../src/deps.ts";

const now = new Date("2026-10-22T12:00:00.000Z");
const ago = (s: number) => new Date(now.getTime() - s * 1000);

describe("exportCooldownRemaining", () => {
  test("no previous export: allowed", () => {
    expect(exportCooldownRemaining(null, now)).toBe(0);
  });
  test("just requested: the whole window", () => {
    expect(exportCooldownRemaining(now, now)).toBe(EXPORT_COOLDOWN_SECONDS);
  });
  test("rounds partial seconds up so a retry at retryAfterSeconds succeeds", () => {
    expect(exportCooldownRemaining(new Date(now.getTime() - 500), now)).toBe(EXPORT_COOLDOWN_SECONDS);
    expect(exportCooldownRemaining(ago(EXPORT_COOLDOWN_SECONDS - 1), now)).toBe(1);
    expect(exportCooldownRemaining(new Date(now.getTime() - EXPORT_COOLDOWN_SECONDS * 1000 + 1), now)).toBe(1);
  });
  test("at and past the boundary: allowed", () => {
    expect(exportCooldownRemaining(ago(EXPORT_COOLDOWN_SECONDS), now)).toBe(0);
    expect(exportCooldownRemaining(ago(EXPORT_COOLDOWN_SECONDS + 3600), now)).toBe(0);
  });
  test("a clock-skewed future timestamp still waits, at most a little longer", () => {
    expect(exportCooldownRemaining(new Date(now.getTime() + 10_000), now)).toBe(EXPORT_COOLDOWN_SECONDS + 10);
  });
});

describe("downloadLinkSeconds", () => {
  test("until expires_at, rounded down so the link never outlives it", () => {
    expect(downloadLinkSeconds(new Date(now.getTime() + 3_600_999), now)).toBe(3600);
  });
  test("never more than the TTL (the SigV4 maximum)", () => {
    expect(downloadLinkSeconds(new Date(now.getTime() + (EXPORT_TTL_SECONDS + 100) * 1000), now)).toBe(
      EXPORT_TTL_SECONDS,
    );
  });
  test("expired, now, under a second, or no expiry: no link", () => {
    expect(downloadLinkSeconds(ago(1), now)).toBe(0);
    expect(downloadLinkSeconds(now, now)).toBe(0);
    expect(downloadLinkSeconds(new Date(now.getTime() + 999), now)).toBe(0);
    expect(downloadLinkSeconds(null, now)).toBe(0);
  });
});

describe("exportFilename", () => {
  test("instance name slug, kind and date", () => {
    expect(exportFilename("Common Air!", "account", now)).toBe("common-air-account-2026-10-22.zip");
    expect(exportFilename("", "channel", now)).toBe("export-channel-2026-10-22.zip");
  });
});

describe("opsHealth", () => {
  const env = (over: Record<string, unknown> = {}) =>
    ({
      env: {
        OPS_TEST_HOOKS: false,
        PAYMENTS_PROVIDER: "manual",
        CDN_PROVIDER: "none",
        WEB_PUSH_ENABLED: false,
        ...over,
      },
    }) as unknown as Pick<Deps, "env">;
  test("all false by default", () => {
    expect(opsHealth(env())).toEqual({ opsTestHooks: false, stripe: false, oauth: false, cdn: false, webPush: false });
  });
  test("each adapter flips its own boolean", () => {
    expect(opsHealth(env({ OPS_TEST_HOOKS: true })).opsTestHooks).toBe(true);
    expect(opsHealth(env({ PAYMENTS_PROVIDER: "stripe" })).stripe).toBe(true);
    expect(opsHealth(env({ OAUTH_GITHUB_CLIENT_ID: "id", OAUTH_GITHUB_CLIENT_SECRET: "s" })).oauth).toBe(true);
    // An id without its secret configures nothing.
    expect(opsHealth(env({ OAUTH_DISCORD_CLIENT_ID: "id" })).oauth).toBe(false);
    expect(opsHealth(env({ CDN_PROVIDER: "origin-pull", CDN_BASE_URL: "https://cdn.test.invalid" })).cdn).toBe(true);
    expect(opsHealth(env({ CDN_PROVIDER: "origin-pull" })).cdn).toBe(false);
    expect(opsHealth(env({ WEB_PUSH_ENABLED: true })).webPush).toBe(true);
  });
});
