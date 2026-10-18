// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Command menu with the shadcn `command` API and base-lyra styling, built on
 * Base UI's inline Autocomplete instead of `cmdk`: cmdk depends on
 * `@radix-ui/*`, and this design system has no Radix in its tree. Filtering,
 * highlighting and Enter-to-activate come from Base UI, so pass the items
 * (flat or grouped) to `<Command items>` and render them with
 * `<CommandList>{(group) => …}</CommandList>` as in the Base UI docs.
 */
import * as React from "react";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@commonair/ui/lib/utils";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@commonair/ui/components/dialog";

type CommandProps = React.ComponentProps<typeof AutocompletePrimitive.Root> & { className?: string };

function Command({ className, children, ...props }: CommandProps) {
  return (
    <div
      data-slot="command"
      className={cn(
        "flex size-full flex-col overflow-hidden rounded-none bg-popover text-popover-foreground",
        className,
      )}
    >
      <AutocompletePrimitive.Root inline open autoHighlight="always" keepHighlight {...props}>
        {children}
      </AutocompletePrimitive.Root>
    </div>
  );
}

function CommandDialog({
  title,
  description,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  /** Accessible name of the dialog (visually hidden). */
  title: string;
  /** Accessible description of the dialog (visually hidden). */
  description: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog {...props}>
      <DialogContent
        className={cn("top-1/4 translate-y-0 overflow-hidden rounded-none p-0 sm:max-w-lg", className)}
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

function CommandInput({ className, ...props }: AutocompletePrimitive.Input.Props) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2 border-b px-2">
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} aria-hidden className="size-4 shrink-0 opacity-50" />
      <AutocompletePrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-9 w-full min-w-0 bg-transparent text-xs outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

function CommandList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <AutocompletePrimitive.List
      data-slot="command-list"
      className={cn("no-scrollbar max-h-72 scroll-py-1 overflow-x-hidden overflow-y-auto py-1 outline-none", className)}
      {...props}
    />
  );
}

function CommandEmpty({ className, ...props }: AutocompletePrimitive.Empty.Props) {
  return (
    <AutocompletePrimitive.Empty
      data-slot="command-empty"
      className={cn("text-center text-xs text-muted-foreground not-empty:py-6", className)}
      {...props}
    />
  );
}

function CommandGroup({ className, ...props }: AutocompletePrimitive.Group.Props) {
  return (
    <AutocompletePrimitive.Group
      data-slot="command-group"
      className={cn("overflow-hidden text-foreground not-last:mb-1", className)}
      {...props}
    />
  );
}

function CommandGroupLabel({ className, ...props }: AutocompletePrimitive.GroupLabel.Props) {
  return (
    <AutocompletePrimitive.GroupLabel
      data-slot="command-group-label"
      className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

const CommandCollection = AutocompletePrimitive.Collection;

function CommandSeparator({ className, ...props }: AutocompletePrimitive.Separator.Props) {
  return (
    <AutocompletePrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex min-h-8 cursor-default scroll-my-1 items-center gap-2 rounded-none px-2 py-2 text-xs outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-muted data-highlighted:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto text-xs tracking-widest text-muted-foreground group-data-highlighted/command-item:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandCollection,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
};
