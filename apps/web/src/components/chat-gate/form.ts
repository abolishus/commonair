// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The `/chat` form's draft, validation and `chat.updateSettings` input (ADR 0015 decisions 6, 7). Pure. */
import type { ChannelChatSettings } from "@commonair/contracts/shapes";

export const GATE_PRESETS = [0, 60, 300, 900] as const;
export const GATE_MIN_SECONDS = 60;
export const GATE_MAX_SECONDS = 3600;
export const RATIO_MIN_PERCENT = 10;
export const RATIO_MAX_PERCENT = 100;
export const COOLDOWN_MIN = 1;
export const COOLDOWN_MAX = 120;

export interface ChatGateFeatures {
  watchGate: boolean;
  surgeGuard: boolean;
}

export interface ChatGateDraft {
  seconds: string;
  exemptSubs: boolean;
  surgeEnabled: boolean;
  /** The trigger ratio as a whole percentage. */
  ratio: string;
  cooldown: string;
}

export type ChatGateField = "seconds" | "ratio" | "cooldown";
export type ChatGateErrors = Partial<Record<ChatGateField, true>>;

export function chatGateDraft(s: ChannelChatSettings): ChatGateDraft {
  return {
    seconds: String(s.minVerifiedWatchSeconds),
    exemptSubs: s.verifiedWatchExemptSubscribers,
    surgeEnabled: s.surgeGuard.enabled,
    ratio: String(Math.round(s.surgeGuard.triggerUnverifiedRatio * 100)),
    cooldown: String(s.surgeGuard.cooldownMinutes),
  };
}

/** A whole number written plainly (no sign, decimals or exponent), or null. */
function wholeNumber(v: string): number | null {
  const s = v.trim();
  return /^\d{1,6}$/.test(s) ? Number(s) : null;
}

export const validGateSeconds = (n: number | null): n is number =>
  n !== null && (n === 0 || (n >= GATE_MIN_SECONDS && n <= GATE_MAX_SECONDS));

export type ChatGateInput = Partial<
  Pick<ChannelChatSettings, "minVerifiedWatchSeconds" | "verifiedWatchExemptSubscribers" | "surgeGuard">
>;

/** The patch for the features the instance runs (the API refuses the others), or the field errors. */
export function chatGateInput(
  d: ChatGateDraft,
  features: ChatGateFeatures,
): { ok: true; input: ChatGateInput } | { ok: false; errors: ChatGateErrors } {
  const errors: ChatGateErrors = {};
  const input: ChatGateInput = {};
  if (features.watchGate) {
    const seconds = wholeNumber(d.seconds);
    if (!validGateSeconds(seconds)) errors.seconds = true;
    else {
      input.minVerifiedWatchSeconds = seconds;
      input.verifiedWatchExemptSubscribers = d.exemptSubs;
    }
  }
  if (features.surgeGuard) {
    const ratio = wholeNumber(d.ratio);
    const cooldown = wholeNumber(d.cooldown);
    if (ratio === null || ratio < RATIO_MIN_PERCENT || ratio > RATIO_MAX_PERCENT) errors.ratio = true;
    if (cooldown === null || cooldown < COOLDOWN_MIN || cooldown > COOLDOWN_MAX) errors.cooldown = true;
    if (ratio !== null && cooldown !== null && !errors.ratio && !errors.cooldown)
      input.surgeGuard = { enabled: d.surgeEnabled, triggerUnverifiedRatio: ratio / 100, cooldownMinutes: cooldown };
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, input };
}
