// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portal `container` on PopoverContent, DropdownMenuContent, DialogContent and TooltipContent:
 * `<body>` is not painted while another element is fullscreen, so a fullscreen player portals its
 * popups into itself, explicitly or through `PortalContainerProvider`.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { Button } from "../src/components/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "../src/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../src/components/tooltip.tsx";
import { PortalContainerProvider, type PortalContainer } from "../src/index.ts";

let host: HTMLElement;
function makeHost(): HTMLElement {
  host = document.createElement("div");
  host.dataset.testid = "host";
  document.body.append(host);
  return host;
}

afterEach(() => {
  cleanup();
  host?.remove();
});

function popups(container?: PortalContainer): Array<[string, React.ReactElement]> {
  return [
    [
      "popover-content",
      <Popover key="p" open>
        <PopoverTrigger render={<Button>Open</Button>} />
        <PopoverContent container={container}>Popover body</PopoverContent>
      </Popover>,
    ],
    [
      "dropdown-menu-content",
      <DropdownMenu key="m" open>
        <DropdownMenuTrigger render={<Button>Menu</Button>} />
        <DropdownMenuContent container={container}>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    ],
    [
      "dialog-content",
      <Dialog key="d" open>
        <DialogContent container={container}>
          <DialogTitle>Dialog</DialogTitle>
        </DialogContent>
      </Dialog>,
    ],
    [
      "tooltip-content",
      <TooltipProvider key="t">
        <Tooltip open>
          <TooltipTrigger render={<Button>Tip</Button>} />
          <TooltipContent container={container}>Tooltip body</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    ],
  ];
}

async function slot(name: string): Promise<Element> {
  return await waitFor(() => {
    const el = document.querySelector(`[data-slot="${name}"]`);
    if (!el) throw new Error(`no ${name}`);
    return el;
  });
}

describe("portal container", () => {
  test.each(popups().map(([name]) => name))("%s portals to <body> by default", async (name) => {
    const target = makeHost();
    const node = popups().find(([n]) => n === name)![1];
    render(node);
    const content = await slot(name);
    expect(target.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });

  test.each(popups().map(([name]) => name))("%s lands in an explicit container", async (name) => {
    const target = makeHost();
    const node = popups(target).find(([n]) => n === name)![1];
    render(node);
    expect(target.contains(await slot(name))).toBe(true);
  });

  test.each(popups().map(([name]) => name))("%s lands in the provider's container", async (name) => {
    const target = makeHost();
    const node = popups().find(([n]) => n === name)![1];
    render(<PortalContainerProvider container={target}>{node}</PortalContainerProvider>);
    expect(target.contains(await slot(name))).toBe(true);
  });

  test("an explicit container wins over the provider's; a null provider keeps <body>", async () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    const target = makeHost();
    const { unmount } = render(
      <PortalContainerProvider container={outer}>
        <Dialog open>
          <DialogContent container={target}>
            <DialogTitle>Dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>,
    );
    expect(target.contains(await slot("dialog-content"))).toBe(true);
    expect(outer.contains(document.querySelector('[data-slot="dialog-content"]'))).toBe(false);
    unmount();
    render(
      <PortalContainerProvider container={null}>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>,
    );
    const content = await slot("dialog-content");
    expect(outer.contains(content) || target.contains(content)).toBe(false);
    expect(screen.getByRole("dialog")).toBe(content);
    outer.remove();
  });

  test("an explicit null container escapes the provider to <body>", async () => {
    const target = makeHost();
    render(
      <PortalContainerProvider container={target}>
        <Dialog open>
          <DialogContent container={null}>
            <DialogTitle>Dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>,
    );
    const content = await slot("dialog-content");
    expect(target.contains(content)).toBe(false);
    expect(document.body.contains(content)).toBe(true);
  });
});
