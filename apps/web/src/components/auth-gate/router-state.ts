// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the prompt is, read from the router when there is one. The actions the prompt sits on
 * (Follow, Report, the 18+ gate) also render outside a router (component tests, embeds), where
 * `useLocation` would throw; there the prompt simply carries no return path. Read at render: the
 * components re-render with the page, so a subscription would only add work.
 */
import { useRouter } from "@tanstack/react-router";

export interface GateLocation {
  /** Path, search and hash, as `location.href`. */
  href: string;
  pathname: string;
  /** The matched route's params (`$channel` on a channel page). */
  params: Record<string, unknown>;
}

export function useGateLocation(): GateLocation | null {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | null | undefined;
  if (!router) return null;
  const { location, matches } = router.state;
  const params = (matches.at(-1)?.params ?? {}) as Record<string, unknown>;
  return { href: location.href, pathname: location.pathname, params };
}
