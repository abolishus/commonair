// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";

/** Form-level error, announced to assistive tech. */
export function FormError({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      data-testid="form-error"
      role="alert"
      className="border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      {children}
    </p>
  );
}
