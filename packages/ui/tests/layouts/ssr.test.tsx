// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";
import { AppShell, ChannelSidebar, PageContainer, SiteFooter, SiteHeader, UserMenu } from "../../src/layouts/index.ts";

test("layout compositions hydrate without console warnings", async () => {
  const brand = { mark: <span aria-hidden="true">CA</span>, name: "CommonAir", href: "/" };
  const tree = (
    <AppShell
      header={
        <SiteHeader
          brand={brand}
          nav={[{ id: "browse", label: "Browse", href: "/browse", current: true }]}
          navLabel="Primary navigation"
          menuLabel="Open navigation"
        />
      }
      sidebar={<ChannelSidebar label="Followed channels" groups={[]} />}
      footer={<SiteFooter instanceName="CommonAir" links={[]} license="AGPL" />}
      skipLabel="Skip to content"
    >
      <PageContainer>
        <p>Content</p>
      </PageContainer>
    </AppShell>
  );
  const markup = renderToString(tree);
  const container = document.createElement("div");
  container.innerHTML = markup;
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  let root: ReturnType<typeof hydrateRoot> | undefined;
  await act(async () => {
    root = hydrateRoot(container, tree);
  });
  expect(container.querySelector("#main-content")?.textContent).toContain("Content");
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  await act(async () => {
    root?.unmount();
  });
  error.mockRestore();
  warn.mockRestore();
});

test("UserMenu can render on the server", () => {
  const markup = renderToString(<UserMenu username="Creator" menuLabel="User menu" items={[]} />);
  expect(markup).toContain("Creator");
});
