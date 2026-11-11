// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * The wave 2 cookie banner: a floating bottom-corner card (a bottom sheet in the gutter on phones,
 * above the tab bar), in the page flow on pages with a player; Accept and Decline weigh the same
 * and neither is the brand fill; non-modal, no focus taken, Escape hides it for the page view and
 * records nothing; the privacy link; and the UI counters.
 *
 * Layout is checked at 320, 375, 768 and 1440 px by resolving the banner's responsive classes at
 * each width the way Tailwind's min-width (`sm:`, `md:`, `lg:`) and `max-md:` variants do.
 */
import { LocaleProvider, TooltipProvider } from "@commonair/ui";
import { BREAKPOINTS, TAB_BAR_HEIGHT } from "@commonair/ui/layouts";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { locale, uiMessages } from "../src/i18n/index.ts";

const fake = vi.hoisted(() => ({
  get: vi.fn<(input: { kind: string }) => Promise<unknown>>(),
  consent: vi.fn<(input: unknown) => Promise<{ ok: true }>>(),
  track: vi.fn<(surface: string, action: string, step?: string) => void>(),
}));

vi.mock("../src/lib/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api.ts")>();
  const client = {
    legal: {
      get: (input: { kind: string }) => fake.get(input),
      consent: (input: unknown) => fake.consent(input),
    },
  };
  return { ...actual, api: () => client };
});

vi.mock("../src/lib/ui-metrics.ts", () => ({
  trackUi: (surface: string, action: string, step?: string) => fake.track(surface, action, step),
}));

vi.mock("@commonair/ui/toast", () => ({ toast: { success: () => {}, error: () => {} }, Toaster: () => null }));

const { ConsentRoot } = await import("../src/components/consent/consent-root.tsx");
const { ConsentBanner } = await import("../src/components/consent/consent-banner.tsx");
const { bannerLayout, placementClasses } = await import("../src/components/consent/banner-placement.ts");
const { CONSENT_COOKIE, resetConsentForTests } = await import("../src/lib/consent.ts");

const doc = (kind: string) => ({
  id: `doc-${kind}`,
  kind,
  version: kind === "privacy" ? "p3" : "v2",
  title: kind === "privacy" ? "Privacy policy" : "Cookie policy",
  body: `The ${kind} text.`,
  isDraft: false,
  requiresAcceptance: false,
  publishedAt: "2026-10-29T00:00:00.000Z",
});

const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });

function Page({ pathname = "/" }: { pathname?: string }) {
  return (
    <RouterContextProvider router={router}>
      <LocaleProvider locale={locale} messages={uiMessages}>
        <TooltipProvider>
          <ConsentRoot consent={null} signedIn={false} pathname={pathname} />
          <main tabIndex={-1}>
            <a href="/somewhere">Page content</a>
          </main>
        </TooltipProvider>
      </LocaleProvider>
    </RouterContextProvider>
  );
}

function clearCookies(): void {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; path=/; max-age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  }
}

beforeEach(() => {
  fake.get.mockReset().mockImplementation(async ({ kind }) => doc(kind));
  fake.consent.mockReset().mockResolvedValue({ ok: true });
  fake.track.mockReset();
  resetConsentForTests();
  clearCookies();
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

// --- resolving responsive classes at a width ------------------------------------------------

const MIN: Record<string, number> = { sm: BREAKPOINTS.sm, md: BREAKPOINTS.md, lg: BREAKPOINTS.lg };

/** The variant prefix (`md:`, `max-md:`) of a class, ignoring colons inside `[...]`. */
function split(cls: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] === "[") depth++;
    else if (cls[i] === "]") depth--;
    else if (cls[i] === ":" && depth === 0) {
      parts.push(cls.slice(start, i));
      start = i + 1;
    }
  }
  return { variants: parts, utility: cls.slice(start) };
}

