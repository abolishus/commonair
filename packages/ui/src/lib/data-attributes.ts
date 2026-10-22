// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `data-*` attributes a page forwards to one element of a composition: e2e test ids and the
 * machine-readable values the visible text formats (docs/testing/*-selectors.md).
 */
export type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
