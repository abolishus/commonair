// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * D1-web (F1): search. The page's box is debounced and ignores an empty query; results come in
 * Channels and Categories groups; the count is announced once, politely; ⌘K / Ctrl-K opens the
 * palette with recent searches, live channels and their categories; the header field submits to
 * `/search`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ART, boot, category, home, live, renderInRouter } from "./d1-fixtures.tsx";

const fake = vi.hoisted(() => ({ boot: null as unknown, homeCalls: 0 }));
vi.mock("../src/lib/bootstrap.ts", () => ({ useBootstrap: () => fake.boot }));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    directory: {
      home: async () => {
        fake.homeCalls++;
        return new Promise(() => {});
      },
    },
  }),
  errorCode: () => null,
  serverApi: () => {
    throw new Error("no server api in tests");
  },
}));

const { SearchBox, SearchResults, SEARCH_DEBOUNCE_MS } = await import("../src/components/discovery/search-page.tsx");
const { DiscoveryPalette, HeaderSearchField } = await import("../src/components/discovery/header-search.tsx");
const { primeHomeFeed, resetHomeFeed } = await import("../src/components/discovery/feed.ts");
const { RECENT_SEARCHES_KEY, readRecentSearches, rememberSearch } =
  await import("../src/components/discovery/tab-storage.ts");
const { searchSearch } = await import("../src/components/discovery/search-params.ts");

beforeEach(() => {
  fake.boot = boot();
  fake.homeCalls = 0;
  resetHomeFeed();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the search box", () => {
  it("searches once typing settles, with the last value", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn<(q: string) => void>();
    render(<SearchBox q="" onSearch={onSearch} />);
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "str" } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    fireEvent.change(input, { target: { value: "streamer " } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(onSearch).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenLastCalledWith("streamer");
  });

  it("does nothing for an empty or blank query, typed or submitted", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn<(q: string) => void>();
    render(<SearchBox q="" onSearch={onSearch} />);
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "   " } });
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("does not search again for the query already shown, and follows the URL's query", () => {
    vi.useFakeTimers();
    const onSearch = vi.fn<(q: string) => void>();
    const { rerender } = render(<SearchBox q="art" onSearch={onSearch} />);
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onSearch).not.toHaveBeenCalled();
    rerender(<SearchBox q="music" onSearch={onSearch} />);
    expect((screen.getByTestId("search-input") as HTMLInputElement).value).toBe("music");
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
    });
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("submits right away on Enter", () => {
    const onSearch = vi.fn<(q: string) => void>();
    render(<SearchBox q="" onSearch={onSearch} />);
    const input = screen.getByTestId("search-input");
    fireEvent.change(input, { target: { value: "lofi" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onSearch).toHaveBeenCalledWith("lofi");
  });

  it("keeps ?q= within the API's limit and drops a blank one", () => {
    expect(searchSearch({ q: "  " })).toEqual({});
    expect(searchSearch({ q: 7 })).toEqual({});
    expect(searchSearch({ q: "x".repeat(200) }).q).toHaveLength(80);
  });
});

const results = {
  channels: [
    {
      slug: "demo_streamer1",
      displayName: "Demo One",
      avatarUrl: null,
      live: live("demo_streamer1", { category: ART, viewers: 7 }).broadcast,
      followerCount: 3,
    },
    { slug: "demo_streamer2", displayName: "Demo Two", avatarUrl: null, live: null, followerCount: 1 },
  ],
  categories: [category(ART, 1)],
};

