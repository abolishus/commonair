// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "../components/command.tsx";
import { useLocale } from "../lib/locale.tsx";
import { Shortcut } from "./shortcut.tsx";

export interface CommandPaletteItem {
  id: string;
  label: string;
  /** Extra search terms (synonyms, the URL slug) that are not shown. */
  keywords?: readonly string[];
  icon?: IconSvgElement;
  /** Keys shown on the right, e.g. `["mod", "shift", "f"]`. */
  shortcut?: readonly string[];
  disabled?: boolean;
  /** Runs after the palette closes. */
  onSelect: () => void;
}

export interface CommandPaletteGroup {
  id: string;
  label: string;
  items: readonly CommandPaletteItem[];
}

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly CommandPaletteGroup[];
  /** Strings default to `messages.commandPalette`. */
  title?: string;
  description?: string;
  placeholder?: string;
  emptyText?: React.ReactNode;
  /** Registers mod+<key> (⌘K / Ctrl+K) on the document to toggle the palette. */
  hotkey?: string;
}

/** Case- and accent-insensitive "contains" for the active locale. */
export function matchesQuery(item: CommandPaletteItem, query: string, locale: string): boolean {
  const normalize = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase(locale);
  const q = normalize(query.trim());
  if (q === "") return true;
  return [item.label, ...(item.keywords ?? [])].some((text) => normalize(text).includes(q));
}

interface GroupValue {
  value: string;
  label: string;
  items: CommandPaletteItem[];
}

/** App-wide command palette shell: groups and actions come from props, filtering and keyboard from Base UI. */
export function CommandPalette({
  open,
  onOpenChange,
  groups,
  title,
  description,
  placeholder,
  emptyText,
  hotkey,
}: CommandPaletteProps): React.JSX.Element {
  const { locale, messages } = useLocale();
  const strings = messages.commandPalette;

  React.useEffect(() => {
    if (!hotkey) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === hotkey.toLowerCase()) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [hotkey, open, onOpenChange]);

  const items = React.useMemo<GroupValue[]>(
    () => groups.filter((g) => g.items.length > 0).map((g) => ({ value: g.id, label: g.label, items: [...g.items] })),
    [groups],
  );

  const select = (item: CommandPaletteItem): void => {
    if (item.disabled) return;
    onOpenChange(false);
    item.onSelect();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title ?? strings.title}
      description={description ?? strings.description}
    >
      <Command
        items={items}
        itemToStringValue={(item: unknown) => (item as CommandPaletteItem).label}
        filter={(item: unknown, query: string) => matchesQuery(item as CommandPaletteItem, query, locale)}
      >
        <CommandInput placeholder={placeholder ?? strings.placeholder} aria-label={title ?? strings.title} />
        <CommandEmpty>{emptyText ?? strings.empty}</CommandEmpty>
        <CommandList>
          {(group: GroupValue) => (
            <CommandGroup key={group.value} items={group.items}>
              <CommandGroupLabel>{group.label}</CommandGroupLabel>
              <CommandCollection>
                {(item: CommandPaletteItem) => (
                  <CommandItem key={item.id} value={item} disabled={item.disabled} onClick={() => select(item)}>
                    {item.icon && <HugeiconsIcon icon={item.icon} strokeWidth={2} aria-hidden />}
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.shortcut && (
                      <CommandShortcut>
                        <Shortcut keys={item.shortcut} />
                      </CommandShortcut>
                    )}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
