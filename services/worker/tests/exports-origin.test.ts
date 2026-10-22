// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { mailableStorageOrigin } from "../src/exports/build.ts";

describe("mailableStorageOrigin", () => {
  test("only an explicit public endpoint, https or a local development host", () => {
    expect(mailableStorageOrigin(undefined)).toBeUndefined();
    expect(mailableStorageOrigin("")).toBeUndefined();
    expect(mailableStorageOrigin("not a url")).toBeUndefined();
    expect(mailableStorageOrigin("https://s3.example.org/bucket")).toBe("https://s3.example.org");
    expect(mailableStorageOrigin("http://localhost:3900")).toBe("http://localhost:3900");
    expect(mailableStorageOrigin("http://garage.test:3900")).toBe("http://garage.test:3900");
    expect(mailableStorageOrigin("http://127.0.0.1:3900")).toBe("http://127.0.0.1:3900");
    // Cleartext to a public host would carry a bearer link to a personal-data archive.
    expect(mailableStorageOrigin("http://s3.example.org")).toBeUndefined();
    expect(mailableStorageOrigin("http://localhost.example.org")).toBeUndefined();
    expect(mailableStorageOrigin("ftp://localhost")).toBeUndefined();
  });
});
