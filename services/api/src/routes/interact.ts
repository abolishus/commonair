// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.*`, composed from one file per area so each E8 unit owns its own (contract step §4.1):
 * E6's alerts and overlays (docs/testing/e6-selectors.md, ADR 0021), E8's polls, predictions,
 * raids and goals (docs/testing/e8-selectors.md, ADR 0026).
 */
import { alerts } from "./interact/alerts.ts";
import { goals } from "./interact/goals.ts";
import { overlays } from "./interact/overlays.ts";
import { polls } from "./interact/polls.ts";
import { predictions } from "./interact/predictions.ts";
import { raids } from "./interact/raids.ts";

export { overlayEventsUrl } from "./interact/overlays.ts";

export const interact = { polls, predictions, raids, alerts, goals, overlays };
