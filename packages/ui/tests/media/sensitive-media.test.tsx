// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { FrameTile, SensitiveMedia } from "../../src/blocks/media/index.ts";

afterEach(cleanup);

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

describe("SensitiveMedia", () => {
  test("obscured: blurred, grayscale, inert, with the overlay", () => {
    render(
      <SensitiveMedia obscured overlay={<p>Under review</p>} data-testid="shield">
        <p>media</p>
      </SensitiveMedia>,
    );
    const shield = screen.getByTestId("shield");
    expect(shield.getAttribute("data-obscured")).toBe("true");
    const media = screen.getByText("media").parentElement as HTMLElement;
    expect(media.className).toContain("blur-2xl");
    expect(media.className).toContain("grayscale");
    expect(media.hasAttribute("inert")).toBe(true);
    expect(media.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("Under review")).toBeTruthy();
  });

  test("not obscured: no blur, no overlay, reachable", () => {
    render(
      <SensitiveMedia obscured={false} overlay={<p>Under review</p>} data-testid="shield">
        <p>media</p>
      </SensitiveMedia>,
    );
    const media = screen.getByText("media").parentElement as HTMLElement;
    expect(media.className).not.toContain("blur-2xl");
    expect(media.hasAttribute("inert")).toBe(false);
    expect(screen.queryByText("Under review")).toBeNull();
  });

  test("respects reduced motion (no transition)", () => {
    render(
      <SensitiveMedia obscured>
        <p>media</p>
      </SensitiveMedia>,
    );
    expect((screen.getByText("media").parentElement as HTMLElement).className).toContain(
      "motion-reduce:transition-none",
    );
  });
});

describe("FrameTile", () => {
  test("blurred by default; reveal calls onReveal; the image has no alt until revealed", () => {
    const onReveal = vi.fn<() => void>();
    const { rerender, container } = render(
      <FrameTile
        src={PIXEL}
        alt="Frame"
        revealed={false}
        onReveal={onReveal}
        revealLabel="Reveal"
        notice="Blurred"
        revealButtonProps={{ "data-testid": "reveal" }}
        caption="score 0.99"
      />,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("draggable")).toBe("false");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(container.querySelector('[data-obscured="true"]')).not.toBeNull();
    fireEvent.click(screen.getByTestId("reveal"));
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(screen.getByText("score 0.99").tagName).toBe("FIGCAPTION");

    rerender(<FrameTile src={PIXEL} alt="Frame" revealed onReveal={onReveal} revealLabel="Reveal" />);
    expect(container.querySelector('[data-obscured="false"]')).not.toBeNull();
    expect(screen.queryByText("Reveal")).toBeNull();
    expect((container.querySelector("img") as HTMLImageElement).getAttribute("alt")).toBe("Frame");
  });

  test("not loaded: the placeholder, no image and no reveal", () => {
    const { container } = render(
      <FrameTile src={null} alt="Frame" revealed={false} revealLabel="Reveal" placeholder={<p>Not loaded</p>} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Not loaded")).toBeTruthy();
    expect(screen.queryByText("Reveal")).toBeNull();
  });
});
