// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { t } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { safeHttpUrl } from "../lib/url.ts";

/** Instance name and the AGPL §13 source link (from `instance.info`). */
export function Footer(): React.JSX.Element {
  const { instance } = useBootstrap();
  const sourceUrl = safeHttpUrl(instance.sourceUrl);
  return (
    <footer className="border-t border-border">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-xs text-muted-foreground">
        <span>{instance.name}</span>
        {sourceUrl && (
          <a
            data-testid="footer-source-link"
            href={sourceUrl}
            rel="noopener"
            className="underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("footer.source")}
          </a>
        )}
        <span>{t("footer.license")}</span>
      </div>
    </footer>
  );
}
