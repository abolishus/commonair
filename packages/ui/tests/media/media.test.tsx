// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act, fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { StreamCard } from "@commonair/contracts/dto";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { LocaleProvider } from "../../src/lib/locale.tsx";
import { AccentButton } from "../../src/primitives/accent-button.tsx";
import { AlertPreview } from "../../src/blocks/media/alert-preview.tsx";
import { CategoryGrid, CategoryTile } from "../../src/blocks/media/category-tile.tsx";
import { ChannelHeader } from "../../src/blocks/media/channel-header.tsx";
import { ChatComposer, ChatMessage, ChatPanel, ChatReplayFooter } from "../../src/blocks/media/chat.tsx";
import { ClipTrimmer } from "../../src/blocks/media/clip-trimmer.tsx";
import { EmoteGrid } from "../../src/blocks/media/emote-grid.tsx";
import { MediaCard, MediaGrid } from "../../src/blocks/media/media-card.tsx";
import { PlayerChrome, PlayerControl, PlayerScrubber } from "../../src/blocks/media/player-chrome.tsx";
import { StreamGrid } from "../../src/blocks/media/stream-grid.tsx";

const stream: StreamCard = {
  channel: { id: "c1", slug: "fern", displayName: "Fernsby", avatarUrl: null, accent: "teal" },
  broadcast: {
    id: "b1",
    title: "Building",
    category: { id: "g1", slug: "games", name: "Games" },
    startedAt: "2026-10-19T10:00:00Z",
    mature: false,
    viewerCount: 42,
    thumbnailUrl: null,
  },
  tags: ["cozy"],
  language: "en",
  reason: "spotlight",
};
const category = { id: "games", name: "Games", liveCount: 3, viewers: 12, accent: "violet" as const };
const media = {
  id: "vod",
  title: "Archive",
  kind: "Past broadcast",
  duration: "2:00",
  ago: "yesterday",
  mature: true,
  matureLabel: "Mature",
  highlightLabel: "Highlight",
};
const noop = () => {};

function wrap(node: React.ReactElement): React.ReactElement {
  return <LocaleProvider locale="en">{node}</LocaleProvider>;
}

