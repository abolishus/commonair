// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, IconButton, ThemeToggle } from "@commonair/ui";
import { buttonVariants } from "@commonair/ui/components/button";
import { toast } from "@commonair/ui/toast";
import { Logout03Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../i18n/index.ts";
import { signOut } from "../lib/auth.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { ThemeContext } from "../lib/theme-context.ts";

export function Header(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  const { theme, setTheme } = React.useContext(ThemeContext);

  const onSignOut = async () => {
    try {
      await signOut();
      // Full load: nothing rendered for the old session survives.
      window.location.assign("/");
    } catch {
      toast.error(t("auth.signOutFailed"));
    }
  };

  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2">
        <Link
          to="/"
          className="font-display text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {instance.name}
        </Link>
        <nav aria-label={t("nav.main")} className="mr-auto">
          <Link
            data-testid="nav-directory"
            to="/"
            activeOptions={{ exact: true }}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            activeProps={{ "aria-current": "page" }}
          >
            {t("nav.directory")}
          </Link>
        </nav>
        <ThemeToggle value={theme} onValueChange={setTheme} />
        {me ? (
          <div data-testid="nav-user" data-username={me.username} className="flex items-center gap-2">
            <Link
              to="/dashboard"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
              aria-label={t("nav.dashboardFor", { name: me.displayName })}
            >
              <ChannelAvatar name={me.displayName} size="xs" decorative />
              <span className="hidden max-w-32 truncate sm:inline">{me.username}</span>
            </Link>
            <IconButton label={t("nav.signOut")} icon={Logout03Icon} variant="ghost" onClick={() => void onSignOut()} />
          </div>
        ) : (
          <nav aria-label={t("nav.account")} className="flex items-center gap-2">
            <Link to="/signin" className={buttonVariants({ variant: "ghost", size: "sm" })}>
              {t("nav.signIn")}
            </Link>
            <Link to="/signup" className={buttonVariants({ variant: "default", size: "sm" })}>
              {t("nav.signUp")}
            </Link>
          </nav>
        )}
      </div>
    </header>
  );
}
