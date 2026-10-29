// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every English message, merged from `locales/en/*.json`, for tests that look keys up. Keys are
 * added in the JSON namespaces, never here (`apps/web/src/i18n/README.md`).
 */
import { registry } from "./index.ts";
import type { MessageKey } from "./keys/index.gen.ts";

export type { MessageKey } from "./keys/index.gen.ts";

export const en: Record<MessageKey, string> = registry.english;
