// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test } from "vite-plus/test";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../src/components/accordion.tsx";
import { Alert, AlertDescription, AlertTitle } from "../src/components/alert.tsx";
import { AspectRatio } from "../src/components/aspect-ratio.tsx";
import { Avatar, AvatarFallback } from "../src/components/avatar.tsx";
import { Badge } from "../src/components/badge.tsx";
import { ButtonGroup } from "../src/components/button-group.tsx";
import { Button } from "../src/components/button.tsx";
import { Card, CardContent } from "../src/components/card.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "../src/components/breadcrumb.tsx";
import { Checkbox } from "../src/components/checkbox.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible.tsx";
import { Combobox, ComboboxContent, ComboboxItem, ComboboxInput, ComboboxList } from "../src/components/combobox.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../src/components/command.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../src/components/context-menu.tsx";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../src/components/dialog.tsx";
import { Drawer, DrawerContent, DrawerTitle, DrawerTrigger } from "../src/components/drawer.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Empty, EmptyTitle } from "../src/components/empty.tsx";
import { Field, FieldLabel } from "../src/components/field.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../src/components/hover-card.tsx";
import { Input } from "../src/components/input.tsx";
import { InputGroup, InputGroupInput } from "../src/components/input-group.tsx";
import { Item } from "../src/components/item.tsx";
import { Kbd } from "../src/components/kbd.tsx";
import { Label } from "../src/components/label.tsx";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "../src/components/navigation-menu.tsx";
import { Pagination, PaginationContent, PaginationItem, PaginationLink } from "../src/components/pagination.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import { Progress } from "../src/components/progress.tsx";
import { RadioGroup, RadioGroupItem } from "../src/components/radio-group.tsx";
import { ScrollArea } from "../src/components/scroll-area.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/select.tsx";
import { Separator } from "../src/components/separator.tsx";
import { Skeleton } from "../src/components/skeleton.tsx";
import { Slider } from "../src/components/slider.tsx";
import { Spinner } from "../src/components/spinner.tsx";
import { Switch } from "../src/components/switch.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "../src/components/sidebar.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs.tsx";
import { Textarea } from "../src/components/textarea.tsx";
import { Toggle } from "../src/components/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "../src/components/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip.tsx";
import { Toaster } from "../src/components/sonner.tsx";

