// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** E6 studio compositions: spec test ids, callbacks, disabled states and the expiry mapping. */
import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vite-plus/test";
import {
  AlertConfigCard,
  ContentBoard,
  OVERLAY_EXPIRY_CHOICES,
  OverlayTokenPanel,
  SimulcastPanel,
  fillAlertTemplate,
  resolveOverlayExpiry,
  simulcastStatusTone,
  type AlertConfigDraft,
  type OverlayTokenStatusView,
  type SimulcastAddValues,
} from "../../src/blocks/studio/index.ts";
import { TooltipProvider } from "../../src/components/tooltip.tsx";
import {
  alertConfigs,
  alertLabels,
  clips,
  contentLabels,
  overlayTokenLabels,
  simulcastLabels,
  simulcastPlatforms,
  simulcastTargets,
  vods,
} from "../../stories/e6-fixtures.tsx";

const withTooltips = (node: React.ReactNode) => <TooltipProvider>{node}</TooltipProvider>;
const attr = (el: Element, name: string) => el.getAttribute(name);
const tip = alertConfigs.tip as AlertConfigDraft;

describe("SimulcastPanel", () => {
  const renderPanel = (props: Partial<React.ComponentProps<typeof SimulcastPanel>> = {}) => {
    const handlers = {
      onAdd: vi.fn<(values: SimulcastAddValues) => void | Promise<void>>(),
      onToggle: vi.fn<(id: string, enabled: boolean) => void>(),
      onRemove: vi.fn<(id: string) => void>(),
      onError: vi.fn<(error: unknown) => void>(),
    };
    render(
      <SimulcastPanel
        targets={simulcastTargets}
        platforms={simulcastPlatforms}
        labels={simulcastLabels}
        {...handlers}
        {...props}
      />,
    );
    return handlers;
  };

  test("rows carry the spec's id, status and enabled state; the key is nowhere", () => {
    renderPanel();
    expect(screen.getByTestId("simulcast")).toBeTruthy();
    const rows = screen.getAllByTestId("simulcast-target");
    expect(
      rows.map((row) => [attr(row, "data-target-id"), attr(row, "data-status"), attr(row, "data-enabled")]),
    ).toEqual([
      ["t1", "live", "true"],
      ["t2", "error", "false"],
    ]);
    expect(rows[1]?.textContent).toContain("connect_refused");
    expect(screen.queryByTestId("simulcast-empty")).toBeNull();
    expect((screen.getByTestId("simulcast-key") as HTMLInputElement).type).toBe("password");
  });

  test("status tones", () => {
    expect(["live", "connecting", "error", "idle", "stopped"].map(simulcastStatusTone)).toEqual([
      "success",
      "info",
      "danger",
      "neutral",
      "neutral",
    ]);
  });

  test("the switch reports the new state", async () => {
    const { onToggle } = renderPanel();
    const [first] = screen.getAllByTestId("simulcast-target");
    await userEvent.setup().click(within(first as HTMLElement).getByTestId("simulcast-enabled"));
    expect(onToggle).toHaveBeenCalledWith("t1", false);
  });

  test("a busy row's switch is disabled", () => {
    renderPanel({ busyIds: ["t2"] });
    const switches = screen.getAllByTestId("simulcast-enabled");
    expect(switches[0]?.hasAttribute("data-disabled")).toBe(false);
    expect(switches[1]?.hasAttribute("data-disabled")).toBe(true);
  });

  test("remove asks first and then calls onRemove", async () => {
    const { onRemove } = renderPanel();
    const user = userEvent.setup();
    const [first] = screen.getAllByTestId("simulcast-remove");
    await user.click(first as HTMLElement);
    expect(onRemove).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onRemove).toHaveBeenCalledWith("t1");
  });

  test("add stays disabled until every field is filled, then submits and clears", async () => {
    const { onAdd } = renderPanel({ targets: [] });
    expect(screen.getByTestId("simulcast-empty")).toBeTruthy();
    const user = userEvent.setup();
    const add = screen.getByTestId("simulcast-add") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    await user.type(screen.getByTestId("simulcast-name"), "Mock");
    await user.type(screen.getByTestId("simulcast-url"), " rtmp://mock-rtmp:1936/live ");
    expect(add.disabled).toBe(true);
    await user.type(screen.getByTestId("simulcast-key"), "harness-1");
    expect(add.disabled).toBe(false);
    await user.click(screen.getByRole("combobox", { name: "Platform" }));
    await user.click(await screen.findByTestId("simulcast-platform-option-custom"));
    expect(attr(screen.getByTestId("simulcast-platform"), "data-value")).toBe("custom");
    await user.click(add);
    expect(onAdd).toHaveBeenCalledWith({
      name: "Mock",
      platform: "custom",
      rtmpUrl: "rtmp://mock-rtmp:1936/live",
      streamKey: "harness-1",
    });
    expect((screen.getByTestId("simulcast-key") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("simulcast-name") as HTMLInputElement).value).toBe("");
  });

  test("a refused add keeps what was typed and reports the error", async () => {
    const refusal = new Error("refused");
    const { onError } = renderPanel({ onAdd: () => Promise.reject(refusal) });
    const user = userEvent.setup();
    await user.type(screen.getByTestId("simulcast-name"), "Mock");
    await user.type(screen.getByTestId("simulcast-url"), "rtmp://10.0.0.1/live");
    await user.type(screen.getByTestId("simulcast-key"), "k");
    await user.click(screen.getByTestId("simulcast-add"));
    expect(onError).toHaveBeenCalledWith(refusal);
    expect((screen.getByTestId("simulcast-key") as HTMLInputElement).value).toBe("k");
  });

  test("an API refusal shows inline with its reason", () => {
    renderPanel({ error: { reason: "private_address", message: "Private network" } });
    const error = screen.getByTestId("simulcast-error");
    expect(attr(error, "data-reason")).toBe("private_address");
    expect(attr(error, "role")).toBe("alert");
  });

  test("at the cap the form is replaced by the limit note", () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ ...simulcastTargets[0]!, id: `x${i}` }));
    renderPanel({ targets: five });
    expect(screen.queryByTestId("simulcast-add")).toBeNull();
    expect(screen.getByTestId("simulcast-limit")).toBeTruthy();
  });

  test("loading shows a skeleton and no add button can fire", () => {
    renderPanel({ targets: null });
    expect(screen.queryAllByTestId("simulcast-target")).toEqual([]);
    expect(screen.queryByTestId("simulcast-empty")).toBeNull();
    expect((screen.getByTestId("simulcast-add") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("fillAlertTemplate", () => {
  test("fills known variables and leaves unknown or missing ones as written", () => {
    expect(fillAlertTemplate("${user} tipped ${amount}", { user: "Fern", amount: "$2.50" })).toBe("Fern tipped $2.50");
    expect(fillAlertTemplate("${user} ${nope} ${tier}", { user: "A" })).toBe("A ${nope} ${tier}");
    expect(fillAlertTemplate("plain", {})).toBe("plain");
  });
});

describe("AlertConfigCard", () => {
  const renderCard = (props: Partial<React.ComponentProps<typeof AlertConfigCard>> = {}) => {
    const handlers = {
      onSave: vi.fn<(draft: AlertConfigDraft) => void>(),
      onTest: vi.fn<() => void>(),
    };
    const view = render(
      <AlertConfigCard
        type="tip"
        title="Tip alert"
        config={tip}
        variables={["user", "amount", "message"]}
        currency="USD"
        labels={alertLabels}
        {...handlers}
        {...props}
      />,
    );
    return { ...handlers, ...view };
  };

  test("the card carries its type and saved enabled state, with every field id", () => {
    renderCard();
    const card = screen.getByTestId("alert-config");
    expect(attr(card, "data-type")).toBe("tip");
    expect(attr(card, "data-enabled")).toBe("true");
    for (const id of ["alert-enabled", "alert-message", "alert-min-amount", "alert-duration", "alert-animation"])
      expect(within(card).getByTestId(id)).toBeTruthy();
    expect(attr(screen.getByTestId("alert-duration"), "data-ms")).toBe("6000");
  });

  test("only tips have a minimum amount", () => {
    renderCard({ type: "follow", config: alertConfigs.follow as AlertConfigDraft });
    expect(screen.queryByTestId("alert-min-amount")).toBeNull();
    expect(attr(screen.getByTestId("alert-config"), "data-enabled")).toBe("false");
  });

  test("save sends the edited draft", async () => {
    const { onSave } = renderCard();
    const user = userEvent.setup();
    const message = screen.getByTestId("alert-message");
    await user.clear(message);
    await user.type(message, "Thanks ");
    await user.click(screen.getByRole("button", { name: "${user}" }));
    const duration = screen.getByTestId("alert-duration");
    await user.clear(duration);
    await user.type(duration, "5");
    const amount = within(screen.getByTestId("alert-min-amount")).getByRole("textbox");
    await user.clear(amount);
    await user.type(amount, "2.50");
    await user.click(screen.getByTestId("alert-enabled"));
    await user.click(screen.getByTestId("alert-save"));
    expect(onSave).toHaveBeenCalledWith({
      ...tip,
      enabled: false,
      message: "Thanks ${user}",
      durationMs: 5000,
      minAmountCents: 250,
    });
  });

  test("picking an animation updates the draft", async () => {
    const { onSave } = renderCard();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Animation" }));
    await user.click(await screen.findByTestId("alert-animation-option-slide"));
    expect(attr(screen.getByTestId("alert-animation"), "data-value")).toBe("slide");
    await user.click(screen.getByTestId("alert-save"));
    expect(onSave).toHaveBeenCalledWith({ ...tip, animation: "slide" });
  });

  test.each(["0", "31", "", "abc"])("duration %j disables save", async (text) => {
    renderCard();
    const duration = screen.getByTestId("alert-duration");
    fireEvent.change(duration, { target: { value: text } });
    expect((screen.getByTestId("alert-save") as HTMLButtonElement).disabled).toBe(true);
    expect(attr(duration, "data-ms")).toBe("");
  });

  test("an empty message disables save", async () => {
    renderCard();
    await userEvent.setup().clear(screen.getByTestId("alert-message"));
    expect((screen.getByTestId("alert-save") as HTMLButtonElement).disabled).toBe(true);
  });

  test("the test button fires onTest", async () => {
    const { onTest } = renderCard();
    await userEvent.setup().click(screen.getByTestId("alert-test"));
    expect(onTest).toHaveBeenCalledOnce();
  });

  test("a new saved config from the server replaces the draft", async () => {
    const { rerender } = renderCard();
    await userEvent.setup().type(screen.getByTestId("alert-message"), "!!");
    expect(attr(screen.getByTestId("alert-config"), "data-dirty")).toBe("true");
    rerender(
      <AlertConfigCard
        type="tip"
        title="Tip alert"
        config={{ ...tip, message: "server" }}
        variables={["user"]}
        currency="USD"
        labels={alertLabels}
        onSave={() => undefined}
        onTest={() => undefined}
      />,
    );
    expect((screen.getByTestId("alert-message") as HTMLInputElement).value).toBe("server");
    expect(screen.getByTestId("alert-config").hasAttribute("data-dirty")).toBe(false);
  });

  test("the preview renders the unsaved draft", async () => {
    renderCard({ preview: (draft) => <output data-testid="preview">{draft.message}</output> });
    await userEvent.setup().type(screen.getByTestId("alert-message"), "!");
    expect(screen.getByTestId("preview").textContent).toBe("${user} tipped ${amount}!");
  });
});

describe("resolveOverlayExpiry", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  test("none is no expiry", () => {
    expect(resolveOverlayExpiry("none", now)).toEqual({ ok: true, expiresAt: null });
  });

  test.each([
    ["1d", 1],
    ["7d", 7],
    ["30d", 30],
    ["90d", 90],
  ] as const)("%s is now + %i days", (choice, days) => {
    expect(resolveOverlayExpiry(choice, now)).toEqual({
      ok: true,
      expiresAt: new Date(now + days * 86_400_000).toISOString(),
    });
  });

  test("6mo adds six calendar months, clamped to a shorter month", () => {
    expect(resolveOverlayExpiry("6mo", now)).toEqual({ ok: true, expiresAt: "2027-04-22T12:00:00.000Z" });
    expect(resolveOverlayExpiry("6mo", Date.UTC(2026, 7, 31, 9))).toEqual({
      ok: true,
      expiresAt: "2027-02-28T09:00:00.000Z",
    });
    expect(resolveOverlayExpiry("6mo", new Date(Date.UTC(2027, 7, 31)))).toEqual({
      ok: true,
      expiresAt: "2028-02-29T00:00:00.000Z",
    });
  });

  test("date reads the datetime-local text in local time and must be in the future", () => {
    const expected = new Date(2026, 11, 24, 18, 30).toISOString();
    expect(resolveOverlayExpiry("date", now, "2026-12-24T18:30")).toEqual({ ok: true, expiresAt: expected });
    expect(resolveOverlayExpiry("date", now, "2026-12-24T18:30:15")).toEqual({
      ok: true,
      expiresAt: new Date(2026, 11, 24, 18, 30, 15).toISOString(),
    });
    expect(resolveOverlayExpiry("date", now, "2020-01-01T00:00")).toEqual({ ok: false, reason: "past" });
    expect(resolveOverlayExpiry("date", now, "")).toEqual({ ok: false, reason: "invalid" });
    expect(resolveOverlayExpiry("date", now, "next tuesday")).toEqual({ ok: false, reason: "invalid" });
    expect(resolveOverlayExpiry("date", now, "2027-02-30T10:00")).toEqual({ ok: false, reason: "invalid" });
  });

  test("every menu choice resolves", () => {
    expect(OVERLAY_EXPIRY_CHOICES).toEqual(["none", "1d", "7d", "30d", "90d", "6mo", "date"]);
    for (const choice of OVERLAY_EXPIRY_CHOICES)
      expect(resolveOverlayExpiry(choice, now, "2030-01-01T00:00").ok).toBe(true);
  });
});

describe("OverlayTokenPanel", () => {
  const active: OverlayTokenStatusView = {
    active: true,
    createdAt: "2026-10-20T12:00:00Z",
    expiresAt: "2026-10-29T12:00:00Z",
  };
  const inactive: OverlayTokenStatusView = { active: false, createdAt: null, expiresAt: null };
  const now = () => Date.UTC(2026, 9, 22, 12);
  const renderPanel = (props: Partial<React.ComponentProps<typeof OverlayTokenPanel>> = {}) => {
    const handlers = {
      onCreate: vi.fn<(expiresAt: string | null) => void>(),
      onRevoke: vi.fn<() => void>(),
    };
    render(
      withTooltips(
        <OverlayTokenPanel status={active} labels={overlayTokenLabels} now={now} {...handlers} {...props} />,
      ),
    );
    return handlers;
  };

  test("the panel carries active and expiry", () => {
    renderPanel();
    const panel = screen.getByTestId("overlay-token");
    expect(attr(panel, "data-active")).toBe("true");
    expect(attr(panel, "data-expires-at")).toBe("2026-10-29T12:00:00Z");
    expect(screen.getByTestId("overlay-token-revoke")).toBeTruthy();
    expect(screen.queryByTestId("overlay-url")).toBeNull();
  });

  test("no token: inactive, empty expiry, no revoke; create sends null by default", async () => {
    const { onCreate } = renderPanel({ status: inactive });
    const panel = screen.getByTestId("overlay-token");
    expect(attr(panel, "data-active")).toBe("false");
    expect(attr(panel, "data-expires-at")).toBe("");
    expect(screen.queryByTestId("overlay-token-revoke")).toBeNull();
    await userEvent.setup().click(screen.getByTestId("overlay-token-create"));
    expect(onCreate).toHaveBeenCalledWith(null);
  });

  test("a quick pick sends its instant", async () => {
    const { onCreate } = renderPanel({ status: inactive });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Expires" }));
    await user.click(await screen.findByTestId("overlay-expiry-option-7d"));
    expect(attr(screen.getByTestId("overlay-expiry"), "data-value")).toBe("7d");
    expect(screen.queryByTestId("overlay-expiry-date")).toBeNull();
    await user.click(screen.getByTestId("overlay-token-create"));
    expect(onCreate).toHaveBeenCalledWith(new Date(now() + 7 * 86_400_000).toISOString());
  });

  test("date shows the input; create waits for a valid future time", async () => {
    const { onCreate } = renderPanel({ status: inactive });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Expires" }));
    await user.click(await screen.findByTestId("overlay-expiry-option-date"));
    const input = screen.getByTestId("overlay-expiry-date");
    const create = screen.getByTestId("overlay-token-create") as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "2020-01-01T00:00" } });
    expect(create.disabled).toBe(true);
    expect(screen.getByText("Pick a time in the future.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "2027-01-01T09:00" } });
    expect(create.disabled).toBe(false);
    await user.click(create);
    expect(onCreate).toHaveBeenCalledWith(new Date(2027, 0, 1, 9, 0).toISOString());
  });

  test("rotating an active token asks first", async () => {
    const { onCreate } = renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overlay-token-create"));
    expect(onCreate).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onCreate).toHaveBeenCalledWith(null);
  });

  test("revoke asks first", async () => {
    const { onRevoke } = renderPanel();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overlay-token-revoke"));
    expect(onRevoke).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onRevoke).toHaveBeenCalledOnce();
  });

  test("the created URL is masked until revealed, and readable from data-url", async () => {
    const url = "https://x.test/overlay/alerts?token=abc";
    renderPanel({ createdUrl: url });
    const field = screen.getByTestId("overlay-url");
    expect(attr(field, "data-url")).toBe(url);
    const value = within(field).getByTestId("overlay-url-value") as HTMLInputElement;
    expect(value.value).not.toContain("token=abc");
    await userEvent.setup().click(within(field).getByTestId("overlay-url-reveal"));
    expect(value.value).toBe(url);
  });

  test("a revoked or inactive status hides the created URL", () => {
    renderPanel({ status: inactive, createdUrl: "https://x.test/overlay/alerts?token=abc" });
    expect(screen.queryByTestId("overlay-url")).toBeNull();
    expect(document.body.innerHTML).not.toContain("token=abc");
  });

  test("loading: no status, create disabled", () => {
    renderPanel({ status: null });
    expect(attr(screen.getByTestId("overlay-token"), "data-active")).toBe("false");
    expect((screen.getByTestId("overlay-token-create") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ContentBoard", () => {
  const renderBoard = (props: Partial<React.ComponentProps<typeof ContentBoard>> = {}) => {
    const handlers = {
      onSaveVod: vi.fn<(id: string, update: { title: string; visibility: string }) => void>(),
      onDeleteVod: vi.fn<(id: string) => void>(),
      onDeleteClip: vi.fn<(id: string) => void>(),
    };
    const view = render(
      withTooltips(<ContentBoard vods={vods} clips={clips} labels={contentLabels} {...handlers} {...props} />),
    );
    return { ...handlers, ...view };
  };

  test("VOD rows carry id, visibility and status; save is disabled until something changes", () => {
    renderBoard();
    expect(screen.getByTestId("content-vods")).toBeTruthy();
    const rows = screen.getAllByTestId("vod-row");
    expect(
      rows.map((row) => [attr(row, "data-vod-id"), attr(row, "data-visibility"), attr(row, "data-status")]),
    ).toEqual([
      ["v1", "public", "ready"],
      ["v2", "subscribers", "processing"],
    ]);
    for (const save of screen.getAllByTestId("vod-save")) expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test("rename and re-scope, then save", async () => {
    const { onSaveVod } = renderBoard();
    const user = userEvent.setup();
    const row = screen.getAllByTestId("vod-row")[0] as HTMLElement;
    const title = within(row).getByTestId("vod-title");
    await user.clear(title);
    await user.type(title, "  Renamed ");
    await user.click(within(row).getByRole("combobox", { name: "Visibility" }));
    await user.click(await screen.findByTestId("vod-visibility-option-private"));
    expect(attr(within(row).getByTestId("vod-visibility"), "data-value")).toBe("private");
    await user.click(within(row).getByTestId("vod-save"));
    expect(onSaveVod).toHaveBeenCalledWith("v1", { title: "Renamed", visibility: "private" });
  });

  test("an empty title cannot be saved", async () => {
    renderBoard();
    const row = screen.getAllByTestId("vod-row")[0] as HTMLElement;
    await userEvent.setup().clear(within(row).getByTestId("vod-title"));
    expect((within(row).getByTestId("vod-save") as HTMLButtonElement).disabled).toBe(true);
  });

  test("delete a VOD asks first", async () => {
    const { onDeleteVod } = renderBoard();
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId("vod-delete")[1] as HTMLElement);
    expect(onDeleteVod).not.toHaveBeenCalled();
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onDeleteVod).toHaveBeenCalledWith("v2");
  });

  test("the clips tab lists clips and deletes after confirming", async () => {
    const { onDeleteClip } = renderBoard();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("content-tab-clips"));
    const panel = await screen.findByTestId("content-clips");
    const row = within(panel).getByTestId("clip-row");
    expect(attr(row, "data-clip-id")).toBe("c1");
    expect(row.textContent).toContain("Clipped by Fernsby");
    await user.click(within(row).getByTestId("clip-delete"));
    await user.click(await screen.findByTestId("confirm-dialog-confirm"));
    expect(onDeleteClip).toHaveBeenCalledWith("c1");
  });

  test("both panels stay mounted, so clip rows are queryable before the clips tab is opened", () => {
    renderBoard();
    const clipsPanel = screen.getByTestId("content-clips");
    expect(clipsPanel.hidden).toBe(true);
    expect(attr(within(clipsPanel).getByTestId("clip-row"), "data-clip-id")).toBe("c1");
    expect(within(clipsPanel).getByTestId("clip-delete")).toBeTruthy();
    expect(screen.getByTestId("content-vods").hidden).toBe(false);
  });

  test("the two empty states differ by data-kind", () => {
    renderBoard({ vods: [], clips: [] });
    expect(screen.getAllByTestId("content-empty").map((el) => attr(el, "data-kind"))).toEqual(["vods", "clips"]);
  });

  test("empty lists show the empty state; loading shows no rows", () => {
    const { unmount } = renderBoard({ vods: [], defaultTab: "vods" });
    expect(within(screen.getByTestId("content-vods")).getByTestId("content-empty")).toBeTruthy();
    unmount();
    renderBoard({ clips: [], tab: "clips" });
    expect(within(screen.getByTestId("content-clips")).getByTestId("content-empty")).toBeTruthy();
  });

  test("loading renders skeletons, not the empty state", () => {
    renderBoard({ vods: null });
    const panel = screen.getByTestId("content-vods");
    expect(within(panel).queryByTestId("content-empty")).toBeNull();
    expect(panel.querySelector("[aria-busy='true']")).not.toBeNull();
  });

  test("the server's copy replaces the draft", async () => {
    const { rerender } = renderBoard();
    const user = userEvent.setup();
    const row = () => screen.getAllByTestId("vod-row")[0] as HTMLElement;
    await user.type(within(row()).getByTestId("vod-title"), " draft");
    act(() => {
      rerender(
        withTooltips(
          <ContentBoard
            vods={[{ ...vods[0]!, title: "From server" }]}
            clips={clips}
            labels={contentLabels}
            onSaveVod={() => undefined}
            onDeleteVod={() => undefined}
            onDeleteClip={() => undefined}
          />,
        ),
      );
    });
    expect((within(row()).getByTestId("vod-title") as HTMLInputElement).value).toBe("From server");
  });
});
