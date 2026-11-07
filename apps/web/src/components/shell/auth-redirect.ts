// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLocation } from "@tanstack/react-router";

/** The return path for Sign in / Sign up (F17): `href` without its hash, unless there is none to keep. */
export function authRedirectFor(href: string): string | undefined {
  const path = href.split("#")[0] ?? "/";
  if (path === "/" || path.startsWith("/signin") || path.startsWith("/signup")) return undefined;
  return path;
}

/** Where Sign in / Sign up send the visitor back to: this page, unless it is one of them. */
export function useAuthRedirect(): string | undefined {
  const href = useLocation({ select: (location) => location.href });
  return authRedirectFor(href);
}
