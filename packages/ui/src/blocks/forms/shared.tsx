// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { FieldDescription, FieldError } from "@commonair/ui/components/field";

export type FormErrors = string | readonly (string | { message?: string } | undefined)[];

export function FormError({ errors }: { errors?: FormErrors }): React.JSX.Element | null {
  if (!errors) return null;
  const normalized = typeof errors === "string" ? [errors] : [...errors];
  return <FieldError errors={normalized} />;
}

export function Hint({ children }: { children?: React.ReactNode }): React.JSX.Element | null {
  return children ? <FieldDescription>{children}</FieldDescription> : null;
}
