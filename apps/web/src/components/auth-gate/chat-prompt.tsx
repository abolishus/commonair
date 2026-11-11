// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed-out chat input (`chat-signin-prompt`'s content): one control that reads like the
 * composer ("Create an account to chat · Free") and opens the sign-up prompt above it
 * (`intent=chat`). It replaces "Sign in to chat", which offered no account (voice-copy §2.4).
 */
import { Button } from "@commonair/ui/components/button";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { AuthGatePrompt, type GateChannel } from "./auth-gate-prompt.tsx";

export function ChatSignUpPrompt({ channel }: { channel?: GateChannel | null }): React.JSX.Element {
  return (
    <AuthGatePrompt
      intent="chat"
      channel={channel}
      side="top"
      trigger={
        <Button
          data-testid="chat-signup-open"
          type="button"
          variant="outline"
          className="h-9 w-full min-w-0 justify-between text-sm font-normal text-muted-foreground"
        />
      }
    >
      <span className="truncate">{t("d2Gate.chat.prompt")}</span>
      <span className="text-xs">{t("d2Gate.chat.free")}</span>
    </AuthGatePrompt>
  );
}

/**
 * The signed-out prediction card's hint: "Join the prediction", opening the sign-up prompt
 * (`intent=predict`), which says predictions use channel points, never money.
 */
export function PredictionSignUpPrompt({ channel }: { channel?: GateChannel | null }): React.JSX.Element {
  return (
    <AuthGatePrompt
      intent="predict"
      channel={channel}
      trigger={<Button data-testid="chat-prediction-signup" type="button" variant="outline" size="sm" />}
    >
      {t("d2Gate.predict.title")}
    </AuthGatePrompt>
  );
}
