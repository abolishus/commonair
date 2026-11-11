// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 3 (D4.1, D4.4): the chat panel's "N new messages" pill counts the rows that
 * arrived after the reader scrolled up, a jump resets it; the column is calmer (one quiet badge
 * tone, no rule under the pinned strip, events without a box).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StarIcon } from "@hugeicons/core-free-icons";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { ChatBadge, ChatEvent, ChatMessage, ChatPanel } from "../../src/blocks/media/index.ts";

afterEach(cleanup);

const label = (count: number) => (count === 0 ? "Jump to latest" : `${count} new messages`);

function viewportOf(): HTMLElement {
  return screen.getByRole("log").closest('[data-slot="scroll-area-viewport"]') as HTMLElement;
}

function scrolledUp(viewport: HTMLElement): void {
  Object.defineProperties(viewport, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 100 },
  });
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
}

function Log({ seq }: { seq: number }) {
  return (
    <ChatPanel title="Chat" logLabel="Messages" newMessagesLabel={label} rowSeq={seq}>
      {Array.from({ length: seq }, (_, i) => (
        <ChatMessage key={i} author="Fern" body={`line ${i}`} colorIndex={1} />
      ))}
    </ChatPanel>
  );
}

describe("ChatPanel new-messages pill", () => {
  test("counts rows since the reader left the bottom, and a jump clears it", async () => {
    const { rerender } = render(<Log seq={3} />);
    expect(document.querySelector('[data-slot="chat-jump-latest"]')).toBeNull();
    const viewport = viewportOf();
    await act(async () => scrolledUp(viewport));
    const pill = () => document.querySelector<HTMLElement>('[data-slot="chat-jump-latest"]');
    expect(pill()?.textContent).toBe("Jump to latest");
    expect(pill()?.dataset.count).toBe("0");
    rerender(<Log seq={5} />);
    expect(pill()?.textContent).toBe("2 new messages");
    // Scrolling within the backlog keeps the count from where they left.
    await act(async () => scrolledUp(viewport));
    rerender(<Log seq={6} />);
    expect(pill()?.textContent).toBe("3 new messages");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "3 new messages" }));
    });
    expect(pill()).toBeNull();
    expect(viewport.scrollTop).toBe(1000);
  });

  test("a plain string label still works (the replay panel)", async () => {
    render(
      <ChatPanel title="Chat" logLabel="Messages" newMessagesLabel="Jump">
        <ChatMessage author="Fern" body="hi" colorIndex={1} />
      </ChatPanel>,
    );
    await act(async () => scrolledUp(viewportOf()));
    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
  });

  test("the pinned strip sits on the panel without a rule under it", () => {
    render(
      <ChatPanel title="Chat" logLabel="Messages" newMessagesLabel="Jump" pinned={<p>Goal</p>}>
        <ChatMessage author="Fern" body="hi" colorIndex={1} />
      </ChatPanel>,
    );
    const pinned = document.querySelector('[data-slot="chat-pinned"]') as HTMLElement;
    expect(pinned.className).not.toContain("border-b");
  });
});

describe("a calmer column", () => {
  test("only the broadcaster's badge stands out; the others are neutral", () => {
    render(
      <>
        <ChatBadge kind="broadcaster" label="Host" data-testid="b" />
        <ChatBadge kind="moderator" label="Mod" data-testid="m" />
        <ChatBadge kind="vip" label="VIP" data-testid="v" />
      </>,
    );
    const tone = (id: string) => screen.getByTestId(id).getAttribute("data-tone");
    expect(tone("b")).toBe("accent");
    expect(tone("m")).toBe("neutral");
    expect(tone("v")).toBe("neutral");
  });

  test("events keep one accent edge and no box", () => {
    const { container } = render(<ChatEvent icon={StarIcon} text="Fern subscribed" />);
    const event = container.querySelector("[data-slot=chat-event]") as HTMLElement;
    expect(event.className).toContain("border-s-2");
    expect(event.className).not.toContain("bg-muted");
  });
});
