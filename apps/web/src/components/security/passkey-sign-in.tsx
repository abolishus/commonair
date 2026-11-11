// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** "Sign in with a passkey" on the sign-in form (D7.2): only where the browser can use one. */
import { Button } from "@commonair/ui/components/button";
import { FingerPrintIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { FormError } from "../form-error.tsx";
import { isCancelled, usePasskeysSupported, signInWithPasskey } from "./webauthn.ts";

export function PasskeySignIn({ onSignedIn }: { onSignedIn: () => Promise<void> | void }): React.JSX.Element | null {
  // Known only in the browser: absent from the server render, shown after mount where it works.
  const supported = usePasskeysSupported();
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  if (!supported) return null;

  const go = async () => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    try {
      await signInWithPasskey();
      await onSignedIn();
    } catch (err) {
      if (!isCancelled(err)) setFailed(true);
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="lg"
        data-testid="signin-passkey"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => void go()}
      >
        <HugeiconsIcon icon={FingerPrintIcon} strokeWidth={2} aria-hidden data-icon="inline-start" />
        {t("d7Security.signin.passkey")}
      </Button>
      {failed && <FormError>{t("d7Security.signin.passkeyFailed")}</FormError>}
    </>
  );
}
