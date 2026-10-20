// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InputGroup, InputGroupAddon } from "@commonair/ui/components/input-group";
import { Input } from "@commonair/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@commonair/ui/components/select";
import { ToggleGroup, ToggleGroupItem } from "@commonair/ui/components/toggle-group";
import { Switch } from "@commonair/ui/components/switch";
import { Label } from "@commonair/ui/components/label";
import { cn } from "@commonair/ui/lib/utils";

export interface FilterOption {
  value: string;
  label: string;
}
export interface FilterSelect {
  id: string;
  label: string;
  value: string;
  options: FilterOption[];
  onValueChange: (value: string) => void;
  /** On the select trigger. Each option carries `data-value` (its value). */
  "data-testid"?: string;
}
export interface FilterBarProps extends React.ComponentProps<"div"> {
  searchLabel?: string;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  /** Extra props for the search input (name, maxLength, `data-testid`, …). */
  searchInputProps?: Omit<React.ComponentProps<typeof Input>, "value" | "onChange"> & { "data-testid"?: string };
  filters?: FilterSelect[];
  toggleLabel?: string;
  toggleValue?: string;
  toggleOptions?: FilterOption[];
  onToggleChange?: (value: string) => void;
  tags?: FilterOption[];
  selectedTags?: string[];
  onTagsChange?: (values: string[]) => void;
  switchLabel?: string;
  switchChecked?: boolean;
  onSwitchChange?: (checked: boolean) => void;
  actions?: React.ReactNode;
}
export function FilterBar({
  searchLabel,
  searchValue,
  onSearchChange,
  searchInputProps,
  filters = [],
  toggleLabel,
  toggleValue,
  toggleOptions = [],
  onToggleChange,
  tags,
  selectedTags = [],
  onTagsChange,
  switchLabel,
  switchChecked = false,
  onSwitchChange,
  actions,
  className,
  ...props
}: FilterBarProps) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)} {...props}>
      {onSearchChange ? (
        <InputGroup className="min-w-40 flex-1">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} aria-hidden />
          </InputGroupAddon>
          <Input
            {...searchInputProps}
            aria-label={searchLabel}
            value={searchValue ?? ""}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder={searchLabel}
          />
        </InputGroup>
      ) : null}
      {filters.map((filter) => (
        <div className="min-w-32 flex-1" key={filter.id}>
          <Label className="sr-only" htmlFor={filter.id}>
            {filter.label}
          </Label>
          <Select
            items={filter.options}
            value={filter.value}
            onValueChange={(value) => {
              if (value !== null) filter.onValueChange(value);
            }}
          >
            <SelectTrigger id={filter.id} aria-label={filter.label} data-testid={filter["data-testid"]}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {filter.options.map((option) => (
                <SelectItem key={option.value} value={option.value} data-value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
      {toggleOptions.length ? (
        <fieldset className="min-w-0">
          <legend className="sr-only">{toggleLabel}</legend>
          <ToggleGroup
            value={toggleValue ? [toggleValue] : []}
            onValueChange={(value) => onToggleChange?.(value[0] ?? "")}
            multiple={false}
            variant="outline"
            size="sm"
          >
            {toggleOptions.map((option) => (
              <ToggleGroupItem key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </fieldset>
      ) : null}
      {tags?.length ? (
        <ToggleGroup
          value={selectedTags}
          onValueChange={onTagsChange}
          multiple
          variant="outline"
          size="sm"
          aria-label={toggleLabel}
        >
          {tags.map((tag) => (
            <ToggleGroupItem key={tag.value} value={tag.value}>
              {tag.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {switchLabel && onSwitchChange ? (
        <Label className="flex items-center gap-2 text-xs">
          <Switch aria-label={switchLabel} checked={switchChecked} onCheckedChange={onSwitchChange} />
          {switchLabel}
        </Label>
      ) : null}
      {actions}
    </div>
  );
}
