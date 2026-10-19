// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Alert, AlertDescription } from "@commonair/ui/components/alert";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";

/** Form-level (or load) error; `Alert` carries `role="alert"`, so it is announced. */
export function FormError({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <Alert data-testid="form-error" variant="destructive">
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} aria-hidden />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
