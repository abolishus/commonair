// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@commonair/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@commonair/ui/components/radio-group";
import { Checkbox } from "@commonair/ui/components/checkbox";
import { MoneyAmount, type MoneyValue } from "../../primitives/money-amount.tsx";

export interface OptionCardItem {
  value: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  perks?: readonly React.ReactNode[];
  trailing?: React.ReactNode;
  price?: MoneyValue;
  disabled?: boolean;
  /** Attributes for the item's radio or checkbox (the element that carries `aria-checked`). */
  controlProps?: DataAttributes;
}
/** `data-*` attributes (test ids, machine-readable values) forwarded to an element. */
export type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
export interface OptionCardProps extends OptionCardItem {
  selected?: boolean;
  multiple?: boolean;
  onSelectedChange?: (selected: boolean) => void;
}
export function OptionCard({
  value,
  title,
  description,
  perks,
  trailing,
  price,
  selected,
  multiple,
  disabled,
  onSelectedChange,
  controlProps,
}: OptionCardProps): React.JSX.Element {
  const id = React.useId();
  return (
    <FieldLabel htmlFor={id}>
      <Field
        orientation="horizontal"
        className="w-full flex-row items-start gap-3 rounded-none border p-3"
        data-checked={selected || undefined}
        data-disabled={disabled || undefined}
      >
        {multiple ? (
          <Checkbox
            {...controlProps}
            id={id}
            checked={selected}
            disabled={disabled}
            onCheckedChange={(value) => onSelectedChange?.(value === true)}
          />
        ) : (
          <RadioGroupItem {...controlProps} id={id} value={value} disabled={disabled} />
        )}
        <FieldContent className="min-w-0 flex-1">
          <span className="font-medium">{title}</span>
          {description && <FieldDescription>{description}</FieldDescription>}
          {perks?.map((perk, index) => (
            <FieldDescription key={index}>{perk}</FieldDescription>
          ))}
        </FieldContent>
        {price && <MoneyAmount value={price} className="shrink-0" />}
        {trailing}
      </Field>
    </FieldLabel>
  );
}
/** Use `multiple` with values/onValuesChange to render the options as a checkbox list. */
export interface OptionGroupProps {
  items: readonly OptionCardItem[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  multiple?: boolean;
  values?: readonly string[];
  defaultValues?: readonly string[];
  onValuesChange?: (values: string[]) => void;
  className?: string;
  id?: string;
  name?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "data-testid"?: string;
}
export function OptionGroup({
  items,
  multiple = false,
  value,
  defaultValue,
  onValueChange,
  values,
  defaultValues,
  onValuesChange,
  className,
  ...props
}: OptionGroupProps): React.JSX.Element {
  const [uncontrolled, setUncontrolled] = React.useState<string[]>([
    ...(defaultValues ?? (defaultValue ? [defaultValue] : [])),
  ]);
  const [selected, setSelected] = React.useState(defaultValue ?? "");
  if (multiple)
    return (
      <FieldSet className={className} aria-label={props["aria-label"]} data-testid={props["data-testid"]}>
        <FieldLegend className="sr-only">{props["aria-label"] ?? ""}</FieldLegend>
        {items.map((item) => (
          <OptionCard
            key={item.value}
            {...item}
            multiple
            selected={(values ?? uncontrolled).includes(item.value)}
            onSelectedChange={(selected) => {
              const next = selected
                ? [...(values ?? uncontrolled), item.value]
                : (values ?? uncontrolled).filter((entry) => entry !== item.value);
              if (values === undefined) setUncontrolled(next);
              onValuesChange?.(next);
            }}
          />
        ))}
      </FieldSet>
    );
  const current = value ?? selected;
  const select = (next: string): void => {
    if (value === undefined) setSelected(next);
    onValueChange?.(next);
  };
  return (
    <RadioGroup
      className={className}
      value={current}
      onValueChange={select}
      onKeyDown={(event) => {
        if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return;
        const available = items.filter((item) => !item.disabled);
        const index = available.findIndex((item) => item.value === current);
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
        const next = available[(index + direction + available.length) % available.length];
        if (next) {
          event.preventDefault();
          select(next.value);
          event.currentTarget.querySelector<HTMLElement>(`[role="radio"][value="${CSS.escape(next.value)}"]`)?.focus();
        }
      }}
      {...props}
    >
      {items.map((item) => (
        <OptionCard key={item.value} {...item} />
      ))}
    </RadioGroup>
  );
}
