// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * d5-dashboard: the "Ready to go live" checklist (overhaul wave 3, D5.1). The rules (current step,
 * phases, `?intent=`, backoff), the rendered steps (one action each, one brand fill, done steps
 * keeping Edit, never a "Go live" button), creating the key with Reveal, the encoder live check
 * and its "still nothing" hint, "Bring your audience" marking the step, the encoder guide, and the
 * load failure's Retry.
 */
import type { StreamSetupState } from "@commonair/contracts/dto";
import { STREAM_SETUP_STEPS, type StreamSetupStep } from "@commonair/contracts/enums";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { RouterContextProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { GoLiveChecklist } from "../src/components/setup-checklist/checklist.tsx";
import type { SetupClient } from "../src/components/setup-checklist/client.ts";
import { EncoderGuide, type Ingest } from "../src/components/setup-checklist/encoder-guide.tsx";
import {
  ENCODER_SLOW_MS,
  SETUP_POLL_MAX_MS,
  SETUP_POLL_MS,
  STEP_MINUTES,
  checklistPhase,
  currentStep,
  parseDashboardSearch,
  phaseSteps,
  progressOf,
  resolutionLabel,
  setupPollDelay,
  visibleSteps,
} from "../src/components/setup-checklist/model.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";
import type { PollEnv, StreamHealthDto } from "../src/lib/stream-health.ts";

// First-party counters: recorded here instead of sent.
const track = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step = "none") => {
    track.calls.push(`${surface}|${action}|${step}`);
  },
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
const wrap = (node: React.ReactNode) =>
  render(
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>{node}</TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>,
  );

type Done = Partial<Record<StreamSetupStep, boolean | null>>;
function setupState(done: Done, signupIntent: StreamSetupState["signupIntent"] = null): StreamSetupState {
  const steps = STREAM_SETUP_STEPS.map((step) => ({
    step,
    // `get_paid` applies only after the first stream on an instance with payouts (d6-studio's tests).
    done: step in done ? (done[step] ?? null) : step === "import_twitch" || step === "get_paid" ? null : false,
    optional: step === "rehearsal" || step === "get_paid",
  }));
  return {
    steps,
    signupIntent,
    complete: steps.every((s) => s.optional || s.done !== false),
  };
}

const INGEST: Ingest = {
  rtmpUrl: "rtmp://ingest.example.test/live",
  whipUrl: "https://ingest.example.test/aurora/whip",
  activeKeyPrefix: null,
  recommended: {
    videoCodec: "H.264 (High profile)",
    audioCodec: "AAC-LC",
    resolution: "1920x1080",
    fps: 60,
    bitrateKbps: 6000,
    keyframeIntervalSeconds: 2,
    rateControl: "CBR",
    audioBitrateKbps: 160,
    notes: [],
  },
};

const HEALTH: StreamHealthDto = {
  live: true,
  broadcastId: "01900000-0000-7000-8000-0000000000b1",
  ingestProtocol: "rtmp",
  transcodeActive: false,
  renditions: [],
  samples: [
    {
      at: "2026-11-11T10:00:00.000Z",
      bitrateKbps: 6000,
      fps: 59.94,
      width: 1920,
      height: 1080,
      videoCodec: "h264",
      audioCodec: "aac",
      keyframeIntervalMs: 2000,
      droppedFrames: 0,
      warnings: [],
    },
  ],
  simulcast: [],
  viewers: { verified: 0, pending: 0, excluded: 0 },
};

function fakeClient(states: StreamSetupState[], over: Partial<SetupClient> = {}) {
  let i = 0;
  const next = () => {
    const s = states[Math.min(i, states.length - 1)];
    i += 1;
    if (!s) throw new Error("no state");
    return s;
  };
  return {
    state: vi.fn<SetupClient["state"]>(async () => next()),
    mark: vi.fn<SetupClient["mark"]>(async () => ({ ok: true })),
    ingest: vi.fn<SetupClient["ingest"]>(async () => INGEST),
    obsConfig: vi.fn<SetupClient["obsConfig"]>(async () => ({ filename: "x-obs-service.json", json: "{}" })),
    createKey: vi.fn<SetupClient["createKey"]>(async () => ({ key: "live_aurora_secretkey123", prefix: "secr" })),
    health: vi.fn<SetupClient["health"]>(async () => HEALTH),
    followLinkConversions: vi.fn<SetupClient["followLinkConversions"]>(async () => 4),
    createFollowLink: vi.fn<SetupClient["createFollowLink"]>(async () => ({ url: "https://site.test/m/aurora/n0nce" })),
    ...over,
  } satisfies SetupClient;
}

