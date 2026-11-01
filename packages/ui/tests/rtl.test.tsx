// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Right-to-left (ADR 0029 decision 5): the design system renders under `dir="rtl"` with logical
 * classes only. A physical class may appear only when its source line says why
 * (`rtl-physical: <reason>`), and directional icons ("next", "back", a submenu chevron) flip.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { act, render, screen } from "@testing-library/react";
import type * as React from "react";
import { describe, expect, it } from "vite-plus/test";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChatMessage, ChatPanel } from "../src/blocks/media/chat.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "../src/components/breadcrumb.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Field, FieldLabel } from "../src/components/field.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../src/components/input-group.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../src/components/pagination.tsx";
import { Sheet, SheetContent, SheetTitle } from "../src/components/sheet.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "../src/components/sidebar.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs.tsx";
import { StreamCard } from "../src/primitives/stream-card.tsx";
import { Toaster, toast } from "../src/toast.tsx";

// The scanner of apps/web/tests/logical-css.test.ts (a local copy: test files do not export).
const NEEDS_VALUE = ["scroll-ml", "scroll-mr", "scroll-pl", "scroll-pr", "ml", "mr", "pl", "pr", "left", "right"];
const STANDS_ALONE = [
  "border-l",
  "border-r",
  "rounded-l",
  "rounded-r",
  "rounded-tl",
  "rounded-tr",
  "rounded-bl",
  "rounded-br",
  "text-left",
  "text-right",
  "float-left",
  "float-right",
  "clear-left",
  "clear-right",
];
const VALUE = String.raw`[A-Za-z0-9_.%/\[\]()#,'-]+`;
const UTILITY = new RegExp(
  String.raw`(?<![\w-])!?-?(?:${NEEDS_VALUE.join("|")})-${VALUE}!?(?![\w-])` +
    String.raw`|(?<![\w-])!?-?(?:${STANDS_ALONE.join("|")})(?:-${VALUE})?!?(?![\w-])`,
  "g",
);
const ALLOW = /rtl-physical:\s*\S/;

/** Whether one class token (`md:ml-2`, `data-[side=left]:-right-1`) is a physical-direction utility. */
function isPhysical(token: string): boolean {
  // The utility is what follows the last variant colon outside brackets.
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === ":" && depth === 0) start = i + 1;
  }
  const utility = token.slice(start);
  return [...utility.matchAll(UTILITY)].some((m) => m[0] === utility);
}

