// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { FileNotFoundIcon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";

/** What a page the visitor may not see shows instead (the same as a page that does not exist). */
export function NotFoundState(): React.JSX.Element {
  return (
    <PageContainer className="py-16">
      <EmptyState
        icon={FileNotFoundIcon}
        title={t("page.notFound")}
        description={t("page.notFoundHint")}
        action={
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/" />}>
            {t("page.notFoundHome")}
          </Button>
        }
      />
    </PageContainer>
  );
}
