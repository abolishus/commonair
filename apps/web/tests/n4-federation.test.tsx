// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * N4-web (ADR 0030; docs/testing/b7-selectors.md "Federation") with fake clients: the studio
 * section (hidden while the instance does not federate, the switch with its confirm on off, the
 * handle and its copy button, the notes), the remote followers (empty, paged, remove behind a
 * confirmation, text only), the admin page (validation, add, remove, rotate behind a
 * confirmation, the "how to turn it on" state), each at 320 px in dark and light, with an
 * accessibility check on the rules axe would flag here (the harness runs axe itself on the live
 * pages, `harness/src/n4/web.ts`).
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  blockCheckMessage,
  FederationAdminPage,
  FEDERATION_ENV_SETTING,
} from "../src/components/federation/blocks.tsx";
import {
  checkBlockDomain,
  followerLabel,
  type FederationAdminClient,
  type FederationBlockDto,
  type FederationClient,
  type FederationFollowerDto,
  type FederationSettingsDto,
} from "../src/components/federation/client.ts";
import { FederationSettings, FederationSettingsSection } from "../src/components/federation/settings.tsx";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

const toasts = vi.hoisted(() => ({ success: [] as string[], error: [] as string[] }));
vi.mock("@commonair/ui/toast", () => ({
  toast: {
    success: (m: string) => toasts.success.push(m),
    error: (m: string) => toasts.error.push(m),
  },
}));

const bootstrap = vi.hoisted(() => ({ federation: undefined as boolean | undefined }));
vi.mock("../src/lib/bootstrap.ts", () => ({
  useBootstrap: () => ({
    instance: { name: "Test", sourceUrl: null, p2pDefault: "off", chatSafety: false, federation: bootstrap.federation },
    me: null,
  }),
}));

beforeEach(() => {
  toasts.success.length = 0;
  toasts.error.length = 0;
  bootstrap.federation = undefined;
});
afterEach(() => cleanup());

const HANDLE = "@ada@tv.example";
const NOW = Date.parse("2026-11-01T12:00:00Z");

