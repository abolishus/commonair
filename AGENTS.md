<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# AGENTS.md

Engineering rules for everyone who changes this repository: human contributors, AI agents,
and the subagents they brief. Read [PLAN.md](PLAN.md) and [PROGRESS.md](PROGRESS.md) first;
they are the source of truth across sessions. Architecture: [docs/architecture.md](docs/architecture.md).

## Non-negotiables

1. **FOSS first.** AGPL-3.0-or-later code, CC-BY-SA-4.0 docs, CC0-1.0 for trivial config. Every
   file carries an SPDX header (or a `REUSE.toml` annotation if it cannot). `reuse lint` passes.
2. **OSI licenses only** for dependencies. `bun scripts/check-licenses.ts` enforces it for npm
   packages, container images (`infra/image-licenses.json`) and Go modules
   (`relay/module-licenses.json`). Verify a new dependency's license from its repository at the
   pinned version, and record judgment calls in `docs/decisions/`.
3. **Proprietary services are optional adapters** with a FOSS default. The platform and the
   harness must run with no Stripe, no OAuth providers, no CDN.
4. **No third-party client-side code.** No analytics, trackers, font CDNs or remote scripts.
   All assets are bundled and self-hosted.
5. **Identity lives in one place.** The name, domain and contact addresses come from
   `@commonair/config/site` (`SITE`) or the instance env (`instanceSite()`). `check-domains`
   fails on stray literals.
6. **No secrets in git.** `.env.example` is the only env file committed. Generate a local `.env`
   with `bun scripts/init-env.ts`.
7. **Vet, cool down, pin, audit** (ADR 0022). Before adding or upgrading any dependency run
   `bun scripts/vet-package.ts <name>[@version]` and read every warning. Nothing younger than
   7 days (`bunfig.toml` `minimumReleaseAge`); exact versions only; no install scripts unless
   listed in `supply-chain.json`; Actions pinned to commit SHAs; third-party images pinned as
   `name:tag@sha256:…` (`bun scripts/pin-images.ts --write`). `bun audit` and govulncheck must be
   clean, apart from dated exceptions with reasons in `supply-chain.json`.
8. **Nothing is committed red.** Run `bun run verify` before every commit.
9. **Integrity is enforced at the lowest layer that can enforce it.** Ledger append-only and
   balance, governance protections, vote rules: database triggers (`packages/db/drizzle/0001_protections.sql`).
   Application checks are in addition to, never instead of, those.

## Commands

| Command                                                 | What it does                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install`                                           | Install all workspaces (Bun isolated linker)                                                                                          |
| `bun scripts/init-env.ts`                               | Write `.env` with fresh random secrets (never overwrites)                                                                             |
| `bun scripts/infra.ts test`                             | Start Postgres, Valkey, Mailpit (and Garage) under Podman, wait for health                                                            |
| `bun run verify`                                        | **The gate**: format → lint → typecheck → unit → infra → migrations → integration → licenses → supply chain → domains → reuse → relay |
| `bun scripts/vet-package.ts <name>[@ver]`               | Vet a package **before** `bun add`: age, advisories, license, install scripts, provenance, publisher                                  |
| `bun scripts/pin-images.ts [--write]`                   | Report (or write) digest pins for every third-party container image                                                                   |
| `bun run verify --quick`                                | Same without integration tests (inner loop only, never the commit gate)                                                               |
| `bun run verify --only static,unit`                     | Only those step groups (static, unit, integration, relay, harness); CI runs one job per group                                         |
| `bun run verify --scenario <name>`                      | Gate plus a named harness scenario                                                                                                    |
| `bun run verify:full`                                   | Gate plus the full harness scenario (end of every phase)                                                                              |
| `vp fmt`                                                | Format everything (Oxfmt)                                                                                                             |
| `vp lint --deny-warnings`                               | Lint with type-aware rules (Oxlint)                                                                                                   |
| `vp run -r test` / `vp run -r test:int`                 | Unit / integration tests in every workspace                                                                                           |
| `bun run --filter @commonair/db generate --name <name>` | Generate a named migration from schema changes                                                                                        |
| `podman compose up`                                     | The whole platform                                                                                                                    |
| `bun harness/src/cli.ts run <scenario>`                 | One harness scenario against the running stack                                                                                        |

Tests run under the Bun runtime (`bun --bun vp test run`), so services can use `Bun.*` APIs in
code under test. Unit test files are `*.test.ts`; integration tests are `*.int.test.ts` and may
assume the infra services are up (`DATABASE_URL`, `VALKEY_URL`, …, with the `.env.example` defaults).

## Repository map and ownership

| Path                                                      | Owner unit                | Notes                                                                                                          |
| --------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/config`                                         | orchestrator              | `SITE`, env schemas. Add env vars here **and** in `.env.example` (a test enforces sync)                        |
| `packages/contracts`                                      | orchestrator              | Zod schemas, oRPC contract, events, chat protocol, scopes. Changing it is a contract change: orchestrator only |
| `packages/db`                                             | orchestrator              | Drizzle schema + migrations. Schema changes go through the orchestrator                                        |
| `packages/tokens`                                         | orchestrator              | Token/receipt crypto and `vectors.json`                                                                        |
| `packages/<lib>`                                          | the unit named in PLAN.md | One unit per package                                                                                           |
| `services/<svc>`, `apps/web`, `relay`, `harness`, `infra` | the unit named in PLAN.md |                                                                                                                |

**File-ownership rules for parallel work**

- Two agents never write the same file at the same time. Each brief lists the paths the agent
  owns; it may read anything but write only those.
