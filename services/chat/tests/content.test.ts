// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { containsLink } from "../src/content.ts";

describe("containsLink", () => {
  test.each([
    "https://example.com",
    "go to example.com now",
    "www.example.org",
    "sub.domain.co.uk/path?q=1",
    "ftp://files.local",
    "visit example.com.",
    "localhost.dev:8080/x",
  ])("%s is a link", (body) => expect(containsLink(body)).toBe(true));

  test.each(["hello world", "e.g. this", "version 1.5.2", "i.e.", "3.14", "wait...what", "Kappa"])(
    "%s is not a link",
    (body) => expect(containsLink(body)).toBe(false),
  );
});
