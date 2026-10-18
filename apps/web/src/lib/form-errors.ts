// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { t, type MessageKey } from "../i18n/index.ts";
import { AuthRequestError } from "./auth.ts";

/** better-auth / signup-gate error codes we can explain in the user's language. */
const AUTH_ERRORS: Record<string, MessageKey> = {
  ALTCHA_FAILED: "error.altcha",
  INVALID_USERNAME: "error.invalidUsername",
  TOO_YOUNG: "error.tooYoung",
  INVALID_BIRTH_DATE: "error.invalidBirthDate",
  LEGAL_ACCEPTANCE_REQUIRED: "error.legalRequired",
  USER_ALREADY_EXISTS: "error.userExists",
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "error.userExists",
  USERNAME_IS_ALREADY_TAKEN: "error.usernameTaken",
  USERNAME_IS_ALREADY_TAKEN_PLEASE_TRY_ANOTHER: "error.usernameTaken",
  INVALID_EMAIL: "error.invalidEmail",
  PASSWORD_TOO_SHORT: "error.passwordTooShort",
  PASSWORD_TOO_LONG: "error.passwordTooLong",
  INVALID_EMAIL_OR_PASSWORD: "error.invalidCredentials",
  EMAIL_NOT_VERIFIED: "error.emailNotVerified",
  RATE_LIMITED: "error.rateLimited",
};

export function authErrorMessage(err: unknown): string {
  if (err instanceof AuthRequestError) {
    const key = err.code ? AUTH_ERRORS[err.code] : undefined;
    if (key) return t(key);
    if (err.status === 429) return t("error.rateLimited");
  }
  return t("error.generic");
}
