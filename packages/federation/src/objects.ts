// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityStreams objects (ADR 0030 decision 3): the go-live `Note` and the `Video` for a public
 * VOD or clip, with stable ids from `federation_objects`, no media URL and no personal data. A
 * stub from the batch 7 contract step; N4-delivery fills it.
 */

/** Object kinds stored in `federation_objects.kind`. */
export const FEDERATION_OBJECT_KINDS = ["note", "video"] as const;
export type FederationObjectKind = (typeof FEDERATION_OBJECT_KINDS)[number];
