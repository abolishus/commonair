// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Portal `container` on PopoverContent, DropdownMenuContent, DialogContent and TooltipContent:
 * `<body>` is not painted while another element is fullscreen, so a fullscreen player portals its
 * popups into itself, explicitly or through `PortalContainerProvider`.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { Button } from "../src/components/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../src/components/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../src/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../src/components/popover.tsx";
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

describe("dropdown menu parts", () => {
  test("a submenu's content follows the provider's container too", async () => {
    const target = makeHost();
    render(
      <PortalContainerProvider container={target}>
        <DropdownMenu open>
          <DropdownMenuTrigger render={<Button>Menu</Button>} />
          <DropdownMenuContent>
            <DropdownMenuSub open>
              <DropdownMenuSubTrigger inset>More</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem>Nested</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      </PortalContainerProvider>,
    );
    const sub = await slot("dropdown-menu-sub-content");
    expect(target.contains(sub)).toBe(true);
    expect(screen.getByText("Nested").closest('[data-slot="dropdown-menu-sub-content"]')).toBe(sub);
    const trigger = await slot("dropdown-menu-sub-trigger");
    expect(trigger.hasAttribute("data-inset")).toBe(true);
    // The chevron follows the label.
    expect(trigger.querySelector("svg")).toBeTruthy();
  });

  test("checkbox items toggle and show their indicator only while checked", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn<(checked: boolean, details: unknown) => void>();
    const { rerender } = render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<Button>Menu</Button>} />
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked={false} onCheckedChange={onCheckedChange} closeOnClick={false}>
            Captions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const item = await screen.findByRole("menuitemcheckbox", { name: "Captions" });
    expect(item.getAttribute("aria-checked")).toBe("false");
    expect(item.querySelector('[data-slot="dropdown-menu-checkbox-item-indicator"] svg')).toBeNull();
    await user.click(item);
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
    rerender(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<Button>Menu</Button>} />
        <DropdownMenuContent>
          <DropdownMenuCheckboxItem checked inset>
            Captions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const checked = screen.getByRole("menuitemcheckbox", { name: "Captions" });
    expect(checked.getAttribute("aria-checked")).toBe("true");
    expect(checked.hasAttribute("data-inset")).toBe(true);
    expect(checked.querySelector('[data-slot="dropdown-menu-checkbox-item-indicator"] svg')).toBeTruthy();
  });

  test("radio items report the picked value; label, separator and shortcut render in the group", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(value: unknown, details: unknown) => void>();
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger render={<Button>Menu</Button>} />
        <DropdownMenuContent>
          <DropdownMenuGroup>
            <DropdownMenuLabel inset>Quality</DropdownMenuLabel>
            <DropdownMenuRadioGroup value="auto" onValueChange={onValueChange}>
              <DropdownMenuRadioItem value="auto">Auto</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="720p" inset closeOnClick={false}>
                720p
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive">
            Report <DropdownMenuShortcut>R</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const auto = await screen.findByRole("menuitemradio", { name: "Auto" });
    const hd = screen.getByRole("menuitemradio", { name: "720p" });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(hd.getAttribute("aria-checked")).toBe("false");
    expect(auto.querySelector('[data-slot="dropdown-menu-radio-item-indicator"] svg')).toBeTruthy();
    expect(hd.hasAttribute("data-inset")).toBe(true);
    await user.click(hd);
    expect(onValueChange).toHaveBeenCalledWith("720p", expect.anything());
    expect((await slot("dropdown-menu-label")).textContent).toBe("Quality");
    expect((await slot("dropdown-menu-group")).contains(auto)).toBe(true);
    expect(screen.getByRole("separator").getAttribute("data-slot")).toBe("dropdown-menu-separator");
    expect((await slot("dropdown-menu-shortcut")).textContent).toBe("R");
    expect((await slot("dropdown-menu-item")).getAttribute("data-variant")).toBe("destructive");
  });

  test("the bare portal mounts its children in a given container", async () => {
    const target = makeHost();
    render(
      <DropdownMenu open>
        <DropdownMenuPortal container={target}>
          <div data-testid="in-portal" />
        </DropdownMenuPortal>
      </DropdownMenu>,
    );
    await waitFor(() => expect(target.contains(screen.getByTestId("in-portal"))).toBe(true));
  });
});

describe("popover and dialog parts", () => {
  test("a popover header names and describes the popup", async () => {
    render(
      <Popover open>
        <PopoverTrigger render={<Button>Open</Button>} />
        <PopoverContent>
          <PopoverHeader className="extra">
            <PopoverTitle>Share</PopoverTitle>
            <PopoverDescription>Copy a link to this moment.</PopoverDescription>
          </PopoverHeader>
        </PopoverContent>
      </Popover>,
    );
    const dialog = await screen.findByRole("dialog");
    expect((await slot("popover-header")).className).toContain("extra");
    const title = await slot("popover-title");
    const description = await slot("popover-description");
    expect(dialog.getAttribute("aria-labelledby")).toBe(title.id);
    expect(dialog.getAttribute("aria-describedby")).toBe(description.id);
  });

  test("the dialog footer has no close button by default and a working one on request", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn<(open: boolean, details: unknown) => void>();
    const { rerender } = render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog</DialogTitle>
          <DialogFooter>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const footer = await slot("dialog-footer");
    expect(footer.querySelectorAll("button")).toHaveLength(1);
    rerender(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>Dialog</DialogTitle>
          <DialogFooter showCloseButton>
            <Button>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const close = screen.getByRole("button", { name: "Close" });
    expect(footer.contains(close)).toBe(true);
    await user.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false, expect.anything());
  });

  test("a trigger opens the dialog; the header describes it and DialogClose closes it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger render={<Button>Open dialog</Button>} />
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete clip</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogClose render={<Button>Cancel</Button>} />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete clip" });
    expect(dialog.getAttribute("aria-describedby")).toBe((await slot("dialog-description")).id);
    expect((await slot("dialog-header")).contains(await slot("dialog-title"))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
