// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The studio's DVR settings (docs/testing/w2-selectors.md "Live DVR") with a fake client. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  DvrSettings,
  dvrWindowLabel,
  dvrWindowOptions,
  type DvrMediaSettings,
  type DvrSettingsClient,
} from "../src/components/dvr-settings.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

function fake(initial: DvrMediaSettings, opts: { failGet?: boolean; failSave?: boolean } = {}) {
  const saves: { enabled: boolean; windowSeconds: number }[] = [];
  let current = initial;
  const client: DvrSettingsClient = {
    get: async () => {
      if (opts.failGet) throw new Error("down");
      return current;
    },
    update: async (_channel, dvr) => {
      if (opts.failSave) throw new Error("down");
      saves.push(dvr);
      // The server clamps to the cap.
      current = {
        ...current,
        dvr: { ...dvr, windowSeconds: Math.min(dvr.windowSeconds, current.dvrMaxWindowSeconds) },
      };
      return current;
    },
  };
  return { client, saves };
}

async function mount(client: DvrSettingsClient) {
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <DvrSettings channel="alice" client={client} />
      </TooltipProvider>
    </LocaleProvider>,
  );
  await waitFor(() => expect(byId("dvr-enabled")).not.toBeNull());
}

describe("dvrWindowOptions", () => {
  it("offers the presets up to the cap, the cap itself and the saved value", () => {
    expect(dvrWindowOptions(7200, 1800)).toEqual([300, 600, 900, 1800, 3600, 7200]);
    expect(dvrWindowOptions(1200, 1200)).toEqual([300, 600, 900, 1200]);
    expect(dvrWindowOptions(7200, 2700)).toEqual([300, 600, 900, 1800, 2700, 3600, 7200]);
    expect(dvrWindowOptions(120, 120)).toEqual([120]);
    expect(dvrWindowOptions(86_400, 1800)).toEqual([300, 600, 900, 1800, 3600, 7200, 86_400]);
    // A cap under a minute turns DVR off: nothing to choose.
    expect(dvrWindowOptions(59, 60)).toEqual([]);
    expect(dvrWindowOptions(0, 1800)).toEqual([]);
  });

  it("labels windows in hours, minutes or seconds", () => {
    expect(dvrWindowLabel(7200, "en")).toBe("2 hours");
    expect(dvrWindowLabel(1800, "en")).toBe("30 minutes");
    expect(dvrWindowLabel(90, "en")).toBe("90 seconds");
    expect(dvrWindowLabel(3600, "es")).toBe("1 hora");
  });
});

describe("DvrSettings", () => {
  it("shows the switch, the window, the VOD, source and origin notes; save is off until a change", async () => {
    const { client } = fake({ dvr: { enabled: true, windowSeconds: 1800 }, dvrMaxWindowSeconds: 7200 });
    await mount(client);
    expect(byId("dvr-settings")).not.toBeNull();
    expect(byId("dvr-enabled")?.dataset.state).toBe("on");
    expect(byId("dvr-window")?.dataset.value).toBe("1800");
    expect(byId("dvr-needs-vods")?.textContent).toBe(t("dvr.settings.needsVods"));
    expect(document.body.textContent).toContain(t("dvr.settings.sourceOnly"));
    expect(document.body.textContent).toContain(t("dvr.settings.originOnly"));
    expect(document.body.textContent).toContain(t("dvr.settings.windowHint", { max: "2 hours" }));
    expect((byId("dvr-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the three notes use the field hint style, not a larger body size (F35)", async () => {
    const { client } = fake({ dvr: { enabled: true, windowSeconds: 1800 }, dvrMaxWindowSeconds: 7200 });
    await mount(client);
    for (const key of ["dvr.settings.needsVods", "dvr.settings.sourceOnly", "dvr.settings.originOnly"] as const) {
      const note = [...document.querySelectorAll("p")].find((p) => p.textContent === t(key));
      expect(note?.dataset.slot).toBe("field-description");
      // The field hint size (14 px reading text since D1), never a larger body size.
      expect(note?.className).toMatch(/(^|\s)text-sm\/relaxed(\s|$)/);
      expect(note?.className).not.toMatch(/\btext-(base|lg)\b/);
    }
  });

  it("turning DVR off and saving sends the change", async () => {
    const { client, saves } = fake({ dvr: { enabled: true, windowSeconds: 1800 }, dvrMaxWindowSeconds: 7200 });
    await mount(client);
    fireEvent.click(byId("dvr-enabled") as HTMLElement);
    await waitFor(() => expect(byId("dvr-enabled")?.dataset.state).toBe("off"));
    const save = byId("dvr-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    await waitFor(() => expect(saves).toEqual([{ enabled: false, windowSeconds: 1800 }]));
    await waitFor(() => expect((byId("dvr-save") as HTMLButtonElement).disabled).toBe(true));
  });

  it("the window choice lists one item per window up to the cap", async () => {
    const { client, saves } = fake({ dvr: { enabled: true, windowSeconds: 600 }, dvrMaxWindowSeconds: 900 });
    await mount(client);
    const trigger = byId("dvr-window") as HTMLElement;
    fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    await waitFor(() => expect(byId("dvr-window-900")).not.toBeNull());
    expect(byId("dvr-window-300")).not.toBeNull();
    expect(byId("dvr-window-1800")).toBeNull();
    // Base UI picks on pointer down / mouse up, then click.
    const option = byId("dvr-window-900") as HTMLElement;
    fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 });
    fireEvent.mouseUp(option, { button: 0 });
    fireEvent.click(option);
    await waitFor(() => expect(byId("dvr-window")?.dataset.value).toBe("900"));
    await act(async () => {
      fireEvent.click(byId("dvr-save") as HTMLElement);
    });
    await waitFor(() => expect(saves).toEqual([{ enabled: true, windowSeconds: 900 }]));
  });

  it("with the instance cap under a minute, DVR is off and nothing can be changed", async () => {
    const { client } = fake({ dvr: { enabled: false, windowSeconds: 1800 }, dvrMaxWindowSeconds: 0 });
    await mount(client);
    expect(document.body.textContent).toContain(t("dvr.settings.instanceOff"));
    expect(byId("dvr-enabled")?.hasAttribute("data-disabled")).toBe(true);
    expect((byId("dvr-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a load failure shows the error instead of the form", async () => {
    const { client } = fake(
      { dvr: { enabled: true, windowSeconds: 1800 }, dvrMaxWindowSeconds: 7200 },
      { failGet: true },
    );
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <DvrSettings channel="alice" client={client} />
      </LocaleProvider>,
    );
    await waitFor(() => expect(byId("form-error")?.textContent).toBe(t("dvr.settings.loadFailed")));
    expect(byId("dvr-enabled")).toBeNull();
    expect(byId("dvr-save")).toBeNull();
  });
});
