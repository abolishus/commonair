// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The scripted classifier (test hooks only). The ONNX default is in `./onnx` (native addon). */
import { MODERATION_CATEGORIES } from "@commonair/contracts/enums";
import { ModerationScores } from "@commonair/contracts/internal";
import type { Classifier } from "./types.ts";

/**
 * Scores come from `readScript(channelId)` (the worker reads `KEYS.moderationScript`); no script
 * means `{}` (nothing scored above anything). `provider` = `scripted`, `providerVersion` =
 * `scripted-v1`, scores every category. A script that is not valid `ModerationScores` throws
 * (the scan job fails visibly instead of silently scoring nothing).
 */
export function scriptedClassifier(readScript: (channelId: string) => Promise<ModerationScores | null>): Classifier {
  return {
    provider: "scripted",
    providerVersion: "scripted-v1",
    scored: MODERATION_CATEGORIES,
    async classify(input) {
      const script = await readScript(input.channelId);
      if (script === null) return {};
      return ModerationScores.parse(script);
    },
  };
}
