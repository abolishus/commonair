// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * D1 design foundation (docs/design/2026-11-overhaul): the brand button
 * contract and its "one filled call to action per screen" rule, 14 px reading
 * text with 12 px metadata, and touch-sized targets below md.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vite-plus/test";
import { Button, buttonVariants } from "../src/components/button.tsx";
import { Card, CardContent, CardDescription } from "../src/components/card.tsx";
import { Empty, EmptyDescription } from "../src/components/empty.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "../src/components/field.tsx";
import { Slider } from "../src/components/slider.tsx";
import { Table, TableBody, TableCell, TableRow } from "../src/components/table.tsx";
import { cn } from "../src/lib/utils.ts";
import { AccentButton } from "../src/primitives/accent-button.tsx";
import { ThemeToggle } from "../src/primitives/theme-toggle.tsx";

const pkgRoot = join(import.meta.dirname, "..");
const repoRoot = join(pkgRoot, "..", "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "storybook-static" || entry === "routeTree.gen.ts") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const classesOf = (el: Element): string[] => el.className.split(/\s+/);

describe("Button variant brand", () => {
  test("marigold fill, zinc-950 text, 14 px semibold labels, the light-theme edge and a hover step", () => {
    const classes = cn(buttonVariants({ variant: "brand" })).split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining([
        "bg-brand",
        "text-brand-foreground",
        "text-sm",
        "font-semibold",
        "border-brand-ring",
        "hover:bg-brand-hover",
      ]),
    );
    expect(classes).not.toContain("text-xs");
    expect(classes).not.toContain("font-medium");
  });

  test.each(["default", "lg"] as const)("keeps 14 px labels at size %s", (size) => {
    const classes = cn(buttonVariants({ variant: "brand", size })).split(/\s+/);
    expect(classes).toContain("text-sm");
    expect(classes).not.toContain("text-xs");
  });

  test("renders as a button with the brand classes", () => {
    render(<Button variant="brand">Create account</Button>);
    const button = screen.getByRole("button", { name: "Create account" });
    expect(classesOf(button)).toEqual(expect.arrayContaining(["bg-brand", "focus-visible:ring-offset-2"]));
  });
});

/** One `variant="brand"` (JSX) or `variant: "brand"` (buttonVariants) use, with the props around it. */
interface BrandUse {
  file: string;
  context: string;
}

function brandUses(file: string, text: string): BrandUse[] {
  const uses: BrandUse[] = [];
  for (const m of text.matchAll(/variant(?:=\{?|:\s*)"brand"\}?/g)) {
    const at = m.index;
    // The enclosing JSX tag (`<X … >`) or object literal (`{ … }`) the variant sits in.
    const jsx = text.lastIndexOf("<", at) > text.lastIndexOf("{", at);
    const start = jsx ? text.lastIndexOf("<", at) : text.lastIndexOf("{", at);
    const end = jsx ? text.indexOf(">", at) : text.indexOf("}", at);
    uses.push({ file, context: text.slice(start, end < 0 ? undefined : end + 1) });
  }
  return uses;
}

/** A file may hold more than one brand button only if they are mutually exclusive, said in this comment. */
const ONE_CTA_MARKER = "one-brand-cta:";

const scanned = [
  ...walk(join(pkgRoot, "src")),
  ...walk(join(pkgRoot, "stories")),
  ...walk(join(repoRoot, "apps/web/src")),
].map((full) => ({ file: relative(repoRoot, full), text: readFileSync(full, "utf8") }));

