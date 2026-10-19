// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { render, screen } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import { Breadcrumbs, PageHeader, PageTabs, Section } from "../../src/blocks/headers/index.ts";
test("PageHeader renders title, description, meta, actions, and slots", () => {
  render(
    <PageHeader
      title="Settings"
      description="Preferences"
      meta="Updated"
      actions={<button>Save</button>}
      breadcrumbs={<span>Home</span>}
      tabs={<span>Tabs</span>}
      data-testid="page-header"
    />,
  );
  expect(screen.getByTestId("page-header").textContent).toContain("Settings");
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Settings");
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
});
test("Section associates its landmark to the heading and forwards data attributes", () => {
  render(
    <Section heading="Recent activity" data-testid="activity">
      <p>Updates</p>
    </Section>,
  );
  const section = screen.getByTestId("activity");
  expect(section.getAttribute("aria-labelledby")).toBe(screen.getByRole("heading", { name: "Recent activity" }).id);
});
test("Breadcrumbs collapse long trails behind an accessible menu", () => {
  render(
    <Breadcrumbs
      label="Breadcrumbs"
      items={["Home", "A", "B", "C", "Current"].map((label) => ({ label, href: `/${label}` }))}
    />,
  );
  expect(screen.getByRole("navigation", { name: "Breadcrumbs" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "Home" })).toBeTruthy();
  expect(screen.getByText("Current")).toBeTruthy();
  expect(screen.queryByText("B")).toBeNull();
});
test("PageTabs route links expose current state", () => {
  render(
    <PageTabs
      items={[
        { id: "overview", label: "Overview", href: "/overview", current: true },
        { id: "activity", label: "Activity", href: "/activity", count: 4 },
      ]}
    />,
  );
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("tab", { name: "Activity 4" })).toBeTruthy();
});
test("PageTabs panel mode renders panel content", () => {
  render(
    <PageTabs
      value="account"
      onValueChange={() => undefined}
      items={[
        { id: "account", label: "Account", content: <p>Account panel</p> },
        { id: "security", label: "Security", content: <p>Security panel</p> },
      ]}
    />,
  );
  expect(screen.getByText("Account panel")).toBeTruthy();
  expect(screen.queryByText("Security panel")).toBeNull();
});
