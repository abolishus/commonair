// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** Avatar and banner upload on /dashboard: contract limits, the scanning commit, theme merge. */
import { MAX_UPLOAD_BYTES, UPLOAD_TYPES, type ChannelTheme } from "@commonair/contracts/shapes";
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ChannelAppearanceCard,
  type AppearanceChannel,
  type AppearanceClient,
} from "../src/components/channel-appearance.tsx";
import { checkUploadFile, uploadAccept, type UploadClient } from "../src/components/safety/upload.ts";
import { en } from "../src/i18n/en.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

let revoked: string[] = [];
beforeEach(() => {
  revoked = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revoked.push(url));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function wrap(node: React.ReactNode) {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>{node}</TooltipProvider>
    </LocaleProvider>,
  );
}

const fileOf = (type: string, size = 64, name = "image") =>
  new File([new Uint8Array(size)], name, { type, lastModified: 0 });

function channelWith(theme: ChannelTheme): AppearanceChannel {
  return {
    displayName: "Rivertide",
    theme,
    avatarUrl: theme.avatarKey ? `https://media.example.test/${theme.avatarKey}` : null,
    bannerUrl: theme.bannerKey ? `https://media.example.test/${theme.bannerKey}` : null,
  };
}

function fakeClient(
  initial: ChannelTheme,
  overrides: { put?: UploadClient["put"]; commit?: UploadClient["commit"] } = {},
) {
  let theme = initial;
  const fns = {
    uploadUrl: vi.fn<UploadClient["uploadUrl"]>(async (input) => ({
      uploadUrl: "https://upload.invalid/put",
      key: `incoming/channels/c1/${input.purpose}/new.png`,
      headers: { "content-type": input.contentType },
    })),
    put: vi.fn<UploadClient["put"]>(overrides.put ?? (async () => ({ ok: true }))),
    commit: vi.fn<UploadClient["commit"]>(
      overrides.commit ??
        (async ({ key }) => {
          const published = key.replace(/^incoming\//, "");
          return { key: published, url: `https://media.example.test/${published}` };
        }),
    ),
  };
  const upload: UploadClient = { uploadUrl: fns.uploadUrl, put: fns.put, commit: fns.commit };
  const client = {
    fns,
    get: vi.fn<AppearanceClient["get"]>(async () => channelWith(theme)),
    updateTheme: vi.fn<AppearanceClient["updateTheme"]>(async (_channel, next) => {
      theme = next;
      return channelWith(theme);
    }),
    upload,
  };
  return {
    ...client,
    /** Change the theme on the "server" behind the card's back (a takedown, another tab). */
    serverSets: (next: ChannelTheme) => {
      theme = next;
    },
  };
}

type Slot = "avatar" | "banner";
const slotEl = (slot: Slot) => {
  const el = screen.queryAllByTestId("appearance-slot").find((e) => e.getAttribute("data-purpose") === slot);
  if (!el) throw new Error(`no ${slot} slot`);
  return el;
};
const findSlot = (slot: Slot) => waitFor(() => slotEl(slot));
const inSlot = (slot: Slot) => within(slotEl(slot));
const previewSrc = (slot: Slot) => inSlot(slot).getByTestId("appearance-preview").getAttribute("data-src");

async function pick(slot: Slot, file: File) {
  const input = within(await findSlot(slot)).getByTestId("appearance-file") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

describe("upload file checks", () => {
  it("accepts each purpose's contract types and nothing else", () => {
    expect(uploadAccept("avatar")).toBe(UPLOAD_TYPES.avatar.join(","));
    expect(uploadAccept("banner")).not.toContain("image/gif");
    expect(checkUploadFile("avatar", fileOf("image/gif"))).toEqual({ ok: true, contentType: "image/gif" });
    expect(checkUploadFile("banner", fileOf("image/gif"))).toEqual({ ok: false, reason: "type" });
    expect(checkUploadFile("avatar", fileOf("image/svg+xml"))).toEqual({ ok: false, reason: "type" });
    expect(checkUploadFile("avatar", fileOf(""))).toEqual({ ok: false, reason: "type" });
  });

  it("enforces the size limit at the boundary and refuses empty files", () => {
    expect(checkUploadFile("banner", fileOf("image/png", MAX_UPLOAD_BYTES)).ok).toBe(true);
    expect(checkUploadFile("banner", fileOf("image/png", MAX_UPLOAD_BYTES + 1))).toEqual({ ok: false, reason: "size" });
    expect(checkUploadFile("banner", fileOf("image/png", 0))).toEqual({ ok: false, reason: "empty" });
  });
});

describe("ChannelAppearanceCard", () => {
  it("uploads an avatar, commits it, and sets theme.avatarKey keeping the rest of the theme", async () => {
    const client = fakeClient({ accent: "sky", bannerKey: "channels/c1/banner/old.png" });
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("avatar", fileOf("image/png", 2048));
    await waitFor(() => expect(client.updateTheme).toHaveBeenCalledTimes(1));
    expect(client.fns.uploadUrl).toHaveBeenCalledWith({
      channel: "rivertide",
      purpose: "avatar",
      contentType: "image/png",
      sizeBytes: 2048,
    });
    expect(client.fns.commit).toHaveBeenCalledWith({
      channel: "rivertide",
      key: "incoming/channels/c1/avatar/new.png",
    });
    // Only the committed key is used, and the accent and banner survive the whole-theme write.
    expect(client.updateTheme).toHaveBeenCalledWith("rivertide", {
      accent: "sky",
      bannerKey: "channels/c1/banner/old.png",
      avatarKey: "channels/c1/avatar/new.png",
    });
    await waitFor(() => expect(inSlot("avatar").getByTestId("appearance-remove")).toBeTruthy());
  });

  it("shows the uploaded banner as the preview", async () => {
    const client = fakeClient({});
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    expect((await findSlot("banner")).textContent).toContain(en["appearance.noBanner"]);
    expect(previewSrc("banner")).toBe("");
    await pick("banner", fileOf("image/webp"));
    await waitFor(() => expect(previewSrc("banner")).toBe("https://media.example.test/channels/c1/banner/new.png"));
    expect(inSlot("banner").getByRole("img").getAttribute("src")).toBe(
      "https://media.example.test/channels/c1/banner/new.png",
    );
    expect(client.updateTheme).toHaveBeenCalledWith("rivertide", { bannerKey: "channels/c1/banner/new.png" });
  });

  it("refuses a file the contract does not allow before asking for an upload URL", async () => {
    const client = fakeClient({});
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("banner", fileOf("image/gif"));
    await waitFor(() => expect(slotEl("banner").textContent).toContain(en["appearance.wrongType"]));
    await pick("avatar", fileOf("image/png", MAX_UPLOAD_BYTES + 1));
    await waitFor(() =>
      expect(slotEl("avatar").textContent).toContain(t("appearance.tooLarge", { mb: MAX_UPLOAD_BYTES / 1_000_000 })),
    );
    expect(client.fns.uploadUrl).not.toHaveBeenCalled();
  });

  it("shows only the generic message when the scan rejects the file, and keeps the theme", async () => {
    const client = fakeClient(
      { avatarKey: "channels/c1/avatar/old.png" },
      {
        commit: async () => Promise.reject(Object.assign(new Error("x"), { code: "UNPROCESSABLE_CONTENT" })),
      },
    );
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("avatar", fileOf("image/jpeg"));
    await waitFor(() => expect(slotEl("avatar").textContent).toContain(en["safety.upload.rejected"]));
    expect(client.updateTheme).not.toHaveBeenCalled();
    // The preview falls back to the current avatar, not the refused file.
    expect(previewSrc("avatar")).toBe("https://media.example.test/channels/c1/avatar/old.png");
  });

  it("reports a failed PUT as a transport failure", async () => {
    const client = fakeClient({}, { put: async () => ({ ok: false }) });
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("avatar", fileOf("image/png"));
    await waitFor(() => expect(slotEl("avatar").textContent).toContain(en["safety.upload.failed"]));
    expect(client.fns.commit).not.toHaveBeenCalled();
  });

  it("removes the banner key and nothing else", async () => {
    const client = fakeClient({
      accent: "pink",
      avatarKey: "channels/c1/avatar/a.png",
      bannerKey: "channels/c1/banner/b.png",
    });
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    fireEvent.click(within(await findSlot("banner")).getByTestId("appearance-remove"));
    await waitFor(() =>
      expect(client.updateTheme).toHaveBeenCalledWith("rivertide", {
        accent: "pink",
        avatarKey: "channels/c1/avatar/a.png",
      }),
    );
    await waitFor(() => expect(inSlot("banner").queryByTestId("appearance-remove")).toBeNull());
    expect(inSlot("avatar").getByTestId("appearance-remove")).toBeTruthy();
  });

  it("says so when the theme update fails after a good upload", async () => {
    const client = fakeClient({});
    client.updateTheme.mockRejectedValueOnce(new Error("down"));
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("avatar", fileOf("image/png"));
    await waitFor(() => expect(slotEl("avatar").textContent).toContain(en["appearance.saveFailed"]));
  });

  it("merges into the theme as the server has it now, not as it was loaded", async () => {
    const client = fakeClient({ accent: "sky", bannerKey: "channels/c1/banner/old.png" });
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await findSlot("avatar");
    // A takedown cleared the banner after the card loaded: the stale key must not come back.
    client.serverSets({ accent: "sky" });
    await pick("avatar", fileOf("image/png"));
    await waitFor(() =>
      expect(client.updateTheme).toHaveBeenCalledWith("rivertide", {
        accent: "sky",
        avatarKey: "channels/c1/avatar/new.png",
      }),
    );
  });

  it("disables every control while one upload runs, and frees the local preview after", async () => {
    let finishPut: (v: { ok: boolean }) => void = () => {};
    const client = fakeClient({}, { put: () => new Promise<{ ok: boolean }>((resolve) => (finishPut = resolve)) });
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await pick("avatar", fileOf("image/png"));
    await waitFor(() => expect(previewSrc("avatar")).toBe("blob:local-preview"));
    for (const slot of ["avatar", "banner"] as const) {
      expect((inSlot(slot).getByTestId("appearance-upload") as HTMLButtonElement).disabled).toBe(true);
      expect((inSlot(slot).getByTestId("appearance-file") as HTMLInputElement).disabled).toBe(true);
    }
    finishPut({ ok: true });
    await waitFor(() => expect(previewSrc("avatar")).toBe("https://media.example.test/channels/c1/avatar/new.png"));
    expect(revoked).toContain("blob:local-preview");
    expect((inSlot("banner").getByTestId("appearance-upload") as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a load error when the channel cannot be read", async () => {
    const client = fakeClient({});
    client.get.mockRejectedValueOnce(new Error("down"));
    wrap(<ChannelAppearanceCard channel="rivertide" client={client} />);
    await waitFor(() =>
      expect(screen.getByTestId("channel-appearance").textContent).toContain(en["appearance.loadFailed"]),
    );
  });
});