- Need a change outside your paths (a contract field, a migration, a shared component)? Do not
  make it. Report it as a **contract request** in your final message, with the exact change.
- New or upgraded dependencies need a passing `bun scripts/vet-package.ts` first; paste its
  output (with any warnings you accepted, and why) in your final message.
- Shared lockfile: run `bun install` only when your brief allows adding dependencies, and add
  them to your own package's `package.json` with exact versions via the root `catalog` only if
  another package already uses them. The orchestrator reconciles `bun.lock` at integration.
- If you work in an isolated git worktree, commit there; the orchestrator merges locally.

## Code style

- TypeScript strict everywhere except the relay (Go). No `any`; no non-null assertions in
  production code paths unless the invariant is commented; tests may use them.
- ES modules, `.ts` import suffixes (`allowImportingTsExtensions`), `verbatimModuleSyntax`.
- Validate at boundaries with the Zod schemas from `@commonair/contracts`. Never trust a client.
- Errors: throw `ORPCError` codes from the contract in API handlers; never leak stack traces or
  SQL to clients. Log with the shared logger (`@commonair/observability`), structured fields, no
  PII (no emails, IPs or tokens in logs — hash or omit).
- Money is integer cents (`bigint` in the DB, `number` in TS) with an explicit currency. Never floats.
- Time is UTC `timestamptz`; ISO 8601 with offset on the wire.
- IDs are UUIDv7 minted by `uuidv7()` from `@commonair/db`.
- Every database write that has a side effect for other systems writes an `events` outbox row in
  the same transaction.
- Every moderator, admin, integrity and governance action writes an `audit_log` row.
- Never write personal data (emails, names, IPs, free text from users) into append-only columns
  (ledger descriptions/memos/metadata, audit `details`, history tables). Reference users by id, so
  account deletion can pseudonymize without rewriting history (ADR 0004).
- The app connects to Postgres as a non-owner role; never rely on application checks alone for
  ledger or governance rules (ADR 0004).
- Comments explain _why_, not _what_. Keep them short.
- User-facing strings go through the i18n message catalog (`t("key")`), never inline literals,
  so the UI is translation-ready.

## Testing

- Every change ships with tests. Pure logic: exhaustive unit tests including edge cases
  (rounding, caps, empty sets, boundaries). Anything touching Postgres/Valkey/S3: integration
  tests with `createTestDatabase()` (one throwaway database per test file).
- Harness scenarios (`harness/scenarios/*`) exercise features end to end against the running
  stack; each is individually runnable.
- Do not mock what you can run: use the real Postgres, Valkey, MediaMTX, Mailpit, stripe-mock.

## Design rules (web)

- shadcn/ui on **Base UI** (style `base-lyra`, base color zinc, CSS variables), Hugeicons, Rubik
  only (`--font-sans` = `--font-display` = Rubik, self-hosted via `@fontsource-variable/rubik`).
- Add components with the shadcn CLI so they stay upgradeable.
- Colors only as CSS variable tokens; never hex in components. Dark mode first, full light theme.
- Never `alert/confirm/prompt` or native `title` tooltips: use `Dialog`/`AlertDialog`/`Tooltip`.
- Accessible by default: keyboard navigation, visible focus, WCAG AA, `prefers-reduced-motion`.
- Responsive to 320px with a 16px gutter and no horizontal scroll.

### House primitives: use X, not Y

| Use                                  | Not                                   | For                                     |
| ------------------------------------ | ------------------------------------- | --------------------------------------- |
| `<StreamCard>`                       | ad-hoc cards                          | any live stream tile                    |
| `<ChannelAvatar>`                    | `<img>` / raw `Avatar`                | user/channel avatars (initial fallback) |
| `<LiveBadge>`                        | text "LIVE"                           | live indicators                         |
| `<ViewerCount>`                      | formatting numbers inline             | viewer counts (verified only)           |
| `<RelativeTime>`                     | `toLocaleString`, date libs inline    | timestamps                              |
| `<MoneyAmount>` / `formatMoney()`    | `toFixed(2)`, `Intl` inline           | currency                                |
| `<EmptyState>`                       | blank screens                         | empty lists                             |
| `<Skeleton*>`                        | spinners for layout                   | loading states                          |
| `<IconButton tooltip>`               | icon buttons without labels, `title=` | icon-only controls                      |
| `toast.*` from `@commonair/ui/toast` | importing `sonner` directly           | notifications                           |
| `<ConfirmDialog>`                    | `window.confirm`                      | destructive confirmation                |

## Subagent briefing template

Every subagent brief must be self-contained. Copy this and fill it in:

```
You are implementing <unit> for CommonAir (repo: /Users/…/bcon). Read AGENTS.md, PLAN.md, and
docs/architecture.md first. Do not look outside the repository.

## You own (write only these)
- <paths>

## Contracts you must honor (read-only for you)
- <packages/contracts files / db tables / env vars / events>

## Build
- <features, behaviors, edge cases>

## Tests you must add
- <unit tests>, <integration tests>, <harness scenario if any>

## Done means
- `bun run verify` passes (or, if other units are mid-flight, `bun run verify --quick` plus your
  package's `test:int`), with your tests included.
- No files outside your ownership list changed (`git status` shows only your paths).
- Final message: what you built, test counts, any contract requests (exact changes needed in
  files you do not own), and anything left undone. Do not commit unless told to.
```

## Commits

Conventional Commits with DCO sign-off (`git commit -s`). Small, focused commits; the
orchestrator commits after verify is green and a reviewer subagent has checked the diff against
this file. Push `main` at verified milestones.