const SRC = join(import.meta.dirname, "..", "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/**
 * Per source file (relative to `src`), every class token written on a line that carries an
 * `rtl-physical:` comment. Exemptions are per file so a token commented in one component does not
 * excuse the same token rendered by another.
 */
const commentedByFile = new Map(
  walk(SRC).map((file) => [
    relative(SRC, file),
    new Set(
      readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => ALLOW.test(line))
        .flatMap((line) => [...line.matchAll(/"([^"\n]*)"/g)].flatMap((m) => (m[1] ?? "").split(/\s+/))),
    ),
  ]),
);

/** Tokens a file's `rtl-physical:` lines exempt (empty for a file with none). */
function commentedIn(file: string): Set<string> {
  return commentedByFile.get(file) ?? new Set();
}

/**
 * Physical classes rendered anywhere in the document that no source comment explains. Only the
 * exemptions of `exemptFrom` (the component files a test renders that carry `rtl-physical:` lines)
 * apply; by default none do.
 */
function uncommentedPhysical(...exemptFrom: string[]): string[] {
  const exempt = new Set(exemptFrom.flatMap((file) => [...commentedIn(file)]));
  const found = new Set<string>();
  for (const el of document.body.querySelectorAll("[class]")) {
    const tokens = (el.getAttribute("class") ?? "").split(/\s+/);
    for (const token of tokens) if (token && isPhysical(token) && !exempt.has(token)) found.add(token);
  }
  return [...found].sort();
}

function inRtl(ui: React.ReactNode) {
  return render(<div dir="rtl">{ui}</div>);
}

const stream: StreamCardData = {
  channel: { id: "c1", slug: "fern", displayName: "Fernsby", avatarUrl: null, accent: "teal" },
  broadcast: {
    id: "b1",
    title: "بث مباشر",
    category: { id: "g1", slug: "games", name: "Games" },
    startedAt: "2026-10-19T10:00:00Z",
    mature: false,
    viewerCount: 42,
    thumbnailUrl: null,
  },
  tags: ["cozy"],
  language: "ar",
  reason: "spotlight",
};

describe("the scanner copy", () => {
  it("flags physical tokens with variants and leaves logical ones", () => {
    expect(isPhysical("md:ml-2")).toBe(true);
    expect(isPhysical("data-[side=left]:-right-1")).toBe(true);
    expect(isPhysical("has-data-[icon=inline-end]:pr-1.5")).toBe(true);
    expect(isPhysical("border-l")).toBe(true);
    expect(isPhysical("text-right")).toBe(true);
    expect(isPhysical("ms-2")).toBe(false);
    expect(isPhysical("data-[side=left]:start-0")).toBe(false);
    expect(isPhysical("rtl:rotate-180")).toBe(false);
    expect(isPhysical("-translate-x-1/2")).toBe(false);
  });

  it("only exempts tokens written on commented lines", () => {
    // The tooltip arrow and the drawer's swipe edges are the physical exceptions.
    expect(commentedIn("components/tooltip.tsx").has("data-[side=left]:-right-1")).toBe(true);
    expect(commentedIn("components/drawer.tsx").has("data-[swipe-direction=left]:left-0")).toBe(true);
    expect(commentedIn("components/tooltip.tsx").has("data-[side=left]:start-0")).toBe(false);
    // An exemption does not leak to another file.
    expect(commentedIn("components/sidebar.tsx").has("data-[side=left]:-right-1")).toBe(false);
  });
});

describe("components under dir=rtl", () => {
  it("sidebar: logical classes, start-side by default, trigger icon mirrors", () => {
    const { container } = inRtl(
      <SidebarProvider>
        <Sidebar collapsible="offcanvas">
          <SidebarContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton>Directory</SidebarMenuButton>
                <SidebarMenuAction>…</SidebarMenuAction>
                <SidebarMenuSub>
                  <SidebarMenuSubItem>
                    <SidebarMenuSubButton href="/a">A</SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                </SidebarMenuSub>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarContent>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>,
    );
    expect(uncommentedPhysical()).toEqual([]);
    const panel = container.querySelector('[data-slot="sidebar-container"]');
    expect(panel?.className).toContain("data-[side=left]:start-0");
    expect(panel?.className).toContain("group-data-[side=left]:border-e");
    const trigger = container.querySelector('[data-slot="sidebar-trigger"] svg');
    expect(trigger?.getAttribute("class")).toContain("rtl:-scale-x-100");
  });

  it("sheet: side=left opens at the inline start, close button at the inline end", () => {
    inRtl(
      <Sheet open>
        <SheetContent side="left">
          <SheetTitle>Menu</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    expect(uncommentedPhysical()).toEqual([]);
    const popup = document.querySelector('[data-slot="sheet-content"]');
    expect(popup?.className).toContain("data-[side=left]:start-0");
    expect(popup?.className).toContain("rtl:data-[side=left]:data-starting-style:-translate-x-[-2.5rem]");
    expect(document.querySelector('[data-slot="sheet-close"]')?.className).toContain("end-3");
  });

  it("pagination: previous and next arrows flip", () => {
    const { container } = inRtl(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="/1" />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="/2" isActive>
              2
            </PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="/3" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>,
    );
    expect(uncommentedPhysical()).toEqual([]);
    const icons = [...container.querySelectorAll("svg[data-icon]")];
    expect(icons).toHaveLength(2);
    for (const icon of icons) expect(icon.getAttribute("class")).toContain("rtl:rotate-180");
  });

  it("breadcrumb: logical classes", () => {
    inRtl(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Settings</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );
    expect(uncommentedPhysical()).toEqual([]);
  });

  it("breadcrumb: the separator chevron flips", () => {
    const { container } = inRtl(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">Home</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
        </BreadcrumbList>
      </Breadcrumb>,
    );
    const icon = container.querySelector('[data-slot="breadcrumb-separator"] svg');
    expect(icon?.getAttribute("class") ?? "").toContain("rtl:rotate-180");
  });

  it("dropdown menu: submenu opens at the inline end and its chevron flips", () => {
    inRtl(
      <DropdownMenu open>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem inset>
            Copy <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSub open>
            <DropdownMenuSubTrigger>More</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Share</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    expect(uncommentedPhysical()).toEqual([]);
    const chevron = document.querySelector('[data-slot="dropdown-menu-sub-trigger"] svg');
    expect(chevron?.getAttribute("class")).toContain("rtl:rotate-180");
    expect(document.querySelector('[data-slot="dropdown-menu-item"][data-inset]')?.className).toContain(
      "data-inset:ps-7",
    );
  });

  it("toast: logical classes", async () => {
    inRtl(<Toaster />);
    act(() => {
      toast.success("تم الحفظ", { description: "Saved" });
    });
    expect(await screen.findByText("تم الحفظ")).toBeTruthy();
    expect(uncommentedPhysical()).toEqual([]);
    act(() => toast.dismiss());
  });

  it("stream card and chat row: logical classes", () => {
    inRtl(
      <>
        <StreamCard stream={stream} href="/fern" />
        <ChatPanel title="Chat" logLabel="Messages" newMessagesLabel="New messages">
          <ChatMessage author="Fern" body="مرحبا" colorIndex={2} />
        </ChatPanel>
      </>,
    );
    expect(uncommentedPhysical()).toEqual([]);
  });

  it("form field with a leading icon: the addon pads the inline start", () => {
    const { container } = inRtl(
      <Field>
        <FieldLabel htmlFor="q">Search</FieldLabel>
        <InputGroup>
          <InputGroupAddon align="inline-start">
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput id="q" />
        </InputGroup>
      </Field>,
    );
    expect(uncommentedPhysical()).toEqual([]);
    expect(container.querySelector('[data-slot="input-group-addon"]')?.className).toContain("ps-2");
  });

  it("tabs: logical classes", () => {
    inRtl(
      <Tabs defaultValue="a" orientation="vertical">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
          <TabsTrigger value="b">B</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel</TabsContent>
      </Tabs>,
    );
    expect(uncommentedPhysical()).toEqual([]);
  });
});