function wrap(node: React.ReactNode, theme: "dark" | "light" = "dark") {
  return render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <div className={theme === "dark" ? "dark w-80" : "w-80"} data-theme={theme}>
          {node}
        </div>
      </TooltipProvider>
    </LocaleProvider>,
  );
}
const q = (c: ParentNode, id: string) => c.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (c: ParentNode, id: string) => [...c.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const confirmButton = () =>
  waitFor(() => {
    const b = document.querySelector<HTMLElement>('[data-testid="confirm-dialog-confirm"]');
    if (!b) throw new Error("no confirm dialog");
    return b;
  });
const noDialog = () =>
  waitFor(() => expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeNull());

const follower = (n: number, over: Partial<FederationFollowerDto> = {}): FederationFollowerDto => ({
  id: `01900000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`,
  actor: `https://social${n}.example/users/fan${n}`,
  handle: `@fan${n}@social${n}.example`,
  domain: `social${n}.example`,
  createdAt: new Date(NOW - n * 3_600_000).toISOString(),
  ...over,
});

function fakeClient(opts: {
  settings?: Partial<FederationSettingsDto>;
  followers?: FederationFollowerDto[];
  pageSize?: number;
  failGet?: boolean;
  failUpdate?: boolean;
  failRemove?: boolean;
}) {
  let settings: FederationSettingsDto = {
    enabled: true,
    instanceEnabled: true,
    handle: HANDLE,
    actorId: "https://tv.example/ap/channels/0190",
    followers: opts.followers?.length ?? 0,
    ...opts.settings,
  };
  let followers = [...(opts.followers ?? [])];
  const pageSize = opts.pageSize ?? 25;
  const calls = { update: [] as boolean[], removed: [] as string[], cursors: [] as (string | null)[] };
  const client: FederationClient = {
    get: async () => {
      if (opts.failGet) throw new Error("down");
      return settings;
    },
    update: async (_channel, enabled) => {
      if (opts.failUpdate) throw new Error("down");
      calls.update.push(enabled);
      settings = { ...settings, enabled, handle: enabled ? HANDLE : null, followers: enabled ? settings.followers : 0 };
      if (!enabled) followers = [];
      return settings;
    },
    followers: async (_channel, cursor) => {
      calls.cursors.push(cursor);
      const start = cursor === null ? 0 : Number(cursor);
      const items = followers.slice(start, start + pageSize);
      const next = start + pageSize < followers.length ? String(start + pageSize) : null;
      return { items, nextCursor: next };
    },
    removeFollower: async (_channel, id) => {
      if (opts.failRemove) throw new Error("down");
      calls.removed.push(id);
      followers = followers.filter((f) => f.id !== id);
    },
  };
  return { client, calls };
}

function fakeAdmin(initial: FederationBlockDto[] = [], opts: { failAdd?: unknown; failRotate?: boolean } = {}) {
  let blocks = [...initial];
  const calls = { added: [] as string[], removed: [] as string[], rotations: 0 };
  const client: FederationAdminClient = {
    blocks: async () => blocks,
    addBlock: async (domain) => {
      if (opts.failAdd) throw opts.failAdd;
      calls.added.push(domain);
      const b = { domain, createdBy: { id: "u1", username: "admin" }, createdAt: new Date(NOW).toISOString() };
      blocks = [b, ...blocks];
      return b;
    },
    removeBlock: async (domain) => {
      calls.removed.push(domain);
      blocks = blocks.filter((b) => b.domain !== domain);
    },
    rotateAll: async () => {
      if (opts.failRotate) throw new Error("down");
      calls.rotations += 1;
      return 3;
    },
  };
  return { client, calls };
}

const block = (domain: string, by: string | null = "admin"): FederationBlockDto => ({
  domain,
  createdBy: by ? { id: "u1", username: by } : null,
  createdAt: new Date(NOW - 86_400_000).toISOString(),
});

/**
 * The accessibility rules axe would flag on these components (button-name, label, link-name,
 * aria-valid-attr-value for id references, image-alt) plus the brief's own: no links and no
 * images in the federation UI, so nothing on it loads or points at a remote server.
 */
function a11yViolations(root: ParentNode): string[] {
  const out: string[] = [];
  const nameOf = (el: Element) =>
    (
      el.getAttribute("aria-label") ??
      (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .map((id) => (id ? (document.getElementById(id)?.textContent ?? "") : ""))
        .join(" ") ??
      ""
    ).trim() || (el.textContent ?? "").trim();
  for (const el of root.querySelectorAll("button, [role='button'], [role='switch']")) {
    const own = nameOf(el);
    const id = el.getAttribute("id");
    const labelled = id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null;
    if (own === "" && !labelled) out.push(`button-name: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("input, textarea, select")) {
    const id = el.getAttribute("id");
    const labelled =
      el.hasAttribute("aria-label") ||
      el.hasAttribute("aria-labelledby") ||
      (id !== null && document.querySelector(`label[for="${CSS.escape(id)}"]`) !== null);
    if (!labelled) out.push(`label: ${el.outerHTML.slice(0, 80)}`);
  }
  for (const el of root.querySelectorAll("[aria-labelledby], [aria-describedby]"))
    for (const attr of ["aria-labelledby", "aria-describedby"])
      for (const id of (el.getAttribute(attr) ?? "").split(/\s+/).filter(Boolean))
        if (!document.getElementById(id)) out.push(`${attr} points at missing #${id}`);
  if (root.querySelector("a")) out.push("link: the federation UI has no links");
  if (root.querySelector("img")) out.push("image: the federation UI loads no images");
  const ids = [...root.querySelectorAll("[id]")].map((el) => el.id);
  if (new Set(ids).size !== ids.length) out.push("duplicate-id");
  return out;
}

/** Fixed widths wider than a 320 px column would allow, set as a plain class (not a ui variant). */
const fixedWidths = (root: ParentNode): string[] =>
  [...root.querySelectorAll("[class]")].flatMap((el) =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter((c) => /^(min-)?w-(\[\d+px\]|96|112|128)$/.test(c)),
  );

async function mountSettings(fake: ReturnType<typeof fakeClient>, theme: "dark" | "light" = "dark") {
  const r = wrap(<FederationSettingsSection channel="ada" client={fake.client} />, theme);
  await waitFor(() => expect(q(r.container, "federation-enabled")).not.toBeNull());
  return r;
}

describe("checkBlockDomain", () => {
  it("normalizes case, spaces, a trailing dot, *. and a pasted URL", () => {
    expect(checkBlockDomain("  Spam.Example ", [])).toEqual({ ok: true, domain: "spam.example" });
    expect(checkBlockDomain("spam.example.", [])).toEqual({ ok: true, domain: "spam.example" });
    expect(checkBlockDomain("*.spam.example", [])).toEqual({ ok: true, domain: "spam.example" });
    expect(checkBlockDomain("https://spam.example/@bot", [])).toEqual({ ok: true, domain: "spam.example" });
    expect(checkBlockDomain("bücher.example", [])).toEqual({ ok: true, domain: "xn--bcher-kva.example" });
  });

  it("refuses what is not a domain", () => {
    for (const bad of ["", "  ", "localhost", "-x.example", "x-.example", "sp am.example", "@bot@spam.example"])
      expect(checkBlockDomain(bad, [])).toEqual({ ok: false, error: "invalid" });
    expect(checkBlockDomain(`${"a".repeat(64)}.example`, [])).toEqual({ ok: false, error: "invalid" });
    expect(checkBlockDomain(`${"a.".repeat(126)}example`, [])).toEqual({ ok: false, error: "invalid" });
    expect(checkBlockDomain(`${"a".repeat(63)}.example`, []).ok).toBe(true);
    expect(checkBlockDomain("ab.c", []).ok).toBe(true);
  });

  it("refuses a duplicate and a subdomain an existing block covers; a parent is new", () => {
    expect(checkBlockDomain("spam.example", ["spam.example"])).toEqual({
      ok: false,
      error: "duplicate",
      domain: "spam.example",
    });
    expect(checkBlockDomain("media.spam.example", ["other.example", "spam.example"])).toEqual({
      ok: false,
      error: "covered",
      domain: "media.spam.example",
      by: "spam.example",
    });
    // Not a subdomain: only a whole label matches.
    expect(checkBlockDomain("notspam.example", ["spam.example"]).ok).toBe(true);
    expect(checkBlockDomain("example", ["spam.example"]).ok).toBe(false);
    expect(checkBlockDomain("spam.example", ["media.spam.example"]).ok).toBe(true);
  });

  it("has a message for each refusal", () => {
    expect(blockCheckMessage({ ok: false, error: "invalid" })).toBe(t("federation.blocks.invalid"));
    expect(blockCheckMessage({ ok: false, error: "duplicate", domain: "a.example" })).toContain("a.example");
    expect(blockCheckMessage({ ok: false, error: "covered", domain: "b.a.example", by: "a.example" })).toBe(
      t("federation.blocks.covered", { domain: "b.a.example", parent: "a.example" }),
    );
  });

  it("labels a follower by handle, or by actor URL as text", () => {
    expect(followerLabel(follower(1))).toBe("@fan1@social1.example");
    expect(followerLabel(follower(2, { handle: null }))).toBe("https://social2.example/users/fan2");
  });
});

describe("the studio section", () => {
  it("renders nothing while the instance flag is off (or unknown)", async () => {
    const fake = fakeClient({});
    const get = vi.spyOn(fake.client, "get");
    for (const flag of [undefined, false]) {
      bootstrap.federation = flag;
      const { container } = wrap(<FederationSettings channel="ada" client={fake.client} />);
      expect(q(container, "federation-settings")).toBeNull();
      cleanup();
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("renders with the instance flag on", async () => {
    bootstrap.federation = true;
    const { container } = wrap(<FederationSettings channel="ada" client={fakeClient({}).client} />);
    await waitFor(() => expect(q(container, "federation-enabled")).not.toBeNull());
    expect(q(container, "federation-settings")).not.toBeNull();
  });

  it("hides itself when the API says the instance does not federate", async () => {
    const fake = fakeClient({ settings: { instanceEnabled: false, enabled: false, handle: null } });
    const { container } = wrap(<FederationSettingsSection channel="ada" client={fake.client} />);
    await waitFor(() => expect(q(container, "federation-settings")).toBeNull());
  });

  it("shows a load failure", async () => {
    const { container } = wrap(
      <FederationSettingsSection channel="ada" client={fakeClient({ failGet: true }).client} />,
    );
    await waitFor(() => expect(container.textContent).toContain(t("federation.settings.loadFailed")));
  });

  it("states the five notes plainly", async () => {
    const { container } = await mountSettings(fakeClient({ settings: { enabled: false, handle: null } }));
    expect(q(container, "federation-note-posted")?.textContent).toBe(t("federation.notes.posted"));
    expect(q(container, "federation-note-mature")?.textContent).toBe(t("federation.notes.mature"));
    expect(q(container, "federation-note-replies")?.textContent).toBe(t("federation.notes.replies"));
    expect(q(container, "federation-note-delete")?.textContent).toBe(t("federation.notes.delete"));
    expect(q(container, "federation-note-refollow")?.textContent).toBe(t("federation.notes.refollow"));
    // The card's hint size, not a larger body size (F35).
    const list = q(container, "federation-note-posted")?.parentElement;
    expect(list?.className).toMatch(/\btext-xs\b/);
    expect(list?.className).not.toMatch(/\btext-sm\b/);
  });

  it("off: turning it on saves at once, shows the handle and toasts", async () => {
    const fake = fakeClient({ settings: { enabled: false, handle: null } });
    const { container } = await mountSettings(fake);
    expect(q(container, "federation-enabled")?.dataset.state).toBe("off");
    expect(q(container, "federation-handle")).toBeNull();
    expect(q(container, "federation-followers")).toBeNull();
    fireEvent.click(q(container, "federation-enabled")!);
    await waitFor(() => expect(q(container, "federation-enabled")?.dataset.state).toBe("on"));
    expect(fake.calls.update).toEqual([true]);
    expect(q(container, "federation-handle")?.dataset.handle).toBe(HANDLE);
    expect(toasts.success).toEqual([t("federation.settings.turnedOn")]);
    expect(document.querySelector('[data-testid="confirm-dialog-confirm"]')).toBeNull();
  });

  it("on: turning it off asks first; cancel keeps it on", async () => {
    const fake = fakeClient({});
    const { container } = await mountSettings(fake);
    fireEvent.click(q(container, "federation-enabled")!);
    await confirmButton();
    const d = q(document, "federation-off-confirm")!;
    expect(d.textContent).toContain(t("federation.settings.offBody"));
    fireEvent.click(q(d, "confirm-dialog-cancel")!);
    await noDialog();
    expect(fake.calls.update).toEqual([]);
    expect(q(container, "federation-enabled")?.dataset.state).toBe("on");
  });

  it("on: confirming turns it off and toasts", async () => {
    const fake = fakeClient({});
    const { container } = await mountSettings(fake);
    fireEvent.click(q(container, "federation-enabled")!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(q(container, "federation-enabled")?.dataset.state).toBe("off"));
    expect(fake.calls.update).toEqual([false]);
    expect(toasts.success).toEqual([t("federation.settings.turnedOff")]);
    expect(q(container, "federation-handle")).toBeNull();
  });

  it("a failed save keeps the state and toasts an error", async () => {
    const fake = fakeClient({ settings: { enabled: false, handle: null }, failUpdate: true });
    const { container } = await mountSettings(fake);
    fireEvent.click(q(container, "federation-enabled")!);
    await waitFor(() => expect(toasts.error).toEqual([t("federation.settings.saveFailed")]));
    expect(q(container, "federation-enabled")?.dataset.state).toBe("off");
  });

  it("copies the handle", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = await mountSettings(fakeClient({}));
    const handle = q(container, "federation-handle")!;
    expect(handle.textContent).toBe(HANDLE);
    expect(handle.tagName).toBe("CODE");
    const copy = q(container, "federation-handle-copy")!;
    expect(copy.getAttribute("aria-label")).toBe(t("federation.settings.handleCopy"));
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(HANDLE));
    expect(toasts.success).toEqual([t("federation.settings.handleCopied")]);
  });

  it("a refused clipboard says so", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { container } = await mountSettings(fakeClient({}));
    fireEvent.click(q(container, "federation-handle-copy")!);
    await waitFor(() => expect(toasts.error).toEqual([t("federation.settings.handleCopyFailed")]));
  });
});

describe("the remote followers", () => {
  it("the intro takes the notes' hint size, one note size per card (F35)", async () => {
    const { container } = await mountSettings(fakeClient({ followers: [] }));
    const intro = q(container, "federation-followers-intro");
    expect(intro?.textContent).toBe(t("federation.followers.intro"));
    expect(intro?.className).toMatch(/\btext-xs\b/);
    expect(intro?.className).not.toMatch(/\btext-sm\b/);
  });

  it("empty: an empty state naming the handle", async () => {
    const { container } = await mountSettings(fakeClient({ followers: [] }));
    await waitFor(() => expect(container.textContent).toContain(t("federation.followers.empty")));
    const list = q(container, "federation-followers")!;
    expect(list.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    expect(list.textContent).toContain(t("federation.followers.emptyHint", { handle: HANDLE }));
    expect(qa(container, "federation-follower")).toHaveLength(0);
  });

  it("lists handle and server as text with when they followed, never links or images", async () => {
    const items = [follower(1), follower(2, { handle: null })];
    const { container } = await mountSettings(fakeClient({ followers: items }));
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(2));
    const [a, b] = qa(container, "federation-follower");
    expect(a?.dataset.followerId).toBe(items[0]?.id);
    expect(a?.dataset.actor).toBe(items[0]?.actor);
    expect(a?.textContent).toContain("@fan1@social1.example");
    expect(a?.textContent).toContain(t("federation.followers.server", { domain: "social1.example" }));
    expect(a?.querySelector("time")?.getAttribute("datetime")).toBe(items[0]?.createdAt);
    expect(b?.textContent).toContain("https://social2.example/users/fan2");
    const list = q(container, "federation-followers")!;
    expect(list.querySelector("a, img")).toBeNull();
  });

  it("pages with Show more and stops at the end", async () => {
    const items = Array.from({ length: 5 }, (_, i) => follower(i + 1));
    const fake = fakeClient({ followers: items, pageSize: 2 });
    const { container } = await mountSettings(fake);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(2));
    fireEvent.click(q(container, "federation-followers-more")!);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(4));
    fireEvent.click(q(container, "federation-followers-more")!);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(5));
    expect(q(container, "federation-followers-more")).toBeNull();
    expect(fake.calls.cursors).toEqual([null, "2", "4"]);
    expect(qa(container, "federation-follower").map((r) => r.dataset.followerId)).toEqual(items.map((f) => f.id));
  });

  it("remove asks first; cancel keeps the follower", async () => {
    const fake = fakeClient({ followers: [follower(1), follower(2)] });
    const { container } = await mountSettings(fake);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(2));
    const remove = qa(container, "federation-follower-remove")[0]!;
    expect(remove.getAttribute("aria-label")).toBe(
      t("federation.followers.removeLabel", { handle: "@fan1@social1.example" }),
    );
    fireEvent.click(remove);
    await confirmButton();
    fireEvent.click(q(document, "confirm-dialog-cancel")!);
    await noDialog();
    expect(fake.calls.removed).toEqual([]);
    expect(qa(container, "federation-follower")).toHaveLength(2);
  });

  it("confirming removes the follower and toasts", async () => {
    const fake = fakeClient({ followers: [follower(1), follower(2)] });
    const { container } = await mountSettings(fake);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(2));
    fireEvent.click(qa(container, "federation-follower-remove")[0]!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(1));
    expect(fake.calls.removed).toEqual([follower(1).id]);
    expect(q(container, "federation-follower")?.dataset.followerId).toBe(follower(2).id);
    expect(toasts.success).toEqual([t("federation.followers.removed")]);
  });

  it("a failed remove keeps the follower and toasts an error", async () => {
    const fake = fakeClient({ followers: [follower(1)], failRemove: true });
    const { container } = await mountSettings(fake);
    await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(1));
    fireEvent.click(q(container, "federation-follower-remove")!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(toasts.error).toEqual([t("federation.followers.removeFailed")]));
    expect(qa(container, "federation-follower")).toHaveLength(1);
  });
});

