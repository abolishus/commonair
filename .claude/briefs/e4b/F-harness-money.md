<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit F, harness-money** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full (especially "The `e4b-money` scenario"), the harness
README and the E2/E3 scenarios (`harness/scenarios/e2e-social.ts`, `e2e-relay.ts`) and
`harness/src/social.ts` for the web/API actor pattern. Do not look outside the repository.

## You own (write only these)

- `harness/scenarios/e4b-money.ts` (new), `harness/src/money*.ts` (new), `harness/src/web/selectors.ts`
  (add the E4b ids), `harness/src/env.ts` (add `DATABASE_URL` as optional for the scenario's DB
  steps), `harness/tests/money*.test.ts`, `harness/tests/web.test.ts` (parse
  `docs/testing/e4b-selectors.md` like the e2/e3 docs), `harness/README.md` (the scenario's
  section)

## Contracts you must honor (read-only for you)

- The spec: routes, test ids, the payment flow and the nine scenario steps.
- `money.*`, `money.treasurer.*`, `coop.transparency` (oRPC/OpenAPI, for `--set via=api` and for
  reading state), `MANUAL_REFERENCE_PATTERN`, `MONEY_LIMITS`, `platform.cut` from `money.support`.
- The operator role CLI: `bun packages/db/src/roles/cli.ts <username> treasurer` with
  `DATABASE_URL` (spawn it with the harness process helpers; it exits 0 on success). The
  `@commonair/db` workspace dependency is available for step 9 (`createDb`, `schema`).
- The web app and API are being built in parallel (units A–E). Code against the spec and the
  contract types; your unit tests cover the pure parts.

## Build

1. `e4b-money` scenario (`needs`: `api`, `web`, `chat`, `worker`; not `stripe`; `inFull: true`)
   with the spec's nine steps, a web path (Playwright, by test id only) and `--set via=api`
   (same steps through the API and the chat socket). Fail fast with a clear message when
   `DATABASE_URL` is missing or `money.support` reports `provider: "stripe"`.
2. Expected numbers are computed, not hard-coded: from the tier prices the scenario sets, the
   `split` from `money.support` and the ledger's rounding rule (creator share =
   `floor(net × streamerShare)` in integer arithmetic on cents — implement it in
   `src/money.ts` with BigInt/millionths like `@commonair/ledger` does, and unit-test it against
   the ledger README's examples). Assert every `data-cents` the spec lists for steps 5–8.
3. Chat events: observe `chat-event` rows in the web path and `op: "event"` frames in the API
   path (`harness/src/chat-client.ts`); the subscriber badge on A's next message.
4. Step 9: with `DATABASE_URL`, sum `ledger_entries` per transaction for the transactions whose
   `ref_id` is one of the scenario's payment ids or dispute ids; every sum is 0. Read-only.
5. Waits use `harness/src/wait.ts` with explicit budgets; the report lists each step's timing and
   the money figures checked.
6. README: what it covers, the env it needs, the exact commands.

## Tests you must add

- Unit: the split/expected-figures calculator (rounding edge cases: odd cents, 0 tax, 90/10 and
  70/30 cuts, refunds in slices summing exactly), reference parsing, selectors match the e4b doc
  (in `tests/web.test.ts`), argument parsing for `via`.

## Done means

See `_common.md` "Done means". Your package: `harness` (`bun run test`, `tsc`), lint/fmt on
changed paths. Never run the scenario: the user does. Give the exact commands in your final
message.
