<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 3: E8, E9, N2-core and N2-consent

Batch 3 of [`.claude/briefs/next/README.md`](../next/README.md): E8 (interactivity and the
channel bot), E9 (the developer platform: OAuth, EventSub, the SDK), N2-core (the i18n
infrastructure) and N2-consent (the cookie consent UI, added 2026-10-29); the rest of N2 is a
later batch. Briefs: [`e8/`](../e8/), [`e9/`](../e9/),
[`n2/`](../n2/). Each milestone has a `contract-step.md` the orchestrator lands (one commit each,
in the order below) before wave 1.

## Gates

| Milestone  | Gated on                                               | State (2026-10-29)                                                 |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| E8         | ADR 0026 (interactivity policies)                      | accepted 2026-10-27                                                |
| E9         | ADR 0027 (OAuth and EventSub)                          | accepted 2026-10-27; SDK licence Apache-2.0 (ADR 0035, 2026-10-29) |
| N2-core    | ADR 0029 (i18n)                                        | accepted 2026-10-27                                                |
| N2-consent | the cookie policy (`packages/db/src/legal/cookies.md`) | user decision 2026-10-29: a consent banner joins batch 3 (wave 3)  |

The three ADRs were accepted with the orchestrator's recommended answers; the briefs and contract
steps match them.

## Decided 2026-10-29 (user)

Applied in the briefs and contract steps named; do not reopen them.

- **Legal seeds**: E8's step bumps the terms (`TERMS_SEED_VERSION`, no-cash-value clause) and the
  privacy policy (`PRIVACY_SEED_VERSION`, a channel-features paragraph), both drafts, counsel not
  reviewed (e8 §12). N2's step bumps `COOKIES_SEED_VERSION` in the same `index.ts` on top of E8's
  (n2 §6).
- **Consent UI**: new unit **N2-consent** in wave 3 (brief `n2/N2-consent.md`, branch
  `n2/consent`, namespace `n2-consent`, selectors `docs/testing/n2-selectors.md` from n2 §6.2).
- **Demo channels**: `points-accrue` skips demo channels and demo viewers, so `demo:clear` keeps
  working (E8-points; e8 §2.3, §2.5 export `anchoredUser`).
- **Channel bot tokens**: `me.bots.createToken` refuses the channel bot, `PRECONDITION_FAILED`
  `channel_bot` (e8 §2.5; no new error code).
- **SDK licence**: Apache-2.0 for `packages/sdk` only (ADR 0035; e9 §6.1, E9-sdk); the
  `actions/setup-node` SHA is filled in E9-sdk (v7.1.0).
- **Technical defaults** (e8 and e9 "Decided 2026-10-29" tables): goal progress in the outbox
  relay transaction (ADR 0026 Amendment 1); no per-channel accrual knobs; the channel bot is a
  moderator; goals count from zero at start; broadcaster and moderators cannot bet; raid countdown
  30 s; one viewer's concurrent sessions accrue once; the channel bot is pseudonymized with its
  owner; E9 revocation notices stay best effort after commit (ADR 0027 consequences);
  `developer.oauth.activation` is a POST with the code in the body; sign-up honours `returnTo`;
  a signed-in member who never chose a language keeps the footer cookie choice over
  Accept-Language (N2-core).

## Contract steps: the order the orchestrator lands them

One commit each on `main`, pushed, CI green before the next. Each is written on top of the one
before it (same shared files: `router.ts`, `entities.ts`, `enums.ts`, `events.ts`,
`internal.ts`, `env.ts`, `.env.example`, `main.ts`, `http.ts`, `jobs/index.ts`,
`account-deletion.ts`, `routes/me.ts`, the route tree, nav, `en.ts`, `HARNESS_OVERRIDES`,
`compose.multi-instance.yaml`, the selfhost `.keys` files, `bun.lock`); re-find anchors by their
quoted text, never by `c0c16fd` line numbers.

