// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The legal documents with a public page of their own (each kind is a reserved username, F10). */
export const PUBLIC_LEGAL_KINDS = ["terms", "privacy", "guidelines"] as const;
export type PublicLegalKind = (typeof PUBLIC_LEGAL_KINDS)[number];

/** Each kind's page. */
export const LEGAL_PATH = { terms: "/terms", privacy: "/privacy", guidelines: "/guidelines" } as const;
