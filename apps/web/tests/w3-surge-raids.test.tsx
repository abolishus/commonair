// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Surge raids on the web (batch 7 decision (w), docs/testing/b7-selectors.md "Surge raids"): the
 * moderator banner's raid line (`surge-raid`: source, verified count, until), the studio "Protect
 * raids" switch and its note (saved as `surgeGuard.onRaid` only when touched), and the outgoing raid
 * panel's note.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatGateStudio } from "../src/components/chat-gate/chat-gate-settings.tsx";
import type { ChatGateClient } from "../src/components/chat-gate/features.ts";
import { chatGateDraft, chatGateInput } from "../src/components/chat-gate/form.ts";
import { SurgeRaidLine, surgeRaidView } from "../src/components/chat-gate/surge-raid.tsx";
import { RaidPanel } from "../src/components/interact-studio/raid-panel.tsx";
import type { StudioApi } from "../src/components/interact-studio/shared.tsx";
import { en } from "../src/i18n/en.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";
import type { RaidStateDto } from "../src/lib/interact-studio.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  const view = render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
  return {
    ...view,
    update: (next: React.ReactNode) =>
      view.rerender(
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>{next}</TooltipProvider>
        </LocaleProvider>,
      ),
  };
}
const settle = () => act(async () => await Promise.resolve());

const UNTIL = "2099-11-01T12:10:00.000Z";
type State = {
  state: "off" | "on" | "suppressed";
  since: string | null;
  until: string | null;
  by: null;
  unavailable: boolean;
  raid?: { fromChannel: string; verifiedCount: number } | null;
};
const ON_RAID: State = {
  state: "on",
  since: "2099-11-01T12:00:00.000Z",
  until: UNTIL,
  by: null,
  unavailable: false,
  raid: { fromChannel: "friendly", verifiedCount: 3 },
};

function surgeClient(...states: State[]) {
  let i = 0;
  const state = vi.fn<() => Promise<State | undefined>>(async () => states[Math.min(i++, states.length - 1)]);
  return { client: { chat: { surge: { state } } } as unknown as ChatGateClient, state };
}

describe("surgeRaidView", () => {
  it("only while surge mode is on and a raid holds it", () => {
    expect(surgeRaidView(ON_RAID)).toEqual({ fromChannel: "friendly", verifiedCount: 3, until: UNTIL });
    expect(surgeRaidView({ ...ON_RAID, raid: null })).toBeNull();
    expect(surgeRaidView({ ...ON_RAID, raid: undefined })).toBeNull();
    expect(surgeRaidView({ ...ON_RAID, state: "suppressed" })).toBeNull();
    expect(surgeRaidView({ ...ON_RAID, state: "off" })).toBeNull();
  });
});

describe("the banner's raid line", () => {
  it("names the source, its verified count and when chat reopens", async () => {
    const { client } = surgeClient(ON_RAID);
    wrap(<SurgeRaidLine channel="ann" surge={{ state: "on", until: UNTIL }} client={client} />);
    const line = await screen.findByTestId("surge-raid");
    expect(line.getAttribute("data-from")).toBe("friendly");
    expect(line.getAttribute("data-verified-count")).toBe("3");
    expect(line.getAttribute("data-until")).toBe(UNTIL);
    expect(line.textContent).toContain("Raid from friendly: 3 verified viewers.");
    expect(line.textContent).toContain("Chat is watchers-only. It reopens");
    expect(line.querySelector("time")?.getAttribute("datetime")).toBe(UNTIL);
  });

  it("one verified viewer and none read right", async () => {
    const one = surgeClient({ ...ON_RAID, raid: { fromChannel: "f", verifiedCount: 1 } });
    wrap(<SurgeRaidLine channel="ann" surge={null} client={one.client} />);
    expect((await screen.findByTestId("surge-raid")).textContent).toContain("Raid from f: 1 verified viewer.");
    cleanup();
    const none = surgeClient({ ...ON_RAID, raid: { fromChannel: "f", verifiedCount: 0 } });
    wrap(<SurgeRaidLine channel="ann" surge={null} client={none.client} />);
    expect((await screen.findByTestId("surge-raid")).textContent).toContain("Raid from f: no verified viewers.");
  });

  it("nothing for a surge no raid opened, or after the read fails", async () => {
    const { client } = surgeClient({ ...ON_RAID, raid: null });
    wrap(<SurgeRaidLine channel="ann" surge={{ state: "on", until: UNTIL }} client={client} />);
    await settle();
    expect(screen.queryByTestId("surge-raid")).toBeNull();
    cleanup();
    const failing = {
      chat: { surge: { state: async () => Promise.reject(new Error("down")) } },
    } as unknown as ChatGateClient;
    wrap(<SurgeRaidLine channel="ann" surge={{ state: "on", until: UNTIL }} client={failing} />);
    await settle();
    expect(screen.queryByTestId("surge-raid")).toBeNull();
  });

  it("reads again when a surge frame turns it on, follows a later until, and hides when it ends", async () => {
    const { client, state } = surgeClient({ ...ON_RAID, raid: null }, ON_RAID);
    const v = wrap(<SurgeRaidLine channel="ann" surge={{ state: "on", until: UNTIL }} client={client} />);
    await settle();
    expect(screen.queryByTestId("surge-raid")).toBeNull();
    const later = "2099-11-01T12:30:00.000Z";
    v.update(<SurgeRaidLine channel="ann" surge={{ state: "on", until: later }} client={client} />);
    const line = await screen.findByTestId("surge-raid");
    expect(state).toHaveBeenCalledTimes(2);
    expect(line.getAttribute("data-until")).toBe(later);
    v.update(<SurgeRaidLine channel="ann" surge={{ state: "suppressed", until: later }} client={client} />);
    expect(screen.queryByTestId("surge-raid")).toBeNull();
    expect(state).toHaveBeenCalledTimes(2);
  });
});

