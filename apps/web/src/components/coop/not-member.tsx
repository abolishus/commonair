// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/** Shown instead of the proposal form to someone who is not an active member. */
export function NotMemberState(): React.JSX.Element {
  return (
    <PageContainer className="py-16">
      <EmptyState
        data-testid="proposal-not-member"
        icon={UserGroupIcon}
        title={t("coop.form.notMemberTitle")}
        description={t("coop.form.notMember")}
        action={
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/coop/membership" />}>
            {t("coop.form.becomeMember")}
          </Button>
        }
      />
    </PageContainer>
  );
}
