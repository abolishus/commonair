// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/* oxlint-disable jsx-a11y/prefer-tag-over-role */

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { useUiMessages } from "@commonair/ui/lib/locale";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";

type SpinnerProps = Omit<React.ComponentProps<"svg">, "strokeWidth"> & { strokeWidth?: number };

function Spinner({ className, strokeWidth = 2, ...props }: SpinnerProps) {
  const messages = useUiMessages();
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={strokeWidth}
      data-slot="spinner"
      role="status"
      aria-label={messages.loading}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