const visibleEnv: PollEnv = {
  isVisible: () => true,
  onVisibilityChange: () => () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
};

const stepEl = (id: string) => {
  const el = document.querySelector(`[data-step="${id}"]`);
  if (!el) throw new Error(`no step ${id}`);
  return el as HTMLElement;
};

describe("the checklist's rules", () => {
  it("accepts only the two intents", () => {
    expect(parseDashboardSearch({ intent: "stream" })).toEqual({ intent: "stream" });
    expect(parseDashboardSearch({ intent: "import" })).toEqual({ intent: "import" });
    expect(parseDashboardSearch({ intent: "follow" })).toEqual({});
    expect(parseDashboardSearch({})).toEqual({});
    expect(parseDashboardSearch({ intent: 3 })).toEqual({});
  });

  it("hides steps that do not apply and orders them as the API does", () => {
    const s = setupState({});
    expect(visibleSteps(s).map((x) => x.step)).not.toContain("import_twitch");
    expect(visibleSteps(setupState({ import_twitch: false }, "import")).map((x) => x.step)).toContain("import_twitch");
  });

  it("is in setup until the first stream, then lists what is still open, then nothing", () => {
    expect(checklistPhase(setupState({}))).toBe("setup");
    const after = setupState({
      channel_profile: true,
      stream_info: true,
      stream_key: true,
      encoder_connected: true,
      first_live: true,
    });
    expect(checklistPhase(after)).toBe("after");
    expect(phaseSteps(after).map((s) => s.step)).toEqual(["bring_your_audience"]);
    const all = setupState({ ...Object.fromEntries(STREAM_SETUP_STEPS.map((s) => [s, true])), import_twitch: null });
    expect(checklistPhase(all)).toBe("complete");
    expect(phaseSteps(all)).toEqual([]);
  });

  it("lists Bring your audience before the first stream only for an import sign-up", () => {
    expect(phaseSteps(setupState({})).map((s) => s.step)).not.toContain("bring_your_audience");
    expect(phaseSteps(setupState({ import_twitch: false }, "import")).map((s) => s.step)).toContain(
      "bring_your_audience",
    );
  });

  it("the current step is the first required one not done; the import intent opens the import", () => {
    const s = phaseSteps(setupState({ channel_profile: true }));
    expect(currentStep(s)).toBe("stream_info");
    const imp = phaseSteps(setupState({ import_twitch: false }, "import"));
    expect(currentStep(imp)).toBe("channel_profile");
    expect(currentStep(imp, "import")).toBe("import_twitch");
    expect(currentStep(imp, "stream")).toBe("channel_profile");
    // Only the optional step left: it becomes current; nothing left: null.
    expect(currentStep([{ step: "rehearsal", done: false, optional: true }])).toBe("rehearsal");
    expect(currentStep([{ step: "rehearsal", done: true, optional: true }])).toBeNull();
    expect(currentStep([])).toBeNull();
  });

  it("counts progress over the listed steps", () => {
    expect(progressOf(phaseSteps(setupState({ channel_profile: true, stream_info: true })))).toEqual({
      done: 2,
      total: 6,
    });
  });

  it("backs the live check off from 10 s to a minute", () => {
    expect([0, 1, 2, 3, 10].map(setupPollDelay)).toEqual([
      10_000,
      20_000,
      40_000,
      SETUP_POLL_MAX_MS,
      SETUP_POLL_MAX_MS,
    ]);
    expect(setupPollDelay(-1)).toBe(SETUP_POLL_MS);
  });

  it("estimates every step but going live, and prints resolutions with ×", () => {
    expect(STEP_MINUTES.first_live).toBeNull();
    expect(STEP_MINUTES.stream_key).toBe(2);
    expect(resolutionLabel("1920x1080")).toBe("1920×1080");
  });
});

