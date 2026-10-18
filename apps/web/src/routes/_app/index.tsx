// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { buttonVariants } from "@commonair/ui/components/button";
import { Link, createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";

export const Route = createFileRoute("/_app/")({ component: Home });

function Home(): React.JSX.Element {
  const { me, instance } = useBootstrap();
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 px-4 py-16">
      <h1 className="font-display text-2xl font-semibold">{t("home.title", { name: instance.name })}</h1>
      <p className="text-sm text-muted-foreground">{t("home.tagline")}</p>
      <div className="flex flex-wrap gap-2">
        {me ? (
          <Link to="/dashboard" className={buttonVariants({ size: "lg" })}>
            {t("home.toDashboard")}
          </Link>
        ) : (
          <>
            <Link to="/signup" className={buttonVariants({ size: "lg" })}>
              {t("nav.signUp")}
            </Link>
            <Link to="/signin" className={buttonVariants({ variant: "outline", size: "lg" })}>
              {t("nav.signIn")}
            </Link>
          </>
        )}
      </div>
    </section>
  );
}
