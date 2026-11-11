// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Button } from "@commonair/ui/components/button";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/** Sign-up and sign-in links that bring the visitor back to `path` with the join intent. */
export function explainerLinks(path: string): { signup: string; signin: string } {
  const back = new URLSearchParams({ intent: "join", redirect: path }).toString();
  return { signup: `/signup?${back}`, signin: `/signin?${new URLSearchParams({ redirect: path }).toString()}` };
}

export interface ExplainerJoinProps {
  /** The page to come back to after signing up or in (`/coop/jury`). */
  path: string;
  title: string;
  body: string;
}

/**
 * The end of a public co-op explainer: create an account (the page's one filled call to action)
 * or sign in, both returning here. Shown to signed-out visitors only.
 */
export function ExplainerJoin({ path, title, body }: ExplainerJoinProps): React.JSX.Element {
  const links = explainerLinks(path);
  return (
    <section
      data-testid="coop-explainer-join"
      aria-labelledby="coop-explainer-join-title"
      className="flex flex-col gap-3 bg-surface-sunken p-5 ring-1 ring-border md:p-6"
    >
      <h2 id="coop-explainer-join-title" className="text-lg font-semibold">
        {title}
      </h2>
      <p className="text-muted-foreground">{body}</p>
      <div className="flex flex-wrap gap-2 max-md:flex-col">
        <Button
          variant="brand"
          size="lg"
          data-filled-cta=""
          data-testid="coop-explainer-signup"
          nativeButton={false}
          className="min-h-11 px-4"
          render={<a href={links.signup} aria-label={t("d2Pages.explainer.createAccount")} />}
        >
          {t("d2Pages.explainer.createAccount")}
        </Button>
        <Button
          variant="outline"
          size="lg"
          data-testid="coop-explainer-signin"
          nativeButton={false}
          className="min-h-11 px-4"
          render={<a href={links.signin} aria-label={t("d2Pages.explainer.signIn")} />}
        >
          {t("d2Pages.explainer.signIn")}
        </Button>
      </div>
    </section>
  );
}
