// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { toast } from "@commonair/ui/toast";
import { t } from "../i18n/index.ts";
import { errorCode } from "./api.ts";

/** A failed call whose cure is signing in again (the session expired or was revoked). */
export function isSessionExpired(err: unknown): boolean {
  return errorCode(err) === "UNAUTHORIZED";
}

/**
 * Toast for a failed user action: "sign in again" with a sign-in action when the session is
 * gone (retrying would fail the same way), otherwise `fallback`.
 */
export function toastActionError(err: unknown, fallback: string): void {
  if (isSessionExpired(err))
    toast.error(t("auth.sessionExpired"), {
      // Full load: nothing rendered for the stale session survives.
      action: { label: t("nav.signIn"), onClick: () => window.location.assign("/signin") },
    });
  else toast.error(fallback);
}
