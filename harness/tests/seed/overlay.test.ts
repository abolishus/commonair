// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The full-coverage seed's compose override (harness/compose.seed.yaml, `stack --seed`): what it
 * turns on, that payments reach only the local stripe-mock, that it commits no secret, and that
 * the `multi` replicas (which share the queues) get the same values.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import { InfraCostModel } from "../../../packages/config/src/env.ts";
import { SEED_ENV_KEYS, SEED_OVERRIDE } from "../../../scripts/infra.ts";
import { E5_GOVERNANCE_BOOTSTRAP, SEED_GOVERNANCE_BOOTSTRAP, preflightGovernance } from "../../src/coop.ts";
import { REPLICAS } from "../../src/multi/replicas.ts";

type Env = Record<string, string>;
type ComposeFile = { services?: Record<string, { environment?: Env; profiles?: string[] }> };

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const load = (p: string) => Bun.YAML.parse(readFileSync(root(p), "utf8")) as ComposeFile;
const seed = load(SEED_OVERRIDE).services ?? {};
const env = (svc: string): Env => seed[svc]?.environment ?? {};
const compose = load("compose.yaml").services ?? {};
const exampleKeys = new Set(
  [...readFileSync(root(".env.example"), "utf8").matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
);

describe("harness/compose.seed.yaml", () => {
  test("sets only known variables on known services", () => {
    for (const [name, svc] of Object.entries(seed)) {
      const original = REPLICAS.find((r) => r.replica === name)?.service ?? name;
      expect(Object.keys(compose), name).toContain(original);
      for (const key of Object.keys(svc.environment ?? {})) expect(exampleKeys.has(key), `${name}: ${key}`).toBe(true);
    }
  });

  test("every replica gets exactly its original's values", () => {
    for (const spec of REPLICAS) expect(env(spec.replica), spec.replica).toEqual(env(spec.service));
  });

  test("points accrue on demo accounts: DEMO_SEED_FULL on the worker only", () => {
    expect(env("worker").DEMO_SEED_FULL).toBe("true");
    expect(env("api").DEMO_SEED_FULL).toBeUndefined();
  });

  test("payments go through Stripe's API to the local stripe-mock, never Stripe", () => {
    for (const svc of ["api", "worker"]) {
      const e = env(svc);
      expect(e.PAYMENTS_PROVIDER, svc).toBe("stripe");
      expect(e.STRIPE_API_BASE, svc).toBe("http://stripe-mock:12111");
      // stripe-mock answers 401 to a key with anything but letters and digits after `sk_test_`.
      expect(e.STRIPE_SECRET_KEY, svc).toMatch(/^sk_test_[A-Za-z0-9]+$/);
    }
    expect(compose["stripe-mock"]?.profiles).toEqual(["stripe"]);
  });

  test("commits no generated secret: those come from .env (init-env --merge --seed)", () => {
    for (const svc of Object.keys(seed))
      for (const key of [...SEED_ENV_KEYS, "STRIPE_CONNECT_WEBHOOK_SECRET"])
        expect(env(svc)[key], `${svc}: ${key}`).toBeUndefined();
  });

  test("a valid cost model that charges for every source a seeded broadcast uses", () => {
    for (const svc of ["api", "worker"]) {
      const model = InfraCostModel.parse(JSON.parse(env(svc).INFRA_COST_MODEL ?? "null"));
      expect(model.centsPerGb.origin ?? 0, svc).toBeGreaterThan(0);
      expect(model.centsPerGb.cdn ?? 0, svc).toBeGreaterThan(0);
    }
  });

  test("migrate's GOVERNANCE_BOOTSTRAP_JSON is exactly SEED_GOVERNANCE_BOOTSTRAP", () => {
    const raw = env("migrate").GOVERNANCE_BOOTSTRAP_JSON;
    expect(typeof raw).toBe("string");
    expect(Bun.deepEquals(JSON.parse(String(raw)), SEED_GOVERNANCE_BOOTSTRAP)).toBe(true);
    expect(Object.keys(env("migrate"))).toEqual(["GOVERNANCE_BOOTSTRAP_JSON"]);
  });

  test("the seed bootstrap is E5's with shorter periods only, and still passes seed-coop's preflight", () => {
    const {
      "governance.ordinary": ordinary,
      "governance.protections": protections,
      ...rest
    } = SEED_GOVERNANCE_BOOTSTRAP;
    const {
      "governance.ordinary": e5Ordinary,
      "governance.protections": e5Protections,
      ...e5Rest
    } = E5_GOVERNANCE_BOOTSTRAP;
    expect(rest).toEqual(e5Rest);
    expect(ordinary).toEqual({ ...e5Ordinary, discussionSeconds: 20, minVotingSeconds: 30, votingSeconds: 30 });
    expect(protections).toEqual({ ...e5Protections, councilReviewSeconds: 20, minVotingSeconds: 30 });
    // The database refuses votingSeconds below minVotingSeconds (0002_protections_hardening.sql).
    expect(ordinary.votingSeconds).toBeGreaterThanOrEqual(ordinary.minVotingSeconds);
    const settings = Object.entries(SEED_GOVERNANCE_BOOTSTRAP).map(([key, value]) => ({
      key,
      value: value as unknown,
    }));
    expect(preflightGovernance(settings)).toEqual({ ok: true, problem: null });
  });
});
