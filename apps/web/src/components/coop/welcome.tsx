// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "Welcome to the co-op" (overhaul wave 2, D2.6 and the post-checkout journey gap): shown once a
 * qualifying sub's payment is confirmed and the viewer membership it started is active (the
 * payment webhook starts it in the same transaction). It says so plainly, names the first vote
 * from the real electorate (`first-vote.tsx`), and links to the membership page.
 */
import { AlertCallout } from "@commonair/ui/blocks/feedback";
import { Button } from "@commonair/ui/components/button";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { FirstVoteNote, type FirstVoteChoice } from "./first-vote.tsx";

export interface CoopWelcomeProps {
  /** The first vote once it loaded; null while it loads or when it could not. */
  firstVote: FirstVoteChoice | null;
}

export function CoopWelcome({ firstVote }: CoopWelcomeProps): React.JSX.Element {
  React.useEffect(() => {
    trackUi("coop.welcome", "view");
  }, []);
  return (
    <AlertCallout
      data-testid="coop-welcome"
      tone="info"
      icon={UserGroupIcon}
      live
      title={t("d2Membership.welcome.title")}
      description={
        <div className="flex flex-col gap-2">
          <p>{t("d2Membership.welcome.body")}</p>
          <FirstVoteNote choice={firstVote} />
        </div>
      }
      action={
        <Button
          variant="outline"
          size="sm"
          nativeButton={false}
          render={
            <Link
              to="/coop/membership"
              data-testid="coop-welcome-link"
              onClick={() => trackUi("coop.welcome", "click")}
            />
          }
        >
          {t("d2Membership.welcome.link")}
        </Button>
      }
    />
  );
}