describe("shadcn component primitives", () => {
  test("renders navigation, command, menu, drawer and sidebar components", () => {
    render(
      <>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/">Home</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbItem>
              <BreadcrumbPage>Streams</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <Combobox items={["Art", "Games"]}>
          <ComboboxInput aria-label="Category" />
          <ComboboxContent>
            <ComboboxList>
              <ComboboxItem value="Art">Art</ComboboxItem>
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Command>
          <CommandInput aria-label="Find command" />
          <CommandList>
            <CommandEmpty>No results</CommandEmpty>
            <CommandItem>Open stream</CommandItem>
          </CommandList>
        </Command>
        <ContextMenu>
          <ContextMenuTrigger>Context target</ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Copy link</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button>Actions</Button>} />
          <DropdownMenuContent>
            <DropdownMenuItem>Share</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Drawer>
          <DrawerTrigger render={<Button>Open drawer</Button>} />
          <DrawerContent>
            <DrawerTitle>Mobile settings</DrawerTitle>
          </DrawerContent>
        </Drawer>
        <NavigationMenu>
          <NavigationMenuList>
            <NavigationMenuItem>
              <NavigationMenuLink href="/">Browse</NavigationMenuLink>
            </NavigationMenuItem>
          </NavigationMenuList>
        </NavigationMenu>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="/page/1" isActive>
                1
              </PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <SidebarProvider>
          <Sidebar>
            <SidebarContent>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton>Directory</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarContent>
          </Sidebar>
        </SidebarProvider>
        <Toaster />
      </>,
    );

    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Find command" })).toBeTruthy();
    expect(screen.getByText("Context target")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open drawer" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Browse" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Pagination" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Directory" })).toBeTruthy();
  });

  test("renders the base, form, data and overlay primitives with accessible names", () => {
    render(
      <>
        <Button>Save</Button>
        <Badge>Live</Badge>
        <ButtonGroup aria-label="Playback controls">
          <Button>Play</Button>
        </ButtonGroup>
        <Card>
          <CardContent>Card content</CardContent>
        </Card>
        <Avatar>
          <AvatarFallback>CA</AvatarFallback>
        </Avatar>
        <AspectRatio ratio={16 / 9}>
          <div>Preview</div>
        </AspectRatio>
        <Alert>
          <AlertTitle>Notice</AlertTitle>
          <AlertDescription>Service is healthy</AlertDescription>
        </Alert>
        <Empty>
          <EmptyTitle>No streams</EmptyTitle>
        </Empty>
        <Field>
          <FieldLabel htmlFor="title">Title</FieldLabel>
          <Input id="title" />
        </Field>
        <Label htmlFor="about">About</Label>
        <Textarea id="about" />
        <InputGroup>
          <InputGroupInput aria-label="Search" />
        </InputGroup>
        <Item>List item</Item>
        <Kbd>⌘K</Kbd>
        <Separator />
        <Progress value={50} aria-label="Upload progress" />
        <RadioGroup aria-label="Tier" defaultValue="one">
          <RadioGroupItem value="one" aria-label="One" />
        </RadioGroup>
        <Checkbox aria-label="Remember me" />
        <Switch aria-label="Notifications" />
        <Slider aria-label="Volume" defaultValue={[40]} />
        <Toggle aria-label="Bold">B</Toggle>
        <ToggleGroup aria-label="View" defaultValue={["grid"]}>
          <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
        </ToggleGroup>
        <Tabs defaultValue="one">
          <TabsList>
            <TabsTrigger value="one">One</TabsTrigger>
          </TabsList>
          <TabsContent value="one">Tab panel</TabsContent>
        </Tabs>
        <Select defaultValue="one">
          <SelectTrigger aria-label="Choice">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="one">One</SelectItem>
          </SelectContent>
        </Select>
        <ScrollArea>
          <div>Scrollable content</div>
        </ScrollArea>
        <Skeleton aria-label="Loading row" />
        <Spinner />
        <Collapsible>
          <CollapsibleTrigger>Details</CollapsibleTrigger>
          <CollapsibleContent>More details</CollapsibleContent>
        </Collapsible>
        <Accordion>
          <AccordionItem value="item">
            <AccordionTrigger>More</AccordionTrigger>
            <AccordionContent>Details</AccordionContent>
          </AccordionItem>
        </Accordion>
        <Tooltip>
          <TooltipTrigger render={<Button>Help</Button>} />
          <TooltipContent>Help text</TooltipContent>
        </Tooltip>
        <Popover>
          <PopoverTrigger render={<Button>Popover</Button>} />
          <PopoverContent>Popover content</PopoverContent>
        </Popover>
        <HoverCard>
          <HoverCardTrigger render={<Button>Profile</Button>} />
          <HoverCardContent>Profile card</HoverCardContent>
        </HoverCard>
        <Dialog>
          <DialogTrigger render={<Button>Open dialog</Button>} />
          <DialogContent>
            <DialogTitle>Dialog title</DialogTitle>
          </DialogContent>
        </Dialog>
      </>,
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Remember me" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "One" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "One" })).toBeTruthy();
    expect(screen.getByText("Card content")).toBeTruthy();
  });

  test("tabs support arrow-key navigation and toggles expose their pressed state", async () => {
    render(
      <>
        <Tabs defaultValue="first">
          <TabsList>
            <TabsTrigger value="first">First</TabsTrigger>
            <TabsTrigger value="second">Second</TabsTrigger>
          </TabsList>
          <TabsContent value="first">Panel one</TabsContent>
          <TabsContent value="second">Panel two</TabsContent>
        </Tabs>
        <ToggleGroup aria-label="Display" defaultValue={["grid"]}>
          <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
          <ToggleGroupItem value="list">List</ToggleGroupItem>
        </ToggleGroup>
      </>,
    );
    const first = screen.getByRole("tab", { name: "First" });
    const user = userEvent.setup();
    await user.click(first);
    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Second" }));
    expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("Select opens from the keyboard and exposes its options", async () => {
    const user = userEvent.setup();
    render(
      <Select>
        <SelectTrigger aria-label="Keyboard category">
          <SelectValue placeholder="Choose" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="art">Art</SelectItem>
          <SelectItem value="games">Games</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("combobox", { name: "Keyboard category" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("option", { name: "Art" })).toBeTruthy();
  });

  test.each([
    ["Dialog", "Open dialog", "Dialog title"],
    ["Drawer", "Open drawer for focus test", "Drawer title"],
  ])("%s keeps focus inside while open and closes on Escape", async (_label, triggerLabel, title) => {
    const user = userEvent.setup();
    render(
      <>
        <Button>Outside action</Button>
        {triggerLabel === "Open dialog" ? (
          <Dialog>
            <DialogTrigger render={<Button>{triggerLabel}</Button>} />
            <DialogContent>
              <DialogTitle>{title}</DialogTitle>
              <Button>Inside action</Button>
            </DialogContent>
          </Dialog>
        ) : (
          <Drawer>
            <DrawerTrigger render={<Button>{triggerLabel}</Button>} />
            <DrawerContent>
              <DrawerTitle>{title}</DrawerTitle>
              <Button>Inside action</Button>
            </DrawerContent>
          </Drawer>
        )}
      </>,
    );

    await user.click(screen.getByRole("button", { name: triggerLabel }));
    const modal = await screen.findByRole("dialog");
    expect(modal.contains(document.activeElement)).toBe(true);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
