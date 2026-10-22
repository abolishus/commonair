// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { errorMessage, redactUrlSecrets } from "../src/redact.ts";

describe("redactUrlSecrets", () => {
  test("overlay tokens and presigned-link credentials are replaced, the rest kept", () => {
    const text =
      'page.goto: net::ERR at http://localhost:3100/overlay/alerts?token=abc_DEF-123 and http://localhost:3900/b/k.zip?X-Amz-Algorithm=AWS4&X-Amz-Credential=GK1%2F2026&X-Amz-Signature=deadbeef "x"';
    const out = redactUrlSecrets(text);
    expect(out).not.toMatch(/abc_DEF-123|GK1|deadbeef/);
    expect(out).toContain("?token=REDACTED");
    expect(out).toContain("X-Amz-Algorithm=AWS4");
    expect(out).toContain('X-Amz-Signature=REDACTED "x"');
  });

  test("errorMessage redacts Error and non-Error values", () => {
    expect(errorMessage(new Error("GET /overlay/state?token=s3cr3t failed"))).toBe(
      "GET /overlay/state?token=REDACTED failed",
    );
    expect(errorMessage("x?access_token=t")).toBe("x?access_token=REDACTED");
  });
});
