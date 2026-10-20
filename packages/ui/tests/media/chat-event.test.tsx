// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E4b: ChatEvent, platform events (subs, gift subs, tips) inline in the chat log. */
import type * as React from "react";
import { act, render, screen, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { GiftIcon, MoneyBag02Icon, StarIcon } from "@hugeicons/core-free-icons";
import { describe, expect, test, vi } from "vite-plus/test";
import { ChatEvent, ChatMessage, ChatPanel } from "../../src/blocks/media/index.ts";

describe("ChatEvent", () => {
  test("one article in the chat log with its line, amount and message", () => {
    render(
      <ChatPanel title="Chat" logLabel="Chat messages" newMessagesLabel="Latest">
        <ChatMessage author="fan" colorIndex={1} body="hi" />
        <ChatEvent
          icon={MoneyBag02Icon}
          text="Someone tipped"
          amount={{ cents: 500, currency: "USD" }}
          locale="en-US"
          message="Great stream"
          data-testid="chat-event"
          data-type="channel.tip"
          data-user=""
          data-cents={500}
        />
      </ChatPanel>,
    );
    const log = screen.getByRole("log", { name: "Chat messages" });
    const rows = within(log).getAllByRole("article");
    expect(rows).toHaveLength(2);
    const event = screen.getByTestId("chat-event");
    expect(event.tagName).toBe("ARTICLE");
    expect(event.getAttribute("data-type")).toBe("channel.tip");
    expect(event.getAttribute("data-user")).toBe("");
    expect(event.getAttribute("data-cents")).toBe("500");
    expect(event.textContent).toContain("Someone tipped");
    expect(event.textContent).toContain("$5.00");
    expect(event.querySelector("data[value='500']")).not.toBeNull();
    expect(within(event).getByText("Great stream")).toBeTruthy();
  });

  test("without amount or message it is a single line; the icon is decorative", () => {
    const { container } = render(<ChatEvent icon={StarIcon} text="mothwing subscribed at Tier 2" />);
    const event = container.querySelector("[data-slot=chat-event]") as HTMLElement;
    expect(event.querySelectorAll("p")).toHaveLength(1);
    expect(event.querySelector("[data-slot=money-amount]")).toBeNull();
    expect(event.querySelector("[data-slot=chat-event-icon]")?.getAttribute("aria-hidden")).toBe("true");
    expect(event.textContent).toBe("mothwing subscribed at Tier 2");
  });

  test("tones: accent by default, others on request; the entrance fade is motion-safe only", () => {
    const { container, rerender } = render(<ChatEvent icon={GiftIcon} text="Gift" />);
    const event = () => container.querySelector("[data-slot=chat-event]") as HTMLElement;
    expect(event().getAttribute("data-tone")).toBe("accent");
    expect(event().className).toContain("border-channel-accent");
    expect(event().querySelector("[data-slot=chat-event-icon]")?.className).toContain("bg-channel-accent");
    const motion = event()
      .className.split(/\s+/)
      .filter((cls) => cls.includes("animate") || cls.includes("fade"));
    expect(motion.length).toBeGreaterThan(0);
    expect(motion.every((cls) => cls.startsWith("motion-safe:"))).toBe(true);
    rerender(<ChatEvent icon={GiftIcon} text="Gift" tone="success" />);
    expect(event().getAttribute("data-tone")).toBe("success");
    expect(event().className).toContain("border-success");
  });

  test("long unbroken text wraps instead of widening the log", () => {
    const { container } = render(<ChatEvent icon={GiftIcon} text={"x".repeat(200)} message={"y".repeat(200)} />);
    for (const p of container.querySelectorAll("p")) expect(p.className).toContain("break-words");
    expect((container.querySelector("[data-slot=chat-event]") as HTMLElement).className).toContain("min-w-0");
  });

  const cases: [string, React.ReactElement][] = [
    ["plain", <ChatEvent key="a" icon={StarIcon} text="Subscribed" />],
    [
      "with amount and message",
      <ChatEvent
        key="b"
        icon={MoneyBag02Icon}
        text="Tip"
        amount={{ cents: 1234, currency: "EUR" }}
        locale="de-DE"
        message="Danke"
      />,
    ],
  ];
  test.each(cases)("%s hydrates without warnings", async (_name, node) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(node);
    document.body.append(container);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, node, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    act(() => root?.unmount());
    error.mockRestore();
    container.remove();
  });
});