describe("GoLiveChecklist", () => {
  it("expands the key step with one brand fill, keeps Edit on done steps, and has no Go live button", async () => {
    const client = fakeClient([setupState({ channel_profile: true, stream_info: true })]);
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    const list = await screen.findByTestId("setup-checklist");
    expect(list.getAttribute("data-phase")).toBe("setup");
    expect(list.getAttribute("data-current")).toBe("stream_key");
    expect(within(list).getByText(t("d5Dashboard.checklist.progress", { done: 2, total: 6 }))).toBeTruthy();
    expect(stepEl("channel_profile").getAttribute("data-state")).toBe("done");
    expect(screen.getByTestId("setup-step-channel_profile-edit").getAttribute("href")).toBe("/dashboard/settings");
    expect(screen.getByTestId("setup-step-stream_info-edit")).toBeTruthy();
    const create = await screen.findByTestId("setup-create-key");
    expect(create.hasAttribute("data-filled-cta")).toBe(true);
    expect(document.querySelectorAll("[data-filled-cta]")).toHaveLength(1);
    expect(screen.getByTestId("encoder-guide")).toBeTruthy();
    expect((screen.getByTestId("setup-server-url-value") as HTMLInputElement).value).toBe(INGEST.rtmpUrl);
    // Going live happens in the encoder.
    expect(screen.queryByRole("button", { name: /go live/i })).toBeNull();
    expect(stepEl("first_live").textContent).toContain(t("d5Dashboard.step.first_live.how"));
    expect(stepEl("stream_key").textContent).toContain(t("d5Dashboard.checklist.estimate", { minutes: 2 }));
    expect(screen.getByText(t("d5Dashboard.checklist.support"))).toBeTruthy();
    expect(track.calls).toContain("studio.checklist|view|stream_key");
  });

  it("creates the key, keeps it on screen masked until Reveal, and re-reads the steps", async () => {
    const client = fakeClient([
      setupState({ channel_profile: true, stream_info: true }),
      setupState({ channel_profile: true, stream_info: true, stream_key: true }),
    ]);
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    fireEvent.click(await screen.findByTestId("setup-create-key"));
    await waitFor(() => expect(client.createKey).toHaveBeenCalledWith("aurora"));
    // The encoder step is current now; it keeps the setup (and the new key) open.
    await waitFor(() =>
      expect(screen.getByTestId("setup-checklist").getAttribute("data-current")).toBe("encoder_connected"),
    );
    const key = screen.getByTestId("setup-stream-key-value") as HTMLInputElement;
    expect(key.value).not.toContain("secretkey");
    fireEvent.click(screen.getByTestId("setup-stream-key-reveal"));
    expect(key.value).toBe("live_aurora_secretkey123");
    expect(client.state).toHaveBeenCalledTimes(2);
  });

  it("a failed key creation says so and changes nothing", async () => {
    const client = fakeClient([setupState({ channel_profile: true, stream_info: true })], {
      createKey: vi.fn<SetupClient["createKey"]>(async () => Promise.reject(new Error("no"))),
    });
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    fireEvent.click(await screen.findByTestId("setup-create-key"));
    await waitFor(() => expect(client.createKey).toHaveBeenCalled());
    expect(screen.queryByTestId("setup-stream-key")).toBeNull();
    expect(screen.getByTestId("setup-checklist").getAttribute("data-current")).toBe("stream_key");
  });

  it("checks for the encoder every 10 s, says what to check after a minute, and ticks with the signal", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = setupState({ channel_profile: true, stream_info: true, stream_key: true });
    const connected = setupState({
      channel_profile: true,
      stream_info: true,
      stream_key: true,
      encoder_connected: true,
    });
    let signal = false;
    const client = fakeClient([waiting], {
      state: vi.fn<SetupClient["state"]>(async () => (signal ? connected : waiting)),
    });
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId("setup-encoder-waiting").tagName).toBe("OUTPUT");
    expect(screen.queryByTestId("setup-encoder-slow")).toBeNull();
    expect(client.state).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(client.state).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ENCODER_SLOW_MS);
    });
    expect(screen.getByTestId("setup-encoder-slow")).toBeTruthy();
    // The encoder connects: the next check ticks the step.
    signal = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    vi.useRealTimers();
    await waitFor(() => expect(stepEl("encoder_connected").getAttribute("data-state")).toBe("done"));
    await waitFor(() =>
      expect(stepEl("encoder_connected").textContent).toContain(
        t("d5Dashboard.step.encoder_connected.ok", { resolution: "1920×1080", fps: "60" }),
      ),
    );
    expect(screen.getByTestId("setup-checklist").getAttribute("data-current")).toBe("first_live");
  });

  it("backs off when the live check fails", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const waiting = setupState({ channel_profile: true, stream_info: true, stream_key: true });
    let calls = 0;
    const client = fakeClient([waiting], {
      state: vi.fn<SetupClient["state"]>(async () => {
        calls += 1;
        if (calls === 1) return waiting;
        throw new Error("busy");
      }),
    });
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(calls).toBe(2);
    // The next check waits 20 s, not 10.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
    });
    expect(calls).toBe(3);
  });

  it("does not check while the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let visible = false;
    let onChange: () => void = () => undefined;
    const env: PollEnv = {
      ...visibleEnv,
      isVisible: () => visible,
      onVisibilityChange: (l) => {
        onChange = l;
        return () => undefined;
      },
    };
    const client = fakeClient([setupState({ channel_profile: true, stream_info: true, stream_key: true })]);
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={env} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
    });
    expect(client.state).toHaveBeenCalledTimes(1);
    visible = true;
    await act(async () => {
      onChange();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.state).toHaveBeenCalledTimes(2);
  });

  it("?intent=import opens the import step with its one action", async () => {
    const client = fakeClient([setupState({ import_twitch: false }, "import")]);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        intent="import"
        client={client}
        pollEnv={visibleEnv}
      />,
    );
    const list = await screen.findByTestId("setup-checklist");
    expect(list.getAttribute("data-current")).toBe("import_twitch");
    const action = screen.getByTestId("setup-step-import_twitch-action");
    expect(action.getAttribute("href")).toBe("/import");
    expect(action.hasAttribute("data-filled-cta")).toBe(true);
    // An import sign-up sees Bring your audience before the first stream.
    expect(stepEl("bring_your_audience").getAttribute("data-state")).toBe("todo");
  });

  it("the stream info step points at the page's editor", async () => {
    const onEditInfo = vi.fn<() => void>();
    const client = fakeClient([setupState({ channel_profile: true })]);
    wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={client}
        pollEnv={visibleEnv}
        onEditInfo={onEditInfo}
      />,
    );
    fireEvent.click(await screen.findByTestId("setup-step-stream_info-action"));
    expect(onEditInfo).toHaveBeenCalledTimes(1);
  });

  it("after the first stream: Bring your audience marks on copy and moves on with I've shared it", async () => {
    const writeText = vi.fn<(v: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const after = setupState({
      channel_profile: true,
      stream_info: true,
      stream_key: true,
      encoder_connected: true,
      first_live: true,
    });
    const client = fakeClient([after, { ...after, complete: true }]);
    const { container } = wrap(
      <GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />,
    );
    const list = await screen.findByTestId("setup-checklist");
    expect(list.getAttribute("data-phase")).toBe("after");
    expect(within(list).getByText(t("d5Dashboard.checklist.afterTitle"))).toBeTruthy();
    expect((screen.getByTestId("setup-audience-channel-url") as HTMLInputElement).value).toBe(
      "https://site.test/aurora",
    );
    expect(await screen.findByTestId("setup-audience-conversions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("setup-audience-create"));
    expect(((await screen.findByTestId("setup-audience-follow-url")) as HTMLInputElement).value).toBe(
      "https://site.test/m/aurora/n0nce",
    );
    fireEvent.click(screen.getByTestId("setup-audience-follow-copy"));
    await waitFor(() => expect(client.mark).toHaveBeenCalledWith("aurora", "bring_your_audience"));
    // A copy marks quietly: the link shown once stays on screen.
    expect(client.state).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("setup-audience-follow")).toBeTruthy();
    fireEvent.click(screen.getByTestId("setup-audience-done"));
    await waitFor(() => expect(container.querySelector("[data-testid='setup-checklist']")).toBeNull());
    expect(client.mark).toHaveBeenCalledTimes(2);
  });

  it("renders nothing once everything is done", async () => {
    const all = setupState({ ...Object.fromEntries(STREAM_SETUP_STEPS.map((s) => [s, true])), import_twitch: null });
    const client = fakeClient([all]);
    const { container } = wrap(
      <GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />,
    );
    await waitFor(() => expect(client.state).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector("[data-testid='setup-checklist-loading']")).toBeNull());
    expect(container.querySelector("[data-testid='setup-checklist']")).toBeNull();
  });

  it("a failed load shows the section's error and Retry loads again", async () => {
    let fail = true;
    const ok = setupState({});
    const client = fakeClient([ok], {
      state: vi.fn<SetupClient["state"]>(async () => {
        if (fail) throw Object.assign(new Error("nope"), { status: 500 });
        return ok;
      }),
    });
    wrap(<GoLiveChecklist channel="aurora" publicUrl="https://site.test" client={client} pollEnv={visibleEnv} />);
    expect(await screen.findByTestId("setup-checklist-error")).toBeTruthy();
    expect(screen.getByText(/didn't load/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByTestId("setup-checklist-retry"));
    expect(await screen.findByTestId("setup-checklist")).toBeTruthy();
  });

  it("refreshKey re-reads the steps", async () => {
    const client = fakeClient([setupState({}), setupState({ channel_profile: true })]);
    const view = wrap(
      <GoLiveChecklist
        channel="aurora"
        publicUrl="https://site.test"
        client={client}
        pollEnv={visibleEnv}
        refreshKey={0}
      />,
    );
    await screen.findByTestId("setup-checklist");
    view.rerender(
      <RouterContextProvider router={router}>
        <LocaleProvider locale={locale} messages={uiMessages}>
          <TooltipProvider>
            <GoLiveChecklist
              channel="aurora"
              publicUrl="https://site.test"
              client={client}
              pollEnv={visibleEnv}
              refreshKey={1}
            />
          </TooltipProvider>
        </LocaleProvider>
      </RouterContextProvider>,
    );
    await waitFor(() => expect(stepEl("channel_profile").getAttribute("data-state")).toBe("done"));
    expect(client.state).toHaveBeenCalledTimes(2);
  });
});

describe("EncoderGuide", () => {
  it("has OBS first, the tools by name, the recommended settings and the profile download", async () => {
    const download = vi.fn<(f: string, j: string) => void>();
    const load = vi.fn<() => Promise<{ filename: string; json: string }>>(async () => ({
      filename: "site-obs-service.json",
      json: '{"services":[]}',
    }));
    wrap(<EncoderGuide ingest={INGEST} loadObsConfig={load} download={download} />);
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual([
      t("d5Dashboard.guide.tab.obs"),
      t("d5Dashboard.guide.tab.streamlabs"),
      t("d5Dashboard.guide.tab.larix"),
      t("d5Dashboard.guide.tab.whip"),
    ]);
    const rec = screen.getByTestId("encoder-guide-recommended");
    expect(rec.textContent).toContain("1920×1080");
    expect(rec.textContent).toContain("6,000 kb/s, CBR");
    expect(rec.textContent).toContain("AAC-LC, 160 kb/s");
    fireEvent.click(screen.getByTestId("encoder-guide-obs-profile"));
    await waitFor(() => expect(download).toHaveBeenCalledWith("site-obs-service.json", '{"services":[]}'));
  });

  it("shows the WHIP URL on its tab", async () => {
    wrap(<EncoderGuide ingest={INGEST} loadObsConfig={async () => ({ filename: "f", json: "{}" })} />);
    fireEvent.click(screen.getByTestId("encoder-guide-tab-whip"));
    expect(((await screen.findByTestId("encoder-guide-whip-url")) as HTMLInputElement).value).toBe(INGEST.whipUrl);
  });

  it("a failed profile download does not download anything", async () => {
    const download = vi.fn<(f: string, j: string) => void>();
    wrap(
      <EncoderGuide ingest={INGEST} loadObsConfig={async () => Promise.reject(new Error("x"))} download={download} />,
    );
    fireEvent.click(screen.getByTestId("encoder-guide-obs-profile"));
    await waitFor(() => expect(screen.getByTestId("encoder-guide-obs-profile").hasAttribute("disabled")).toBe(false));
    expect(download).not.toHaveBeenCalled();
  });
});
