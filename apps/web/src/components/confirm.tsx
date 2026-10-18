// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ConfirmDialog, type ConfirmDialogProps } from "@commonair/ui";
import * as React from "react";

/**
 * `ConfirmDialog` with `data-testid="confirm-dialog-confirm"` on its confirm button (the E1
 * selector contract). The shared primitive has no prop for it yet, so a marker child tags the
 * button once the dialog content mounts. Contract request: add the test id in @commonair/ui.
 */
export function Confirm({ children, ...props }: ConfirmDialogProps): React.JSX.Element {
  return (
    <ConfirmDialog {...props}>
      {children}
      <ConfirmTestId />
    </ConfirmDialog>
  );
}

function ConfirmTestId(): React.JSX.Element {
  const marker = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    const content = marker.current?.closest('[data-slot="alert-dialog-content"]');
    content?.querySelector('[data-slot="alert-dialog-action"]')?.setAttribute("data-testid", "confirm-dialog-confirm");
  });
  return <span ref={marker} hidden />;
}
