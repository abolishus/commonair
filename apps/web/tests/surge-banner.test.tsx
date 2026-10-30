// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * `SurgeBanner` (ADR 0015 decisions 4, 6, 7): moderators see `surge-banner` with end/start while
 * surge mode is on or suppressed; viewers see one `chat-gate-hint` sentence (never a countdown);
 * nothing renders without `instance.info`.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { SurgeBanner, type SurgeBannerProps } from "../src/chat/surge-banner.tsx";
import type { ChatGateClient } from "../src/components/chat-gate/features.ts";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const UNTIL = "2099-10-30T12:10:00.000Z";
type Surge = {
  state: "off" | "on" | "suppressed";
  since: string | null;
  until: string | null;
  by: { id: string; username: string } | null;
  unavailable: boolean;
};
const OFF: Surge = { state: "off", since: null, until: null, by: null, unavailable: false };

function fake(features: { watchGate: boolean; surgeGuard: boolean } | null, initial: Surge = OFF) {
  const override = vi.fn<(i: { channel: string; action: "start" | "end" }) => Promise<Surge>>(async ({ action }) => ({
    state: action === "start" ? ("on" as const) : ("suppressed" as const),
    since: "2099-10-30T12:00:00.000Z",
    until: UNTIL,
    by: { id: "u1", username: "mo" },
    unavailable: false,
  }));
  const client = {
    instance: {
      info: async () =>
        features ? { features: { ...features, p2pDefault: "off" } } : Promise.reject(new Error("no server")),
    },
    chat: { surge: { state: async () => initial, override } },
  } as unknown as ChatGateClient;
  return { client, override };
}

function banner(client: ChatGateClient, over: Partial<SurgeBannerProps> = {}) {
  const props: SurgeBannerProps = {
    channel: "ann",
    canModerate: false,
    signedIn: true,
    settings: ChannelChatSettings.parse({}),
    surge: null,
    gateDenied: false,
    client,
    ...over,
  };
  const view = render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <SurgeBanner {...props} />
      </TooltipProvider>
    </LocaleProvider>,
  );
  return {
    ...view,
    update: (next: Partial<SurgeBannerProps>) =>
      view.rerender(
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <SurgeBanner {...props} {...next} />
          </TooltipProvider>
        </LocaleProvider>,
      ),
  };
}

const settle = () => act(async () => await Promise.resolve());

describe("SurgeBanner for viewers", () => {
  it("the hint on a gated channel, as one sentence without numbers", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: false });
    banner(client, { settings: ChannelChatSettings.parse({ minVerifiedWatchSeconds: 300 }) });
    const hint = await screen.findByTestId("chat-gate-hint");
    expect(hint.textContent).toBe(en["surge.hint"]);
    expect(hint.textContent).not.toMatch(/\d/);
    expect(screen.queryByTestId("surge-banner")).toBeNull();
  });

  it("no hint while the instance flag is off, or the channel's gate is 0", async () => {
    const off = fake({ watchGate: false, surgeGuard: false });
    banner(off.client, { settings: ChannelChatSettings.parse({ minVerifiedWatchSeconds: 300 }) });
    await settle();
    expect(screen.queryByTestId("chat-gate-hint")).toBeNull();
    cleanup();
    const zero = fake({ watchGate: true, surgeGuard: true });
    banner(zero.client);
    await settle();
    expect(screen.queryByTestId("chat-gate-hint")).toBeNull();
  });

  it("the hint during surge mode and after a refused send", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: true });
    const view = banner(client, { surge: { state: "on", until: UNTIL } });
    await screen.findByTestId("chat-gate-hint");
    view.update({ surge: { state: "suppressed", until: UNTIL } });
    expect(screen.queryByTestId("chat-gate-hint")).toBeNull();
    view.update({ surge: { state: "off", until: null }, gateDenied: true });
    expect(screen.getByTestId("chat-gate-hint")).toBeTruthy();
  });

  it("renders nothing when instance.info fails", async () => {
    const { client } = fake(null);
    banner(client, { gateDenied: true, surge: { state: "on", until: UNTIL } });
    await settle();
    expect(screen.queryByTestId("chat-gate-hint")).toBeNull();
  });
});

describe("SurgeBanner for moderators", () => {
  it("reads the state once on mount: on, with who started it and End", async () => {
    const { client, override } = fake(
      { watchGate: true, surgeGuard: true },
      {
        state: "on",
        since: "2099-10-30T12:00:00.000Z",
        until: UNTIL,
        by: { id: "u2", username: "kim" },
        unavailable: false,
      },
    );
    banner(client, { canModerate: true });
    const b = await screen.findByTestId("surge-banner");
    expect(b.getAttribute("data-state")).toBe("on");
    expect(b.textContent).toContain("kim");
    expect(screen.queryByTestId("chat-gate-hint")).toBeNull();
    fireEvent.click(screen.getByTestId("surge-end"));
    await waitFor(() => expect(screen.getByTestId("surge-banner").getAttribute("data-state")).toBe("suppressed"));
    expect(override).toHaveBeenCalledWith({ channel: "ann", action: "end" });
    fireEvent.click(screen.getByTestId("surge-start"));
    await waitFor(() => expect(override).toHaveBeenLastCalledWith({ channel: "ann", action: "start" }));
  });

  it("follows the surge frames after the read", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: true });
    const view = banner(client, { canModerate: true });
    await settle();
    expect(screen.queryByTestId("surge-banner")).toBeNull();
    view.update({ surge: { state: "on", until: UNTIL } });
    expect((await screen.findByTestId("surge-banner")).getAttribute("data-state")).toBe("on");
    view.update({ surge: { state: "off", until: null } });
    await waitFor(() => expect(screen.queryByTestId("surge-banner")).toBeNull());
  });

  it("says when the check is unavailable", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: true }, { ...OFF, unavailable: true });
    banner(client, { canModerate: true });
    expect(await screen.findByTestId("surge-unavailable")).toBeTruthy();
  });

  it("nothing for moderators while the surge guard is off on the instance", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: false });
    banner(client, { canModerate: true, surge: { state: "on", until: UNTIL } });
    await settle();
    expect(screen.queryByTestId("surge-banner")).toBeNull();
  });
});
