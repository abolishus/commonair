// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Overhaul wave 5 schedule, rendered: the studio editor (`/schedule`: limits stated before they
 * are hit, errors after a save attempt, the whole schedule saved, skipping one stream) and the
 * About tab's schedule (loaded only inside the About tab).
 */
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const metrics = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (...args: unknown[]) => {
    metrics.calls.push(args);
  },
}));
const toasts = vi.hoisted(() => ({ success: [] as unknown[], error: [] as unknown[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (message: unknown) => {
      toasts.success.push(message);
      return 1;
    },
    error: (message: unknown) => {
      toasts.error.push(message);
      return 1;
    },
  },
}));

const { ScheduleEditor, durationLabel } = await import("../src/components/schedule/schedule-editor.tsx");
const { AboutSchedule, AboutTabContext } = await import("../src/components/schedule/about-schedule.tsx");
const { ChannelTabs } = await import("../src/components/channel/channel-tabs.tsx");
const { locale, t, uiMessages } = await import("../src/i18n/index.ts");
type ChannelSchedule = import("../src/components/schedule/model.ts").ChannelSchedule;
type ChannelScheduleInput = import("../src/components/schedule/model.ts").ChannelScheduleInput;
type ScheduleClient = import("../src/components/schedule/schedule-editor.tsx").ScheduleClient;

afterEach(cleanup);
beforeEach(() => {
  metrics.calls = [];
  toasts.success = [];
  toasts.error = [];
});