| #   | Step                         | Migration(s)                                   | Notes                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | [E8](../e8/contract-step.md) | `0033_e8_interactivity`, `0034_e8_protections` | `packages/interact`, `PluginHost` extension, `interactEnv`, `compose.e8.yaml`, `/interact` and `/bot` placeholders, inline `studio.*` keys, terms points clause and privacy paragraph (drafts), channel-bot token refusal, `anchoredUser` export                                                      |
| 2   | [E9](../e9/contract-step.md) | `0035_e9_developer_platform`                   | on top of E8: keeps E8's `interactHealth` check in `main.ts`, registers its jobs after E8's, adds deletion changes beside E8's channel-bot pseudonymization, `compose.e9.yaml` after `compose.e8.yaml`; SDK skeleton Apache-2.0 (`LICENSES/Apache-2.0.txt`, `REUSE.toml`, `check-licenses`), ADR 0035 |
| 3   | [N2](../n2/contract-step.md) | `0036_n2_users_locale`                         | appends only; `packages/i18n` scaffold; checks no new `users.locale` reader came in with E8/E9; `COOKIES_SEED_VERSION` on top of E8's `TERMS_SEED_VERSION` and `PRIVACY_SEED_VERSION` bumps; `n2-selectors.md` for N2-consent                                                                         |

Migration rule: each step takes one more than the highest file after the previous step; if a step
ends with a different count, the later ones shift and the orchestrator states the final numbers in
the base-sha message. Generate each on top of the previous snapshot, never in parallel.

## i18n namespaces

N2-core creates each of these five empty (`apps/web/src/i18n/locales/en/<name>.json` = `{}` and
`keys/<name>.gen.ts`) and registers it; no unit ever creates a namespace.

| Namespace    | Unit       | Wave | Key prefixes                                                                                         |
| ------------ | ---------- | ---- | ---------------------------------------------------------------------------------------------------- |
| `e8-studio`  | E8-studio  | 2    | `interact.`, `bot.`                                                                                  |
| `e8-viewer`  | E8-viewer  | 2    | `chatPoll.`, `chatPrediction.`, `chatPoints.`, `chatRaid.`, `raid.`, `overlayGoals.`, `overlayChat.` |
| `e9-consent` | E9-consent | 3    | `oauth.`                                                                                             |
| `e9-console` | E9-console | 3    | `developer.`                                                                                         |
| `n2-consent` | N2-consent | 3    | `consent.`                                                                                           |

