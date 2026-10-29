// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type MessageArgs, type MessageAst, formatMessage, parseMessage } from "./format.ts";

/**
 * Translator over a catalog with per-key English fallback and a parse cache. `onMissing` hears
 * about a key the catalog lacks (English is used) and about a message that does not parse (its
 * raw source is shown): a translation must never break the page.
 */
export function createTranslator<K extends string>(opts: {
  locale: string;
  messages: Partial<Record<K, string>>;
  fallback: Record<K, string>;
  onMissing?: (key: K) => void;
}): (key: K, args?: MessageArgs) => string {
  const { locale, messages, fallback, onMissing } = opts;
  const cache = new Map<K, MessageAst | string>();
  const has = (catalog: object, key: K) => Object.hasOwn(catalog, key);
  return (key, args) => {
    let parsed = cache.get(key);
    if (parsed === undefined) {
      let source: string;
      if (has(messages, key)) source = messages[key] as string;
      else {
        onMissing?.(key);
        source = has(fallback, key) ? fallback[key] : key;
      }
      try {
        parsed = parseMessage(source);
      } catch {
        onMissing?.(key);
        parsed = source;
      }
      cache.set(key, parsed);
    }
    return typeof parsed === "string" ? parsed : formatMessage(parsed, args, locale);
  };
}
