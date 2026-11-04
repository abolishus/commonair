// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { IconButton } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { WELCOME_KEY, readTab, writeTab } from "./tab-storage.ts";

const noopSubscribe = (): (() => void) => () => {};

/**
 * The signed-out welcome (F8): one slim line instead of a block that repeats the header's Sign up
 * and Sign in. Dismissed for the rest of the tab. Shown on the server render and until the tab's
 * choice is read, so a visitor who never dismissed it sees no shift.
 */
export function WelcomeStrip({ name }: { name: string }): React.JSX.Element | null {
  const [dismissed, setDismissed] = React.useState(false);
  // The tab's earlier dismissal: false on the server and while hydrating, then read once.
  const stored = React.useSyncExternalStore(
    noopSubscribe,
    () => readTab(WELCOME_KEY) === "1",
    () => false,
  );
  if (dismissed || stored) return null;
  return (
    <aside
      data-testid="welcome-strip"
      aria-label={t("discovery.welcome.label")}
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border bg-muted/40 px-4 py-2 text-sm"
    >
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t("home.title", { name })}</span>{" "}
        <span className="text-muted-foreground">{t("home.tagline")}</span>
      </p>
      <Button size="sm" nativeButton={false} render={<Link to="/signup" />}>
        {t("nav.signUp")}
      </Button>
      <IconButton
        data-testid="welcome-dismiss"
        variant="ghost"
        size="icon-sm"
        icon={Cancel01Icon}
        label={t("discovery.welcome.dismiss")}
        onClick={() => {
          writeTab(WELCOME_KEY, "1");
          setDismissed(true);
        }}
      />
    </aside>
  );
}