describe("the admin page", () => {
  it("explains how to turn federation on while the instance does not federate", async () => {
    const fake = fakeAdmin();
    const blocks = vi.spyOn(fake.client, "blocks");
    const { container } = wrap(<FederationAdminPage instanceEnabled={false} client={fake.client} />);
    expect(q(container, "federation-admin-page")).not.toBeNull();
    expect(q(container, "federation-admin-off")?.textContent).toContain(t("federation.admin.offHowTo"));
    expect(container.querySelector("pre code")?.textContent).toBe(FEDERATION_ENV_SETTING);
    expect(q(container, "federation-block-add")).toBeNull();
    expect(q(container, "federation-keys-rotate")).toBeNull();
    expect(blocks).not.toHaveBeenCalled();
  });

  it("lists blocks, with an empty state when there are none", async () => {
    const empty = wrap(<FederationAdminPage instanceEnabled client={fakeAdmin().client} />);
    await waitFor(() => expect(empty.container.textContent).toContain(t("federation.blocks.empty")));
    expect(q(empty.container, "federation-blocks")?.querySelector('[data-slot="empty-state"]')).not.toBeNull();
    cleanup();
    const { container } = wrap(
      <FederationAdminPage instanceEnabled client={fakeAdmin([block("a.example"), block("b.example", null)]).client} />,
    );
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(2));
    expect(qa(container, "federation-block").map((b) => b.dataset.domain)).toEqual(["a.example", "b.example"]);
    expect(container.textContent).toContain(t("federation.blocks.blockedBy", { username: "admin" }));
    expect(container.textContent).toContain(t("federation.blocks.subdomains"));
  });

  it("validates before calling the API", async () => {
    const fake = fakeAdmin([block("spam.example")]);
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(1));
    const input = q(container, "federation-block-domain") as HTMLInputElement;
    for (const [value, message] of [
      ["not a domain", t("federation.blocks.invalid")],
      ["spam.example", t("federation.blocks.duplicate", { domain: "spam.example" })],
      ["media.spam.example", t("federation.blocks.covered", { domain: "media.spam.example", parent: "spam.example" })],
    ] as const) {
      fireEvent.change(input, { target: { value } });
      fireEvent.click(q(container, "federation-block-add")!);
      await waitFor(() => expect(q(container, "federation-block-error")?.textContent).toBe(message));
      expect(input.getAttribute("aria-invalid")).toBe("true");
    }
    expect(fake.calls.added).toEqual([]);
    // Typing clears the error.
    fireEvent.change(input, { target: { value: "x" } });
    expect(q(container, "federation-block-error")).toBeNull();
  });

  it("adds a block (normalized), clears the input and toasts", async () => {
    const fake = fakeAdmin([block("other.example")]);
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(1));
    const input = q(container, "federation-block-domain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: " Spam.Example " } });
    fireEvent.submit(input.closest("form")!);
    await confirmButton();
    expect(q(document, "federation-block-confirm")?.textContent).toContain(
      t("federation.blocks.addBody", { domain: "spam.example" }),
    );
    expect(fake.calls.added).toEqual([]);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(2));
    await noDialog();
    expect(fake.calls.added).toEqual(["spam.example"]);
    expect(qa(container, "federation-block")[0]?.dataset.domain).toBe("spam.example");
    expect(input.value).toBe("");
    expect(toasts.success).toEqual([t("federation.blocks.added", { domain: "spam.example" })]);
  });

  it("add asks first: cancel calls nothing and keeps the input", async () => {
    const fake = fakeAdmin();
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    await waitFor(() => expect(q(container, "federation-blocks")?.textContent).toContain(t("federation.blocks.empty")));
    const input = q(container, "federation-block-domain") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "big.example" } });
    fireEvent.click(q(container, "federation-block-add")!);
    await confirmButton();
    expect(document.body.textContent).toContain(t("federation.blocks.addTitle", { domain: "big.example" }));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-testid")).toBe("confirm-dialog-cancel"));
    fireEvent.click(q(document, "confirm-dialog-cancel")!);
    await noDialog();
    expect(fake.calls.added).toEqual([]);
    expect(input.value).toBe("big.example");
    expect(qa(container, "federation-block")).toHaveLength(0);
    expect(toasts.success).toEqual([]);
  });

  it("a server refusal shows the invalid message; another failure toasts", async () => {
    const bad = fakeAdmin([], { failAdd: Object.assign(new Error("bad"), { code: "BAD_REQUEST" }) });
    const r1 = wrap(<FederationAdminPage instanceEnabled client={bad.client} />);
    await waitFor(() =>
      expect(q(r1.container, "federation-blocks")?.textContent).toContain(t("federation.blocks.empty")),
    );
    fireEvent.change(q(r1.container, "federation-block-domain")!, { target: { value: "spam.example" } });
    fireEvent.click(q(r1.container, "federation-block-add")!);
    fireEvent.click(await confirmButton());
    await waitFor(() =>
      expect(q(r1.container, "federation-block-error")?.textContent).toBe(t("federation.blocks.invalid")),
    );
    cleanup();
    const down = fakeAdmin([], { failAdd: new Error("down") });
    const r2 = wrap(<FederationAdminPage instanceEnabled client={down.client} />);
    await waitFor(() =>
      expect(q(r2.container, "federation-blocks")?.textContent).toContain(t("federation.blocks.empty")),
    );
    fireEvent.change(q(r2.container, "federation-block-domain")!, { target: { value: "spam.example" } });
    fireEvent.click(q(r2.container, "federation-block-add")!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(toasts.error).toEqual([t("federation.blocks.addFailed")]));
  });

  it("remove asks first, then unblocks and toasts", async () => {
    const fake = fakeAdmin([block("a.example"), block("b.example")]);
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(2));
    fireEvent.click(qa(container, "federation-block-remove")[1]!);
    await confirmButton();
    fireEvent.click(q(document, "confirm-dialog-cancel")!);
    await noDialog();
    expect(fake.calls.removed).toEqual([]);
    fireEvent.click(qa(container, "federation-block-remove")[1]!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(1));
    expect(fake.calls.removed).toEqual(["b.example"]);
    expect(toasts.success).toEqual([t("federation.blocks.removed", { domain: "b.example" })]);
  });

  it("rotate asks first, with the explanation, then toasts the count", async () => {
    const fake = fakeAdmin();
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    expect(q(container, "federation-keys")?.textContent).toContain(t("federation.keys.intro"));
    fireEvent.click(q(container, "federation-keys-rotate")!);
    await confirmButton();
    expect(document.body.textContent).toContain(t("federation.keys.confirmBody"));
    expect(fake.calls.rotations).toBe(0);
    fireEvent.click(q(document, "confirm-dialog-cancel")!);
    await noDialog();
    expect(fake.calls.rotations).toBe(0);
    fireEvent.click(q(container, "federation-keys-rotate")!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(fake.calls.rotations).toBe(1));
    await waitFor(() => expect(toasts.success).toEqual([t("federation.keys.rotated", { count: 3 })]));
  });

  it("a failed rotation toasts an error", async () => {
    const fake = fakeAdmin([], { failRotate: true });
    const { container } = wrap(<FederationAdminPage instanceEnabled client={fake.client} />);
    fireEvent.click(q(container, "federation-keys-rotate")!);
    fireEvent.click(await confirmButton());
    await waitFor(() => expect(toasts.error).toEqual([t("federation.keys.rotateFailed")]));
  });
});

