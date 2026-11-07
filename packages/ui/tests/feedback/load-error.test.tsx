// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";
import { LoadError } from "../../src/blocks/feedback/index.ts";

describe("LoadError", () => {
  test("a section heading (h2 by default), the note, and Retry in a polite live region", () => {
    const retry = vi.fn<() => void>();
    render(
      <LoadError
        data-testid="err"
        retryTestId="err-retry"
        title="Recent videos didn't load."
        description="The rest of the page is fine."
        retryLabel="Retry"
        onRetry={retry}
      />,
    );
    const block = screen.getByTestId("err");
    expect(block.tagName).toBe("SECTION");
    expect(block.getAttribute("aria-live")).toBe("polite");
    expect(block.getAttribute("aria-atomic")).toBe("true");
    expect(block.getAttribute("data-busy")).toBeNull();
    expect(within(block).getByRole("heading", { level: 2 }).textContent).toBe("Recent videos didn't load.");
    expect(within(block).getByText("The rest of the page is fine.").tagName).toBe("P");
    fireEvent.click(within(block).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByTestId("err-retry").textContent).toBe("Retry");
  });

  test("headingLevel fits the outline; no description renders no paragraph", () => {
    render(
      <LoadError data-testid="err" title="Board didn't load." retryLabel="Retry" onRetry={() => {}} headingLevel={3} />,
    );
    const block = screen.getByTestId("err");
    expect(within(block).getByRole("heading", { level: 3 })).toBeTruthy();
    expect(block.querySelector("p")).toBeNull();
  });

  test("busy swaps the warning icon for a spinner that respects reduced motion", () => {
    const { container, rerender } = render(
      <LoadError title="x" retryLabel="Retry" onRetry={() => {}} data-testid="err" />,
    );
    const icon = () => container.querySelector("svg");
    expect(icon()?.getAttribute("aria-hidden")).toBe("true");
    expect(icon()?.getAttribute("class")).not.toContain("animate-spin");
    rerender(<LoadError title="x" retryLabel="Retry now" onRetry={() => {}} data-testid="err" busy />);
    expect(screen.getByTestId("err").getAttribute("data-busy")).toBe("true");
    expect(icon()?.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(screen.getByRole("button").textContent).toBe("Retry now");
  });

  test("only token classes, and it renders on the server", () => {
    const html = renderToString(<LoadError title="x" retryLabel="Retry" onRetry={() => {}} className="mt-2" />);
    expect(html).toContain('data-slot="load-error"');
    expect(html).toContain("bg-muted/40");
    expect(html).toContain("ring-border");
    expect(html).toContain("mt-2");
    expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });
});
