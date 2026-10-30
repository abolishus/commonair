// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The RFC 8058 one-click route (N1, ADR 0028) is a raw route ahead of the oRPC handler: GET and
 * POST reach `emailUnsubscribe` (GET 303, POST applies), with no session, origin or CORS involved.
 */
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { EMAIL_UNSUBSCRIBE_PATH } from "@commonair/contracts/notify";
import { startApi, type TestApi } from "./harness.ts";

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api?.stop();
});

test.each(["GET", "POST"])("%s reaches the one-click handler, not the oRPC handler", async (method) => {
  const res = await fetch(`${api.url}${EMAIL_UNSUBSCRIBE_PATH}?list=go_live&token=v1.x.y`, {
    method,
    redirect: "manual",
    ...(method === "POST"
      ? {
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://mail.example" },
          body: "List-Unsubscribe=One-Click",
        }
      : {}),
  });
  // GET redirects to the confirm page; this POST's token is forged.
  expect(res.status).toBe(method === "GET" ? 303 : 400);
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
});

test("a neighbouring path still goes to the oRPC handler", async () => {
  const res = await fetch(`${api.url}${EMAIL_UNSUBSCRIBE_PATH}/other`);
  expect(res.status).toBe(404);
});
