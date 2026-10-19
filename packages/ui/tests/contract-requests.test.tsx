// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Props added for the apps/web migration (U6b contract requests). */
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import type { StreamCard } from "@commonair/contracts/dto";
import { PasswordField } from "../src/blocks/forms/index.ts";
import { ChannelHeader } from "../src/blocks/media/channel-header.tsx";
import { PlayerChrome } from "../src/blocks/media/player-chrome.tsx";
import { StreamGrid } from "../src/blocks/media/stream-grid.tsx";
import { PageContainer, SiteFooter, SiteHeader, StudioShell, UserMenu } from "../src/layouts/index.ts";

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

describe("U6b contract requests", () => {
  test("StreamGrid forwards per-card props", () => {
    render(
      <StreamGrid
        streams={[stream]}
        hrefFor={() => "/fern"}
        cardProps={(s) => ({ "data-testid": "card", "data-channel": s.channel.slug, showReason: false })}
      />,
    );
    expect(screen.getByTestId("card").getAttribute("data-channel")).toBe("fern");
  });

  test("PlayerChrome and ChannelHeader forward live badge props", () => {
    render(
      <>
        <PlayerChrome variant="live" liveLabel="Live" liveBadgeProps={{ "data-testid": "player-live" }}>
          <span />
        </PlayerChrome>
        <ChannelHeader name="Fernsby" live liveBadgeProps={{ "data-testid": "header-live" }} />
      </>,
    );
    expect(screen.getByTestId("player-live")).toBeTruthy();
    expect(screen.getByTestId("header-live")).toBeTruthy();
  });

  test("PasswordField takes autocomplete from inputProps and shows a description", () => {
    render(
      <PasswordField
        label="Password"
        showLabel="Show"
        hideLabel="Hide"
        description="At least 12 characters"
        inputProps={{ autoComplete: "current-password" }}
      />,
    );
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByText("At least 12 characters")).toBeTruthy();
  });

  test("PasswordField defaults to new-password", () => {
    render(<PasswordField label="Password" showLabel="Show" hideLabel="Hide" />);
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("new-password");
  });

  test("StudioShell renders a footer", () => {
    render(
      <StudioShell
        header={<div />}
        groups={[]}
        sidebarLabel="Studio"
        skipLabel="Skip to content"
        footer={<p>footer here</p>}
      >
        <p>content</p>
      </StudioShell>,
    );
    const footer = screen.getByText("footer here");
    expect(footer.closest("main")).toBeNull();
    expect(screen.getByRole("link", { name: "Skip to content" }).getAttribute("href")).toBe("#main-content");
  });

  test("PageContainer has a form width", () => {
    render(<PageContainer width="form" data-testid="pc" />);
    expect(screen.getByTestId("pc").className).toContain("max-w-md");
  });

  test("UserMenu hides the username on phones", () => {
    render(<UserMenu username="averylongusername" menuLabel="Account" items={[]} />);
    expect(screen.getByText("averylongusername").className).toContain("hidden");
  });

  test("SiteHeader renders the brand through a render element", () => {
    render(
      <SiteHeader
        brand={{
          mark: <span aria-hidden>C</span>,
          name: "CommonAir",
          href: "/",
          render: (
            <a href="/home" data-router>
              home
            </a>
          ),
        }}
        nav={[]}
        navLabel="Main"
        menuLabel="Menu"
        mobileActions={<span>theme</span>}
      />,
    );
    const link = screen.getByRole("link", { name: "CommonAir" });
    expect(link.getAttribute("href")).toBe("/home");
    expect(link.hasAttribute("data-router")).toBe(true);
  });

  test("SiteFooter source link keeps its data attributes and does not leak label as an attribute", () => {
    render(
      <SiteFooter
        instanceName="CommonAir"
        links={[]}
        license="AGPL"
        sourceLink={{ label: "Source", href: "https://example.org/src", "data-testid": "footer-source-link" }}
      />,
    );
    const link = screen.getByTestId("footer-source-link");
    expect(link.textContent).toBe("Source");
    expect(link.hasAttribute("label")).toBe(false);
    expect(link.getAttribute("rel")).toBe("noopener");
  });
});