describe("brand usage rules (review guard)", () => {
  test("the scanner finds JSX and buttonVariants uses and their sizes", () => {
    const sample = `<Button variant="brand" size="sm">x</Button>; buttonVariants({ variant: "brand", size: "xs" });`;
    expect(brandUses("x.tsx", sample).map((u) => /size(?:=|:\s*)"(\w+)"/.exec(u.context)?.[1])).toEqual(["sm", "xs"]);
  });

  test("brand buttons are size default or lg, never xs, sm or icon (14 px / 600 labels)", () => {
    const offenders = scanned
      .flatMap(({ file, text }) => brandUses(file, text))
      .filter((u) => /size(?:=\{?|:\s*)"(xs|sm|icon[\w-]*)"/.test(u.context))
      .map((u) => `${u.file}: ${u.context}`);
    expect(offenders).toEqual([]);
  });

  test(`one filled brand call to action per screen: at most one per file, unless marked "${ONE_CTA_MARKER}"`, () => {
    const offenders = scanned
      .filter(({ file, text }) => brandUses(file, text).length > 1 && !text.includes(ONE_CTA_MARKER))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("no brand fill carries white text", () => {
    const offenders = scanned
      .filter(({ text }) => /\bbg-brand\b(?!-)[^"'`]*\btext-(white|background|primary-foreground)\b/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

describe("AccentButton", () => {
  test("Follow and Support labels are 14 px semibold on the channel accent", () => {
    render(<AccentButton accent="indigo">Follow</AccentButton>);
    const classes = classesOf(screen.getByRole("button", { name: "Follow" }));
    expect(classes).toEqual(
      expect.arrayContaining(["bg-channel-accent", "text-sm", "font-semibold", "focus-visible:ring-offset-2"]),
    );
    expect(classes).not.toContain("text-xs");
  });
});

describe("reading text is 14 px, metadata stays 12 px", () => {
  test("card bodies and descriptions, form labels, hints and errors, empty-state bodies", () => {
    render(
      <>
        <Card data-testid="card">
          <CardContent>
            <CardDescription data-testid="card-description">Description</CardDescription>
          </CardContent>
        </Card>
        <Field>
          <FieldLabel data-testid="label">Label</FieldLabel>
          <FieldDescription data-testid="hint">Hint</FieldDescription>
          <FieldError data-testid="error">Error</FieldError>
        </Field>
        <Empty>
          <EmptyDescription data-testid="empty">Nothing here</EmptyDescription>
        </Empty>
      </>,
    );
    for (const id of ["card", "card-description", "label", "hint", "error", "empty"]) {
      const classes = classesOf(screen.getByTestId(id));
      expect(
        classes.some((c) => /^text-sm(\/|$)/.test(c)),
        id,
      ).toBe(true);
      expect(
        classes.some((c) => /^text-xs(\/|$)/.test(c)),
        id,
      ).toBe(false);
    }
  });

  test("every *-description slot in the components is 14 px", () => {
    const dir = join(pkgRoot, "src/components");
    const slots: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".tsx"))) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const m of text.matchAll(/data-slot="([\w-]+-description)"[\s\S]{0,200}?\btext-(xs|sm)\b/g)) {
        slots.push(`${m[1]}: text-${m[2]}`);
      }
    }
    expect(slots.length).toBeGreaterThanOrEqual(10);
    expect(slots.filter((s) => s.endsWith("text-xs"))).toEqual([]);
  });

  test("tables stay 12 px so dense studio and admin tables keep their width", () => {
    render(
      <Table data-testid="table">
        <TableBody>
          <TableRow>
            <TableCell>1</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(classesOf(screen.getByTestId("table"))).toContain("text-xs");
  });
});

describe("touch targets", () => {
  test("icon buttons are 40px (icon) and 44px (icon-lg) below md", () => {
    expect(cn(buttonVariants({ size: "icon" })).split(/\s+/)).toEqual(
      expect.arrayContaining(["size-8", "max-md:size-10"]),
    );
    expect(cn(buttonVariants({ size: "icon-lg" })).split(/\s+/)).toEqual(
      expect.arrayContaining(["size-9", "max-md:size-11"]),
    );
  });

  test("slider: a 24px tall hit area (44px on touch) around a thin track, and a keyboard focus ring", () => {
    render(<Slider defaultValue={[50]} getAriaLabel={() => "Volume"} />);
    const control = document.querySelector('[data-slot="slider"] > div');
    expect(control).not.toBeNull();
    expect(classesOf(control!)).toEqual(
      expect.arrayContaining(["data-horizontal:min-h-6", "pointer-coarse:data-horizontal:min-h-11"]),
    );
    const thumb = document.querySelector('[data-slot="slider-thumb"]');
    expect(thumb).not.toBeNull();
    // Base UI focuses the thumb's nested range input, so the ring keys off `:has(:focus-visible)`.
    expect(thumb!.querySelector('input[type="range"]')).not.toBeNull();
    expect(classesOf(thumb!)).toEqual(
      expect.arrayContaining([
        "after:-inset-2",
        "pointer-coarse:after:-inset-4",
        "has-focus-visible:ring-2",
        "has-focus-visible:ring-offset-2",
      ]),
    );
  });

  test("ThemeToggle items are 40px below md", () => {
    render(<ThemeToggle value="dark" onValueChange={() => {}} />);
    for (const name of ["Dark", "Light", "System"]) {
      const button = screen.getByRole("button", { name });
      expect(classesOf(button)).toEqual(expect.arrayContaining(["max-md:h-10", "max-md:min-w-10"]));
    }
  });
});
