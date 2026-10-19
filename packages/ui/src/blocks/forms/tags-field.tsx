// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { Field, FieldDescription, FieldLabel } from "@commonair/ui/components/field";
import {
  Combobox,
  ComboboxChips,
  ComboboxChip,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
} from "@commonair/ui/components/combobox";

export interface TagsFieldProps {
  label: React.ReactNode;
  values?: readonly string[];
  defaultValues?: readonly string[];
  onValuesChange?: (values: string[]) => void;
  options?: readonly string[];
  max?: number;
  hint?: React.ReactNode;
  noResultsLabel?: React.ReactNode;
  addTagLabel?: (value: string) => React.ReactNode;
  "data-input-testid"?: string;
  "data-testid"?: string;
}
export function TagsField({
  label,
  values,
  defaultValues = [],
  onValuesChange,
  options = [],
  max = 10,
  hint,
  noResultsLabel,
  addTagLabel,
  ...props
}: TagsFieldProps): React.JSX.Element {
  const [inner, setInner] = React.useState<string[]>([...defaultValues].slice(0, Math.max(0, max)));
  const [query, setQuery] = React.useState("");
  const current = (values ?? inner).slice(0, Math.max(0, max));
  const set = (next: string[]): void => {
    const retained = current.filter((tag) => next.includes(tag));
    const additions = next.filter((tag) => !current.includes(tag));
    const limited = [...retained, ...additions.slice(0, Math.max(0, max - retained.length))];
    if (values === undefined) setInner(limited);
    onValuesChange?.(limited);
  };
  const id = React.useId();
  const candidates = options.filter(
    (option) => !current.includes(option) && option.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const add = (tag: string): void => {
    const normalized = tag.trim();
    if (
      !normalized ||
      current.length >= max ||
      current.some((entry) => entry.toLocaleLowerCase() === normalized.toLocaleLowerCase())
    )
      return;
    set([...current, normalized]);
    setQuery("");
  };
  return (
    <Field data-testid={props["data-testid"]}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox multiple value={[...current]} onValueChange={(next) => set(next)}>
        <ComboboxChips>
          <>
            {current.map((tag) => (
              <ComboboxChip key={tag}>{tag}</ComboboxChip>
            ))}
            <ComboboxChipsInput
              id={id}
              aria-label={typeof label === "string" ? label : undefined}
              data-testid={props["data-input-testid"]}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDownCapture={(event) => {
                if (event.key === "Enter" && query) {
                  event.preventDefault();
                  add(query);
                }
                if (event.key === "Backspace" && !query && current.length > 0) {
                  event.preventDefault();
                  set(current.slice(0, -1));
                }
              }}
              data-at-max={current.length >= max || undefined}
            />
          </>
        </ComboboxChips>
        <ComboboxContent>
          <ComboboxList>
            {candidates.map((option) => (
              <ComboboxItem key={option} value={option} disabled={current.length >= max}>
                {option}
              </ComboboxItem>
            ))}
            {query && !options.includes(query) && addTagLabel && (
              <ComboboxItem value={query} disabled={current.length >= max} onClick={() => add(query)}>
                {addTagLabel(query)}
              </ComboboxItem>
            )}
            {noResultsLabel && <ComboboxEmpty>{noResultsLabel}</ComboboxEmpty>}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {hint && <FieldDescription>{hint}</FieldDescription>}
      <FieldDescription>
        {current.length} / {max}
      </FieldDescription>
    </Field>
  );
}
