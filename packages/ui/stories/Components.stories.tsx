// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The shadcn (base-lyra on Base UI) building blocks, themed by our tokens. */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "../src/components/badge.tsx";
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

function Gallery() {
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
