// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * App message catalog. English only for now; every user-facing string goes through `t()`.
 * Design-system strings (`UiMessages`) come from the same place via `uiMessages`.
 */
import { enMessages, type UiMessages } from "@commonair/ui/lib/messages";
import { en, type MessageKey } from "./en.ts";

export type { MessageKey } from "./en.ts";

export const locale = "en";

const catalog: Record<MessageKey, string> = en;

/** Look up `key` and replace `{name}` placeholders from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = catalog[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}

export const uiMessages: UiMessages = enMessages;
