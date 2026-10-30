// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Step 2's pure helpers (harness/src/n1/email.ts): reading List-Unsubscribe and matching the go-live mail. */
import { describe, expect, test } from "vite-plus/test";
import { headerValues, linksChannel, oneClickTarget, oneClickUrl, step } from "../../src/n1/email.ts";

const URL_ONE = "http://localhost:3000/api/email/unsubscribe?list=go_live&token=v1.abc.def";

describe("oneClickUrl", () => {
  test("reads the one-click URL from Mailpit's headers, whatever the header case", () => {
    expect(oneClickUrl({ "List-Unsubscribe": [`<${URL_ONE}>`] })?.toString()).toBe(URL_ONE);
    expect(oneClickUrl({ "list-unsubscribe": [` <${URL_ONE}> `] })?.searchParams.get("token")).toBe("v1.abc.def");
  });
  test.each([
    ["missing", {}],
    ["two values", { "List-Unsubscribe": [`<${URL_ONE}>`, `<${URL_ONE}>`] }],
    ["a mailto as well", { "List-Unsubscribe": [`<mailto:u@example.test>, <${URL_ONE}>`] }],
    ["no angle brackets", { "List-Unsubscribe": [URL_ONE] }],
    [
      "another path",
      { "List-Unsubscribe": ["<http://localhost:3000/settings/notifications/unsubscribe?list=go_live&token=x>"] },
    ],
    ["no token", { "List-Unsubscribe": ["<http://localhost:3000/api/email/unsubscribe?list=go_live>"] }],
    ["no list", { "List-Unsubscribe": ["<http://localhost:3000/api/email/unsubscribe?token=x>"] }],
  ])("refuses %s", (_name, headers: Record<string, string[]>) => {
    expect(oneClickUrl(headers)).toBeNull();
  });
  test("headerValues is case-insensitive and keeps every value", () => {
    expect(
      headerValues({ "List-Unsubscribe-Post": ["a"], "list-unsubscribe-post": ["b"] }, "LIST-UNSUBSCRIBE-POST"),
    ).toEqual(["a", "b"]);
  });
});

describe("linksChannel", () => {
  const mail = (html: string, text = "") => ({ html, text });
  test("matches a link to exactly /<slug>", () => {
    expect(linksChannel(mail('<a href="http://localhost:3000/ada_plays">Ada</a>'), "ada_plays")).toBe(true);
    expect(linksChannel(mail("", "Ada http://localhost:3000/ada_plays: title"), "ada_plays")).toBe(true);
  });
  test("does not match another channel or a longer path", () => {
    expect(linksChannel(mail('<a href="http://localhost:3000/ada_plays2">x</a>'), "ada_plays")).toBe(false);
    expect(linksChannel(mail('<a href="http://localhost:3000/ada_plays/clips">x</a>'), "ada_plays")).toBe(false);
    expect(linksChannel(mail('<a href="http://localhost:3000/settings/notifications">x</a>'), "ada_plays")).toBe(false);
  });
});

test("oneClickTarget keeps the path and query on the API the harness reaches", () => {
  expect(oneClickTarget(new URL(URL_ONE), "http://localhost:4000").toString()).toBe(
    "http://localhost:4000/api/email/unsubscribe?list=go_live&token=v1.abc.def",
  );
});

test("the step module: N1-email's step 2, after step 1", () => {
  expect(step).toMatchObject({ name: "email", owner: "N1-email", needs: [1] });
  expect(step.webOnly).toBeUndefined();
});