const wrap = (node: React.ReactNode) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
const byId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
const allById = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)];
const uuid = (n: number) => `0192f000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const NOW = new Date("2026-11-11T12:00:00.000Z");

function schedule(over: Partial<ChannelSchedule> = {}): ChannelSchedule {
  return {
    timezone: "America/Toronto",
    slots: [
      { id: uuid(1), weekday: 5, startLocal: "19:30", durationMinutes: 180, title: "Campaign night", category: null },
    ],
    oneOffs: [],
    upcoming: [
      {
        startsAt: "2026-11-14T00:30:00.000Z",
        endsAt: "2026-11-14T03:30:00.000Z",
        title: "Campaign night",
        category: null,
        slotId: uuid(1),
        oneOffId: null,
      },
      {
        startsAt: "2026-11-21T00:30:00.000Z",
        endsAt: "2026-11-21T03:30:00.000Z",
        title: "Campaign night",
        category: null,
        slotId: uuid(1),
        oneOffId: null,
      },
    ],
    feedPath: "/api/channels/rivertide/schedule.ics",
    ...over,
  };
}

function fakeClient(initial: ChannelSchedule | Error) {
  const sets: ChannelScheduleInput[] = [];
  const client: ScheduleClient = {
    get: async () => {
      if (initial instanceof Error) throw initial;
      return initial;
    },
    set: async (_channel, input) => {
      sets.push(input);
      return initial instanceof Error ? schedule() : { ...initial, timezone: input.timezone };
    },
    categories: async () => [{ id: uuid(90), name: "Just Chatting" }],
  };
  return { client, sets };
}

const change = (el: Element | null, value: string) => {
  if (!el) throw new Error("no element");
  fireEvent.change(el, { target: { value } });
};

describe("the schedule editor", () => {
  it("states the limits up front and saves the whole schedule", async () => {
    const { client, sets } = fakeClient(schedule());
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-editor")).not.toBeNull());
    expect(byId("schedule-weekly")?.textContent).toContain(
      t("w5Schedule.weekly.description", { max: String(SCHEDULE_RULES.maxSlots) }),
    );
    expect(byId("schedule-timezone")?.getAttribute("data-value")).toBe("America/Toronto");
    expect(allById("schedule-slot")).toHaveLength(1);
    expect(allById("schedule-upcoming-item")).toHaveLength(2);

    fireEvent.click(byId("schedule-add-slot") as Element);
    expect(allById("schedule-slot")).toHaveLength(2);
    expect(byId("schedule-upcoming-changed")).not.toBeNull();
    change(allById("schedule-slot-title")[1] ?? null, "  Viewer games ");
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(sets).toHaveLength(1));
    expect(sets[0]).toEqual({
      timezone: "America/Toronto",
      slots: [
        { weekday: 5, startLocal: "19:30", durationMinutes: 180, title: "Campaign night", categoryId: null },
        { weekday: 5, startLocal: "19:00", durationMinutes: 120, title: "Viewer games", categoryId: null },
      ],
      oneOffs: [],
    });
    await waitFor(() => expect(toasts.success).toEqual([t("w5Schedule.saved")]));
    expect(metrics.calls).toContainEqual(["studio.schedule", "submit"]);
  });

  it("shows errors only after a save attempt, and does not send a broken schedule", async () => {
    const { client, sets } = fakeClient(schedule());
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-editor")).not.toBeNull());
    change(byId("schedule-slot-start"), "");
    fireEvent.click(byId("schedule-add-one-off") as Element);
    change(byId("schedule-one-off-starts-at"), "2026-11-01T10:00");
    expect(byId("schedule-error-summary")).toBeNull();
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(byId("schedule-error-summary")).not.toBeNull());
    expect(document.body.textContent).toContain(t("w5Schedule.error.start"));
    expect(document.body.textContent).toContain(t("w5Schedule.error.past"));
    expect(sets).toEqual([]);
    change(byId("schedule-slot-start"), "20:15");
    change(byId("schedule-one-off-starts-at"), "2026-11-20T18:00");
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(sets).toHaveLength(1));
    expect(sets[0]?.slots[0]?.startLocal).toBe("20:15");
    expect(sets[0]?.oneOffs).toEqual([
      {
        startsAt: new Date("2026-11-20T18:00").toISOString(),
        durationMinutes: 120,
        title: null,
        categoryId: null,
        cancelsSlot: null,
      },
    ]);
  });

  it("a saved one-off that is on now does not block saving; moving it into the past does", async () => {
    // Started ten minutes ago, still running: the API still lists it.
    const live = {
      id: uuid(50),
      startsAt: "2026-11-11T11:50:00.000Z",
      durationMinutes: 120,
      title: "Launch day",
      category: null,
      cancelsSlotId: null,
    };
    const { client, sets } = fakeClient(schedule({ oneOffs: [live] }));
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-one-off-starts-at")).not.toBeNull());
    change(byId("schedule-slot-title"), "Campaign night 2");
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(sets).toHaveLength(1));
    expect(byId("schedule-error-summary")).toBeNull();
    expect(sets[0]?.oneOffs).toEqual([
      { startsAt: live.startsAt, durationMinutes: 120, title: "Launch day", categoryId: null, cancelsSlot: null },
    ]);
    change(byId("schedule-one-off-starts-at"), "2026-11-10T10:00");
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(byId("schedule-error-summary")).not.toBeNull());
    expect(document.body.textContent).toContain(t("w5Schedule.error.past"));
    expect(sets).toHaveLength(1);
  });

  it("skips one stream of a saved weekly slot", async () => {
    const { client, sets } = fakeClient(schedule());
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(allById("schedule-upcoming-skip")).toHaveLength(2));
    fireEvent.click(allById("schedule-upcoming-skip")[1] as Element);
    expect(allById("schedule-upcoming-item")[1]?.getAttribute("data-skipped")).toBe("true");
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(sets).toHaveLength(1));
    expect(sets[0]?.oneOffs).toEqual([
      { startsAt: "2026-11-21T00:30:00.000Z", durationMinutes: 180, title: null, categoryId: null, cancelsSlot: 0 },
    ]);
  });

  it("a full week: Add is off and says why", async () => {
    const slots = Array.from({ length: SCHEDULE_RULES.maxSlots }, (_, i) => ({
      id: uuid(100 + i),
      weekday: (i % 7) + 1,
      startLocal: `${String(8 + Math.floor(i / 7)).padStart(2, "0")}:00`,
      durationMinutes: 60,
      title: null,
      category: null,
    }));
    const { client } = fakeClient(schedule({ slots, upcoming: [] }));
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-slots-full")).not.toBeNull());
    expect((byId("schedule-add-slot") as HTMLButtonElement).disabled).toBe(true);
    expect(byId("schedule-one-offs-full")).toBeNull();
    fireEvent.click(allById("schedule-slot-remove")[0] as Element);
    expect(byId("schedule-slots-full")).toBeNull();
  });

  it("a failed load offers Retry", async () => {
    const { client } = fakeClient(new Error("down"));
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-load-error")).not.toBeNull());
    expect(byId("schedule-retry")).not.toBeNull();
  });

  it("a failed save keeps the draft and says so", async () => {
    const { client } = fakeClient(schedule());
    client.set = async () => {
      throw new Error("nope");
    };
    wrap(<ScheduleEditor channel="rivertide" client={client} now={() => NOW} />);
    await waitFor(() => expect(byId("schedule-editor")).not.toBeNull());
    fireEvent.click(byId("schedule-add-slot") as Element);
    fireEvent.click(byId("schedule-save") as Element);
    await waitFor(() => expect(toasts.error).toEqual([t("w5Schedule.saveFailed")]));
    expect(allById("schedule-slot")).toHaveLength(2);
  });

  it("durations read as words", () => {
    expect(durationLabel(120, "en")).toBe("2 hours");
    expect(durationLabel(90, "en")).toBe("1 hour 30 minutes");
    expect(durationLabel(45, "en")).toBe("45 minutes");
  });
});

describe("About's schedule", () => {
  it("lists the week in the viewer's zone, the one-offs, and the feed", async () => {
    const s = schedule({
      upcoming: [
        ...schedule().upcoming,
        {
          startsAt: "2026-11-18T00:00:00.000Z",
          endsAt: "2026-11-18T01:30:00.000Z",
          title: "Charity",
          category: null,
          slotId: null,
          oneOffId: uuid(10),
        },
      ],
    });
    wrap(<AboutSchedule channel="rivertide" publicUrl="https://air.example" load={async () => s} />);
    await waitFor(() => expect(allById("channel-schedule-slot")).toHaveLength(1));
    expect(byId("channel-schedule-slot")?.textContent).toContain("Campaign night");
    expect(allById("channel-schedule-one-off")).toHaveLength(1);
    expect(byId("channel-schedule-one-off")?.textContent).toContain("Charity");
    expect(byId("channel-schedule-subscribe")?.getAttribute("href")).toBe(
      "webcal://air.example/api/channels/rivertide/schedule.ics",
    );
  });

  it("shows nothing when nothing is coming up", async () => {
    const loaded = vi.fn<(channel: string) => Promise<ChannelSchedule>>(async () => schedule({ upcoming: [] }));
    wrap(<AboutSchedule channel="rivertide" publicUrl="https://air.example" load={loaded} />);
    await waitFor(() => expect(loaded).toHaveBeenCalled());
    await waitFor(() => expect(byId("channel-schedule")).toBeNull());
  });

  it("the About tab, and only it, says it is the About tab", () => {
    const Probe = ({ id }: { id: string }) => (
      <span data-testid={id} data-in-tab={String(React.useContext(AboutTabContext))} />
    );
    const panels = {
      home: <Probe id="probe-home" />,
      videos: null,
      clips: null,
      about: <Probe id="probe-about" />,
    };
    const { rerender } = wrap(<ChannelTabs tab="home" onTabChange={() => undefined} panels={panels} />);
    expect(byId("probe-home")?.getAttribute("data-in-tab")).toBe("false");
    expect(byId("probe-about")).toBeNull();
    rerender(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <ChannelTabs tab="about" onTabChange={() => undefined} panels={panels} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(byId("probe-about")?.getAttribute("data-in-tab")).toBe("true");
  });
});
