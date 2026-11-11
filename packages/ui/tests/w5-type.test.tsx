// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W5 type sweep (README decision 1, change 3): reading text in the shared blocks is 14 px,
 * while captions, metadata and table cells keep 12 px.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { CouncilResponseCard } from "../src/blocks/coop/council-response.tsx";
import { MetricPanel } from "../src/blocks/data/metric-panel.tsx";
import { FormSection } from "../src/blocks/forms/form-section.tsx";
import { CommentItem } from "../src/blocks/media/comment-item.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs.tsx";

const src = join(import.meta.dirname, "..", "src");
const is14 = (el: Element | null): boolean => (el?.className ?? "").split(/\s+/).some((c) => /^text-sm(\/|$)/.test(c));
const is12 = (el: Element | null): boolean => (el?.className ?? "").split(/\s+/).some((c) => /^text-xs(\/|$)/.test(c));

describe("reading text in the blocks is 14 px", () => {
  test("a plain form section's description", () => {
    render(
      <FormSection variant="plain" title="Title" description="What this section does">
        <span />
      </FormSection>,
    );
    const description = screen.getByText("What this section does");
    expect(is14(description)).toBe(true);
    expect(is12(description)).toBe(false);
  });

  test("a metric panel's body is 14 px, its caption stays 12 px", () => {
    render(<MetricPanel title="Viewers" value="12" caption="Last 30 days" body="Up from last month" />);
    expect(is14(screen.getByText("Up from last month"))).toBe(true);
    expect(is12(screen.getByText("Last 30 days"))).toBe(true);
  });

  test("a comment body", () => {
    render(
      <CommentItem author="Aurora" time="now">
        A comment
      </CommentItem>,
    );
    const body = screen.getByText("A comment");
    expect(is14(body)).toBe(true);
    expect(is12(body)).toBe(false);
  });

  test("a council response body", () => {
    render(<CouncilResponseCard stance="support" stanceLabel="Supports" title="Response" body="We agree." />);
    const body = screen.getByText("We agree.");
    expect(is14(body)).toBe(true);
    expect(is12(body)).toBe(false);
  });

  test("a tab panel's text", () => {
    render(
      <Tabs defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">Panel text</TabsContent>
      </Tabs>,
    );
    const panel = screen.getByText("Panel text");
    expect(is14(panel)).toBe(true);
    expect(is12(panel)).toBe(false);
  });

  test("popover bodies and headers", () => {
    const text = readFileSync(join(src, "components/popover.tsx"), "utf8");
    const content = /"z-50 flex w-72[^"]*"/.exec(text)?.[0] ?? "";
    expect(content).toMatch(/\btext-sm\b/);
    expect(content).not.toMatch(/\btext-xs\b/);
    expect(text).toContain('data-slot="popover-header" className={cn("flex flex-col gap-1 text-sm"');
  });

  test.each([
    ["blocks/forms/form-section.tsx", '{description && <p className="mt-1 text-sm text-muted-foreground">'],
    ["blocks/coop/settings-list.tsx", '{item.description ? <p className="text-sm text-muted-foreground">'],
    ["blocks/coop/proposal-changes.tsx", '{kind.description ? <p className="text-sm text-muted-foreground">'],
    ["blocks/coop/membership.tsx", '<div className="text-sm/relaxed whitespace-pre-line'],
    ["blocks/coop/statement.tsx", 'className="text-sm text-muted-foreground wrap-anywhere"'],
    [
      "blocks/privacy/deletion-panel.tsx",
      'className="flex flex-col items-start gap-3 border border-warning p-3 text-sm"',
    ],
    ["blocks/studio/alert-config.tsx", '{note ? <p className="text-sm text-muted-foreground">{note}</p> : null}'],
  ])("%s keeps its reading text at 14 px", (file, snippet) => {
    expect(readFileSync(join(src, file), "utf8")).toContain(snippet);
  });
});

describe("metadata stays 12 px", () => {
  test.each([
    ["blocks/data/key-value-list.tsx", '<dt className="min-w-0 text-xs text-muted-foreground">'],
    ["blocks/data/stat-card.tsx", '{hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}'],
    ["blocks/coop/threshold-bar.tsx", '{thresholdText ? <p className="text-xs text-muted-foreground">'],
    ["blocks/media/sensitive-media.tsx", '<figcaption className="text-xs text-muted-foreground">'],
    ["blocks/data/timeline.tsx", '<time className="text-xs text-muted-foreground">'],
  ])("%s", (file, snippet) => {
    expect(readFileSync(join(src, file), "utf8")).toContain(snippet);
  });
});
