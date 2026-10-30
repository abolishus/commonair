// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payment fraud floor detectors (ADR 0036): pure signals and the scan's SQL inputs. Owned by
 * W1-fraud-floor; the hold and the flag writes live in `@commonair/ledger` (`payouts.ts`).
 */
export * from "./inputs.ts";
export * from "./signals.ts";