/** The utilities that apply at `width`, in cascade order (base first, then each breakpoint up). */
function at(className: string, width: number): string[] {
  const ranked: { utility: string; rank: number }[] = [];
  for (const cls of className.split(/\s+/).filter(Boolean)) {
    const { variants, utility } = split(cls);
    let applies = true;
    let rank = 0;
    for (const v of variants) {
      if (v in MIN) {
        applies &&= width >= (MIN[v] ?? 0);
        rank = Math.max(rank, MIN[v] ?? 0);
      } else if (v.startsWith("max-") && v.slice(4) in MIN) applies &&= width < (MIN[v.slice(4)] ?? 0);
      else if (v === "motion-safe" || v === "dark") continue;
      else applies = false; // hover:, focus-visible: and the like: not layout at rest
    }
    if (applies) ranked.push({ utility, rank });
  }
  return ranked.sort((a, b) => a.rank - b.rank).map((r) => r.utility);
}

/** The winning utility of a property family (`bottom-`, `w-`), the last in cascade order. */
function winner(utilities: string[], test: (u: string) => boolean): string | undefined {
  return utilities.filter(test).at(-1);
}

const REM = 16;
const TAB_BAR_PX = TAB_BAR_HEIGHT; // `BottomTabBar`'s `h-14`, checked against its source below

function remOf(utility: string): number {
  const step = /-(\d+(?:\.\d+)?)$/.exec(utility);
  return step ? Number(step[1]) / 4 : Number.NaN;
}

