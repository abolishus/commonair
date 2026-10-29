// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The interactivity test hook (`POST /internal/interact/tick`): off is 404, a bad body 400. */
import { describe, expect, test } from "vite-plus/test";
import { INTERNAL_ROUTES } from "@commonair/contracts/internal";
import { interactHealth, interactHook, isInteractHookPath } from "../src/interact/hooks.ts";
import type { Deps } from "../src/deps.ts";

const deps = (on: boolean) => ({ env: { INTERACT_TEST_HOOKS: on }, logger: { warn() {} } }) as unknown as Deps;

describe("interact test hook", () => {
  test("off: 404 whatever the request", async () => {
    expect((await interactHook(deps(false), "POST", { job: "interact-tick" })).status).toBe(404);
    expect((await interactHook(deps(false), "GET", null)).status).toBe(404);
  });

  test("on: only POST, and only a known job", async () => {
    expect((await interactHook(deps(true), "GET", null)).status).toBe(405);
    expect((await interactHook(deps(true), "POST", null)).status).toBe(400);
    expect((await interactHook(deps(true), "POST", { job: "coop-tick" })).status).toBe(400);
    expect((await interactHook(deps(true), "POST", {})).status).toBe(400);
  });

  test("path and health", () => {
    expect(isInteractHookPath(INTERNAL_ROUTES.interactTick)).toBe(true);
    expect(isInteractHookPath("/internal/coop/tick")).toBe(false);
    expect(interactHealth(deps(true))).toEqual({ interactTestHooks: true });
    expect(interactHealth(deps(false))).toEqual({ interactTestHooks: false });
  });
});
