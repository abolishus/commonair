// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@commonair/ui/components/input-group";
import { Kbd, KbdGroup } from "@commonair/ui/components/kbd";

export interface HeaderSearchProps extends Omit<React.ComponentProps<"form">, "onSubmit"> {
  label: string;
  placeholder: string;
  shortcut?: string;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
  onOpenPalette?: () => void;
}
export function HeaderSearch({
  label,
  placeholder,
  shortcut,
  onSubmit,
  onOpenPalette,
  ...props
}: HeaderSearchProps): React.JSX.Element {
  return (
    <search aria-label={label}>
      <form onSubmit={onSubmit} {...props}>
        <InputGroup>
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput aria-label={label} placeholder={placeholder} onFocus={onOpenPalette} />
          {shortcut ? (
            <InputGroupAddon align="inline-end">
              <KbdGroup>
                <Kbd>{shortcut}</Kbd>
              </KbdGroup>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </form>
    </search>
  );
}
