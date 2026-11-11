// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * Follow-ups: the studio's "Edit stream info" card with its social links editor (add, remove,
 * reorder with focus kept, the platform select, the contract's https check inline, the cap) and
 * the API client that saves the whole list with `channels.update`.
 */
import type { ChannelSocial } from "@commonair/contracts/shapes";
import { MAX_CHANNEL_SOCIALS } from "@commonair/contracts/shapes";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const fake = vi.hoisted(() => ({
  get: null as unknown as (input: unknown) => Promise<unknown>,
  update: null as unknown as (input: unknown) => Promise<unknown>,
  list: null as unknown as (input: unknown) => Promise<unknown>,
}));
vi.mock("../src/lib/api.ts", () => ({
  api: () => ({
    channels: { get: (i: unknown) => fake.get(i), update: (i: unknown) => fake.update(i) },
    categories: { list: (i: unknown) => fake.list(i) },
  }),
  errorCode: () => null,
}));

const { StreamInfoEditor, apiStreamInfoClient, moveItem, socialErrors, streamInfoError } =
  await import("../src/components/studio/stream-info.tsx");
type StreamInfo = import("../src/components/studio/stream-info.tsx").StreamInfo;
type StreamInfoClient = import("../src/components/studio/stream-info.tsx").StreamInfoClient;

afterEach(cleanup);

const INFO: StreamInfo = {
  title: "Painting skies",
  category: { id: "c-art", name: "Art" },
  tags: ["chill"],
  socials: [
    { platform: "website", url: "https://example.org" },
    { platform: "github", url: "https://github.com/alice" },
    { platform: "mastodon", url: "https://social.example/@alice" },
  ],
};
const CATEGORIES = [
  { id: "c-art", name: "Art" },
  { id: "c-music", name: "Music" },
];

/** Fake client calls; `over` replaces a call's behaviour, still recorded as a mock. */
function client(over: Partial<StreamInfoClient> = {}, info: StreamInfo = INFO) {
  return {
    get: vi.fn<StreamInfoClient["get"]>(over.get ?? (async () => structuredClone(info))),
    update: vi.fn<StreamInfoClient["update"]>(over.update ?? (async (_c, next) => next)),
    categories: vi.fn<StreamInfoClient["categories"]>(
      over.categories ?? (async (q) => CATEGORIES.filter((c) => c.name.toLowerCase().includes(q.toLowerCase()))),
    ),
  } satisfies StreamInfoClient;
}

async function mount(c: StreamInfoClient) {
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <StreamInfoEditor channel="alice" client={c} />
      </TooltipProvider>
    </LocaleProvider>,
  );
  await screen.findByTestId("stream-info-title");
}

const rows = () => screen.queryAllByTestId("stream-info-social");
const urls = () => rows().map((r) => (within(r).getByTestId("stream-info-social-url") as HTMLInputElement).value);
const platforms = () => rows().map((r) => within(r).getByTestId("stream-info-social-platform").dataset.value);
const part = (i: number, id: string) => within(rows()[i] as HTMLElement).getByTestId(id) as HTMLButtonElement;
const save = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId("stream-info-save"));
  });
};
/** Base UI picks on pointer down / mouse up, then click. */
function press(el: HTMLElement) {
  fireEvent.pointerDown(el, { pointerType: "mouse", button: 0 });
  fireEvent.mouseDown(el, { button: 0 });
  fireEvent.mouseUp(el, { button: 0 });
  fireEvent.click(el);
}

describe("socialErrors", () => {
  it("accepts https links and refuses the rest with the inline message", () => {
    const bad = t("fuChannel.editor.badUrl");
    const links: ChannelSocial[] = [
      { platform: "website", url: "https://example.org" },
      { platform: "website", url: "  https://example.org/padded  " },
      { platform: "website", url: "http://example.org" },
      { platform: "website", url: "" },
      { platform: "website", url: "example.org" },
      { platform: "website", url: "https://user:pw@example.org" },
      { platform: "website", url: "https://user@example.org" },
      { platform: "website", url: `https://example.org/${"a".repeat(500)}` },
    ];
    expect(socialErrors(links)).toEqual([null, null, bad, bad, bad, bad, bad, bad]);
  });

  it("is empty for no links", () => {
    expect(socialErrors([])).toEqual([]);
  });
});

