// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

/**
 * F2 on the discovery pages: a loader that hit a busy, unreachable or broken API answers
 * `{ status: "failed" }`, and the page shows the section that did not load with a Retry (which
 * reloads the route's data) instead of hiding the shelf or claiming there is nothing.
 */
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CategoryLoadFailed } from "../src/components/discovery/category-page.tsx";
import { loaderFailed, loaderOk } from "../src/components/discovery/loaders.ts";
import { Directory } from "../src/components/directory.tsx";
import { en } from "../src/i18n/en.ts";
import { ART, category, live, renderInRouter } from "./d1-fixtures.tsx";

afterEach(cleanup);

const retryOf = (el: HTMLElement) => within(el).getByRole("button", { name: en["fixSession.retry"] });

describe("the discovery loaders' results", () => {
  it("ok carries the data", () => {
    expect(loaderOk([1, 2])).toEqual({ status: "ok", data: [1, 2] });
  });

  it("a 429 keeps the server's retry hint", () => {
    const busy = Object.assign(new Error("busy"), {
      code: "RATE_LIMITED",
      status: 429,
      data: { retryAfterSeconds: 7 },
    });
    expect(loaderFailed(busy)).toEqual({ status: "failed", retryAfterSeconds: 7 });
  });

  it("a 503, a network failure or a bug has no hint", () => {
    expect(loaderFailed(Object.assign(new Error("down"), { status: 503 }))).toEqual({
      status: "failed",
      retryAfterSeconds: null,
    });
    expect(loaderFailed(new TypeError("fetch failed"))).toEqual({ status: "failed", retryAfterSeconds: null });
    expect(loaderFailed(new Error("bug"))).toEqual({ status: "failed", retryAfterSeconds: null });
  });
});

describe("the home Categories shelf", () => {
  it("says it did not load, with Retry that reloads the route, beside the shelves that did", async () => {
    const { router } = await renderInRouter(
      <Directory sections={[{ id: "live", cards: [live("l1")] }]} categories={[]} categoriesFailed />,
    );
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    const error = screen.getByTestId("home-categories-load-error");
    expect(error.textContent).toContain(
      en["fixSession.load.title"].replace("{section}", en["discovery.home.categories"]),
    );
    expect(error.textContent).toContain(en["fixSession.load.sectionBody"]);
    expect(screen.queryByTestId("home-categories-shelf")).toBeNull();
    expect(screen.getAllByTestId("directory-section")).toHaveLength(1);
    fireEvent.click(retryOf(error));
    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("loaded categories are the shelf, with no error", async () => {
    await renderInRouter(
      <Directory sections={[{ id: "live", cards: [live("l1")] }]} categories={[category(ART, 2)]} />,
    );
    expect(screen.getByTestId("home-categories-shelf")).toBeTruthy();
    expect(screen.queryByTestId("home-categories-load-error")).toBeNull();
  });
});

describe("a category page that did not load", () => {
  it("names its live channels as what did not load, with Retry", async () => {
    const { router } = await renderInRouter(<CategoryLoadFailed />, "/directory/art");
    const invalidate = vi.spyOn(router, "invalidate").mockResolvedValue(undefined);
    const error = screen.getByTestId("category-load-error");
    expect(error.textContent).toContain(
      en["fixSession.load.title"].replace("{section}", en["discovery.category.tabLive"]),
    );
    expect(error.textContent).toContain(en["fixSession.load.pageBody"]);
    fireEvent.click(retryOf(error));
    expect(invalidate).toHaveBeenCalledOnce();
  });
});
