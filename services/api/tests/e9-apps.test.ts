// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E9-apps pure parts: client id and secret shapes, and DTOs that never carry the secret hash. */
import { describe, expect, test } from "vite-plus/test";
import { dto } from "@commonair/contracts";
import { sha256Hex } from "@commonair/tokens";
import {
  CLIENT_ID_ALPHABET,
  CLIENT_ID_LENGTH,
  CLIENT_SECRET_PREFIX,
  mintClientId,
  mintClientSecret,
} from "../src/developer/apps/credentials.ts";
import { toAdminOAuthApp, toOAuthApp, type OAuthAppRow } from "../src/developer/apps/dto.ts";

describe("mintClientId", () => {
  test("30 lowercase alphanumerics, different every time", () => {
    const ids = Array.from({ length: 200 }, mintClientId);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{30}$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(CLIENT_ID_LENGTH).toBe(30);
  });

  test("uses the whole alphabet", () => {
    const seen = new Set(Array.from({ length: 200 }, mintClientId).join("").split(""));
    const sorted = (xs: string[]) => xs.sort((a, b) => a.localeCompare(b)).join("");
    expect(sorted([...seen])).toBe(sorted(CLIENT_ID_ALPHABET.split("")));
  });
});

describe("mintClientSecret", () => {
  test("cas_ and 64 lowercase hex, with its sha256", async () => {
    const { secret, hash } = await mintClientSecret();
    expect(secret.startsWith(CLIENT_SECRET_PREFIX)).toBe(true);
    expect(secret).toMatch(/^cas_[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(secret));
    expect(hash).not.toContain(secret);
  });

  test("fresh each time", async () => {
    const a = await mintClientSecret();
    const b = await mintClientSecret();
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).not.toBe(b.hash);
  });
});

const HASH = "f".repeat(64);
const row = (over: Partial<OAuthAppRow> = {}): OAuthAppRow => ({
  id: "01900000-0000-7000-8000-000000000001",
  ownerId: "01900000-0000-7000-8000-000000000002",
  name: "My app",
  description: "does things",
  clientId: "a".repeat(30),
  clientSecretHash: HASH,
  redirectUris: ["https://app.example.test/cb"],
  confidential: true,
  secretRotatedAt: null,
  suspendedAt: null,
  suspendedReason: null,
  suspendedById: null,
  createdAt: new Date("2026-10-29T12:00:00.000Z"),
  ...over,
});

describe("toOAuthApp", () => {
  test("matches the contract and never carries the hash or the suspending admin", () => {
    const out = toOAuthApp(row());
    expect(dto.OAuthApp.strict().parse(out)).toEqual(out);
    const json = JSON.stringify(out);
    expect(json).not.toContain(HASH);
    expect(json).not.toContain("clientSecretHash");
    expect(json).not.toContain("ownerId");
    expect(out).toMatchObject({ confidential: true, suspended: null, secretRotatedAt: null });
  });

  test("suspension and rotation times", () => {
    const at = new Date("2026-10-29T13:00:00.000Z");
    const out = toOAuthApp(row({ suspendedAt: at, suspendedReason: "abuse", suspendedById: "x", secretRotatedAt: at }));
    expect(out.suspended).toEqual({ at: at.toISOString(), reason: "abuse" });
    expect(out.secretRotatedAt).toBe(at.toISOString());
    expect(JSON.stringify(out)).not.toContain('"x"');
  });

  test("a copy of the redirect URIs, not the row's array", () => {
    const r = row();
    const out = toOAuthApp(r);
    out.redirectUris.push("https://other.example.test/cb");
    expect(r.redirectUris).toHaveLength(1);
  });
});

describe("toAdminOAuthApp", () => {
  test("owner and counts, still no hash", () => {
    const out = toAdminOAuthApp(
      row({ confidential: false, clientSecretHash: null }),
      { id: "01900000-0000-7000-8000-000000000002", username: "dev" },
      { grants: 3, subscriptions: 1 },
    );
    expect(dto.AdminOAuthApp.strict().parse(out)).toEqual(out);
    expect(out).toMatchObject({ owner: { username: "dev" }, grants: 3, subscriptions: 1, confidential: false });
    expect(JSON.stringify(out)).not.toContain("clientSecretHash");
  });

  test("only the owner's id and username leave", () => {
    const owner = { id: "01900000-0000-7000-8000-000000000002", username: "dev", email: "dev@example.test" };
    const out = toAdminOAuthApp(row(), owner, { grants: 0, subscriptions: 0 });
    expect(out.owner).toEqual({ id: owner.id, username: "dev" });
  });
});
