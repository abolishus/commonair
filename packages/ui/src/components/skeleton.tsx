// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cn } from "@commonair/ui/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-none bg-muted", className)} {...props} />;
}

export { Skeleton };
