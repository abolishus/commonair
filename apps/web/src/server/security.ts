// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Headers on everything the web server itself answers. Only `/embed/*` may be framed by other
 * sites (that is its purpose); every other page is clickjacking-protected.
 */
export function securityHeaders(pathname: string): Record<string, string> {
  const embeddable = pathname.startsWith("/embed/");
  return {
    "content-security-policy": `frame-ancestors ${embeddable ? "*" : "'self'"}`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
  };
}
