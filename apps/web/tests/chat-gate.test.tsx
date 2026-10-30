// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Studio `/chat` (ADR 0015, docs/testing/w1-selectors.md "Watch gate"): controls per instance
 * flag, validation of the gate (0 or 60–3600), the ratio and the cooldown, and the saved patch.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ChatGateStudio } from "../src/components/chat-gate/chat-gate-settings.tsx";
import type { ChatGateClient } from "../src/components/chat-gate/features.ts";
import { chatGateDraft, chatGateInput, validGateSeconds } from "../src/components/chat-gate/form.ts";
import { locale, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

function fake(features: { watchGate: boolean; surgeGuard: boolean }, settings = ChannelChatSettings.parse({})) {
  const updateSettings = vi.fn<(input: Record<string, unknown>) => Promise<ChannelChatSettings>>(async (input) => {
    const { channel: _c, ...patch } = input;
    return ChannelChatSettings.parse({ ...settings, ...patch });
  });
  const client = {
    instance: { info: async () => ({ features: { ...features, p2pDefault: "off" } }) },
    chat: { settings: async () => settings, updateSettings },
  } as unknown as ChatGateClient;
  return { client, updateSettings };
}

const input = (id: string) => screen.getByTestId(id) as HTMLInputElement;

describe("chat-gate form logic", () => {
  it("accepts 0 and 60–3600 only", () => {
    for (const n of [0, 60, 61, 900, 3600]) expect(validGateSeconds(n), String(n)).toBe(true);
    for (const n of [1, 59, 3601, null]) expect(validGateSeconds(n), String(n)).toBe(false);
  });

  it("builds only the enabled features' fields", () => {
    const d = chatGateDraft(ChannelChatSettings.parse({ minVerifiedWatchSeconds: 300 }));
    expect(d).toEqual({ seconds: "300", exemptSubs: true, surgeEnabled: false, ratio: "50", cooldown: "10" });
    expect(chatGateInput(d, { watchGate: true, surgeGuard: false })).toEqual({
      ok: true,
      input: { minVerifiedWatchSeconds: 300, verifiedWatchExemptSubscribers: true },
    });
    expect(chatGateInput({ ...d, surgeEnabled: true, ratio: "80" }, { watchGate: false, surgeGuard: true })).toEqual({
      ok: true,
      input: { surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.8, cooldownMinutes: 10 } },
    });
  });

  it("reports each bad field", () => {
    const d = { seconds: "30", exemptSubs: true, surgeEnabled: true, ratio: "5", cooldown: "121" };
    expect(chatGateInput(d, { watchGate: true, surgeGuard: true })).toEqual({
      ok: false,
      errors: { seconds: true, ratio: true, cooldown: true },
    });
    for (const bad of ["", "1e3", "-60", "60.5", " "])
      expect(
        chatGateInput({ ...d, seconds: bad, ratio: "50", cooldown: "10" }, { watchGate: true, surgeGuard: false }).ok,
        bad,
      ).toBe(false);
  });
});

describe("ChatGateStudio", () => {
  it("both flags off: the not-enabled state, no controls", async () => {
    const { client } = fake({ watchGate: false, surgeGuard: false });
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-off");
    expect(screen.queryByTestId("chat-gate-settings")).toBeNull();
  });

  it("only the gate: gate controls, the guard's empty state", async () => {
    const { client } = fake({ watchGate: true, surgeGuard: false });
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-settings");
    expect(screen.getByTestId("chat-gate-seconds")).toBeTruthy();
    expect(screen.getByTestId("chat-gate-exempt-subs")).toBeTruthy();
    expect(screen.getByTestId("chat-gate-surge-off")).toBeTruthy();
    expect(screen.queryByTestId("surge-guard-enabled")).toBeNull();
    expect(screen.queryByTestId("surge-guard-ratio")).toBeNull();
  });

  it("only the guard: guard controls, the gate's empty state", async () => {
    const { client } = fake({ watchGate: false, surgeGuard: true });
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-settings");
    expect(screen.getByTestId("surge-guard-enabled")).toBeTruthy();
    expect(screen.getByTestId("surge-guard-ratio")).toBeTruthy();
    expect(screen.getByTestId("surge-guard-cooldown")).toBeTruthy();
    expect(screen.getByTestId("chat-gate-gate-off")).toBeTruthy();
    expect(screen.queryByTestId("chat-gate-seconds")).toBeNull();
  });

  it("refuses 30 seconds, then saves a preset with the guard", async () => {
    const { client, updateSettings } = fake({ watchGate: true, surgeGuard: true });
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-settings");
    fireEvent.change(input("chat-gate-seconds"), { target: { value: "30" } });
    fireEvent.click(screen.getByTestId("chat-gate-save"));
    await waitFor(() => expect(input("chat-gate-seconds").getAttribute("aria-invalid")).toBe("true"));
    expect(updateSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("chat-gate-seconds-300"));
    expect(input("chat-gate-seconds").value).toBe("300");
    expect(screen.getByTestId("chat-gate-seconds-300").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("surge-guard-enabled"));
    fireEvent.change(input("surge-guard-ratio"), { target: { value: "70" } });
    fireEvent.change(input("surge-guard-cooldown"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("chat-gate-save"));
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings.mock.calls[0]?.[0]).toEqual({
      channel: "ann",
      minVerifiedWatchSeconds: 300,
      verifiedWatchExemptSubscribers: true,
      surgeGuard: { enabled: true, triggerUnverifiedRatio: 0.7, cooldownMinutes: 15 },
    });
  });

  it("a failed load offers a retry", async () => {
    const client = {
      instance: { info: async () => Promise.reject(new Error("down")) },
      chat: { settings: async () => ChannelChatSettings.parse({}) },
    } as unknown as ChatGateClient;
    wrap(<ChatGateStudio channel="ann" client={client} />);
    await screen.findByTestId("chat-gate-load-error");
    expect(screen.getByTestId("chat-gate-retry")).toBeTruthy();
  });
});
