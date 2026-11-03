// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Sign-in and sign-up (F17): the form, and on `lg` beside it a short co-op pitch. Full pages, not a
 * modal, for accessibility; on narrow screens one column with the form first (source order).
 */
import { PageHeader } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@commonair/ui/components/card";
import { PageContainer } from "@commonair/ui/layouts";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";

export interface AuthLayoutProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  "data-testid"?: string;
}

export function AuthLayout({ title, description, children, ...props }: AuthLayoutProps): React.JSX.Element {
  return (
    <PageContainer data-testid={props["data-testid"]} className="py-12">
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2 lg:items-start">
        <div className="mx-auto flex w-full max-w-md flex-col gap-6">
          <PageHeader title={title} description={description} />
          {children}
        </div>
        <CoopPitch />
      </div>
    </PageContainer>
  );
}

/** What joining means here: the co-op, in two lines and a link to the books. */
export function CoopPitch(): React.JSX.Element {
  return (
    <Card data-testid="auth-coop-pitch" className="mx-auto w-full max-w-md lg:mt-16">
      <CardHeader>
        <CardTitle>
          <h2>{t("polish.auth.pitch.title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ul className="flex list-disc flex-col gap-2 ps-5">
          <li>{t("polish.auth.pitch.memberOwned")}</li>
          <li>{t("polish.auth.pitch.openBooks")}</li>
        </ul>
        <div>
          <Button variant="outline" size="sm" nativeButton={false} render={<Link to="/transparency" />}>
            {t("polish.auth.pitch.transparency")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