describe("where the banner sits", () => {
  it("floats on browsing, settings and auth pages, above the tab bar only where the bar shows", () => {
    expect(bannerLayout("/")).toEqual({ placement: "floating", aboveTabBar: true });
    expect(bannerLayout("/directory")).toEqual({ placement: "floating", aboveTabBar: true });
    expect(bannerLayout("/search")).toEqual({ placement: "floating", aboveTabBar: true });
    expect(bannerLayout("/settings")).toEqual({ placement: "floating", aboveTabBar: false });
    expect(bannerLayout("/signin")).toEqual({ placement: "floating", aboveTabBar: false });
    expect(bannerLayout("/dmca")).toEqual({ placement: "floating", aboveTabBar: false });
  });

  it("goes in the page flow wherever a player can be on screen, so it never covers one", () => {
    for (const path of ["/demo_streamer", "/demo_streamer/vods/01a", "/demo_streamer/clips/01b", "/m/demo/abc"])
      expect(bannerLayout(path), path).toEqual({ placement: "inline", aboveTabBar: false });
    for (const path of ["/dashboard", "/rehearse"])
      expect(bannerLayout(path), path).toEqual({ placement: "inline", aboveTabBar: false });
    const inline = placementClasses({ placement: "inline", aboveTabBar: false }).split(/\s+/);
    for (const forbidden of ["fixed", "sticky", "absolute"]) expect(inline).not.toContain(forbidden);
  });

  it("checks its tab bar clearance against the bar's real height and stacking", () => {
    const source = readFileSync(
      join(import.meta.dirname, "../../../packages/ui/src/layouts/bottom-tab-bar.tsx"),
      "utf8",
    );
    expect(TAB_BAR_HEIGHT).toBe(14 * 4);
    expect(source).toContain('"grid h-14"');
    expect(source).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(source).toMatch(/fixed inset-x-0 bottom-0 z-30 .*md:hidden/);
  });

  const GUTTER = "bottom-safe-gutter";
  const ABOVE_BAR = "bottom-safe-tab-bar";
  const VIEWPORTS = [
    { width: 320, insetX: "inset-x-4", end: undefined, w: undefined, browseBottom: ABOVE_BAR, settingsBottom: GUTTER },
    { width: 375, insetX: "inset-x-4", end: undefined, w: undefined, browseBottom: ABOVE_BAR, settingsBottom: GUTTER },
    {
      width: 768,
      insetX: "inset-x-auto",
      end: "end-6",
      w: "w-96",
      browseBottom: "bottom-6",
      settingsBottom: "bottom-6",
    },
    {
      width: 1440,
      insetX: "inset-x-auto",
      end: "end-6",
      w: "w-96",
      browseBottom: "bottom-6",
      settingsBottom: "bottom-6",
    },
  ] as const;

  /** The card's horizontal extent in px at `width`, from its inset, end offset and width. */
  function extent(utilities: string[], width: number): { left: number; right: number } {
    const insetX = winner(utilities, (u) => u.startsWith("inset-x-")) ?? "";
    if (insetX !== "inset-x-auto") {
      const gutter = remOf(insetX) * REM;
      return { left: gutter, right: width - gutter };
    }
    const w = remOf(winner(utilities, (u) => u.startsWith("w-")) ?? "") * REM;
    // `max-w-viewport-6` (styles.css) caps the card at the viewport less both 24 px offsets.
    const capped = utilities.includes("max-w-viewport-6") ? Math.min(w, width - 3 * REM) : w;
    const end = remOf(winner(utilities, (u) => u.startsWith("end-")) ?? "") * REM;
    return { left: width - end - capped, right: width - end };
  }

  for (const vp of VIEWPORTS) {
    describe(`at ${vp.width} px`, () => {
      const browse = at(placementClasses(bannerLayout("/")), vp.width);
      const settings = at(placementClasses(bannerLayout("/settings")), vp.width);

      it("floats in its corner: a bottom sheet in the 16 px gutter below md, the end corner from md", () => {
        expect(browse).toContain("fixed");
        expect(winner(browse, (u) => u.startsWith("inset-x-"))).toBe(vp.insetX);
        expect(winner(browse, (u) => u.startsWith("end-"))).toBe(vp.end);
        expect(winner(browse, (u) => u.startsWith("w-"))).toBe(vp.w);
      });

      it("never overflows the viewport sideways", () => {
        for (const utilities of [browse, settings]) {
          const { left, right } = extent(utilities, vp.width);
          expect(left).toBeGreaterThanOrEqual(16);
          expect(right).toBeLessThanOrEqual(vp.width - 16);
          expect(right).toBeGreaterThan(left);
        }
      });

      it("clears the bottom tab bar where it shows (below md, browsing pages), the gutter elsewhere", () => {
        expect(winner(browse, (u) => u.startsWith("bottom-"))).toBe(vp.browseBottom);
        expect(winner(settings, (u) => u.startsWith("bottom-"))).toBe(vp.settingsBottom);
        // Over the bar (z-30), under dialogs (z-50).
        expect(winner(browse, (u) => u.startsWith("z-"))).toBe("z-40");
      });

      it("keeps the choices readable: one column on a narrow phone, labels that wrap", () => {
        render(<Page />);
        const grid = screen.getByTestId("consent-accept-all").parentElement;
        const cols = winner(at(grid?.className ?? "", vp.width), (u) => u.startsWith("grid-cols-"));
        expect(cols).toBe(vp.width < BREAKPOINTS.sm ? "grid-cols-1" : "grid-cols-2");
        for (const id of ["consent-accept-all", "consent-reject", "consent-customize"]) {
          const button = at(screen.getByTestId(id).className, vp.width);
          expect(winner(button, (u) => u.startsWith("whitespace-"))).toBe("whitespace-normal");
          expect(button).toContain("w-full");
          // 40 px touch targets below md.
          expect(winner(button, (u) => u.startsWith("min-h-"))).toBe(
            vp.width < BREAKPOINTS.md ? "min-h-10" : "min-h-8",
          );
        }
      });
    });
  }

  it("sits a full gutter above the tab bar's 56 px", () => {
    // The bar and the sheet both stand on the same safe-area inset, so the rem part is the gap.
    // Both are named utilities in styles.css (the source policy bans arbitrary calc() values).
    const css = readFileSync(join(import.meta.dirname, "../src/styles.css"), "utf8");
    const bottomRem = (utility: string) => {
      const m = new RegExp(
        `@utility ${utility} \\{\\s*bottom: calc\\(([\\d.]+)rem \\+ env\\(safe-area-inset-bottom\\)\\);`,
      ).exec(css);
      return m ? Number(m[1]) : Number.NaN;
    };
    expect(bottomRem(ABOVE_BAR) * REM).toBe(TAB_BAR_PX + 16);
    expect(bottomRem(GUTTER) * REM).toBe(16);
  });
});

