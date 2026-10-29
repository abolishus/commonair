// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import type * as React from "react";
import { openCookieSettings } from "../../lib/consent.ts";

/**
 * The footer's "Cookie settings" entry. `SiteFooter` clones it with the label as its child, so
 * it reads like the other footer links but is a button (it opens a dialog, not a page).
 */
export function CookieSettingsButton(props: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="link"
      data-testid="footer-cookie-settings"
      className="h-auto px-0 font-normal text-inherit"
      onClick={() => openCookieSettings()}
    >
      {props.children}
    </Button>
  );
}
