// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `e2e-basic` under the `en-XA` pseudo-locale (batch 5 decision (k)): every page it visits is
 * scanned for text that is not pseudo-localized, plus the `es` negotiation smoke step. A scenario
 * of its own because `full` runs each name once and `--set` applies to the whole run.
 * `--set locale=<tag>` still overrides the default.
 */
import { PSEUDO_LOCALE } from "../src/n2/pseudo-run.ts";
import { defineScenario, type ScenarioContext } from "../src/scenario.ts";
import e2eBasic from "./e2e-basic.ts";

/** The same context with `locale` defaulting to `en-XA`; everything else passes through. */
export function withPseudoLocale(ctx: ScenarioContext): ScenarioContext {
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "param")
        return (name: string, fallback: string) => target.param(name, name === "locale" ? PSEUDO_LOCALE : fallback);
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export default defineScenario({
  ...e2eBasic,
  name: "e2e-basic-en-xa",
  description: `${e2eBasic.description} — under the en-XA pseudo-locale, scanning every page for untranslated text`,
  run: (ctx) => e2eBasic.run(withPseudoLocale(ctx)),
});
