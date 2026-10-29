// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import { FieldDescription } from "@commonair/ui/components/field";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { AuthRequestError, resendVerificationEmail } from "../lib/auth.ts";
import { FormError } from "./form-error.tsx";

/** How long the button stays disabled after a send, so one click cannot become a burst. */
export const RESEND_COOLDOWN_MS = 60_000;

/**
 * "Resend verification email" for a lost first mail. Every answer except a rate limit shows the
 * same confirmation, so the page never says whether the address has an account (better-auth
 * answers alike for unknown and verified addresses; a mail failure for a real one must not
 * stand out either).
 */
export function ResendVerification({
  email,
  callbackURL,
  send = resendVerificationEmail,
}: {
  email: string;
  /** Where the new link lands (a validated `returnTo`); the dashboard when absent. */
  callbackURL?: string | undefined;
  /** Tests pass a fake; the better-auth endpoint otherwise. */
  send?: (email: string, callbackURL?: string) => Promise<void>;
}): React.JSX.Element {
  const [state, setState] = React.useState<"idle" | "pending" | "sent" | "limited">("idle");
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    setState("pending");
    let next: "sent" | "limited" = "sent";
    try {
      await (callbackURL === undefined ? send(email) : send(email, callbackURL));
    } catch (err) {
      if (err instanceof AuthRequestError && err.status === 429) next = "limited";
    }
    setState(next);
    clearTimeout(timer.current);
    // After the cooldown the button comes back; the last message stays until then.
    timer.current = setTimeout(() => setState((s) => (s === next ? "idle" : s)), RESEND_COOLDOWN_MS);
  };

  const busy = state !== "idle";
  return (
    <div className="flex flex-col gap-2">
      <FieldDescription>
        {t("verify.resendHint")}{" "}
        <Button
          data-testid="resend-verification"
          type="button"
          variant="link"
          disabled={busy || email === ""}
          aria-busy={state === "pending" || undefined}
          onClick={() => void onClick()}
        >
          {t("verify.resend")}
        </Button>
      </FieldDescription>
      {/* Always mounted, so screen readers announce the confirmation when it appears. */}
      <output className="block">
        {state === "sent" && (
          <FieldDescription data-testid="resend-verification-sent">{t("verify.resent")}</FieldDescription>
        )}
      </output>
      {state === "limited" && <FormError>{t("error.rateLimited")}</FormError>}
    </div>
  );
}
