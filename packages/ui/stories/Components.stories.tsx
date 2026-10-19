// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The shadcn (base-lyra on Base UI) building blocks, themed by our tokens. */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "../src/components/badge.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../src/components/alert-dialog.tsx";
import { ChartContainer } from "../src/components/chart.tsx";
import { Alert, AlertDescription, AlertTitle } from "../src/components/alert.tsx";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../src/components/accordion.tsx";
import { AspectRatio } from "../src/components/aspect-ratio.tsx";
import { Avatar, AvatarFallback } from "../src/components/avatar.tsx";
import { ButtonGroup } from "../src/components/button-group.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "../src/components/breadcrumb.tsx";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible.tsx";
import { Combobox, ComboboxContent, ComboboxInput, ComboboxItem, ComboboxList } from "../src/components/combobox.tsx";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "../src/components/command.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../src/components/context-menu.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../src/components/dialog.tsx";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle, DrawerTrigger } from "../src/components/drawer.tsx";
import { Empty, EmptyTitle } from "../src/components/empty.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../src/components/hover-card.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../src/components/input-group.tsx";
import { Item, ItemDescription, ItemTitle } from "../src/components/item.tsx";
import { Kbd } from "../src/components/kbd.tsx";
import { Label } from "../src/components/label.tsx";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "../src/components/navigation-menu.tsx";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "../src/components/pagination.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import { RadioGroup, RadioGroupItem } from "../src/components/radio-group.tsx";
import { ScrollArea } from "../src/components/scroll-area.tsx";
import { Separator } from "../src/components/separator.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "../src/components/sidebar.tsx";
import { Skeleton } from "../src/components/skeleton.tsx";
import { Spinner } from "../src/components/spinner.tsx";
import { Toggle } from "../src/components/toggle.tsx";
import { ToggleGroup, ToggleGroupItem } from "../src/components/toggle-group.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip.tsx";
import { Toaster } from "../src/components/sonner.tsx";
import { AccentButton } from "../src/primitives/accent-button.tsx";
import { OverlayBadge } from "../src/primitives/overlay-badge.tsx";
import { StatusBadge } from "../src/primitives/status-badge.tsx";
import { Button } from "../src/components/button.tsx";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../src/components/card.tsx";
import { Checkbox } from "../src/components/checkbox.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "../src/components/field.tsx";
import { Input } from "../src/components/input.tsx";
import { Progress } from "../src/components/progress.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../src/components/sheet.tsx";
import { Slider } from "../src/components/slider.tsx";
import { Switch } from "../src/components/switch.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../src/components/table.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs.tsx";
import { Textarea } from "../src/components/textarea.tsx";
import { MoneyAmount } from "../src/index.ts";

