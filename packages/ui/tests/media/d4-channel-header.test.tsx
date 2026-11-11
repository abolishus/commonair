// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul D4.1 and D4.7 on `ChannelHeader`: the compact phone row leaves the stream title out
 * below `lg` (the watch page shows it in About), and a note follows the viewer count.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ChannelHeader } from "../../src/blocks/media/channel-header.tsx";

afterEach(cleanup);

const title = (root: HTMLElement) => root.querySelector('[data-slot="channel-header-title"]');

describe("ChannelHeader (D4)", () => {
  test("compactBelowLg hides only the title below lg", () => {
    const { container, rerender } = render(<ChannelHeader name="Fernsby" live title="Building a village" />);
    expect(title(container)?.className).not.toContain("max-lg:hidden");
    rerender(<ChannelHeader name="Fernsby" live title="Building a village" compactBelowLg />);
    expect(title(container)?.className).toContain("max-lg:hidden");
    expect(title(container)?.textContent).toBe("Building a village");
  });

  test("the viewer count note sits right after the count", () => {
    const { container } = render(
      <ChannelHeader
        name="Fernsby"
        live
        viewerCount={12}
        viewerCountNote={<span data-testid="note">Verified viewers</span>}
        uptime={<span data-testid="uptime">1:00</span>}
      />,
    );
    const count = container.querySelector('[data-slot="viewer-count"]');
    expect(count?.nextElementSibling?.getAttribute("data-testid")).toBe("note");
  });

  test("a note alone still renders the stats row", () => {
    const { getByTestId } = render(
      <ChannelHeader name="Fernsby" viewerCountNote={<span data-testid="note">x</span>} />,
    );
    expect(getByTestId("note")).toBeTruthy();
  });
});
