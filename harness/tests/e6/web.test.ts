// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** E6 web helpers that run without a browser: the /rpc filter and the secret-safe navigation. */
import type { Page } from "playwright";
import { describe, expect, test } from "vite-plus/test";
import { gotoSecretUrl, isRpcUrl } from "../../src/e6/web.ts";

describe("isRpcUrl", () => {
  test("the API's /rpc endpoint, proxied or not", () => {
    expect(isRpcUrl("http://localhost:4000/rpc/stream/simulcast/create")).toBe(true);
    expect(isRpcUrl("http://localhost:3000/api/rpc/stream/simulcast/list")).toBe(true);
    expect(isRpcUrl("http://localhost:3000/rpc")).toBe(true);
    expect(isRpcUrl("http://localhost:3000/dashboard")).toBe(false);
    expect(isRpcUrl("http://localhost:3000/rpcx/a")).toBe(false);
    expect(isRpcUrl("nope")).toBe(false);
  });
});

describe("gotoSecretUrl", () => {
  test("a failed navigation is rethrown without the URL or its token", async () => {
    const url = "http://localhost:3000/overlay/alerts?token=ovl_secret_value_123";
    const failing = () => {
      const err = new Error(`page.goto: Timeout 30000ms exceeded. navigating to "${url}"`);
      err.name = "TimeoutError";
      return Promise.reject(err);
    };
    const err = await gotoSecretUrl(failing, "the overlay page").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("the overlay page did not load (TimeoutError)");
    expect((err as Error).message).not.toContain("ovl_secret_value_123");
  });

  test("a successful navigation returns the page", async () => {
    const page = {} as Page;
    expect(await gotoSecretUrl(() => Promise.resolve(page), "x")).toBe(page);
  });
});
