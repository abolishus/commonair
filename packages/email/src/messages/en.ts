// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The English email catalog: the default and the shape every translation follows. The strings
 * live in `locales/en/<group>.json` (flat `block.field` keys, the ICU subset of ADR 0029); this
 * module nests them back into blocks, typed from the JSON, so a missing key is a type error in
 * templates. `{instance}` (the instance name) is available in every string. Translator notes:
 * `NOTES.md`.
 */
import account from "./locales/en/account.json" with { type: "json" };
import governance from "./locales/en/governance.json" with { type: "json" };
import layout from "./locales/en/layout.json" with { type: "json" };
import notify from "./locales/en/notify.json" with { type: "json" };
import payments from "./locales/en/payments.json" with { type: "json" };
import privacy from "./locales/en/privacy.json" with { type: "json" };
import security from "./locales/en/security.json" with { type: "json" };
import trust from "./locales/en/trust.json" with { type: "json" };

/** Every English JSON group, by file name (the order of `locales/en/`). */
export const EN_GROUPS = { account, governance, layout, notify, payments, privacy, security, trust } as const;

type Flat = typeof account &
  typeof governance &
  typeof layout &
  typeof notify &
  typeof payments &
  typeof privacy &
  typeof security &
  typeof trust;

type BlockOf<K> = K extends `${infer B}.${string}` ? B : never;

/** Flat `block.field` keys back to `{ block: { field: string } }` (the field may contain dots). */
export type Nested<T> = {
  [B in BlockOf<keyof T>]: { [K in keyof T as K extends `${B}.${infer F}` ? F : never]: string };
};

/** The full message catalog for one locale. */
export type EmailCatalog = Nested<Flat>;
export type LayoutMessages = EmailCatalog["layout"];

/** Nest flat `block.field` entries (split at the first dot). */
export function nestFlat(flat: Readonly<Record<string, string>>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [key, message] of Object.entries(flat)) {
    const dot = key.indexOf(".");
    if (dot <= 0) continue;
    const block = key.slice(0, dot);
    (out[block] ??= {})[key.slice(dot + 1)] = message;
  }
  return out;
}

export const en: EmailCatalog = nestFlat(Object.assign({}, ...Object.values(EN_GROUPS))) as unknown as EmailCatalog;
