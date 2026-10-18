// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Example middleware: lets every message through. Copy this shape for a new plugin
 * (`process` may return "continue", `{ drop: <NoticeCode> }` or `{ transform: <new body> }`).
 */
import type { MessageMiddleware } from "../pipeline.ts";

export const noopMiddleware: MessageMiddleware = {
  name: "noop",
  async process() {
    return "continue";
  },
};
