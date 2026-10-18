// SPDX-FileCopyrightText: 2023 shadcn (https://ui.shadcn.com, MIT)
// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import { useUiMessages } from "@commonair/ui/lib/locale";

import { Button } from "@commonair/ui/components/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon, ArrowRight01Icon, MoreHorizontalCircle01Icon } from "@hugeicons/core-free-icons";

function Pagination({ className, ...props }: React.ComponentProps<"nav">) {
  const messages = useUiMessages();
  return (
    <nav
      role="navigation"
      aria-label={messages.pagination}
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

function PaginationContent({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="pagination-content" className={cn("flex items-center gap-0.5", className)} {...props} />;
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
  isActive?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> &
  React.ComponentProps<"a">;

function PaginationLink({ className, isActive, size = "icon", ...props }: PaginationLinkProps) {
  return (
    <Button
      variant={isActive ? "outline" : "ghost"}
      size={size}
      className={cn(className)}
      nativeButton={false}
      render={
        <a aria-current={isActive ? "page" : undefined} data-slot="pagination-link" data-active={isActive} {...props} />
      }
    />
  );
}

function PaginationPrevious({
  className,
  text,
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  const messages = useUiMessages();
  return (
    <PaginationLink aria-label={messages.previousPage} size="default" className={cn("pl-1.5!", className)} {...props}>
      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} data-icon="inline-start" />
      <span className="hidden sm:block">{text ?? messages.previous}</span>
    </PaginationLink>
  );
}

function PaginationNext({
  className,
  text,
  ...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
  const messages = useUiMessages();
  return (
    <PaginationLink aria-label={messages.nextPage} size="default" className={cn("pr-1.5!", className)} {...props}>
      <span className="hidden sm:block">{text ?? messages.next}</span>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
    </PaginationLink>
  );
}

function PaginationEllipsis({ className, ...props }: React.ComponentProps<"span">) {
  const messages = useUiMessages();
  return (
    <span
      aria-hidden
      data-slot="pagination-ellipsis"
      className={cn("flex size-8 items-center justify-center [&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      <HugeiconsIcon icon={MoreHorizontalCircle01Icon} strokeWidth={2} />
      <span className="sr-only">{messages.morePages}</span>
    </span>
  );
}

export {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
};