function gateClient(settings = ChannelChatSettings.parse({ surgeGuard: { enabled: true } })) {
  const updateSettings = vi.fn<(input: Record<string, unknown>) => Promise<ChannelChatSettings>>(async (input) => {
    const { channel: _c, surgeGuard, ...patch } = input;
    return ChannelChatSettings.parse({
      ...settings,
      ...patch,
      surgeGuard: { ...settings.surgeGuard, ...(surgeGuard as object) },
    });
  });
  const client = {
    instance: { info: async () => ({ features: { watchGate: false, surgeGuard: true, p2pDefault: "off" } }) },
    chat: { settings: async () => settings, updateSettings },
  } as unknown as ChatGateClient;
  return { client, updateSettings };
}

describe("Protect raids", () => {
  it("shows the stored value with its note, and saves onRaid only once touched", async () => {
    const { client, updateSettings } = gateClient();
    wrap(<ChatGateStudio channel="ann" client={client} />);
    const sw = await screen.findByTestId("surge-guard-on-raid");
    expect(sw.getAttribute("data-state")).toBe("on");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("surge-guard-on-raid-note").textContent).toBe(en["surgeRaids.protect.note"]);
    expect(screen.getByText(en["surgeRaids.protect.label"])).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-gate-save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toEqual({
      channel: "ann",
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 },
    });

    fireEvent.click(screen.getByTestId("surge-guard-on-raid"));
    await waitFor(() => expect(screen.getByTestId("surge-guard-on-raid").getAttribute("data-state")).toBe("off"));
    fireEvent.click(screen.getByTestId("chat-gate-save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(2));
    expect(updateSettings.mock.calls[1]?.[0]).toEqual({
      channel: "ann",
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10, onRaid: false },
    });
    // The saved value stays shown after the save.
    await waitFor(() => expect(screen.getByTestId("surge-guard-on-raid").getAttribute("data-state")).toBe("off"));
  });

  it("a stored off reads off", async () => {
    const { client } = gateClient(ChannelChatSettings.parse({ surgeGuard: { enabled: true, onRaid: false } }));
    wrap(<ChatGateStudio channel="ann" client={client} />);
    expect((await screen.findByTestId("surge-guard-on-raid")).getAttribute("data-state")).toBe("off");
  });

  it("hidden with the guard's empty state when the instance does not run it", async () => {
    const client = {
      instance: { info: async () => ({ features: { watchGate: true, surgeGuard: false, p2pDefault: "off" } }) },
      chat: { settings: async () => ChannelChatSettings.parse({}) },
    } as unknown as ChatGateClient;
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-surge-off");
    expect(screen.queryByTestId("surge-guard-on-raid")).toBeNull();
  });

  it("form logic: the patch carries onRaid only when set", () => {
    const d = chatGateDraft(ChannelChatSettings.parse({}));
    expect(d.onRaid).toBeUndefined();
    const features = { watchGate: false, surgeGuard: true };
    expect(chatGateInput(d, features)).toEqual({
      ok: true,
      input: { surgeGuard: { enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10 } },
    });
    expect(chatGateInput({ ...d, onRaid: true }, features)).toEqual({
      ok: true,
      input: { surgeGuard: { enabled: false, triggerUnverifiedRatio: 0.5, cooldownMinutes: 10, onRaid: true } },
    });
  });
});

describe("the outgoing raid panel", () => {
  it("notes that the target may have raid protection on", () => {
    const initial: RaidStateDto = { raid: null, cooldownEndsAt: null, policy: "anyone" };
    const client = { interact: { raids: {} } } as unknown as StudioApi;
    wrap(<RaidPanel channel="ann" initial={initial} client={client} />);
    expect(screen.getByTestId("raid-protection-note").textContent).toBe(en["surgeRaids.panel.note"]);
    expect(screen.getByTestId("raid-form").contains(screen.getByTestId("raid-protection-note"))).toBe(true);
  });
});
