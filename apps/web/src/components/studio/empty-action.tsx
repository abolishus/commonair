// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The primary action of a studio empty state (F25, `empty-state-action`): a link to the page that
 * fills it, or a button that moves focus to the form on this page that does ("Add a relay" focuses
 * the relay name). Focus, not just scroll, so keyboard and screen-reader users land in the form.
 */
import { Button } from "@commonair/ui/components/button";
import { Link } from "@tanstack/react-router";
import type * as React from "react";

/** Focus the first element matching `selector` and bring it into view; false when there is none. */
export function focusFirst(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return false;
  el.focus();
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}

/** "Do it here": focuses the form field `selector` names. */
export function FocusFormAction({
  selector,
  children,
}: {
  selector: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button data-testid="empty-state-action" size="sm" type="button" onClick={() => focusFirst(selector)}>
      {children}
    </Button>
  );
}

/** "Go there": a link to the studio page that fills this list. */
export function StudioLinkAction({
  to,
  children,
}: {
  to: "/dashboard" | "/dashboard/settings" | "/rehearse" | "/interact" | "/revenue";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button data-testid="empty-state-action" size="sm" nativeButton={false} render={<Link to={to} />}>
      {children}
    </Button>
  );
}
