// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ActivityStreams activities (ADR 0030): `Create`, `Delete` with `Tombstone`, `Accept` and
 * `Update{Service}`, addressed to Public and the followers collection. A stub from the batch 7
 * contract step; N4-delivery fills it (pure functions, plain JSON with the AS2 context).
 */

/** The ActivityStreams 2.0 context. */
export const AS2_CONTEXT = "https://www.w3.org/ns/activitystreams";
/** The security vocabulary context, for `publicKey`. */
export const SECURITY_CONTEXT = "https://w3id.org/security/v1";
/** The public collection. */
export const AS2_PUBLIC = "https://www.w3.org/ns/activitystreams#Public";
/** The media type of ActivityPub requests and answers. */
export const ACTIVITY_CONTENT_TYPE = "application/activity+json";
