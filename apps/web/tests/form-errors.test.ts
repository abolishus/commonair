// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sign-up and sign-in errors in the visitor's language, by the API's error code. */
import { describe, expect, it } from "vite-plus/test";
import { en } from "../src/i18n/en.ts";
import { AuthRequestError } from "../src/lib/auth.ts";
import { authErrorMessage } from "../src/lib/form-errors.ts";

const authError = (code: string | null, status = 400) => new AuthRequestError(status, code, "x");

describe("authErrorMessage", () => {
  it("a reserved name is its own message, not the format hint", () => {
    expect(authErrorMessage(authError("USERNAME_RESERVED"))).toBe(en["error.usernameReserved"]);
    expect(authErrorMessage(authError("INVALID_USERNAME"))).toBe(en["error.invalidUsername"]);
    expect(en["error.usernameReserved"]).not.toBe(en["error.invalidUsername"]);
  });

  it("a taken name, and a rate limit by code or by status", () => {
    expect(authErrorMessage(authError("USERNAME_IS_ALREADY_TAKEN"))).toBe(en["error.usernameTaken"]);
    expect(authErrorMessage(authError("RATE_LIMITED", 429))).toBe(en["error.rateLimited"]);
    expect(authErrorMessage(authError(null, 429))).toBe(en["error.rateLimited"]);
  });

  it("anything else is the generic message", () => {
    expect(authErrorMessage(authError("SOMETHING_NEW"))).toBe(en["error.generic"]);
    expect(authErrorMessage(new Error("x"))).toBe(en["error.generic"]);
  });
});
