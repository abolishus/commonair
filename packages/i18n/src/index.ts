// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ICU subset formatter, plural rules, locale negotiation and the pseudo-locale (ADR 0029).
 * Framework-neutral and browser-safe; the Node-only catalog tooling is `@commonair/i18n/catalog`.
 */
export {
  type ArgNode,
  type MessageArgs,
  type MessageAst,
  type MessageNode,
  type PluralNode,
  type PoundNode,
  type SelectNode,
  I18nSyntaxError,
  formatMessage,
  parseMessage,
  printMessage,
} from "./format.ts";
export { localeDirection, negotiateLocale, parseAcceptLanguage, pickLocale } from "./negotiate.ts";
export { PSEUDO_LOCALE, pseudoLocalize } from "./pseudo.ts";
export { createTranslator } from "./translator.ts";
