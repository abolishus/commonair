// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * PlayerChrome's popup layer. While the player is fullscreen its root is a grid; a portal `<div>`
 * appended to the root itself would take a second grid row and halve the picture. Popups go to
 * `data-slot="player-portal"` instead, an absolutely positioned (out of flow) layer, so the
 * AspectRatio stays the root's only in-flow child. `document.fullscreenElement` is stubbed.
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { PlayerChrome } from "../../src/blocks/media/player-chrome.tsx";
import { Button } from "../../src/components/button.tsx";
import { Dialog, DialogContent, DialogTitle } from "../../src/components/dialog.tsx";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../src/components/tooltip.tsx";
import { PortalContainerProvider } from "../../src/lib/portal-container.tsx";

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(document, "fullscreenElement");
});

function setFullscreen(el: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, value: el });
  act(() => void document.dispatchEvent(new Event("fullscreenchange")));
}

async function slot(name: string): Promise<Element> {
  return await waitFor(() => {
    const el = document.querySelector(`[data-slot="${name}"]`);
    if (!el) throw new Error(`no ${name}`);
    return el;
  });
}

/** A tooltip in the controls and a dialog beside the chrome, wired like the web players. */
function Harness() {
  const [layer, setLayer] = React.useState<HTMLDivElement | null>(null);
  const [fullscreen, setFs] = React.useState(false);
  React.useEffect(() => {
    const sync = () => setFs(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return (
    <TooltipProvider>
      <PortalContainerProvider container={fullscreen ? layer : null}>
        <PlayerChrome
          data-testid="chrome"
          variant="vod"
          portalRef={setLayer}
          controls={
            <Tooltip open>
              <TooltipTrigger render={<Button>Tip</Button>} />
              <TooltipContent>Tooltip body</TooltipContent>
            </Tooltip>
          }
        >
          <div />
        </PlayerChrome>
        <Dialog open>
          <DialogContent>
            <DialogTitle>Dialog</DialogTitle>
          </DialogContent>
        </Dialog>
      </PortalContainerProvider>
    </TooltipProvider>
  );
}

describe("PlayerChrome popup layer", () => {
  test("is an absolute, click-through layer over the player", async () => {
    render(<Harness />);
    const layer = await slot("player-portal");
    expect(layer.className).toContain("absolute");
    expect(layer.className).toContain("inset-0");
    expect(layer.className).toContain("pointer-events-none");
  });

  test("outside fullscreen popups portal to <body>, outside the player", async () => {
    render(<Harness />);
    const chrome = document.querySelector('[data-slot="player-chrome"]')!;
    expect(chrome.contains(await slot("tooltip-content"))).toBe(false);
    expect(chrome.contains(await slot("dialog-content"))).toBe(false);
  });

  test("in fullscreen popups land in the layer and the picture stays the only in-flow child", async () => {
    render(<Harness />);
    const chrome = document.querySelector<HTMLElement>('[data-slot="player-chrome"]')!;
    setFullscreen(chrome);
    await waitFor(() => expect(chrome.hasAttribute("data-fullscreen")).toBe(true));
    const layer = await slot("player-portal");
    await waitFor(() => expect(layer.contains(document.querySelector('[data-slot="tooltip-content"]'))).toBe(true));
    await waitFor(() => expect(layer.contains(document.querySelector('[data-slot="dialog-content"]'))).toBe(true));
    // Every direct child but the AspectRatio is absolutely positioned (out of the grid's flow).
    const inFlow = [...chrome.children].filter((c) => !c.classList.contains("absolute"));
    expect(inFlow).toHaveLength(1);
    expect(inFlow[0]?.getAttribute("data-slot")).toBe("aspect-ratio");
  });

  test("hands the layer to portalRef, and null on unmount", async () => {
    const seen: (HTMLDivElement | null)[] = [];
    const { unmount } = render(
      <PlayerChrome variant="vod" portalRef={(el) => void seen.push(el)}>
        <div />
      </PlayerChrome>,
    );
    expect(seen[0]).toBe(await slot("player-portal"));
    unmount();
    expect(seen.at(-1)).toBeNull();
  });
});
