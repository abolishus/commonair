// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { act } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";
import { Breadcrumbs, PageHeader, PageTabs, Section } from "../../src/blocks/headers/index.ts";

test("header compositions hydrate without console warnings", async () => {
  const tree = (
    <div>
      <PageHeader
        title="Settings"
        breadcrumbs={<Breadcrumbs label="Breadcrumbs" items={[{ label: "Home", href: "/" }, { label: "Settings" }]} />}
        tabs={<PageTabs items={[{ id: "account", label: "Account", href: "/account", current: true }]} />}
      />
      <Section heading="Account">
        <p>Details</p>
      </Section>
    </div>
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
  expect(container.querySelector("h1")?.textContent).toBe("Settings");
  expect(error).not.toHaveBeenCalled();
  expect(warn).not.toHaveBeenCalled();
  await act(async () => {
    root?.unmount();
  });
  error.mockRestore();
  warn.mockRestore();
});
