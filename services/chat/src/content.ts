// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Content rules: link detection. Word filters live in `@commonair/chat-filter`. */

/**
 * Explicit schemes, `www.` hosts, and bare `host.tld` forms (TLD of 2+ letters). Deliberately
 * broad: a channel that disables links prefers a false positive over a phishing link.
 */
const LINK =
  /(?:\b[a-z][a-z0-9+.-]*:\/\/\S+)|(?:\bwww\.\S+)|(?:\b[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*\.[a-z]{2,24}(?::\d{1,5})?(?:\/\S*)?(?=$|[\s,;!?)'"]|\.(?:\s|$)))/iu;

export const containsLink = (body: string): boolean => LINK.test(body);