export function Gallery() {
  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <section className="flex flex-wrap gap-2">
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">Destructive</Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
        <Badge>Badge</Badge>
        <Badge variant="outline">Outline</Badge>
        <Badge variant="destructive">Destructive</Badge>
        <StatusBadge tone="success">Verified</StatusBadge>
        <StatusBadge tone="warning">Review</StatusBadge>
        <StatusBadge tone="info">New</StatusBadge>
        <StatusBadge tone="danger">Blocked</StatusBadge>
        <StatusBadge tone="accent">Featured</StatusBadge>
        <OverlayBadge>12:34</OverlayBadge>
        <AccentButton accent="teal">Follow</AccentButton>
      </section>

      <section className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Controls</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-wrap gap-2">
            <ButtonGroup aria-label="Button sizes">
              <Button size="sm">Small</Button>
              <Button size="icon" aria-label="More">
                ⋯
              </Button>
            </ButtonGroup>
            <Toggle aria-label="Pin">Pin</Toggle>
            <ToggleGroup aria-label="View mode" defaultValue={["grid"]}>
              <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
              <ToggleGroupItem value="list">List</ToggleGroupItem>
            </ToggleGroup>
            <RadioGroup aria-label="Plan" defaultValue="free">
              <RadioGroupItem value="free" aria-label="Free" />
              <RadioGroupItem value="plus" aria-label="Plus" />
            </RadioGroup>
            <Label htmlFor="gallery-label">Label</Label>
            <Input id="gallery-label" placeholder="Input" />
            <InputGroup>
              <InputGroupInput aria-label="Search" placeholder="Search" />
              <InputGroupAddon>⌕</InputGroupAddon>
            </InputGroup>
            <Combobox items={["Games", "Art"]}>
              <ComboboxInput aria-label="Pick category" />
              <ComboboxContent>
                <ComboboxList>
                  <ComboboxItem value="Games">Games</ComboboxItem>
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <Spinner />
            <Skeleton className="w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Navigation and feedback</CardTitle>
          </CardHeader>
          <CardContent className="flex min-w-0 flex-col gap-3">
            <Breadcrumb>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink href="#">Home</BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbItem>
                  <BreadcrumbPage>Directory</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>
            <NavigationMenu>
              <NavigationMenuList>
                <NavigationMenuItem>
                  <NavigationMenuLink href="#">Browse channels</NavigationMenuLink>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious href="#" />
                </PaginationItem>
                <PaginationItem>
                  <PaginationLink href="#" isActive>
                    1
                  </PaginationLink>
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext href="#" />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
            <Alert>
              <AlertTitle>Stream health</AlertTitle>
              <AlertDescription>All systems operational.</AlertDescription>
            </Alert>
            <Empty>
              <EmptyTitle>No recent streams</EmptyTitle>
            </Empty>
            <Separator />
            <Item variant="outline">
              <ItemTitle>Featured channel</ItemTitle>
              <ItemDescription>Live now</ItemDescription>
            </Item>
            <Kbd>⌘ K</Kbd>
            <Avatar>
              <AvatarFallback>CA</AvatarFallback>
            </Avatar>
            <SidebarProvider>
              <Sidebar collapsible="none">
                <SidebarContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive>Directory</SidebarMenuButton>
                    </SidebarMenuItem>
                  </SidebarMenu>
                </SidebarContent>
              </Sidebar>
              <SidebarTrigger aria-label="Toggle sidebar" />
            </SidebarProvider>
          </CardContent>
        </Card>
      </section>

      <section className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Disclosure and overlays</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Accordion defaultValue={["one"]}>
              <AccordionItem value="one">
                <AccordionTrigger>Stream details</AccordionTrigger>
                <AccordionContent>Category and language</AccordionContent>
              </AccordionItem>
            </Accordion>
            <Collapsible>
              <CollapsibleTrigger>Show details</CollapsibleTrigger>
              <CollapsibleContent>Additional information</CollapsibleContent>
            </Collapsible>
            <AspectRatio ratio={16 / 9} className="bg-muted">
              <div className="flex size-full items-center justify-center">16:9 preview</div>
            </AspectRatio>
            <ScrollArea className="h-20">
              <div className="p-2">
                Scrollable channel list
                <br />
                More channels
                <br />
                More channels
              </div>
            </ScrollArea>
            <ChartContainer config={{ streams: { label: "Streams", color: "var(--chart-1)" } }} className="h-20 w-full">
              <div className="flex h-full items-end gap-2 border-b border-border px-2">
                <span className="h-1/2 flex-1 bg-chart-1" />
                <span className="h-3/4 flex-1 bg-chart-2" />
                <span className="h-full flex-1 bg-chart-3" />
              </div>
            </ChartContainer>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Menus and dialogs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <ContextMenu>
              <ContextMenuTrigger className="border p-3">Right click here</ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem>Share</ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline">Menu</Button>} />
              <DropdownMenuContent>
                <DropdownMenuItem>Share</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <PopoverTrigger render={<Button variant="outline">Popover</Button>} />
              <PopoverContent>Quick details</PopoverContent>
            </Popover>
            <HoverCard>
              <HoverCardTrigger render={<Button variant="link">Channel profile</Button>} />
              <HoverCardContent>Creator profile preview</HoverCardContent>
            </HoverCard>
            <Tooltip>
              <TooltipTrigger render={<Button variant="outline">Tooltip</Button>} />
              <TooltipContent>More information</TooltipContent>
            </Tooltip>
            <Dialog>
              <DialogTrigger render={<Button variant="outline">Dialog</Button>} />
              <DialogContent>
                <DialogTitle>Dialog title</DialogTitle>
                <DialogDescription>Dialog content</DialogDescription>
              </DialogContent>
            </Dialog>
            <Drawer>
              <DrawerTrigger render={<Button variant="outline">Drawer</Button>} />
              <DrawerContent>
                <DrawerTitle>Mobile settings</DrawerTitle>
                <DrawerDescription>Settings description</DrawerDescription>
              </DrawerContent>
            </Drawer>
            <AlertDialog>
              <AlertDialogTrigger render={<Button variant="destructive">Delete channel</Button>} />
              <AlertDialogContent>
                <AlertDialogTitle>Delete channel?</AlertDialogTitle>
                <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Command>
              <CommandInput placeholder="Search commands" />
              <CommandList>
                <CommandEmpty>No results</CommandEmpty>
                <CommandItem>Open channel</CommandItem>
              </CommandList>
            </Command>
            <Toaster />
          </CardContent>
        </Card>
      </section>

      <form className="flex flex-col gap-4" onSubmit={(e) => e.preventDefault()}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="title">Stream title</FieldLabel>
            <Input id="title" placeholder="What are you streaming?" />
            <FieldDescription>Shown on your channel and in the directory.</FieldDescription>
          </Field>
          <Field data-invalid="true">
            <FieldLabel htmlFor="slug">Channel name</FieldLabel>
            <Input id="slug" aria-invalid="true" defaultValue="Bad Name!" />
            <FieldError
              errors={["Use lowercase letters, digits and underscores", { message: "At least 3 characters" }]}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="about">About</FieldLabel>
            <Textarea id="about" placeholder="Tell viewers about your channel" />
          </Field>
          <Field orientation="horizontal">
            <Checkbox id="mature" />
            <FieldLabel htmlFor="mature">Mature content</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Switch id="vod" defaultChecked />
            <FieldLabel htmlFor="vod">Save past broadcasts</FieldLabel>
          </Field>
          <Field>
            <FieldLabel>Category</FieldLabel>
            <Select defaultValue="retro">
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="retro">Retro games</SelectItem>
                <SelectItem value="music">Music</SelectItem>
                <SelectItem value="art">Art</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Chat delay</FieldLabel>
            <Slider defaultValue={[2]} max={10} aria-label="Chat delay" />
          </Field>
        </FieldGroup>
      </form>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="payouts">Payouts</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Card>
            <CardHeader>
              <CardTitle>Monthly goal</CardTitle>
              <CardDescription>Subscriptions this month</CardDescription>
            </CardHeader>
            <CardContent>
              <Progress value={64} aria-label="Monthly goal" />
            </CardContent>
            <CardFooter>
              <MoneyAmount value={{ cents: 64_000, currency: "USD" }} />
            </CardFooter>
          </Card>
        </TabsContent>
        <TabsContent value="payouts">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-end">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>May</TableCell>
                <TableCell className="text-end">
                  <MoneyAmount value={{ cents: 123_456, currency: "USD" }} />
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell>April (refund)</TableCell>
                <TableCell className="text-end">
                  <MoneyAmount value={{ cents: -2_500, currency: "USD" }} colorNegative />
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TabsContent>
      </Tabs>

      <section className="flex flex-wrap gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline">Channel menu</Button>} />
          <DropdownMenuContent>
            <DropdownMenuItem>Share</DropdownMenuItem>
            <DropdownMenuItem>Report</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive">Block</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Sheet>
          <SheetTrigger render={<Button variant="outline">Open chat settings</Button>} />
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Chat settings</SheetTitle>
              <SheetDescription>Slow mode, followers-only and filters.</SheetDescription>
            </SheetHeader>
          </SheetContent>
        </Sheet>
      </section>
    </div>
  );
}

const meta = { title: "Components/Gallery", component: Gallery } satisfies Meta<typeof Gallery>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = {};
export const Light: Story = { globals: { theme: "light" } };
export const Mobile320: Story = { globals: { viewport: { value: "mobile320" } } };
export const RightToLeft: Story = { globals: { dir: "rtl" } };