describe("moveItem", () => {
  it("swaps with the neighbour and never touches the input", () => {
    const list = ["a", "b", "c"];
    expect(moveItem(list, 1, -1)).toEqual(["b", "a", "c"]);
    expect(moveItem(list, 1, 1)).toEqual(["a", "c", "b"]);
    expect(list).toEqual(["a", "b", "c"]);
  });

  it("leaves a copy unchanged for moves past either end or from outside the list", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(list, 1, 1)).toEqual(["a", "b"]);
    expect(moveItem(list, -1, 1)).toEqual(["a", "b"]);
    expect(moveItem(list, 2, -1)).toEqual(["a", "b"]);
    expect(moveItem(list, 0, -1)).not.toBe(list);
    expect(moveItem([], 0, 1)).toEqual([]);
  });
});

describe("streamInfoError", () => {
  it("checks the title, the tags and then the links", () => {
    expect(streamInfoError(INFO)).toBeNull();
    expect(streamInfoError({ ...INFO, title: "x".repeat(141) })).toBe(t("studio.info.titleTooLong"));
    // Trimmed first: padding does not count.
    expect(streamInfoError({ ...INFO, title: ` ${"x".repeat(140)} ` })).toBeNull();
    expect(streamInfoError({ ...INFO, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toBe(
      t("studio.info.tooManyTags"),
    );
    expect(streamInfoError({ ...INFO, tags: ["x".repeat(25)] })).toBeNull();
    expect(streamInfoError({ ...INFO, tags: ["x".repeat(26)] })).toBe(t("studio.info.badTag"));
    expect(streamInfoError({ ...INFO, socials: [{ platform: "x", url: "nope" }] })).toBe(
      t("fuChannel.editor.fixLinks"),
    );
  });
});

describe("apiStreamInfoClient", () => {
  const channel = {
    title: "Live",
    category: { id: "c-art", slug: "art", name: "Art", boxArtUrl: null },
    tags: ["a"],
    socials: [{ platform: "github", url: "https://github.com/a" }],
  };
  beforeEach(() => {
    fake.get = vi.fn<(i: unknown) => Promise<unknown>>(async () => channel);
    fake.update = vi.fn<(i: unknown) => Promise<unknown>>(async () => ({ ...channel, category: null, socials: [] }));
    fake.list = vi.fn<(i: unknown) => Promise<unknown>>(async () => ({
      items: [{ id: "c1", slug: "c1", name: "One", liveChannels: 0, viewerCount: 0, tags: [] }],
      nextCursor: null,
    }));
  });

  it("reads the channel's info and links", async () => {
    expect(await apiStreamInfoClient.get("alice")).toEqual({
      title: "Live",
      category: { id: "c-art", name: "Art" },
      tags: ["a"],
      socials: [{ platform: "github", url: "https://github.com/a" }],
    });
    expect(fake.get).toHaveBeenCalledWith({ channel: "alice" });
  });

  it("saves the title, category, tags and the whole links list in one update", async () => {
    const socials: ChannelSocial[] = [{ platform: "x", url: "https://x.com/a" }];
    const saved = await apiStreamInfoClient.update("alice", { title: "T", category: null, tags: [], socials });
    expect(fake.update).toHaveBeenCalledWith({ channel: "alice", title: "T", categoryId: null, tags: [], socials });
    expect(saved).toEqual({ title: "Live", category: null, tags: ["a"], socials: [] });
    await apiStreamInfoClient.update("alice", { ...INFO, socials: [] });
    expect(fake.update).toHaveBeenLastCalledWith(expect.objectContaining({ categoryId: "c-art", socials: [] }));
  });

  it("lists categories, filtered only when something was typed", async () => {
    expect(await apiStreamInfoClient.categories("")).toEqual([{ id: "c1", name: "One" }]);
    expect(fake.list).toHaveBeenLastCalledWith({ limit: 50 });
    await apiStreamInfoClient.categories("on");
    expect(fake.list).toHaveBeenLastCalledWith({ limit: 50, q: "on" });
  });
});

describe("StreamInfoEditor", () => {
  it("shows a skeleton while loading, then the form", async () => {
    let resolve: (info: StreamInfo) => void = () => undefined;
    const c = client({
      get: () =>
        new Promise<StreamInfo>((r) => {
          resolve = r;
        }),
    });
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <StreamInfoEditor channel="alice" client={c} />
        </TooltipProvider>
      </LocaleProvider>,
    );
    expect(screen.getByTestId("stream-info").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("stream-info-title")).toBeNull();
    await act(async () => resolve(structuredClone(INFO)));
    expect(screen.getByTestId("stream-info").getAttribute("aria-busy")).toBe("false");
    expect(screen.getByTestId("stream-info-shown").textContent).toBe(
      t("studio.info.shown", { title: "Painting skies", category: "Art" }),
    );
  });

  it("says so when the info could not be loaded, and Retry loads it again", async () => {
    let fail = true;
    const get = vi.fn<StreamInfoClient["get"]>(async () =>
      fail ? Promise.reject(new Error("x")) : structuredClone(INFO),
    );
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <StreamInfoEditor channel="alice" client={client({ get })} />
      </LocaleProvider>,
    );
    expect(await screen.findByTestId("stream-info-error")).toBeTruthy();
    expect(screen.getByTestId("stream-info").getAttribute("aria-busy")).toBe("false");
    fail = false;
    fireEvent.click(screen.getByTestId("stream-info-retry"));
    expect(await screen.findByTestId("stream-info-shown")).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("names an untitled, uncategorised stream as such", async () => {
    await mount(client({}, { ...INFO, title: "", category: null }));
    expect(screen.getByTestId("stream-info-shown").textContent).toBe(
      t("studio.info.shown", { title: t("studio.info.untitled"), category: t("studio.info.noCategory") }),
    );
  });

  it("searches categories a beat after the input changes and picks one from the list", async () => {
    const c = client({ categories: async () => CATEGORIES });
    await mount(c);
    // The first search is the empty one; the input then shows the saved category's name.
    await waitFor(() => expect(c.categories).toHaveBeenCalledWith(""));
    const input = screen.getByTestId("stream-info-category") as HTMLInputElement;
    expect(input.value).toBe("Art");
    await act(async () => {
      input.focus();
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    const option = await screen.findByRole("option", { name: "Music" });
    await act(async () => {
      fireEvent.click(option);
    });
    await waitFor(() => expect(input.value).toBe("Music"));
    await save();
    await waitFor(() => expect(c.update).toHaveBeenCalled());
    expect(c.update.mock.calls[0]?.[1].category).toEqual({ id: "c-music", name: "Music" });
  });

  it("keeps the saved category as an option when the search does not return it", async () => {
    const c = client({ categories: async () => [{ id: "c-music", name: "Music" }] });
    await mount(c);
    await waitFor(() => expect(c.categories).toHaveBeenCalled());
    expect((screen.getByTestId("stream-info-category") as HTMLInputElement).value).toBe("Art");
  });

  it("edits tags in the tags field (Backspace drops the last one)", async () => {
    const c = client();
    await mount(c);
    const input = screen.getByTestId("stream-info-tags-input");
    fireEvent.keyDown(input, { key: "Backspace" });
    await save();
    await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
    expect(c.update.mock.calls[0]?.[1].tags).toEqual([]);
  });

  it("ignores a failed category search", async () => {
    const c = client({ categories: async () => Promise.reject(new Error("down")) });
    await mount(c);
    await waitFor(() => expect(c.categories).toHaveBeenCalled());
    expect(screen.getByTestId("stream-info-title")).toBeTruthy();
  });

  describe("social links", () => {
    it("lists the saved links in order with their platforms", async () => {
      await mount(client());
      expect(screen.getByTestId("stream-info-socials").dataset.count).toBe("3");
      expect(urls()).toEqual(INFO.socials.map((s) => s.url));
      expect(platforms()).toEqual(["website", "github", "mastodon"]);
      expect(rows().map((r) => r.dataset.index)).toEqual(["0", "1", "2"]);
      expect(rows()[1]?.getAttribute("aria-label")).toBe(t("fuChannel.editor.row", { n: 2 }));
      expect(part(1, "stream-info-social-up").getAttribute("aria-label")).toBe(t("fuChannel.editor.moveUp", { n: 2 }));
      expect(screen.queryByTestId("stream-info-socials-empty")).toBeNull();
    });

    it("says there are none yet, and Add gives a website row with focus in its address", async () => {
      const c = client({}, { ...INFO, socials: [] });
      await mount(c);
      expect(screen.getByTestId("stream-info-socials-empty").textContent).toBe(t("fuChannel.editor.socialsEmpty"));
      fireEvent.click(screen.getByTestId("stream-info-social-add"));
      expect(rows()).toHaveLength(1);
      expect(platforms()).toEqual(["website"]);
      expect(document.activeElement).toBe(part(0, "stream-info-social-url"));
      fireEvent.change(part(0, "stream-info-social-url"), { target: { value: "  https://me.example  " } });
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
      // Trimmed on save, the whole list sent.
      expect(c.update.mock.calls[0]?.[1].socials).toEqual([{ platform: "website", url: "https://me.example" }]);
    });

    it("moves a link up and down, disabling the end buttons and keeping focus on the moved row", async () => {
      const c = client();
      await mount(c);
      expect(part(0, "stream-info-social-up").disabled).toBe(true);
      expect(part(2, "stream-info-social-down").disabled).toBe(true);
      expect(part(1, "stream-info-social-up").disabled).toBe(false);

      // Middle row up to the top: its Up goes disabled, so focus lands on its Down.
      fireEvent.click(part(1, "stream-info-social-up"));
      expect(urls()).toEqual([INFO.socials[1]?.url, INFO.socials[0]?.url, INFO.socials[2]?.url]);
      expect(document.activeElement).toBe(part(0, "stream-info-social-down"));

      // Top row down one place (not to an end): focus stays on Down of the same link.
      fireEvent.click(part(0, "stream-info-social-down"));
      expect(urls()).toEqual(INFO.socials.map((s) => s.url));
      expect(document.activeElement).toBe(part(1, "stream-info-social-down"));

      // Down to the bottom: focus moves to its Up.
      fireEvent.click(part(1, "stream-info-social-down"));
      expect(urls()).toEqual([INFO.socials[0]?.url, INFO.socials[2]?.url, INFO.socials[1]?.url]);
      expect(document.activeElement).toBe(part(2, "stream-info-social-up"));

      // Bottom row up one place (not to an end): focus stays on Up.
      fireEvent.click(part(2, "stream-info-social-up"));
      expect(document.activeElement).toBe(part(1, "stream-info-social-up"));
      expect(urls()).toEqual(INFO.socials.map((s) => s.url));

      fireEvent.click(part(2, "stream-info-social-up"));
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
      expect(c.update.mock.calls[0]?.[1].socials.map((s) => s.platform)).toEqual(["website", "mastodon", "github"]);
    });

    it("removes a link, focusing the next row's Remove, the previous one's, then Add", async () => {
      const c = client();
      await mount(c);
      fireEvent.click(part(0, "stream-info-social-remove"));
      expect(platforms()).toEqual(["github", "mastodon"]);
      expect(document.activeElement).toBe(part(0, "stream-info-social-remove"));
      fireEvent.click(part(1, "stream-info-social-remove"));
      expect(platforms()).toEqual(["github"]);
      expect(document.activeElement).toBe(part(0, "stream-info-social-remove"));
      fireEvent.click(part(0, "stream-info-social-remove"));
      expect(rows()).toHaveLength(0);
      expect(document.activeElement).toBe(screen.getByTestId("stream-info-social-add"));
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
      expect(c.update.mock.calls[0]?.[1].socials).toEqual([]);
    });

    it("changes a row's platform with the select", async () => {
      const c = client();
      await mount(c);
      press(part(0, "stream-info-social-platform"));
      const option = await waitFor(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="stream-info-social-platform-bluesky"]');
        if (!el) throw new Error("not open yet");
        return el;
      });
      // Brand names stay untranslated; website/other go through the catalog.
      expect(document.querySelector('[data-testid="stream-info-social-platform-website"]')?.textContent).toBe(
        t("fuChannel.socials.website"),
      );
      press(option);
      await waitFor(() => expect(platforms()[0]).toBe("bluesky"));
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
      expect(c.update.mock.calls[0]?.[1].socials[0]).toEqual({ platform: "bluesky", url: "https://example.org" });
    });

    it("shows the error inline on the bad row only after a save attempt, and does not save", async () => {
      const c = client();
      await mount(c);
      const url = part(1, "stream-info-social-url") as unknown as HTMLInputElement;
      fireEvent.change(url, { target: { value: "http://github.com/alice" } });
      expect(screen.queryByTestId("stream-info-social-error")).toBeNull();
      expect(url.hasAttribute("aria-invalid")).toBe(false);
      await save();
      expect(c.update).not.toHaveBeenCalled();
      const error = within(rows()[1] as HTMLElement).getByTestId("stream-info-social-error");
      expect(error.textContent).toBe(t("fuChannel.editor.badUrl"));
      expect(url.getAttribute("aria-invalid")).toBe("true");
      expect(url.getAttribute("aria-describedby")).toBe(error.id);
      expect(within(rows()[0] as HTMLElement).queryByTestId("stream-info-social-error")).toBeNull();
      expect(screen.getByTestId("stream-info-error").textContent).toBe(t("fuChannel.editor.fixLinks"));
      // Fixing it clears the error and lets the save through.
      fireEvent.change(url, { target: { value: "https://github.com/alice2" } });
      expect(screen.queryByTestId("stream-info-social-error")).toBeNull();
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
    });

    it("stops at the cap: Add is disabled with a note, and removing one re-enables it", async () => {
      const ten = Array.from({ length: MAX_CHANNEL_SOCIALS }, (_, i) => ({
        platform: "other" as const,
        url: `https://example.org/${i}`,
      }));
      await mount(client({}, { ...INFO, socials: ten }));
      const add = screen.getByTestId("stream-info-social-add") as HTMLButtonElement;
      expect(rows()).toHaveLength(MAX_CHANNEL_SOCIALS);
      expect(add.disabled).toBe(true);
      expect(screen.getByTestId("stream-info-socials-full").textContent).toBe(
        t("fuChannel.editor.full", { max: MAX_CHANNEL_SOCIALS }),
      );
      fireEvent.click(add);
      expect(rows()).toHaveLength(MAX_CHANNEL_SOCIALS);
      fireEvent.click(part(9, "stream-info-social-remove"));
      expect(add.disabled).toBe(false);
      expect(screen.queryByTestId("stream-info-socials-full")).toBeNull();
      // The removed last row hands focus to the row before it.
      expect(document.activeElement).toBe(part(8, "stream-info-social-remove"));
      fireEvent.click(add);
      expect(rows()).toHaveLength(MAX_CHANNEL_SOCIALS);
    });

    it("keeps the typed links when the save fails, so a retry is one click", async () => {
      const c = client({
        update: vi
          .fn<StreamInfoClient["update"]>()
          .mockRejectedValueOnce(new Error("down"))
          .mockImplementation(async (_c, next) => ({ ...next, socials: next.socials.slice(0, 1) })),
      });
      await mount(c);
      fireEvent.click(part(2, "stream-info-social-remove"));
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(screen.getByTestId("stream-info-save").hasAttribute("aria-busy")).toBe(false));
      expect(rows()).toHaveLength(2);
      await save();
      await waitFor(() => expect(c.update).toHaveBeenCalledTimes(2));
      // The retry sends the same edited list the failed save did.
      expect(c.update.mock.calls[1]?.[1].socials).toEqual(INFO.socials.slice(0, 2));
      expect(c.update.mock.calls[1]?.[1].socials).toEqual(c.update.mock.calls[0]?.[1].socials);
      // The form keeps the draft after a save (as for the title); only "Viewers see" follows the server.
      expect(rows()).toHaveLength(2);
    });
  });
});
