// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** better-auth's security error codes in the member's language; anything else as the auth forms say it. */
import { t, type MessageKey } from "../../i18n/index.ts";
import { AuthRequestError } from "../../lib/auth.ts";
import { authErrorMessage } from "../../lib/form-errors.ts";

const SECURITY_ERRORS: Record<string, MessageKey> = {
  INVALID_PASSWORD: "d7Security.error.password",
  INVALID_CODE: "d7Security.error.code",
  INVALID_BACKUP_CODE: "d7Security.error.backupCode",
  TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: "d7Security.error.locked",
  ACCOUNT_TEMPORARILY_LOCKED: "d7Security.error.locked",
  SESSION_NOT_FRESH: "d7Security.error.notFresh",
  INVALID_TWO_FACTOR_COOKIE: "d7Security.error.expiredStep",
};

export function securityErrorMessage(err: unknown): string {
  if (err instanceof AuthRequestError && err.code) {
    const key = SECURITY_ERRORS[err.code];
    if (key) return t(key);
  }
  return authErrorMessage(err);
}