No existing key uses these prefixes (checked at `c0c16fd`). The contract steps' inline keys
(`studio.interact`, `studio.bot`, `studio.developer`, `nav.connections`, `nav.adminApps`) go into
N2-core's `core` namespace. The one cross-namespace edit: E8-viewer deletes `overlay.goalsLater`
and `overlay.chatLater` from `ops` (N2-core's recipe rule 5 exception).

## Waves

At most six units at a time; two agents never write the same file at the same time.

| Wave | Units (parallel)                                                            | Starts from                                     | Why this order                                                                                                                                                                                                                                                                                                                                              |
| ---- | --------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | N2-core, E8-polls, E8-raids-goals, E8-points, E8-bot-engine, E8-bot-api (6) | the N2 contract step's sha (all three steps in) | the five E8 units write API, worker and chat code only, no web strings; N2-core is the only writer in `apps/web` and must merge before any unit writes web strings. No E9 unit: the six slots are taken and nothing in E9's API must precede E8                                                                                                             |
| 2    | E9-oauth, E9-apps, E9-subs, E9-ws, E8-studio, E8-viewer (6)                 | `main` after wave 1 merged (N2-core included)   | E8's web units write strings in N2-core's format and call wave-1 handlers; the four E9 API units need no web strings and are disjoint (E9-subs codes against E9-ws's `EventSubSessions` with a fake); E9-ws's step 5 needs E8-polls and E8-points                                                                                                           |
| 3    | E9-sdk, E9-consent, E9-console, N2-consent (4)                              | `main` after wave 2 merged                      | the web units drive real consent, grant, subscription and suspension endpoints; the SDK wraps merged endpoints and its harness step needs steps 4 and 5; E9-console's docs need wave 2's final messages; N2-consent needs N2-core's `rememberLocale` and namespace format, and owns the root, bootstrap, theme and footer parts no other wave-3 unit writes |

Between waves the orchestrator merges each unit, applies its contract requests, lifts the
harness steps whose units have all merged from the pending lists, pushes `main` and waits for CI.

## Path conflicts and how they are resolved

- **`apps/web/src/i18n/**`**: N2-core alone in wave 1. From wave 2 a unit writes only its own
  `locales/en/<namespace>.json` and `keys/<namespace>.gen.ts` (E8-viewer also the two `ops`
  deletions and `keys/ops.gen.ts`). If `bun run i18n:gen` changes `keys/index.gen.ts`, it is a
  contract request.
- **`apps/web/src/chat/events.ts`, `apps/web/tests/chat-events.test.ts`**: N2-core edits the gift
  plural (:94-95) and adds two cases in wave 1; E8-viewer adds the raid row and its cases in
  wave 2, on top.
- **`packages/ui/src`**: only new block directories this batch: E8-studio
  `blocks/interact-studio/**`, E8-viewer `blocks/interact-viewer/**` (strings as props, no
  `UiMessages` keys), stories and tests with distinct prefixes. N2-core's `logical-css.test.ts`
  holds new files at zero physical-direction classes unless marked `rtl-physical:` (E8-viewer's
  goal-bar fill). One more change, wave 3: N2-consent removes the unread `sidebar_state` cookie
  write from `components/sidebar.tsx` and updates its `DEVIATIONS.md` row. Nothing else in
  `packages/ui` changes (N2-ui later).
- **`__root.tsx`, `server/bootstrap.ts`, `lib/bootstrap-types.ts`, `altcha-field.tsx`**: N2-core
  (wave 1). Route tree, nav, `_studio.tsx`, `_admin.tsx`, `site-chrome.tsx`, `guard.ts`,
  `signin.tsx`, `signup.tsx`, `lib/auth.ts`, `resend-verification.tsx`: contract steps only; units
  fill their placeholder routes. **Wave 3 exception, N2-consent**: `__root.tsx` (theme setter and
  `<ConsentRoot />` only), `server/bootstrap.ts` and `lib/bootstrap-types.ts` (`consent` only),
  `lib/theme.ts`, and `InstanceFooter` in `site-chrome.tsx`; E9-consent and E9-console only read
  these. N2-consent also edits the `Bootstrap` fixtures in six web tests and `env.test.ts`'s
  theme assertions, which no other wave-3 unit touches.
- **`services/api`**: E8 units own `routes/{interact,bot}/*.ts` split files and their
  `services/api/src/<area>/**`; E9 units own `routes/developer/*.ts`, `oauth/**`, `eventsub/**`,
  `developer/{apps,subscriptions}/**`. Composers, `router.ts`, `http.ts`, `main.ts`, `lib/**`,
  `developer/{grants,webhook-queue}.ts`: orchestrator.
- **`services/worker`**: wave 1 E8 job files and `interact/<area>/**`, `exports/collectors.ts`
  (E8-points); wave 2 `jobs/oauth-expire.ts` (E9-oauth), `webhooks/**` and `jobs/webhook-*.ts`
  (E9-subs). `jobs/index.ts`, `outbox.ts`, `env.ts`, `deletion/**`: orchestrator.
- **`services/chat`**: E8-bot-engine owns `plugins/bot/**` (wave 1); everything else is the
  contract steps'. No E9 unit edits chat.
- **Harness**: units own `harness/src/e8/<their step>.ts` / `harness/src/e9/<their step>.ts` and
  their tests; `steps.ts`, `kit.ts`, `run.ts`, `selectors.ts`, `receiver.ts`, `ws-client.ts`,
  scenarios, `registry.ts`, `shards.ts`, compose overrides and CI are the orchestrator's.
  `sdk-bot.ts` and `harness/tests/bots.test.ts` (its parts): E9-sdk.
- **`docs/developers/**`**: E9-console, except `sdk.md` (E9-sdk); both wave 3; the orchestrator
  links `sdk.md` from the README after both merge. `docs/streamers/*.md`: one page per E8 unit.
- **E8's EventSub delivery check**: E8's scenarios assert outbox rows only; E9's
  `developer-platform` step 5 (E9-ws) now subscribes `channel.poll.begin` and
  `channel.points.change` over the WebSocket (step 2's grant adds `channel:manage:polls
  channel:read:points`). E9-sdk's step 6 "repeats 5" and may cover them too; not required.

## Shared rules

- Units are told "read and implement `<brief>`", one git worktree each, branch per brief:
  `n2/core`, `e8/polls`, `e8/raids-goals`, `e8/points`, `e8/bot-engine`, `e8/bot-api`,
  `e8/studio`, `e8/viewer`, `e9/oauth`, `e9/apps`, `e9/subs`, `e9/ws`, `e9/sdk`, `e9/consent`,
  `e9/console`, `n2/consent`. `git commit -s`, Conventional Commits, `Co-Authored-By` trailer.
- Pipeline per unit: implement → independent reviewer (diff vs AGENTS.md and the brief) → the
  implementer's fix pass.
- Units run targeted checks only (`.claude/briefs/_done-means.md` and each brief's "Done
  means"): their packages' tests, `tsc`, lint and format on their paths, `vp build` for web units.
  Never `bun run verify`, `verify:full`, `podman compose`, `scripts/infra.ts` or a harness
  scenario. **CI on `main` is the gate**; the orchestrator pushes `main` after each merged wave
  and fixes what CI reports. The user runs the scenarios and every browser and visual check.
- Contract requests (exact diffs) go to the orchestrator, applied at integration. No unit adds,
  renames or removes a route file, creates a namespace or edits a shared contract file.
- No new third-party dependency in this batch (`packages/i18n` and `packages/interact` have
  none; the SDK uses only catalog packages; N2-consent none). Anything else needs `vet-package` and a contract
  request.

## Milestone checks

- **E8** (e8/contract-step.md §17): no `notImplemented` under `routes/interact/` or `routes/bot/`;
  `interact` and `channel-bot` pass with no pending steps, in `FULL_REQUIRED` with `inFull` true
  and in the new `interact` shard (`shards.ts` and the CI matrix); the e8 selectors check in
  `apps/web/tests/selectors.test.ts`; `terms.md` carries the points clause and `privacy.md` the
  channel-features paragraph.
- **E9** (e9/contract-step.md §11): no `notImplemented` under `routes/developer/`;
  `developer-platform` (all eight steps via web; 1-2, 4-6, 8 via api) and `e2e-social` pass, and
  `developer-platform` is in `FULL_REQUIRED` (the `rest` shard); `packages/sdk` tests and licence
  test pass, Apache-2.0 (ADR 0035); `sdk-publish.yml` passes actionlint and zizmor; `docs/developers/` complete; the e9
  selectors check added.
- **N2-consent**: its web and `packages/ui` tests green; the n2 selectors check in
  `apps/web/tests/selectors.test.ts`; no Preferences cookie is written without consent (user
  check in a private window, N2-consent "Done means").
- **N2-core**: `i18n:check` clean, the i18n, runtime, SSR, negotiation, client and logical-CSS
  tests green; the equivalence check reports 0 mismatches; `e2e-basic` still passes in English;
  with `commonair-locale=en-XA` every visible string is bracketed and accented (user check). The
  N2 milestone gate (`e2e-basic` under `en-XA`) waits for the later N2 units.
- **End of batch**: CI green on `main` with every job, including the full harness shards.

## Open items

For the orchestrator:

- Create this file before wave 1 (done) and keep the namespace list in step with any brief change.
- The `actions/setup-node` SHA is filled (`949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0`,
  2026-10-29); recheck that no newer release older than 7 days exists before wave 3.
- Commit `docs/decisions/0035-sdk-license.md` and the ADR 0026/0027 edits with these briefs (or
  with the E9 step at the latest).
- After wave 3: link `sdk.md` from `docs/developers/README.md`, `docs/developers/` from
  `docs/README.md`; add the e8, e9 and n2 selectors checks; replace `apps/web/README.md:71` with
  N2-core's proposed text; apply E9-sdk's dual-licence request for the inlined contract files once
  the maintainer confirms it.

For the user:

- **SDK inlined contract files** (ADR 0035): confirm that the `@commonair/contracts` files the SDK
  bundle inlines become `AGPL-3.0-or-later OR Apache-2.0`, so the published bundle is Apache-2.0.
  Needed before the first publish, not before wave 3.
- **npm**: create the `@commonair` organisation and the trusted-publisher link before any SDK
  publish.
- Counsel: the terms points clause and the privacy channel-features paragraph (E8) and the cookie
  policy language paragraph (N2) are drafts.
