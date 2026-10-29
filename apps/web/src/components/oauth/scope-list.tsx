// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Scope } from "@commonair/contracts/scopes";
import { StatusBadge } from "@commonair/ui";
import { CheckmarkCircle02Icon, SecurityWarningIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { SCOPE_MESSAGES, isSensitiveScope } from "./scope-messages.ts";

export interface ScopeListProps {
  scopes: readonly Scope[];
  /** Labels the list (the id of the "will be able to:" line above it). */
  labelledBy?: string;
  /** Each row's test id: `oauth-consent-scope` on the consent pages (also on `/activate`). */
  itemTestId?: string;
  /** Show the one-sentence explanation under each title (off in the compact connections rows). */
  detailed?: boolean;
}

/** The requested permissions in plain words, sensitive ones marked; a real list for screen readers. */
export function ScopeList({
  scopes,
  labelledBy,
  itemTestId = "oauth-consent-scope",
  detailed = true,
}: ScopeListProps): React.JSX.Element {
  const anySensitive = scopes.some(isSensitiveScope);
  return (
    <div className="flex flex-col gap-3">
      <ul aria-labelledby={labelledBy} className="flex flex-col gap-2">
        {scopes.map((scope) => {
          const message = SCOPE_MESSAGES[scope];
          const sensitive = isSensitiveScope(scope);
          return (
            <li
              key={scope}
              data-testid={itemTestId}
              data-scope={scope}
              data-sensitive={sensitive ? "true" : "false"}
              className="flex items-start gap-2"
            >
              <HugeiconsIcon
                icon={sensitive ? SecurityWarningIcon : CheckmarkCircle02Icon}
                strokeWidth={2}
                aria-hidden
                className={sensitive ? "mt-0.5 size-4 shrink-0 text-warning" : "mt-0.5 size-4 shrink-0 text-primary"}
              />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {t(message.title)}
                  {sensitive && <StatusBadge tone="warning">{t("oauth.scope.sensitive")}</StatusBadge>}
                </span>
                {detailed && <span className="text-xs text-muted-foreground">{t(message.body)}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {detailed && anySensitive && <p className="text-xs text-muted-foreground">{t("oauth.scope.sensitiveHint")}</p>}
    </div>
  );
}
