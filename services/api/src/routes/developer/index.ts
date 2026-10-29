// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `developer.*`, composed from one file per area so each E9 unit owns its own (contract step §4):
 * apps and admin (E9-apps), tokens and OAuth consent and grants (E9-oauth), EventSub
 * subscriptions (E9-subs). ADR 0027.
 */
import { admin } from "./admin.ts";
import { apps } from "./apps.ts";
import { events } from "./events.ts";
import { grants, oauth } from "./oauth.ts";
import { tokens } from "./tokens.ts";

export const developer = { apps, tokens, events, oauth, grants, admin };
