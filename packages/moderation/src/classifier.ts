// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The scripted classifier (test hooks only). The ONNX default is in `./onnx` (native addon). */
import type { ModerationScores } from "@commonair/contracts/internal";
import { pending } from "./pending.ts";
import type { Classifier } from "./types.ts";

/**
 * Scores come from `readScript(channelId)` (the worker reads `KEYS.moderationScript`); no script
 * means `{}` (nothing scored above anything). `provider` = `scripted`, `providerVersion` =
 * `scripted-v1`, scores every category.
 */
export function scriptedClassifier(_readScript: (channelId: string) => Promise<ModerationScores | null>): Classifier {
  return pending("scriptedClassifier");
}
