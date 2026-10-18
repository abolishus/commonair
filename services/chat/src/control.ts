// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Bus message shapes live in the shared chat contract; re-exported here for existing imports. */
import type { z } from "zod";

export { ChatControlMessage, ChatFanout, InvalidateMessage } from "@commonair/contracts/chat";

export function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const result = schema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
