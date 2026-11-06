// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portal `container`: popovers, menus, dialogs and tooltips mount into a given element instead of
 * `<body>`. The "Go fullscreen" button puts the frame in fullscreen, where only its own subtree is
 * painted: the popups still show because they portal into it.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import * as React from "react";
import { Button } from "../src/components/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../src/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip.tsx";
import { PortalContainerProvider } from "../src/index.ts";

function Frame({ viaProvider }: { viaProvider: boolean }): React.JSX.Element {
  const [frame, setFrame] = React.useState<HTMLDivElement | null>(null);
  const container = viaProvider ? undefined : frame;
  const popups = (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => void frame?.requestFullscreen?.().catch(() => undefined)}>
        Go fullscreen
      </Button>
      <Popover>
        <PopoverTrigger render={<Button variant="outline">Popover</Button>} />
        <PopoverContent container={container}>Inside the frame</PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline">Menu</Button>} />
        <DropdownMenuContent container={container}>
          <DropdownMenuItem>Small</DropdownMenuItem>
          <DropdownMenuItem>Large</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog>
        <DialogTrigger render={<Button variant="outline">Dialog</Button>} />
        <DialogContent container={container}>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Mounted in the frame, so it shows in fullscreen.</DialogDescription>
        </DialogContent>
      </Dialog>
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline">Tooltip</Button>} />
        <TooltipContent container={container}>Also in the frame</TooltipContent>
      </Tooltip>
    </div>
  );
  return (
    <div ref={setFrame} className="flex min-h-48 flex-col gap-4 border border-border bg-background p-4">
      {viaProvider ? <PortalContainerProvider container={frame}>{popups}</PortalContainerProvider> : popups}
    </div>
  );
}

const meta = {
  title: "Components/PortalContainer",
  component: Frame,
  args: { viaProvider: false },
} satisfies Meta<typeof Frame>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Each content gets `container={frame}`. */
export const ExplicitContainer: Story = {};
/** `PortalContainerProvider` sets the default for everything below it (how the player does it). */
export const ViaProvider: Story = { args: { viaProvider: true } };
export const ViaProviderLight: Story = { args: { viaProvider: true }, globals: { theme: "light" } };