describe("the results", () => {
  it("groups channels and categories, linking each", async () => {
    await renderInRouter(<SearchResults q="demo" results={results} />, "/search?q=demo");
    const channels = screen.getByTestId("search-results-channels");
    const categories = screen.getByTestId("search-results-categories");
    expect([...channels.querySelectorAll('[data-testid="search-channel"]')].map((a) => a.getAttribute("href"))).toEqual(
      ["/demo_streamer1", "/demo_streamer2"],
    );
    expect(categories.querySelector("a")?.getAttribute("href")).toBe("/directory/art");
    // Live channels show the live state; offline ones their followers.
    expect(channels.querySelector('[data-slot="live-badge"]')).not.toBeNull();
    expect(screen.getByText("1 follower")).toBeTruthy();
  });

  it("leaves out an empty group", async () => {
    await renderInRouter(<SearchResults q="art" results={{ channels: [], categories: [category(ART, 0)] }} />);
    expect(screen.queryByTestId("search-results-channels")).toBeNull();
    expect(screen.getByTestId("search-results-categories")).toBeTruthy();
  });

  it("announces the count once, politely, and nothing for an empty query", async () => {
    const view = await renderInRouter(<SearchResults q="" results={{ channels: [], categories: [] }} />);
    const region = screen.getByTestId("search-announcement");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    expect(screen.getByText("Type a channel or category name to search.")).toBeTruthy();
    view.unmount();

    await renderInRouter(<SearchResults q="demo" results={results} />);
    expect(screen.getByTestId("search-announcement").textContent).toBe("3 results for demo");
    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    cleanup();

    await renderInRouter(<SearchResults q="zzz" results={{ channels: [], categories: [] }} />);
    expect(screen.getByTestId("search-announcement").textContent).toBe("No results for zzz");
    expect(screen.getByTestId("search-empty")).toBeTruthy();
  });

  it("says when search is down instead of claiming no results", async () => {
    await renderInRouter(<SearchResults q="demo" results={null} />);
    expect(screen.queryByTestId("search-empty")).toBeNull();
    expect(screen.getByTestId("search-announcement").textContent).toBe("");
  });
});

describe("recent searches (this tab only)", () => {
  it("keeps the newest five, case-insensitively unique, and ignores blanks", () => {
    for (const q of ["a", "b", "c", "A", "d", "e", "f", "  "]) rememberSearch(q);
    expect(readRecentSearches()).toEqual(["f", "e", "d", "A", "c"]);
  });

  it("keeps one entry for a query typed with pauses (a prefix gives way to the longer query)", () => {
    for (const q of ["cozy", "str", "strea", "Streamer"]) rememberSearch(q);
    expect(readRecentSearches()).toEqual(["Streamer", "cozy"]);
    // A shorter query after a longer one is a new search; the longer one stays.
    rememberSearch("stream");
    expect(readRecentSearches()).toEqual(["stream", "Streamer", "cozy"]);
  });

  it("survives storage that throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readRecentSearches()).toEqual([]);
    expect(rememberSearch("x", [])).toEqual(["x"]);
    spy.mockRestore();
    set.mockRestore();
    sessionStorage.setItem(RECENT_SEARCHES_KEY, "not json");
    expect(readRecentSearches()).toEqual([]);
  });
});

function Palette(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return <DiscoveryPalette open={open} onOpenChange={setOpen} />;
}

describe("the ⌘K palette", () => {
  it("opens on ⌘K and Ctrl-K with recent searches, live channels and their categories", async () => {
    rememberSearch("lofi beats");
    primeHomeFeed(home({ live: [live("demo_streamer1", { category: ART, viewers: 4 })] }));
    await renderInRouter(<Palette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Recent searches");
    expect(screen.getByRole("option", { name: "lofi beats" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "demo_streamer1" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Art" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true });
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      fireEvent.keyDown(document, { key: "K", ctrlKey: true });
    });
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("asks for directory.home only while open (it is mounted on every page for its hotkey)", async () => {
    await renderInRouter(<Palette />);
    expect(fake.homeCalls).toBe(0);
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    await screen.findByRole("dialog");
    expect(fake.homeCalls).toBe(1);
  });

  it("choosing a live channel goes to it", async () => {
    primeHomeFeed(home({ live: [live("demo_streamer1")] }));
    const { router } = await renderInRouter(<Palette />);
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("option", { name: "demo_streamer1" }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/demo_streamer1"));
  });
});

describe("the header field", () => {
  it("submits to /search?q= and remembers the query; a blank one does nothing", async () => {
    const { router } = await renderInRouter(<HeaderSearchField />, "/directory");
    const form = screen.getByTestId("header-search");
    const input = form.querySelector("input") as HTMLInputElement;
    input.value = "   ";
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(router.state.location.pathname).toBe("/directory");
    input.value = "streamer";
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(router.state.location.pathname).toBe("/search"));
    expect(router.state.location.search).toEqual({ q: "streamer" });
    expect(readRecentSearches()).toEqual(["streamer"]);
  });
});
