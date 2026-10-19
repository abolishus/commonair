// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IconButton } from "../../primitives/icon-button.tsx";
import { toast } from "@commonair/ui/toast";

export interface CodeBlockProps {
  value: string;
  label: string;
  copiedLabel: string;
  copyFailedLabel: string;
  wrap?: boolean;
  "data-testid"?: string;
  "data-copy-testid"?: string;
}
export function CodeBlock({
  value,
  label,
  copiedLabel,
  copyFailedLabel,
  wrap = true,
  ...props
}: CodeBlockProps): React.JSX.Element {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(copiedLabel);
    } catch {
      toast.error(copyFailedLabel);
    }
  };
  return (
    <div
      className="flex min-w-0 items-start gap-2 rounded-none border bg-muted/30 p-3"
      data-testid={props["data-testid"]}
    >
      <pre
        className={`min-w-0 flex-1 text-xs ${wrap ? "break-all whitespace-pre-wrap" : "overflow-x-auto whitespace-pre"}`}
      >
        <code>{value}</code>
      </pre>
      <IconButton
        type="button"
        label={label}
        tooltip={label}
        onClick={() => void copy()}
        data-testid={props["data-copy-testid"]}
      >
        <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} aria-hidden />
      </IconButton>
    </div>
  );
}