describe("the banner", () => {
  it("renders the floating card on the raised surface, with the privacy link", () => {
    render(<Page />);
    const banner = screen.getByRole("region", { name: "Cookies and storage" });
    expect(banner.getAttribute("data-placement")).toBe("floating");
    expect(banner.getAttribute("data-above-tab-bar")).toBe("true");
    const classes = banner.className.split(/\s+/);
    for (const cls of ["bg-popover", "text-popover-foreground", "shadow-raised", "border"])
      expect(classes).toContain(cls);
    expect(screen.getByTestId("consent-privacy-link").textContent).toBe("Privacy policy");
  });

  it("renders in the page flow on a watch page", () => {
    render(<Page pathname="/demo_streamer" />);
    const banner = screen.getByTestId("consent-banner");
    expect(banner.getAttribute("data-placement")).toBe("inline");
    expect(banner.className.split(/\s+/)).not.toContain("fixed");
  });

  it("gives Accept and Decline equal weight, neither the brand fill", () => {
    render(<Page />);
    const accept = screen.getByTestId("consent-accept-all");
    const decline = screen.getByTestId("consent-reject");
    expect(accept.textContent).toBe("Accept");
    expect(decline.textContent).toBe("Decline non-essential");
    expect(accept.className).toBe(decline.className);
    expect(accept.getAttribute("data-choice-weight")).toBe("equal");
    expect(decline.getAttribute("data-choice-weight")).toBe("equal");
    const banner = screen.getByTestId("consent-banner");
    expect(banner.querySelector("[data-filled-cta]")).toBeNull();
    for (const button of banner.querySelectorAll("button")) expect(button.className).not.toMatch(/\bbg-brand\b/);
    // Choose is quieter than both, never louder.
    expect(screen.getByTestId("consent-customize").textContent).toBe("Choose");
    expect(screen.getByTestId("consent-customize").getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("is non-modal: no dialog role, no scroll lock, no focus taken on load, no inert page", async () => {
    render(<Page />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    const banner = screen.getByTestId("consent-banner");
    expect(banner.tagName).toBe("SECTION");
    expect(banner.getAttribute("role")).toBeNull();
    expect(banner.hasAttribute("aria-modal")).toBe(false);
    expect(banner.contains(document.activeElement)).toBe(false);
    expect(document.body.style.overflow).toBe("");
    expect(document.querySelector("main")?.hasAttribute("inert")).toBe(false);
    expect(document.querySelector("[aria-hidden='true'] main")).toBeNull();
  });

  it("animates only under motion-safe (reduced motion gets none)", () => {
    for (const path of ["/", "/demo_streamer"]) {
      render(<Page pathname={path} />);
      const classes = screen.getByTestId("consent-banner").className.split(/\s+/);
      const motion = classes.filter((cls) => /animate|fade-|slide-|zoom-|transition/.test(cls));
      expect(motion.length).toBeGreaterThan(0);
      expect(motion.filter((cls) => !cls.startsWith("motion-safe:"))).toEqual([]);
      cleanup();
    }
  });
});

describe("Escape", () => {
  it("from a banner button hides it for this page view, records nothing, and focus goes to the page", async () => {
    render(<Page />);
    await waitFor(() => expect(fake.get).toHaveBeenCalled());
    const accept = screen.getByTestId("consent-accept-all");
    accept.focus();
    fireEvent.keyDown(accept, { key: "Escape" });
    expect(screen.queryByTestId("consent-banner")).toBeNull();
    expect(document.activeElement).toBe(document.querySelector("main"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(fake.consent).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain(CONSENT_COOKIE);
    expect(fake.track).toHaveBeenCalledWith("consent.banner", "dismiss", undefined);
  });

  it("with nothing focused hides it too", () => {
    render(<Page />);
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("consent-banner")).toBeNull();
  });

  it("from elsewhere on the page leaves it alone (that Escape belongs to whatever has focus)", () => {
    render(<Page />);
    const link = screen.getByRole("link", { name: "Page content" });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.getByTestId("consent-banner")).toBeTruthy();
  });

  it("in the privacy dialog closes the dialog, not the banner", async () => {
    render(<Page />);
    fireEvent.click(screen.getByTestId("consent-privacy-link"));
    const dialog = await screen.findByTestId("consent-privacy-dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("consent-privacy-dialog")).toBeNull());
    expect(screen.getByTestId("consent-banner")).toBeTruthy();
  });

  it("lasts one page view: the next page asks again", () => {
    const { rerender } = render(<Page />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByTestId("consent-banner")).toBeNull();
    rerender(<Page pathname="/directory" />);
    expect(screen.getByTestId("consent-banner")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    rerender(<Page pathname="/" />);
    expect(screen.getByTestId("consent-banner")).toBeTruthy();
  });

  it("ignores other keys and an Escape something else already handled", () => {
    render(<Page />);
    fireEvent.keyDown(screen.getByTestId("consent-reject"), { key: "Enter" });
    fireEvent.keyDown(document.body, { key: "a" });
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    document.body.dispatchEvent(handled);
    expect(screen.getByTestId("consent-banner")).toBeTruthy();
  });
});

describe("the privacy link", () => {
  it("fetches the privacy policy only when opened, and shows it", async () => {
    render(<Page />);
    await waitFor(() => expect(fake.get).toHaveBeenCalledWith({ kind: "cookies" }));
    expect(fake.get).not.toHaveBeenCalledWith({ kind: "privacy" });
    fireEvent.click(screen.getByTestId("consent-privacy-link"));
    const dialog = await screen.findByTestId("consent-privacy-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("The privacy text."));
    expect(dialog.textContent).toContain("Version p3");
    expect(fake.get).toHaveBeenCalledWith({ kind: "privacy" });
  });

  it("says when it did not load, and Retry fetches again", async () => {
    let fail = true;
    fake.get.mockImplementation(async ({ kind }) => {
      if (kind === "privacy" && fail) throw new Error("down");
      return doc(kind);
    });
    render(<Page />);
    fireEvent.click(screen.getByTestId("consent-privacy-link"));
    const dialog = await screen.findByTestId("consent-privacy-dialog");
    await waitFor(() => expect(dialog.textContent).toContain("The privacy policy didn't load."));
    fail = false;
    fireEvent.click(screen.getByTestId("consent-privacy-retry"));
    await waitFor(() => expect(dialog.textContent).toContain("The privacy text."));
  });
});

describe("the UI counters", () => {
  it("counts a view when shown and each choice as a click", async () => {
    render(<Page />);
    expect(fake.track).toHaveBeenCalledWith("consent.banner", "view", undefined);
    fireEvent.click(screen.getByTestId("consent-customize"));
    expect(fake.track).toHaveBeenCalledWith("consent.banner", "click", "choose");
    expect(await screen.findByTestId("consent-dialog")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("consent-dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("consent-dialog")).toBeNull());
    fireEvent.click(screen.getByTestId("consent-reject"));
    expect(fake.track).toHaveBeenCalledWith("consent.banner", "click", "decline");
    await waitFor(() => expect(fake.consent).toHaveBeenCalledTimes(1));
  });

  it("counts Accept", () => {
    render(
      <LocaleProvider locale={locale} messages={uiMessages}>
        <ConsentBanner
          reason="none"
          layout={{ placement: "floating", aboveTabBar: false }}
          onAccept={() => {}}
          onReject={() => {}}
          onCustomize={() => {}}
          onDismiss={() => {}}
        />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByTestId("consent-accept-all"));
    expect(fake.track).toHaveBeenCalledWith("consent.banner", "click", "accept");
  });
});
