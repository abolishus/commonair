// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/** The studio's Discord webhook section (ADR 0028 decision 5) with a fake client. */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DiscordWebhookPanel } from "../src/components/discord-webhook/panel.tsx";
import {
  cleanWebhookUrl,
  discordDocsUrl,
  type DiscordWebhookClient,
  type DiscordWebhookStatusDto,
} from "../src/components/discord-webhook/shared.ts";
import { locale, t, uiMessages } from "../src/i18n/index.ts";

afterEach(cleanup);

const OFF: DiscordWebhookStatusDto = { configured: false, setAt: null, lastPostedAt: null, lastError: null };
const ON: DiscordWebhookStatusDto = {
  configured: true,
  setAt: "2026-10-30T10:00:00.000Z",
  lastPostedAt: "2026-10-30T11:00:00.000Z",
  lastError: null,
};
const GOOD_URL = "https://discord.com/api/webhooks/123456789/abc_DEF-123";

function fake(initial: DiscordWebhookStatusDto, opts: { failGet?: boolean; refuseSet?: boolean } = {}) {
  const calls: string[] = [];
  let status = initial;
  const client: DiscordWebhookClient = {
    get: async () => {
      calls.push("get");
      if (opts.failGet) throw new Error("down");
      return status;
    },
    set: async (url) => {
      calls.push(`set ${url}`);
      if (opts.refuseSet) throw Object.assign(new Error("bad"), { code: "BAD_REQUEST" });
      status = { ...ON, lastPostedAt: status.lastPostedAt, lastError: null };
      return status;
    },
    remove: async () => {
      calls.push("remove");
      status = OFF;
      return { ok: true };
    },
    test: async () => {
      calls.push("test");
      return status;
    },
  };
  return { client, calls };
}

const show = (
  client: DiscordWebhookClient,
  docsUrl: string | null = "https://code.example/air/blob/HEAD/docs/streamers/discord.md",
) =>
  render(
    <LocaleProvider locale={locale} messages={uiMessages}>
      <TooltipProvider>
        <DiscordWebhookPanel client={client} docsUrl={docsUrl} />
      </TooltipProvider>
    </LocaleProvider>,
  );

const statusEl = () => screen.getByTestId("discord-webhook-status");

