// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * W5 type sweep: popover bodies are 14 px, but keyboard hints, metadata and chat inside a
 * popover keep 12 px (the Calm Chat keys and rate, the held-queue row).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { ChatMessageFrame } from "../src/chat/connection.ts";
import { CalmControls } from "../src/chat/calm/calm-controls.tsx";
import { DEFAULT_CALM_SETTINGS } from "../src/chat/calm/settings.ts";
import { HeldRow } from "../src/components/mod/held-queue.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const is12 = (el: Element | null): boolean => (el?.className ?? "").split(/\s+/).some((c) => /^text-xs(\/|$)/.test(c));

afterEach(cleanup);

function wrap(node: React.ReactNode): React.JSX.Element {
  return (
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>
  );
}

describe("12 px inside 14 px popovers", () => {
  it("the Calm Chat keyboard hints and rate stay at text-xs", async () => {
    render(wrap(<CalmControls settings={DEFAULT_CALM_SETTINGS} />));
    fireEvent.click(screen.getByRole("button", { name: t("calmChat.settings.open") }));
    const keysTitle = await screen.findByText(t("calmChat.keys.title"));
    expect(is12(keysTitle.parentElement)).toBe(true);
    const rate = screen.getByText(t("calmChat.settings.rateValue", { count: DEFAULT_CALM_SETTINGS.rowsPerSecond }));
    expect(is12(rate.closest("output"))).toBe(true);
  });

  it("a held-queue row (author, time, message) stays at text-xs", () => {
    const message = {
      id: "01900000-0000-7000-8000-000000000001",
      body: "held words",
      isAction: false,
      createdAt: new Date().toISOString(),
      user: { id: "u1", username: "aurora", displayName: "Aurora" },
    } as unknown as ChatMessageFrame;
    render(wrap(<HeldRow message={message} onResolve={() => {}} />));
    expect(is12(screen.getByTestId("held-message"))).toBe(true);
  });
});
