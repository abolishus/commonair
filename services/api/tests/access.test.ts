// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { ProcedureMeta } from "@commonair/contracts";
import type { Scope } from "@commonair/contracts/scopes";
import { channelAuthority, decideAccess, tokenAllowed, type Caller, type CallerUser } from "../src/lib/access.ts";

const user = (over: Partial<CallerUser> = {}): CallerUser => ({
  id: "u1",
  username: "alice",
  role: "user",
  accountType: "human",
  suspended: false,
  ...over,
});
const session = (over: Partial<CallerUser> = {}): Caller => ({ kind: "session", user: user(over), sessionId: "s1" });
const token = (scopes: Scope[], over: Partial<CallerUser> = {}): Caller => ({
  kind: "token",
  user: user(over),
  tokenId: "t1",
  appId: null,
  scopes,
  expiresAt: new Date(Date.now() + 60_000),
});
const meta = (m: Partial<ProcedureMeta> & Pick<ProcedureMeta, "access">): ProcedureMeta => m;
const ownChannel = { exists: true, ownerId: "u1", callerRoles: [] };
const otherChannel = (roles: ("moderator" | "vip" | "editor")[] = []) => ({
  exists: true,
  ownerId: "u2",
  callerRoles: roles,
});

describe("token scope rule", () => {
  test("undefined scopes = session only", () => {
    expect(tokenAllowed(meta({ access: "user" }), ["chat:read"]).ok).toBe(false);
  });
  test("[] = any valid token", () => {
    expect(tokenAllowed(meta({ access: "user", scopes: [] }), []).ok).toBe(true);
  });
  test("all listed scopes required", () => {
    const m = meta({ access: "user", scopes: ["chat:read", "chat:edit"] });
    expect(tokenAllowed(m, ["chat:read"]).ok).toBe(false);
    expect(tokenAllowed(m, ["chat:edit", "chat:read", "clips:edit"]).ok).toBe(true);
  });
});

describe("decideAccess", () => {
  test("public allows anyone", () => {
    expect(decideAccess({ meta: meta({ access: "public" }), caller: null, write: true }).ok).toBe(true);
  });

  test("user requires a caller", () => {
    const d = decideAccess({ meta: meta({ access: "user" }), caller: null, write: false });
    expect(d).toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(decideAccess({ meta: meta({ access: "user" }), caller: session(), write: false }).ok).toBe(true);
  });

  test("tokens are refused on session-only procedures and need scopes elsewhere", () => {
    expect(decideAccess({ meta: meta({ access: "user" }), caller: token(["chat:read"]), write: false })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    const follows = meta({ access: "user", scopes: ["user:read:follows"] });
    expect(decideAccess({ meta: follows, caller: token(["chat:read"]), write: false }).ok).toBe(false);
    expect(decideAccess({ meta: follows, caller: token(["user:read:follows"]), write: false }).ok).toBe(true);
  });

  test("suspended users may read but not write", () => {
    const m = meta({ access: "user" });
    expect(decideAccess({ meta: m, caller: session({ suspended: true }), write: false }).ok).toBe(true);
    expect(decideAccess({ meta: m, caller: session({ suspended: true }), write: true })).toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
  });

  test("bots can only use tokens", () => {
    const m = meta({ access: "user", scopes: [] });
    expect(decideAccess({ meta: m, caller: session({ accountType: "bot" }), write: false }).ok).toBe(false);
    expect(decideAccess({ meta: m, caller: token([], { accountType: "bot" }), write: false }).ok).toBe(true);
  });

  test("owner: owner or editor; moderators are refused", () => {
    const m = meta({ access: "owner" });
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: ownChannel }).ok).toBe(true);
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: otherChannel(["editor"]) }).ok).toBe(true);
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: otherChannel(["moderator"]) }).ok).toBe(
      false,
    );
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: otherChannel() })).toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("owner/moderator on a missing channel is NOT_FOUND", () => {
    const d = decideAccess({
      meta: meta({ access: "moderator" }),
      caller: session(),
      write: false,
      channel: { exists: false, ownerId: null, callerRoles: [] },
    });
    expect(d).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  test("moderator: owner, editor or moderator; VIPs are refused", () => {
    const m = meta({ access: "moderator" });
    for (const roles of [["moderator"], ["editor"]] as const)
      expect(decideAccess({ meta: m, caller: session(), write: true, channel: otherChannel([...roles]) }).ok).toBe(
        true,
      );
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: otherChannel(["vip"]) }).ok).toBe(false);
    expect(decideAccess({ meta: m, caller: session(), write: true, channel: ownChannel }).ok).toBe(true);
  });

  test("token callers on owner procedures still need the scope", () => {
    const m = meta({ access: "owner", scopes: ["channel:manage"] });
    expect(decideAccess({ meta: m, caller: token([]), write: true, channel: ownChannel }).ok).toBe(false);
    expect(decideAccess({ meta: m, caller: token(["channel:manage"]), write: true, channel: ownChannel }).ok).toBe(
      true,
    );
  });

  test.each([
    ["admin", "admin", true],
    ["admin", "moderator", false],
    ["admin", "treasurer", false],
    ["treasurer", "treasurer", true],
    ["treasurer", "admin", false],
    ["platform-moderator", "moderator", true],
    ["platform-moderator", "admin", true],
    ["platform-moderator", "user", false],
    ["platform-moderator", "legal", false],
    ["legal", "legal", true],
    ["legal", "admin", false],
    ["legal", "moderator", false],
    ["legal", "treasurer", false],
    ["safety-staff", "moderator", true],
    ["safety-staff", "admin", true],
    ["safety-staff", "legal", true],
    ["safety-staff", "treasurer", false],
    ["safety-staff", "user", false],
    ["finance", "treasurer", true],
    ["finance", "admin", true],
    ["finance", "moderator", false],
    ["finance", "legal", false],
    ["finance", "user", false],
  ] as const)("%s procedure with role %s → %s", (access, role, ok) => {
    expect(decideAccess({ meta: meta({ access }), caller: session({ role }), write: false }).ok).toBe(ok);
  });

  test("relay and overlay need their machine credential", () => {
    for (const access of ["relay", "overlay"] as const) {
      expect(
        decideAccess({ meta: meta({ access }), caller: null, write: true, machineCredential: false }),
      ).toMatchObject({
        code: "UNAUTHORIZED",
      });
      expect(decideAccess({ meta: meta({ access }), caller: null, write: true, machineCredential: true }).ok).toBe(
        true,
      );
    }
  });
});

test("channelAuthority ranks owner > editor > moderator", () => {
  expect(channelAuthority(session(), { ownerId: "u1" }, [])).toBe("owner");
  expect(channelAuthority(session(), { ownerId: "u2" }, ["moderator", "editor"])).toBe("editor");
  expect(channelAuthority(session(), { ownerId: "u2" }, ["moderator"])).toBe("moderator");
  expect(channelAuthority(session(), { ownerId: "u2" }, ["vip"])).toBeNull();
  expect(channelAuthority(null, { ownerId: "u2" }, [])).toBeNull();
});