describe("DiscordWebhookPanel", () => {
  it("not configured: says so, no test or remove, an empty password input", async () => {
    const { client } = fake(OFF);
    show(client);
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("false"));
    expect(statusEl().getAttribute("data-error")).toBe("");
    expect(statusEl().textContent).toContain(t("discord.status.off"));
    expect(screen.queryByTestId("discord-webhook-test")).toBeNull();
    expect(screen.queryByTestId("discord-webhook-remove")).toBeNull();
    const input = screen.getByTestId("discord-webhook-input") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.value).toBe("");
    // Optional, third-party terms, and the guide with the open alternatives.
    expect(screen.getByTestId("discord-webhook-section").textContent).toContain(t("discord.terms"));
    const guide = screen.getByTestId("discord-webhook-section").querySelector("a[href]");
    expect(guide?.textContent).toBe(t("discord.guide"));
    expect(guide?.getAttribute("href")).toContain("discord.md");
  });

  it("configured: the last post and no error; the input is still never pre-filled", async () => {
    const { client } = fake(ON);
    show(client, null);
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("true"));
    expect(statusEl().getAttribute("data-error")).toBe("");
    expect(statusEl().textContent).toContain(t("discord.status.on"));
    expect(statusEl().querySelector("time")).not.toBeNull();
    expect((screen.getByTestId("discord-webhook-input") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("discord-webhook-test")).toBeTruthy();
    expect(screen.getByTestId("discord-webhook-remove")).toBeTruthy();
    expect(screen.getByTestId("discord-webhook-section").querySelector("a[href]")).toBeNull();
  });

  it("configured with an error: data-error and the error in words", async () => {
    const { client } = fake({ ...ON, lastPostedAt: null, lastError: "not_found" });
    show(client);
    await waitFor(() => expect(statusEl().getAttribute("data-error")).toBe("not_found"));
    expect(statusEl().textContent).toContain(t("discord.error.not_found"));
    expect(statusEl().textContent).toContain(t("discord.status.never"));
  });

  it("a load failure offers a retry", async () => {
    const f = fake(OFF, { failGet: true });
    show(f.client);
    await screen.findByText(t("discord.loadFailed"));
    expect(screen.queryByTestId("discord-webhook-input")).toBeNull();
  });

  it("save checks the URL shape first, then saves and clears the input", async () => {
    const f = fake(OFF);
    show(f.client);
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("false"));
    const input = screen.getByTestId("discord-webhook-input") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "https://example.com/hook" } });
    await act(async () => fireEvent.click(screen.getByTestId("discord-webhook-save")));
    expect(screen.getByText(t("discord.url.invalid"))).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(f.calls.filter((c) => c.startsWith("set"))).toEqual([]);

    fireEvent.change(input, { target: { value: `  ${GOOD_URL}  ` } });
    expect(screen.queryByText(t("discord.url.invalid"))).toBeNull();
    await act(async () => fireEvent.click(screen.getByTestId("discord-webhook-save")));
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("true"));
    expect(f.calls).toContain(`set ${GOOD_URL}`);
    expect(input.value).toBe("");
  });

  it("a server refusal shows as the URL error", async () => {
    const f = fake(OFF, { refuseSet: true });
    show(f.client);
    await waitFor(() => expect(statusEl()).toBeTruthy());
    fireEvent.change(screen.getByTestId("discord-webhook-input"), { target: { value: GOOD_URL } });
    await act(async () => fireEvent.click(screen.getByTestId("discord-webhook-save")));
    await screen.findByText(t("discord.url.invalid"));
  });

  it("test sends one test post", async () => {
    const f = fake(ON);
    show(f.client);
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("true"));
    await act(async () => fireEvent.click(screen.getByTestId("discord-webhook-test")));
    expect(f.calls.filter((c) => c === "test")).toHaveLength(1);
  });

  it("remove asks first: cancel keeps it, confirm removes it", async () => {
    const f = fake(ON);
    show(f.client);
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("true"));

    fireEvent.click(screen.getByTestId("discord-webhook-remove"));
    let dialog = await screen.findByTestId("discord-webhook-remove-confirm");
    expect(dialog.textContent).toContain(t("discord.removeTitle"));
    fireEvent.click(within(dialog).getByTestId("confirm-dialog-cancel"));
    await waitFor(() => expect(screen.queryByTestId("discord-webhook-remove-confirm")).toBeNull());
    expect(f.calls).not.toContain("remove");

    fireEvent.click(screen.getByTestId("discord-webhook-remove"));
    dialog = await screen.findByTestId("discord-webhook-remove-confirm");
    await act(async () => fireEvent.click(within(dialog).getByTestId("confirm-dialog-confirm")));
    await waitFor(() => expect(statusEl().getAttribute("data-configured")).toBe("false"));
    expect(f.calls).toContain("remove");
    expect(screen.queryByTestId("discord-webhook-remove")).toBeNull();
  });
});

describe("helpers", () => {
  it("cleanWebhookUrl accepts Discord webhooks only", () => {
    expect(cleanWebhookUrl(` ${GOOD_URL}\n`)).toBe(GOOD_URL);
    expect(cleanWebhookUrl("https://discordapp.com/api/webhooks/1/x")).toBe("https://discordapp.com/api/webhooks/1/x");
    for (const bad of [
      "",
      "https://example.com/api/webhooks/1/x",
      "http://discord.com/api/webhooks/1/x",
      "https://discord.com/api/webhooks/1/x?wait=true",
      `https://discord.com/api/webhooks/1/${"x".repeat(300)}`,
    ])
      expect(cleanWebhookUrl(bad)).toBeNull();
  });

  it("discordDocsUrl points at the running commit, or HEAD", () => {
    expect(discordDocsUrl(null)).toBeNull();
    expect(discordDocsUrl("https://code.example/org/air/")).toBe(
      "https://code.example/org/air/blob/HEAD/docs/streamers/discord.md",
    );
    expect(discordDocsUrl("https://code.example/org/air/tree/abc123")).toBe(
      "https://code.example/org/air/blob/abc123/docs/streamers/discord.md",
    );
  });
});
