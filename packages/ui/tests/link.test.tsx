// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { TargetLink } from "../src/lib/link.tsx";
import { IncidentCard } from "../src/blocks/feedback/index.ts";
import { SiteHeader } from "../src/layouts/index.ts";

describe("TargetLink", () => {
  test("href renders a plain link with the class and data props", () => {
    render(
      <TargetLink target={{ href: "/x" }} className="underline" data-slot="x-link">
        X
      </TargetLink>,
    );
    const link = screen.getByRole("link", { name: "X" });
    expect(link.getAttribute("href")).toBe("/x");
    expect(link.className).toBe("underline");
    expect(link.getAttribute("data-slot")).toBe("x-link");
  });

  test("a render element keeps its own classes, merged with the composition's", () => {
    render(
      <TargetLink
        target={{
          render: (
            <a href="/r" className="router-active px-2">
              Routed
            </a>
          ),
        }}
        className="underline px-4"
      >
        Routed
      </TargetLink>,
    );
    const link = screen.getByRole("link", { name: "Routed" });
    expect(link.getAttribute("href")).toBe("/r");
    // tailwind-merge resolves the conflict (px-4 wins) and keeps the router's own class.
    expect(link.className.split(" ").sort()).toEqual(["px-4", "router-active", "underline"]);
  });

  test("neither href nor render renders text, not an href-less <a>", () => {
    const { container } = render(<TargetLink target={{}}>Plain</TargetLink>);
    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("span")?.textContent).toBe("Plain");
  });

  test("compositions inherit the no-target behaviour", () => {
    const { container } = render(
      <>
        <IncidentCard status="Resolved" title="Outage" date="Aug 22" link={{ label: "Postmortem" }} />
        <SiteHeader
          brand={{ mark: null, name: "CommonAir", href: "/" }}
          context={{ label: "Creator studio" }}
          nav={[]}
          navLabel="Studio"
          menuLabel="Open navigation"
        />
      </>,
    );
    expect(screen.queryByRole("link", { name: "Postmortem" })).toBeNull();
    expect(screen.getByText("Postmortem").tagName).toBe("SPAN");
    expect(container.querySelector("[data-slot=site-header-context]")?.tagName).toBe("SPAN");
  });
});
