// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every locale under `locales/`, statically imported: email renders on the server only, so all of
 * them ship (batch 5 decision (d)). Adding a language is adding `locales/<lang>/*.json` and one
 * line here; a test fails when a directory is missing from `BUNDLED`.
 */
import esAccount from "./locales/es/account.json" with { type: "json" };
import esGovernance from "./locales/es/governance.json" with { type: "json" };
import esLayout from "./locales/es/layout.json" with { type: "json" };
import esNotify from "./locales/es/notify.json" with { type: "json" };
import esPayments from "./locales/es/payments.json" with { type: "json" };
import esPrivacy from "./locales/es/privacy.json" with { type: "json" };
import esSecurity from "./locales/es/security.json" with { type: "json" };
import esTrust from "./locales/es/trust.json" with { type: "json" };
import { en, nestFlat } from "./en.ts";
import type { PartialCatalog } from "./types.ts";

const fromGroups = (...groups: Readonly<Record<string, string>>[]): PartialCatalog =>
  nestFlat(Object.assign({}, ...groups)) as PartialCatalog;

/** Catalogs by BCP 47 tag, one per `locales/<lang>/` directory. */
export const BUNDLED: Readonly<Record<string, PartialCatalog>> = {
  en,
  es: fromGroups(esAccount, esGovernance, esLayout, esNotify, esPayments, esPrivacy, esSecurity, esTrust),
};
