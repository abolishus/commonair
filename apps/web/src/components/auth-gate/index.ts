// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The sign-up prompt for signed-out actions and the intent confirm after sign-up (README D2.1). */
export {
  AuthGateActions,
  AuthGateDialog,
  AuthGatePanel,
  AuthGatePrompt,
  gateCopy,
  useGateChannel,
  useGateSearch,
  type AuthGateCopyProps,
  type AuthGatePromptProps,
  type GateChannel,
} from "./auth-gate-prompt.tsx";
export { ChatSignUpPrompt, PredictionSignUpPrompt } from "./chat-prompt.tsx";
export { GatedSupportButton, type GatedSupportButtonProps } from "./gated-support.tsx";
export {
  IntentConfirm,
  usePendingIntent,
  type IntentConfirmProps,
  type PendingIntentState,
} from "./intent-confirm.tsx";
export {
  CHANNEL_INTENTS,
  CONFIRMABLE_INTENTS,
  GATE_INTENTS,
  gateSearch,
  intentLanding,
  signInLeads,
  signupIntentOf,
  type GateIntent,
  type GateSearch,
} from "./intents.ts";
export {
  PENDING_INTENT_KEY,
  clearPendingIntent,
  parsePendingIntent,
  pendingMatches,
  pendingIntentFor,
  readPendingIntent,
  savePendingIntent,
  type PendingIntent,
} from "./pending-intent.ts";
