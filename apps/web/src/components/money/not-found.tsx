// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a page the visitor may not see shows instead: D4's shared not-found state (F13), with its
 * "Browse live channels" action. Kept under this name so the money, admin and studio pages that
 * import it from here get the shared state. The title stays the `page.notFound` message ("Page not
 * found", the shared state's own wording) because the co-op, console and giveaway tests look for it.
 */
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { NotFoundState as SharedNotFoundState, type NotFoundStateProps } from "../not-found.tsx";

export type { NotFoundStateProps };

export function NotFoundState(props: NotFoundStateProps): React.JSX.Element {
  return <SharedNotFoundState title={t("page.notFound")} {...props} />;
}