describe("layout and accessibility", () => {
  for (const theme of ["dark", "light"] as const) {
    it(`the studio section fits 320 px and passes the a11y check (${theme})`, async () => {
      const { container } = await mountSettings(
        fakeClient({ followers: [follower(1), follower(2, { handle: null })], pageSize: 1 }),
        theme,
      );
      await waitFor(() => expect(qa(container, "federation-follower")).toHaveLength(1));
      expect(container.querySelector(`[data-theme="${theme}"]`)).not.toBeNull();
      expect(fixedWidths(container)).toEqual([]);
      expect(q(container, "federation-followers")?.className).toContain("min-w-0");
      expect(q(container, "federation-handle")?.className).toContain("break-all");
      expect(a11yViolations(container)).toEqual([]);
    });

    it(`the admin page fits 320 px and passes the a11y check (${theme})`, async () => {
      const { container } = wrap(
        <FederationAdminPage instanceEnabled client={fakeAdmin([block(`${"long".repeat(10)}.example`)]).client} />,
        theme,
      );
      await waitFor(() => expect(qa(container, "federation-block")).toHaveLength(1));
      expect(fixedWidths(container)).toEqual([]);
      expect(q(container, "federation-admin-page")?.className).toContain("min-w-0");
      expect(a11yViolations(container)).toEqual([]);
      // The error state keeps its references valid.
      fireEvent.click(q(container, "federation-block-add")!);
      await waitFor(() => expect(q(container, "federation-block-error")).not.toBeNull());
      expect(a11yViolations(container)).toEqual([]);
    });
  }

  it("the off-instance admin state passes the a11y check", () => {
    const { container } = wrap(<FederationAdminPage instanceEnabled={false} client={fakeAdmin().client} />);
    expect(a11yViolations(container)).toEqual([]);
  });

  it("the confirm dialogs start on Cancel (Enter never confirms by accident)", async () => {
    const { container } = await mountSettings(fakeClient({}));
    fireEvent.click(q(container, "federation-enabled")!);
    await confirmButton();
    await waitFor(() => expect(document.activeElement?.getAttribute("data-testid")).toBe("confirm-dialog-cancel"));
    expect(a11yViolations(q(document, "federation-off-confirm")!)).toEqual([]);
  });
});
