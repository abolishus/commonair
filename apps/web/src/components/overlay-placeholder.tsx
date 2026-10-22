// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import type { IconSvgElement } from "@hugeicons/react";
import type * as React from "react";

/**
 * An overlay that does not exist yet (goals, chat; ADR 0021): an `<EmptyState>` on the
 * transparent overlay page, so a browser source pointed at it shows why it is blank.
 */
export function OverlayPlaceholder({
  kind,
  icon,
  title,
  description,
}: {
  kind: "goals" | "chat";
  icon: IconSvgElement;
  title: string;
  description: string;
}): React.JSX.Element {
  return (
    <div className="grid min-h-svh place-items-center p-4">
      <EmptyState
        data-testid="overlay-placeholder"
        data-kind={kind}
        icon={icon}
        title={title}
        description={description}
      />
    </div>
  );
}
