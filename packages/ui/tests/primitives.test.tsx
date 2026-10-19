// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type * as React from "react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { InboxIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import {
  ChannelAvatar,
  EmptyState,
  IconButton,
  LiveBadge,
  LocaleProvider,
  MoneyAmount,
  RelativeTime,
  Shortcut,
  SkeletonGroup,
  SkeletonText,
  StreamCard,
  StreamCardSkeleton,
  ThemeToggle,
  ViewerCount,
  applyTheme,
  keyLabel,
} from "../src/index.ts";
import { Toaster, toast } from "../src/toast.tsx";
import { AccentButton } from "../src/primitives/accent-button.tsx";
import { OverlayBadge } from "../src/primitives/overlay-badge.tsx";
import { StatusBadge } from "../src/primitives/status-badge.tsx";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function advance(totalMs: number, stepMs: number): void {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    act(() => {
      vi.advanceTimersByTime(stepMs);
    });
  }
}

describe("ChannelAvatar", () => {
  test("falls back to the accent-colored initial and keeps the name accessible", () => {
    const { container } = render(<ChannelAvatar name="émile" accent="violet" />);
    const root = container.querySelector('[data-slot="avatar"]')!;
    expect(root.getAttribute("data-accent")).toBe("violet");
    const fallback = container.querySelector('[data-slot="avatar-fallback"]')!;
    expect(fallback.className).toContain("bg-channel-accent");
    expect(
      within(fallback as HTMLElement)
        .getByText("É")
        .getAttribute("aria-hidden"),
    ).toBe("true");
    expect(screen.getByText("émile").className).toContain("sr-only");
  });

  test("uses zinc when the channel has no accent, and '?' for an empty name", () => {
    const { container } = render(<ChannelAvatar name="" accent={null} />);
    expect(container.querySelector('[data-slot="avatar"]')!.getAttribute("data-accent")).toBe("zinc");
    expect(screen.getByText("?")).toBeTruthy();
  });

  test("decorative avatars are hidden from assistive tech", () => {
    const { container } = render(<ChannelAvatar name="bob" decorative />);
    expect(container.querySelector('[data-slot="avatar"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(screen.queryByText("bob")).toBeNull();
  });

  test("live adds the live ring", () => {
    const { container } = render(<ChannelAvatar name="bob" live />);
    const root = container.querySelector('[data-slot="avatar"]')!;
    expect(root.getAttribute("data-live")).toBe("true");
    expect(root.className).toContain("ring-live");
  });
});

describe("ViewerCount", () => {
  test("shows a compact number and announces the full verified count", () => {
    const { container } = render(<ViewerCount count={1234} locale="en" />);
    expect(container.querySelector('[aria-hidden="true"]:not(svg)')!.textContent).toBe("1.2K");
    expect(screen.getByText("1,234 verified viewers").className).toContain("sr-only");
  });

  test("singular label and locale from the provider", () => {
    render(
      <LocaleProvider
        locale="de"
        messages={{ viewerCount: (n, count) => `${n} ${count === 1 ? "verifizierter Zuschauer" : "Zuschauer"}` }}
      >
        <ViewerCount count={1} />
        <ViewerCount count={1_500_000} />
      </LocaleProvider>,
    );
    expect(screen.getByText("1 verifizierter Zuschauer")).toBeTruthy();
    expect(screen.getByText("1.500.000 Zuschauer")).toBeTruthy();
  });

  test("treats negative or invalid counts as zero", () => {
    render(<ViewerCount count={-5} locale="en" />);
    expect(screen.getByText("0 verified viewers")).toBeTruthy();
  });
});

describe("LiveBadge", () => {
  test("uses the catalog label unless one is passed", () => {
    render(
      <>
        <LiveBadge />
        <LiveBadge label="En direct" />
      </>,
    );
    expect(screen.getByText("Live")).toBeTruthy();
    expect(screen.getByText("En direct")).toBeTruthy();
  });
});

describe("design-system status primitives", () => {
  test("StatusBadge exposes tone and keeps its meaning in text", () => {
    const { container } = render(<StatusBadge tone="success">Approved</StatusBadge>);
    expect(container.querySelector('[data-tone="success"]')?.textContent).toBe("Approved");
  });

  test("OverlayBadge marks video overlay content and forwards data attributes", () => {
    render(
      <OverlayBadge data-testid="duration" size="sm">
        2:34
      </OverlayBadge>,
    );
    expect(screen.getByTestId("duration").getAttribute("data-overlay")).toBe("");
    expect(screen.getByText("2:34").className).toContain("text-2xs");
  });

  test("AccentButton keeps the channel accent", () => {
    render(<AccentButton accent="teal">Follow</AccentButton>);
    const button = screen.getByRole("button", { name: "Follow" });
    expect(button.getAttribute("data-accent")).toBe("teal");
    expect(button.className).toContain("bg-channel-accent");
  });
});

describe("RelativeTime", () => {
  test("renders <time dateTime> and updates as time passes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    render(<RelativeTime date="2026-06-15T11:59:55Z" locale="en" />);
    const time = screen.getByText("5 seconds ago");
    expect(time.tagName).toBe("TIME");
    expect(time.getAttribute("datetime")).toBe("2026-06-15T11:59:55.000Z");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(time.textContent).toBe("6 seconds ago");

    // Each tick re-renders and schedules the next one, so advance in steps the way real time passes.
    advance(54_000, 1_000);
    expect(time.textContent).toBe("1 minute ago");
    // Minutes only re-render once per minute, not every second.
    expect(vi.getTimerCount()).toBe(1);

    advance(59 * 60_000, 60_000);
    expect(time.textContent).toBe("1 hour ago");
  });

  test("does not tick when live is off", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-15T12:00:00Z"));
    render(<RelativeTime date={new Date("2026-06-15T11:59:00Z")} locale="en" live={false} />);
    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(screen.getByText("1 minute ago")).toBeTruthy();
  });

  test("clears its timer on unmount", () => {
    vi.useFakeTimers();
    const { unmount } = render(<RelativeTime date={Date.now() - 1000} locale="en" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("shows the absolute time in a tooltip on hover", async () => {
    const user = userEvent.setup();
    render(<RelativeTime date="2026-06-15T11:00:00Z" locale="en" timeZone="UTC" />);
    await user.hover(screen.getByText(/ago$/));
    expect(await screen.findByText("June 15, 2026 at 11:00 AM")).toBeTruthy();
  });

  test("renders an empty time element for an invalid date instead of throwing", () => {
    const { container } = render(<RelativeTime date="not a date" />);
    expect(container.querySelector("time")!.textContent).toBe("");
  });
});

describe("MoneyAmount", () => {
  test("formats from the Money DTO shape and keeps the raw value", () => {
    const { container } = render(<MoneyAmount value={{ cents: -1234, currency: "JPY" }} locale="en" colorNegative />);
    const data = container.querySelector("data")!;
    expect(data.textContent).toBe("-¥1,234");
    expect(data.getAttribute("value")).toBe("-1234");
    expect(data.className).toContain("text-destructive");
  });

  test("follows the provider locale", () => {
    render(
      <LocaleProvider locale="de-DE">
        <MoneyAmount value={{ cents: 499, currency: "EUR" }} />
      </LocaleProvider>,
    );
    expect(screen.getByText(/^4,99\s€$/)).toBeTruthy();
  });
});

describe("EmptyState", () => {
  test("renders a heading, description and action", () => {
    render(
      <EmptyState
        icon={InboxIcon}
        title="No clips yet"
        description="Clips you make appear here."
        action={<button type="button">Make a clip</button>}
        headingLevel={3}
      />,
    );
    expect(screen.getByRole("heading", { level: 3, name: "No clips yet" })).toBeTruthy();
    expect(screen.getByText("Clips you make appear here.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make a clip" })).toBeTruthy();
  });
});

describe("IconButton", () => {
  test("is named by its label and shows it as a tooltip on hover and focus", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(<IconButton label="Settings" icon={Settings01Icon} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Settings" });
    expect(button.hasAttribute("title")).toBe(false);
    expect(screen.queryByRole("tooltip")).toBeNull();

    await user.hover(button);
    expect(
      (
        await screen.findByText("Settings", {
          selector: '[data-slot="tooltip-content"] *, [data-slot="tooltip-content"]',
        })
      ).textContent,
    ).toBe("Settings");
    await user.unhover(button);
    await user.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("tooltip text can differ from the accessible label", async () => {
    const user = userEvent.setup();
    render(<IconButton label="Search" tooltip="Search (⌘K)" icon={Settings01Icon} />);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Search (⌘K)")).toBeTruthy();
  });
});

const stream: StreamCardData = {
  channel: {
    id: "0190a8a0-0000-7000-8000-000000000001",
    slug: "pixel_pioneer",
    displayName: "Pixel Pioneer",
    avatarUrl: null,
    accent: "teal",
  },
  broadcast: {
    id: "0190a8a0-0000-7000-8000-000000000002",
    title: "Speedrunning every co-op classic",
    category: { id: "0190a8a0-0000-7000-8000-000000000003", slug: "retro", name: "Retro" },
    startedAt: "2026-06-15T10:00:00Z",
    mature: false,
    viewerCount: 15_300,
    thumbnailUrl: "https://media.invalid/thumb.webp",
  },
  tags: ["speedrun", "co-op", "english", "chill"],
  language: "en",
  reason: "spotlight",
};

/** Stands in for a router <Link>: receives href, className and children from the card. */
function RouterLink({ children, ...props }: React.ComponentProps<"a">) {
  return (
    <a data-router="yes" {...props}>
      {children}
    </a>
  );
}

/** happy-dom reports every <img> as complete with no size; real browsers report "still loading". */
function imagesStillLoading(): void {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
}

describe("StreamCard", () => {
  test("is one keyboard-focusable link with title, channel, category, live and viewer count", async () => {
    imagesStillLoading();
    const user = userEvent.setup();
    const { container } = render(<StreamCard stream={stream} href="/pixel_pioneer" locale="en" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/pixel_pioneer");
    await user.tab();
    expect(document.activeElement).toBe(link);
    expect(within(link).getByRole("heading", { level: 3 }).textContent).toBe(stream.broadcast.title);
    expect(within(link).getByText("Pixel Pioneer")).toBeTruthy();
    expect(within(link).getByText("Retro")).toBeTruthy();
    expect(within(link).getByText("Live")).toBeTruthy();
    expect(within(link).getByText("15,300 verified viewers")).toBeTruthy();
    expect(container.querySelector("article")!.getAttribute("data-accent")).toBe("teal");
    expect(container.querySelector("img")!.getAttribute("alt")).toBe("");
  });

  test("shows the discovery reason and at most maxTags tags", () => {
    render(<StreamCard stream={stream} href="/x" maxTags={2} />);
    expect(screen.getByText("Spotlight").closest("[data-reason]")!.getAttribute("data-reason")).toBe("spotlight");
    expect(screen.getByText("speedrun")).toBeTruthy();
    expect(screen.getByText("co-op")).toBeTruthy();
    expect(screen.queryByText("english")).toBeNull();
  });

  test("custom reason label, hidden reason, mature badge and missing thumbnail", () => {
    const mature = { ...stream, broadcast: { ...stream.broadcast, mature: true, thumbnailUrl: null } };
    const { container, rerender } = render(<StreamCard stream={mature} href="/x" reasonLabel="Staff pick" />);
    expect(screen.getByText("Staff pick")).toBeTruthy();
    expect(screen.getByText("Mature")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    rerender(<StreamCard stream={mature} href="/x" showReason={false} maxTags={0} />);
    expect(screen.queryByText("Spotlight")).toBeNull();
    expect(container.querySelector("ul")).toBeNull();
  });

  test("a thumbnail that fails to load falls back to the accent placeholder", () => {
    imagesStillLoading();
    const { container } = render(<StreamCard stream={stream} href="/x" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".bg-channel-accent\\/15")).toBeTruthy();
  });

  test("a thumbnail that already failed before hydration (complete, no size) falls back too", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(0);
    const { container } = render(<StreamCard stream={stream} href="/x" />);
    expect(container.querySelector("img")).toBeNull();
  });

  test("a loaded thumbnail is kept", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(320);
    const { container } = render(<StreamCard stream={stream} href="/x" />);
    expect(container.querySelector("img")).toBeTruthy();
  });

  test("renders through a custom link element", () => {
    render(<StreamCard stream={stream} href="/x" render={<RouterLink />} />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("data-router")).toBe("yes");
    expect(link.getAttribute("href")).toBe("/x");
  });

  test("user text is direction-isolated for RTL titles", () => {
    const rtl = { ...stream, broadcast: { ...stream.broadcast, title: "بث مباشر طويل جدا" } };
    render(<StreamCard stream={rtl} href="/x" />);
    expect(screen.getByRole("heading").getAttribute("dir")).toBe("auto");
  });

  test("skeleton is hidden from assistive tech", () => {
    const { container } = render(<StreamCardSkeleton />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("skeletons", () => {
  test("a group announces one loading status", () => {
    render(
      <SkeletonGroup>
        <SkeletonText lines={4} />
      </SkeletonGroup>,
    );
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-busy")).toBe("true");
    expect(within(status).getByText("Loading")).toBeTruthy();
    expect(status.querySelectorAll('[data-slot="skeleton"]').length).toBe(4);
  });
});

describe("Shortcut", () => {
  test("maps mod to ⌘ on macOS and Ctrl elsewhere", () => {
    expect(keyLabel("mod", "mac")).toBe("⌘");
    expect(keyLabel("mod", "other")).toBe("Ctrl");
    expect(keyLabel("k", "other")).toBe("K");
    expect(keyLabel("F5", "mac")).toBe("F5");
    const { container } = render(<Shortcut keys={["mod", "shift", "k"]} platform="mac" />);
    expect([...container.querySelectorAll("kbd kbd")].map((k) => k.textContent)).toEqual(["⌘", "⇧", "K"]);
  });
});

describe("ThemeToggle", () => {
  test("reports the chosen theme and never deselects", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn<(theme: string) => void>();
    render(<ThemeToggle value="dark" onValueChange={onValueChange} />);
    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Light" }));
    expect(onValueChange).toHaveBeenLastCalledWith("light");
    await user.click(screen.getByRole("button", { name: "Dark" }));
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });

  test("applyTheme sets data-theme (and the light class) on the root", () => {
    const root = document.createElement("html");
    applyTheme("light", root);
    expect(root.dataset.theme).toBe("light");
    expect(root.classList.contains("light")).toBe(true);
    applyTheme("system", root);
    expect(root.dataset.theme).toBe("system");
    expect(root.classList.contains("light")).toBe(false);
  });
});

describe("toast", () => {
  test("success, error and promise render through the Toaster", async () => {
    render(<Toaster />);
    act(() => {
      toast.success("Saved", { description: "Your settings are live." });
      toast.error("Could not save");
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(screen.getByText("Your settings are live.")).toBeTruthy();
    expect(screen.getByText("Could not save")).toBeTruthy();

    let resolve: (v: number) => void = () => {};
    const pending = new Promise<number>((r) => {
      resolve = r;
    });
    let returned: Promise<number> | undefined;
    act(() => {
      returned = toast.promise(pending, {
        loading: "Uploading…",
        success: (n) => `Uploaded ${n} files`,
        error: "Failed",
      });
    });
    expect(returned).toBe(pending);
    expect(await screen.findByText("Uploading…")).toBeTruthy();
    await act(async () => {
      resolve(3);
      await pending;
    });
    await waitFor(() => expect(screen.getByText("Uploaded 3 files")).toBeTruthy());
    act(() => toast.dismiss());
  });

  test("the toaster region is labelled from the catalog", () => {
    render(
      <LocaleProvider locale="fr" messages={{ notifications: "Notifications FR" }}>
        <Toaster />
      </LocaleProvider>,
    );
    expect(document.querySelector('[aria-label^="Notifications FR"]')).toBeTruthy();
  });
});