const hydrationCases: [string, React.ReactElement][] = [
  ["StreamGrid", <StreamGrid key="grid" streams={[stream]} hrefFor={() => "/fern"} />],
  [
    "CategoryTile and CategoryGrid",
    <>
      <CategoryTile key="tile" category={category} liveLabel={(n) => `${n} live`} viewerLabel={(n) => `${n} viewers`} />
      <CategoryGrid
        key="grid"
        categories={[category]}
        liveLabel={(n) => `${n} live`}
        viewerLabel={(n) => `${n} viewers`}
      />
    </>,
  ],
  [
    "MediaCard and MediaGrid",
    <>
      <MediaCard key="card" media={media} variant="highlight" />
      <MediaGrid key="grid" media={[media]} />
    </>,
  ],
  ["ChannelHeader", <ChannelHeader key="header" name="Fernsby" offlineLabel="Offline" />],
  [
    "PlayerChrome and controls",
    <PlayerChrome key="player" variant="vod" aria-label="Player">
      <video>
        <track kind="captions" />
      </video>
      <PlayerControl label="Play" icon={PlayIcon} />
      <PlayerScrubber value={5} max={20} label="Seek" valueText="5 seconds" />
    </PlayerChrome>,
  ],
  [
    "ChatPanel and message",
    <ChatPanel key="chat" title="Chat" logLabel="Messages" newMessagesLabel="New messages">
      <ChatMessage key="message" author="Fern" body="Hi" colorIndex={2} />
    </ChatPanel>,
  ],
  [
    "ChatComposer and replay footer",
    <>
      <ChatComposer
        key="composer"
        value=""
        onValueChange={noop}
        onSubmit={noop}
        placeholder="Message"
        sendLabel="Send"
      />
      <ChatReplayFooter key="footer">Replay</ChatReplayFooter>
    </>,
  ],
  [
    "ClipTrimmer",
    <ClipTrimmer
      key="trimmer"
      value={[2, 8]}
      onValueChange={noop}
      duration={30}
      minDuration={2}
      maxDuration={15}
      startLabel="Start"
      endLabel="End"
      durationLabel="Range"
      formatTime={(n) => `${n}s`}
    />,
  ],
  ["AlertPreview", <AlertPreview key="alert" name="Fern" message="Thanks" eventLabel="Tipped" stageLabel="Alert" />],
  ["EmoteGrid", <EmoteGrid key="emotes" emotes={[{ id: "leaf", label: "Leaf", glyph: "🌿" }]} />],
];

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("media block behavior", () => {
  test("StreamGrid exposes loading skeletons, empty content, and forwards data attributes", () => {
    const { rerender, container } = render(
      <StreamGrid data-testid="directory" streams={[]} hrefFor={() => "/"} loading loadingCount={2} />,
    );
    expect(container.querySelectorAll('[data-slot="stream-card-skeleton"]')).toHaveLength(2);
    rerender(<StreamGrid data-testid="directory" streams={[]} hrefFor={() => "/"} empty={<p>No streams</p>} />);
    expect(screen.getByText("No streams")).toBeTruthy();
    expect(screen.getByTestId("directory")).toBeTruthy();
  });

  test("MediaCard renders badge slots and compact layout", () => {
    const { container, rerender } = render(<MediaCard media={media} variant="highlight" data-testid="media" />);
    expect(screen.getByText("Past broadcast")).toBeTruthy();
    expect(screen.getByText("Mature")).toBeTruthy();
    expect(screen.getByText("Highlight")).toBeTruthy();
    rerender(<MediaCard media={media} layout="compact" data-testid="media" />);
    expect(container.querySelector('[data-testid="media"]')?.textContent).toContain("Archive");
  });

  test("ChannelHeader honors heading level, offline state and forwarded data", () => {
    const { container } = render(
      <ChannelHeader name="Fern" variant="offline" offlineLabel="Offline" headingLevel={2} data-testid="channel" />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Fern");
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByTestId("channel")).toBeTruthy();
  });

  test("ChannelHeader scopes the channel accent to the header so actions inherit it", () => {
    const { rerender } = render(
      <ChannelHeader
        name="Fern"
        accent="teal"
        data-testid="channel"
        actions={<AccentButton data-testid="cta">Support</AccentButton>}
      />,
    );
    const header = screen.getByTestId("channel");
    expect(header.getAttribute("data-accent")).toBe("teal");
    // The button sets no accent of its own: it inherits the header's tokens.
    expect(screen.getByTestId("cta").hasAttribute("data-accent")).toBe(false);
    expect(screen.getByTestId("cta").closest("[data-accent]")).toBe(header);
    rerender(<ChannelHeader name="Fern" accent={null} data-testid="channel" />);
    expect(screen.getByTestId("channel").hasAttribute("data-accent")).toBe(false);
  });

  test("player controls retain labels and pressed state and scrubber exposes value text", () => {
    render(
      <PlayerChrome variant="vod" aria-label="Player">
        <video aria-label="Video">
          <track kind="captions" />
        </video>
        <PlayerControl label="Pause" icon={PlayIcon} pressed />
        <PlayerScrubber value={35} max={100} label="Seek" valueText="35 seconds" />
      </PlayerChrome>,
    );
    expect(screen.getByRole("button", { name: "Pause" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector('[data-slot="slider"][aria-label="Seek"]')?.getAttribute("aria-valuetext")).toBe(
      "35 seconds",
    );
  });

  test("chat panel exposes the jump action when scrolled away and composer submits or disables", async () => {
    const submit = vi.fn<() => void>();
    render(
      <ChatPanel title="Chat" logLabel="Messages" newMessagesLabel="Jump">
        <ChatMessage author="Fern" body="Hi" colorIndex={12} data-testid="message" />
      </ChatPanel>,
    );
    const log = screen.getByRole("log");
    const viewport = log.closest('[data-slot="scroll-area-viewport"]') as HTMLElement;
    Object.defineProperties(viewport, {
      scrollHeight: { configurable: true, value: 500 },
      clientHeight: { configurable: true, value: 100 },
    });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(screen.getByRole("button", { name: "Jump" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Jump" }));
    });
    expect(viewport.scrollTop).toBe(500);
    expect(screen.getByTestId("message").querySelector("p > span")?.className).toContain("text-chat-12");
    const { rerender } = render(
      <ChatComposer value="hello" onValueChange={noop} onSubmit={submit} placeholder="Message" sendLabel="Send" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(submit).toHaveBeenCalledTimes(1);
    rerender(
      <ChatComposer
        value="hello"
        onValueChange={noop}
        onSubmit={submit}
        placeholder="Message"
        sendLabel="Send"
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  test("deleted messages and notices carry state; clip trimmer exposes two handles", () => {
    const onRangeChange = vi.fn<(value: [number, number]) => void>();
    const { container } = render(
      <>
        <ChatMessage author="Fern" body="text" colorIndex={1} deleted deletedLabel="Deleted" data-id="m1" />
        <ChatMessage author="System" body="Slow mode" colorIndex={1} notice data-code="slow" />
        <ClipTrimmer
          value={[3, 9]}
          onValueChange={onRangeChange}
          duration={30}
          minDuration={2}
          maxDuration={15}
          startLabel="Start"
          endLabel="End"
          durationLabel="Clip range"
          formatTime={(n) => `${n}s`}
        />
      </>,
    );
    expect(container.querySelector('[data-id="m1"]')?.getAttribute("data-deleted")).toBe("true");
    expect(container.querySelector('[data-code="slow"]')?.getAttribute("data-slot")).toBe("chat-notice");
    expect(container.querySelectorAll('[data-slot="slider-thumb"]')).toHaveLength(2);
    const handles = container.querySelectorAll('input[type="range"]');
    fireEvent.keyDown(handles[0] as HTMLInputElement, { key: "ArrowRight" });
    expect(onRangeChange).toHaveBeenCalled();
  });
});

describe("media block server rendering and hydration", () => {
  test.each(hydrationCases)("%s hydrates without warnings", async (_name, node) => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(wrap(node));
    document.body.append(container);
    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, wrap(node), { onRecoverableError: (error) => errors.push(error) });
    });
    expect(errors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    act(() => root?.unmount());
  });
});
