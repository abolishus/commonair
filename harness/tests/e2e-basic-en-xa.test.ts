// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import e2eBasic from "../scenarios/e2e-basic.ts";
import variant, { withPseudoLocale } from "../scenarios/e2e-basic-en-xa.ts";
import type { ScenarioContext } from "../src/scenario.ts";

class FakeContext {
  constructor(private readonly params: Record<string, string>) {}
  param(name: string, fallback: string): string {
    return this.params[name] ?? fallback;
  }
  label(): string {
    return `params:${Object.keys(this.params).length}`;
  }
}

const ctx = (params: Record<string, string> = {}) => new FakeContext(params) as unknown as ScenarioContext;

describe("e2e-basic-en-xa", () => {
  it("is e2e-basic under its own name, with the same needs and deadline", () => {
    expect(variant.name).toBe("e2e-basic-en-xa");
    expect(variant.needs).toEqual(e2eBasic.needs);
    expect(variant.timeoutMs).toBe(e2eBasic.timeoutMs);
  });

  it("defaults locale to en-XA, keeps an explicit --set locale, and passes other params through", () => {
    expect(withPseudoLocale(ctx()).param("locale", "")).toBe("en-XA");
    expect(withPseudoLocale(ctx({ locale: "es" })).param("locale", "")).toBe("es");
    expect(withPseudoLocale(ctx()).param("other", "x")).toBe("x");
    expect(withPseudoLocale(ctx({ other: "y" })).param("other", "x")).toBe("y");
  });

  it("keeps the context's own methods bound to it", () => {
    const wrapped = withPseudoLocale(ctx({ a: "1" })) as unknown as FakeContext;
    // The point is calling it detached from the proxy, as destructuring callers do.
    // oxlint-disable-next-line typescript/unbound-method
    const { label } = wrapped;
    expect(label()).toBe("params:1");
  });
});
