<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# HANDOFF — for the next head agent

Written 2026-10-18, updated at the end of orchestration session four (E3 finished). Read this, then
[AGENTS.md](AGENTS.md), [PLAN.md](PLAN.md) ("Milestones — end-to-end vertical slices"),
[PROGRESS.md](PROGRESS.md), [docs/architecture.md](docs/architecture.md), ADRs 0001–0004 in
`docs/decisions/`, [docs/testing/e1-selectors.md](docs/testing/e1-selectors.md),
[docs/testing/e2-selectors.md](docs/testing/e2-selectors.md),
[docs/testing/e3-selectors.md](docs/testing/e3-selectors.md), ADR 0005 (P2P tracker) and
[docs/deploy/railway.md](docs/deploy/railway.md). The original constraints still apply: FOSS-first,
Podman, local-first on `main`, DCO sign-off, subagent pods with disjoint ownership (≤ ~6 at once),
an independent reviewer **before** every merge and a focused re-review of fix rounds for any HIGH.

## Session eight in flight (E4c trust & safety)

Started 2026-10-20 from `468f4f0`. Prompt: slice E4c (PLAN.md row E4c, ADR 0006): T0 hash match,
T1/T2 classifier tiers, legal holds, NCMEC drafts, NCII 48-hour clock, upload scanning, mod
queue/appeals/NCII UI, harness `trust-safety`. Reviews are **harder than E4b**: an independent
reviewer before every merge, a focused re-review after any HIGH fix, and a second,
security-focused reviewer for the T0 path, holds, deletion, evidence storage and the NCII clock,
even when the first finds no HIGH. Losing evidence, skipping a T0 action, showing T0 material
outside the `legal` role, or switching the pipeline off counts as HIGH. The user said to **skip
the E4b validations for now** and finish E4c first. Safety rules (every brief repeats them): never
obtain, generate, describe or handle real CSAM/NCII; synthetic geometric fixtures only;
no industry hash lists; logs carry ids, categories and scores only.

Step 1 (done): ADR 0006 "Resolution of the open questions" and ADR 0008 (licenses), both
**accepted 2026-10-20**, with the user's four policy decisions recorded in ADR 0006. Found in the
code: the hash matcher is a no-op by default (SHA-256 `stub` only), quarantine moves evidence
inside the media bucket with media's own credentials, `legal_holds` had no triggers and no users,
uploads are presigned straight to public keys. Also: **reports, the mod queue, suspension, the
audit log, data export and account deletion are 501 stubs** in the API (only schema exists), and
there is **no 18+ gate on the channel page or playback** (only the directory filters mature).
E4c builds account deletion (the scenario needs it) and the playback/page gate. Garage v2.4.1
cannot deny delete to a writing key, so evidence images go into an append-only, sealed Postgres
table and large media into an evidence bucket only the worker can reach (ADR 0006 Q4).

### Step 2, head-agent contract step (done)

Done and committed (`3d51fbc`, all on local `main`, **not pushed**):

- `docs/testing/e4c-selectors.md`: **the spec** (safety rules, tiers/thresholds, flow table,
  routes, test ids, `trust-safety` scenario steps, test hooks). Read it in full first.
- Enums (`packages/contracts/src/enums.ts`): `legal` platform role, `MODERATION_*`,
  `HASH_LIST_CATEGORIES`, `CONTENT_LABELS`, `LEGAL_HOLD_REASONS`, `EVIDENCE_*`,
  `NCMEC_REPORT_STATUSES`, `NCII_*`; appeal subjects `content_label`/`moderation_case`; report
  reason `ncii`; mod actions `end_stream`/`warn`.
- DB: `packages/db/src/schema/moderation.ts` (+ `legal_holds` columns in `safety.ts`,
  `broadcasts.restricted_at/restricted_case_id`), migrations `0015_trust_safety.sql` and
  `0016_trust_safety_protections.sql` (all triggers; header comment lists them; it also
  `CREATE OR REPLACE`s `commonair_settings_guard` and `commonair_configure_app_role` from 0002 with
  additions only). `moderation.thresholds` governance seed. Tests:
  `packages/db/tests/trust-safety.int.test.ts` (32) + `holds.test.ts` (5); all db tests pass
  (int 84, unit 22), tsc clean.
- Operator hold CLI: `bun run --filter @commonair/db hold -- list | release <id> --reason <text>`
  (owner `DATABASE_URL` only; the trigger refuses the app role).
- Stopgap in `services/api/src/routes/appeals.ts`: the two new appeal subjects are refused
  (`UNWIRED_SUBJECTS`) until the API unit wires them.
- tsc clean in contracts, api, worker, chat, media, web, ui, harness after these changes.

Done in the second sitting (2026-10-20, all on local `main`, **not pushed**; each commit had its
targeted checks pass: tsc, unit tests, lint/fmt of the touched files):

- `7501bb9` **contracts**: `EventDef.internal`; internal events `moderation.flagged`,
  `moderation.case.resolved`, `moderation.restriction`, `ncii.request.received`,
  `ncii.request.decided`, `legal.hold.placed`, `ncmec.draft.created` (ids/enums only);
  `PUBLIC_EVENT_TYPES`/`isInternalEvent`; `SubscriptionEnvelope`, `WsMetadata`, `BusEvent` and the
  EventSub router inputs accept public types only. `internal.ts`: `QUEUES.moderation`,
  `MODERATION_JOBS`, `MODERATION_FRAME_TTL_SECONDS`, `KEYS.moderationFrame/moderationScript`,
  `ModerationScores` (unscored = absent), `ModerationScanJob`, `SealedEvidence`, `ModerationT0Job`
  (+ `t0JobId`), `ModerationT0MediaJob`, `ModerationT0EscalatedJob`, `NciiClockJob/Result`,
  `INTERNAL_ROUTES.moderationScript/nciiTick` with bodies. Entities: `ContentLabel`,
  `ModerationFlag` (no frame URL; `hasFrame`), `CaseHistoryRow`, `ModerationCase(+Detail)`,
  `EvidenceObject`, `EvidenceView`, `LegalHold`, `NcmecReport(+Detail)`, `NcmecSnapshot` (the
  sealed snapshot's plaintext), `LegalCase`, `NciiRequest(+Item)`, `BroadcastSummary.restricted`
  (optional). Router: `moderation.*` (12), `ncii.{submit,queue,decide}`, `channels.commitUpload`
  (`UPLOAD_REJECTED`: 422 `data.reason = "upload_rejected"`), `admin.expediteDeletion`,
  `admin.legalHold` (legal-only, place-only, returns `LegalHold`), `me.labels`, `playback.start`
  with `MATURE_GATE` (`FORBIDDEN` `data.reason = "mature_gate"`). Access levels `legal` and
  `safety-staff` (moderator, admin, legal), real checks in `services/api/src/lib/access.ts` with
  tests. 501 stubs: `routes/moderation.ts`, `routes/ncii.ts`, `commitUpload`, `expediteDeletion`,
  `me.labels`.
- `0e948da` `MODERATION_JOBS.nciiHash` + `NciiHashJob`: NCII `removed` unpublishes in the API
  transaction and the worker hashes then deletes (hashing whole VODs does not belong in a request).
- Spec edits (same commits): the API **enqueues** `t0` for uploads and `t0-escalated` for
  human-escalated confirms, so the **worker owns the only implementation of the T0 actions**;
  `ncii-tick` is served by the API, which enqueues `ncii-clock` and awaits it; error data uses
  `data.reason`. Evidence frames are sealed as **PNG** (lossless), not WebP.
- `f038c0e` **config**: `moderationEnv` (sample 2–60, lists, `onnx|scripted`, model path,
  test hooks; `scripted` refused without hooks; no on/off switch exists), `evidenceSealEnv`
  (raw 32-byte X25519 public, base64), `evidenceOpenEnv` (X25519 **PKCS#8** private, base64; the
  handoff said raw, PKCS#8 is what WebCrypto imports), `evidenceStorageEnv`,
  `S3_BUCKET_EVIDENCE`. `HASH_MATCH_*` marked deprecated. `init-env` generates the keypair and the
  `GK…` evidence key, refuses a merge that would pair half a kept keypair with a new half.
  **The user must run `bun scripts/init-env.ts --merge`** before the next stack start
  (garage-init now requires `S3_EVIDENCE_*`).
- `2813f99` **`packages/moderation`**: `MODERATION_CONSTANTS`, `INCOMING_PREFIX`,
  `reviewFrameKey`, `parseThresholds`/`validThresholds`/`tierFor`/`effectiveSampleSeconds`
  (implemented, 10 tests), **the seal implemented** (format v1 in `seal.ts` header: magic, version,
  key id, ephemeral key, nonce, AES-GCM with the header as AAD; 5 tests), `types.ts` interfaces,
  and final signatures for PDQ, lists/matcher/watcher, scripted classifier, ffmpeg helpers and
  `./onnx` (bodies throw until unit A). `onnxruntime-node`/`-common` 1.30.0 pinned;
  `check-licenses` passes. `LICENSES/BSD-3-Clause.txt` is added by unit A with the first BSD file
  (reuse lint fails on an unused license).
- `6377f0c` **Garage**: `garage-init` imports the evidence key, grants it read+write (not owner)
  on the evidence bucket only, revokes any main-key grant there and any evidence-key grant
  elsewhere (unit tests with the fake admin API). Compose/Quadlet blank `S3_EVIDENCE_*` and
  `EVIDENCE_PRIVATE_KEY` for every app service and hand them back only to the worker and the API;
  `ONNXRUNTIME_NODE_INSTALL=skip` everywhere. A real-Garage proof (main key cannot list/get/put
  evidence; evidence key cannot touch other buckets) is in `infra/tests/stack.int.test.ts`,
  **not run** (it starts its own compose project; the user's gate runs it).
- `5658eef` `scripts/fetch-model.ts`; `MODEL.sha256 = d25aa73f…35fa` (equals the Hugging Face LFS
  oid of `onnx/model_int8.onnx` at the pinned revision, 88,500,985 bytes). The file is in
  `.cache/models/` (gitignored) in the main checkout.
- `738532e` **briefs** `.claude/briefs/e4c/`: `_common.md` (safety rules verbatim, HIGH list,
  database-first, process, review) and units **A** moderation, **B** media, **C** worker, **D** API,
  **E** web + ui, **F** harness. Decided in the briefs: bucket evidence keys are
  `evidence/<caseId>/<evidenceId>.<sha256 of sealed bytes>` so the daily audit can verify without
  the private key; VOD evidence is sealed per HLS object.

Open items from the contract step:

- **onnxruntime-node postinstall**: Bun's `pm untrusted` reports nothing blocked, which may mean
  Bun's built-in default trust list lets the script run. It is a no-op on macOS; on Linux x64 it
  could fetch CUDA from NuGet. Mitigated by `ONNXRUNTIME_NODE_INSTALL=skip` in compose/Quadlet, but
  the **image build** (`infra/containers/service.Containerfile`, `bun install`) must also set it:
  add `ENV ONNXRUNTIME_NODE_INSTALL=skip` before the install step and confirm in a Linux build that
  no `.nuget`/CUDA files appear. Adding `"trustedDependencies": []` to the root was tried and
  reverted (unclear effect on other packages' scripts).
- Hash-list file mounts for media/api/worker and the model volume for the worker in compose are
  not done (unit F writes `harness/compose.trust-safety.yaml` for the scenario; production mounts
  are a head-agent integration task).
- `docs/operators/trust-safety.md` (ADR 0006 Q5, "not legal advice" header, S3 Object Lock policy
  for stores that support it): head agent, at integration.
- Remove `HASH_MATCH_*` from config and `.env.example` once unit B merges.

### Step 3, fire and merge the units (resume here)

Fire **A, B, C, D, E, F** (six, the maximum), each with the Agent tool in its own git worktree
(`isolation: "worktree"`), prompt = "Read `.claude/briefs/e4c/_common.md` and
`.claude/briefs/e4c/<X>.md` and do what they say. First run `git merge main --no-edit`." Merge **A
first** after its review; then tell B, C and D (SendMessage) to `git merge main --no-edit` and run
their integration tests for real. Review rules (harder than E4b): an independent reviewer before
every merge (diff vs `_common.md`, the spec, AGENTS.md), a focused re-review after any HIGH fix,
and a **second, security-focused reviewer for B, C and D** even with no HIGH. Losing evidence,
skipping a T0 action, showing T0 material outside `legal`, or switching the pipeline off is HIGH.
Apply contract requests yourself on `main` between merges. After all merge: the open items above,
e4c doc wiring check, then hand the user the gate, `bun run verify --scenario trust-safety` and
the browser checks.

Decisions taken in the spec that go slightly beyond ADR 0006 (tell the user if asked): T0 removal
of VOD/clip media is **not restored** after a two-reviewer dismissal (copies exist only as sealed
evidence; account and channel are restored); T1-restricted streams offer "show anyway" only to
signed-in, 18+-confirmed viewers; uploads above T2 `sexual` are rejected (avatars etc. show
outside the 18+ gate); human escalation of a report/case to legal runs the full T0 actions on
confirm; `admin.expediteDeletion` exists so the scenario (and support) can delete now.

## Session six in flight (E4b money)

Started 2026-10-19 from `06cb6c9`. Prompt: build slice E4b (PLAN.md): the manual adapter first
(subscriptions in 3 tiers, tips, gift subs, ledger postings, revenue dashboard, refunds,
chargeback clawback, payout threshold), then the Stripe adapter against stripe-mock. Web UI only
from `packages/ui` compositions (Support, Revenue and Transparency boards); missing pieces go into
`packages/ui` as compositions with stories and tests. Contract: `docs/testing/e4b-selectors.md`
plus a harness scenario. Briefs in `.claude/briefs/e4b/`. Same process: ≤ ~6 units in worktrees,
contract changes by the head agent only, an independent reviewer before every merge (focused
re-review for any HIGH), the user runs the gate, harness, Storybook, Railway and browser checks.

Starting point found in the code: the money contract (`money.*`, `coop.transparency`), the payment
tables and `@commonair/ledger` (rules, poster, holds, reversals, payout batch, aggregates) already
exist; every `money.*` handler is a 501 stub; `packages/payments` (adapter interface) does not
exist yet. The "offline/recent followed channels on /" open item landed in `28bd4aa`.

Head-agent contract step (`9f371ae`, `41ac078`): `money.support`, gift subs on `subscribe`,
`RevenueSummary` balances/sources/tiers, `money.revenueLedger`, `treasurer.payments|payouts|
setPayoutAccount`, `MONEY_LIMITS`, `QUEUES.payments`; migration `0013` (payment tier/quantity/
expiry, `subscriptions.gift_payment_id`); `bun run --filter @commonair/db role -- <user> <role>`
(operator role CLI, audited); `packages/payments` scaffold; config `MANUAL_PAYMENT_INSTRUCTIONS`,
`MANUAL_PAYOUT_INSTRUCTIONS`, `PAYMENT_PENDING_DAYS` (`PAYOUT_MINIMUM_CENTS` removed: the minimum
is the protected `payout.rules`); API money handlers split into `money/checkout.ts` and
`money/reports.ts`; web route stubs and per-unit catalogs; `docs/testing/e4b-selectors.md`.

Units in flight (manual adapter, `.claude/briefs/e4b/`): A api-checkout, B api-reports, C
worker-money, D web-support (+ `ChatEvent`, OptionGroup/AmountField props), E web-money
(`/revenue`, `/treasury`, `/transparency`, nav), F harness `e4b-money`. After A–F: the head adds
the e4b doc to `apps/web/tests/selectors.test.ts`/`i18n.test.ts`, then unit G (Stripe adapter
against stripe-mock, webhook route, Connect onboarding, harness `--set provider=stripe`).

### Session seven (2026-10-20, in progress)

Resumed from `e64e007`. **A–F are reviewed and merged on `main`** (A `8dc5f20`, B `e4e586a`,
D `561c8bf`, E `55a0461`, F `0b34b44`; C was already in). Reviews: A no HIGH (6 fixes: tip
`decimal_places`, confirm date floor with 60 s skew, gift price kept, owner-only `setTiers`,
payout account rules, race tests); B no HIGH (the nine head decisions); D 1 HIGH (cancel on
gifts) then a new HIGH in its fix (tip validity after a tab switch), both fixed and re-reviewed
clean; E no HIGH (8 fixes: tier limits from `MONEY_LIMITS`, treasury paging, instance currency,
category rules, CSV truncation); F 1 HIGH (step 9 dispute match by idempotency key) fixed and
re-reviewed clean. Head: spec clarifications (`ea277d0`), `SessionUser.role` (`7fad717`),
`MONEY_LIMITS.tierNameMaxLength`/`tierBenefitsMaxLength` + `PublicConfig.currency` (`e897ba4`),
e4b doc in `apps/web/tests/selectors.test.ts` (multi-id cells, `<n>` templates) and a catalog
disjointness check in `i18n.test.ts`. Targeted checks on merged main: tsc + unit tests in web,
ui, api, harness, worker, ledger, payments, contracts; api `test:int`; `vp build`.

Then **G** (Stripe: fetch client, webhook with redacted `payment_events`, Connect onboarding +
visit sync, `STRIPE_CONNECT_WEBHOOK_SECRET`, harness `--set provider=stripe`; review 1 HIGH —
renewals dropped — fixed and re-reviewed; follow-up moved the refund call outside the row lock),
**H** (payouts reserve the running-minimum balance from `periodEnd` to now; hold releases dated
when due; `releaseDueHolds` refuses `asOf` > 60 s ahead; optional `WorkerContext.money`; no HIGH)
and **I** (PageTabs per-tab `disabled`/`data-testid`/`aria-describedby`/`afterList`, ChoiceToggle
`wrap`, Support dialog + treasury tabs on PageTabs, channel accent on ChannelHeader and the Support
dialog, Support board as shipped; no HIGH) are merged. **E4b is code-complete; nothing is run
live yet.** The user runs: `bun run verify`, `e4b-money` (manual, web and `via=api`), `e4b-money
--set provider=stripe --set via=api` against stripe-mock (the API refuses a zero Stripe fee, so a
stripe-mock fixture without a fee stalls confirms), Storybook (Support, PageTabs, ChoiceToggle,
ChannelHeader accents) and the browser pass on `/revenue`, `/treasury`, `/transparency`, the
Support dialog and `/settings/subscriptions`.

Decided 2026-10-20 and recorded in ADR 0007, **not to be built until the user asks**: one open
unpaid gift per gifter per channel + 24-hour gift window; auto-refund `paid_after_end` money;
Stripe refund "outcome unknown" keeps blocking. Recorded as is: owner-only revenue/tiers, hold
releases dated when due, Connect transfers later. Smaller: the webhook rate limit is a local constant in
`stripe-webhook.ts` (could move to `DEFAULT_RATE_LIMITS`); Stripe Connect transfers are out of scope; `packages/ui/README.md` doesn't list the new props.

### Resume point (2026-10-20, stopped at the user's request) — superseded by session seven

The user asked to stop the units and push `main`. On `main` (pushed): the contract step, migration
`0013` + `0014` (partial indexes for the worker scans), unit **C worker-money** merged after
review (no HIGH) plus its fix round (`b5d7c26`), spec updates (hourly hold release, Cancel row,
renewal price copied on confirm, lock order payment → subscription, `chat-message`
`data-badges`, no cancel on gifts, every held payout re-pended), `channel.tip` `decimal_places`
follows the currency, and the unit G (Stripe) brief. Nothing below is merged:

| Unit                  | Branch `worktree-agent-…`                                             | State                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A api-checkout        | `a429124a5bed5abe9` @ `4acc234`                                       | done (4 head decisions folded in); review was stopped midway — rerun it. Follow-up for A: send `decimal_places = minorUnits(currency)` in `channel.tip`                                                                                                                                                                                                                              |
| B api-reports         | `a9845f0b5eb7d8c4b` @ `5ac96fb` + 1 uncommitted file in its worktree  | reviewed (no HIGH); fix round stopped midway (head decisions: payouts paged by id, revenue owner-only, previousNet = previous calendar month for whole months, runPayouts refuses periodEnd before the previous month, anonymous tip fail-closed, daily gross = payments only, reserve `payment-fees`, revenueLedger default month, payout-run audit subject). Resume it, then merge |
| D web-support         | `a9d461986eaf7e292` @ `3c6dba7`                                       | done; review stopped midway — rerun it. Known fix: no `subscription-cancel` on gifted rows                                                                                                                                                                                                                                                                                           |
| E web-money           | `abde70cbc8c84de35` (no commit; 21 uncommitted files in its worktree) | stopped while building `/revenue`; resume it from its worktree                                                                                                                                                                                                                                                                                                                       |
| F harness `e4b-money` | `a21ffbae211abf479` @ `94f1523`                                       | done; review stopped midway — rerun it                                                                                                                                                                                                                                                                                                                                               |

After A–F: add the e4b doc to `apps/web/tests/selectors.test.ts` and `i18n.test.ts`, then unit G
(`.claude/briefs/e4b/G-stripe.md`). Open items from reviews: payout reservation is dated at
`periodEnd` (a run on the 5th for the previous month books releases from days 1–5 into that
month); optional `WorkerContext.money` config; packages/ui `PageTabs`/`ChoiceToggle` per-item
`disabled`/`data-testid` so the Support dialog can use the compositions; channel accent in
`ChannelSummary`; Support board fixture still shows a processing segment and card picker.

## Session five in flight (E4a design system)

The user's session-five prompt: E4 starts with an application-design-only track (no API, worker,
DB or harness work). Briefs in `.claude/briefs/e4/`, canvas
<https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. Full review process again: an independent
reviewer before every merge, focused re-review of fix rounds for any HIGH. The user runs the gate,
Storybook and all visual checks; units run only targeted checks (unit tests, `tsc`, `vp lint`/`vp
fmt` on changed files, `vp build` for web, `build-storybook` for packages/ui).

### Resume point (2026-10-19)

E4a U1–U5 are reviewed, merged locally, and pushed to `origin/main` at `3b882054`. U1
(`af745a6`) brought in the pinned shadcn primitives/gallery and three house primitives. U2 adds
shells, navigation and headers; U3 adds data blocks (and the root-cataloged TanStack Table 8.21.3);
U4 adds form/settings blocks; U5 adds content cards, player chrome and chat compositions. U2's
router-render/variant HIGHs, U3's accidental implicit pagination, U4's tag-limit/label HIGHs and
U5's chat viewport HIGH were fixed and independently re-reviewed. Targeted UI tests, TypeScript,
strict lint and formatting passed for the units; Storybook builds passed for U1, U2, U4 and U5.
U3's tests also passed. The aggregate unit-test command completed successfully during integration.
The user still runs the repository gate and visual/browser review.

**U6b merged (2026-10-19, `6d31d95`)**: apps/web now renders on the shells and compositions
(AppShell/SiteHeader/UserMenu/SiteFooter; StudioShell for `/dashboard` and `/relays`; StreamGrid,
ChannelHeader, PlayerChrome, ChatPanel, CodeBlock, DataTable, FormSection …). Every e1–e3 id kept:
`tests/selectors.test.ts` keeps exact matching, ids that reach the DOM through composition props
are listed in `tests/composition-ids.ts` and proven by the SSR test `tests/selectors-render.test.tsx`.
`tests/source-policy.test.ts` enforces the design rules in apps/web (allowlist keyed by snippet +
count: the `<video>`, the ALTCHA element, `formatBytes`). Review: 5 HIGH + 4 MEDIUM fixed,
re-reviewed clean. Head-agent packages/ui additions for it: StreamGrid `cardProps`,
`liveBadgeProps`, PasswordField autocomplete/description, Studio/Admin shells built on AppShell
(skip link, footer outside main), SiteHeader `brand.render`/`mobileActions`/`desktopActions`,
avatar-only UserMenu on phones, `PageContainer width="form"`, coarse-pointer player controls. e1
now says `signup-legal` is a `role="checkbox"` control. **U6a merged (`2a5c2c7`)**: `packages/ui/stories/pages/**`, one story per board
(`Pages/<Group>/<Board>`, Default/Light/Mobile320, Mobile also Phone390; the four interactive
boards keep their interaction), fixtures in integer cents (sub-cent unit costs stay strings until
`formatMoney` gets a precision option), `tests/pages.test.tsx` renders every board,
`tests/source-policy.test.ts` enforces the design rules in packages/ui (allowlist keyed by
file + rule + snippet + count). Review: 1 HIGH + 3 MEDIUM fixed, re-reviewed clean.
**U7 merged ahead of its review at the user's request** (`.claude/briefs/e4/U7-ui-followups.md`; review: no HIGH, four MEDIUMs fixed in `4c2829e`). It cleared the allowlist's "contract request"
entries (arbitrary grid widths, Progress tone selectors, UptimeStrip `role="img"` around focusable
triggers, icon sizing, raw `<label>`, older stories) and adds the compositions the boards asked
for (SelectField, AlertCallout tones, DataTable controlled selection, StatCard footer, TrendChart
legend, value-less Legend, StreamCard uptime, ChannelSidebar "show all", QueueItemCard,
ProposalCard, CommentItem, IncidentCard, SiteHeader context, sub-cent money formatting).

**Storybook for the user:** `cd packages/ui && bun run storybook`, open `Pages/…` (start with
Support, Proposal, Finances, Expenses; Mobile at Phone390; any board's Mobile320).

**For the user (visual):** `/`, `/signin`, `/signup`, `/<channel>` (live and offline), `/embed/<channel>`,
signed in: user menu, `/dashboard` (studio sidebar, copy server URL/key, rotate), `/relays` (create,
token/command copy, table, retire). Both themes, 320 px, keyboard. Then `e2e-basic`, `e2e-social`,
`e2e-relay` against the stack, since the markup under every selector moved.

**Why staging looked unchanged before U6b (2026-10-19):** Railway `web` was deployed at `97d4f37`, but U1–U5 only added `packages/ui` compositions and Storybook stories; no route uses them
until U6b lands. The demo seed did reach staging (`/demo_streamer1` renders "Aurora Pixel",
offline), but `directory.home` lists **live** channels only and the seed creates past broadcasts,
never live ones, so `/` says "Nobody is live" (the signed-in `bob` also follows no demo channel).
To see a live card, sign in as a demo streamer, copy the stream key from `/dashboard` and publish a
test pattern to the mediamtx TCP proxy (see "For the user to run"). Showing offline/recent
followed channels on `/` needs an API change (E4b or later; Main board's sidebar has the design).

## Process rules from the user (session three)

- **The user runs the gate (`bun run verify`), image rebuilds, harness scenarios and all visual
  checks.** Agents and units do not. Run only targeted checks: the touched packages' unit tests and
  `test:int`, `bunx tsc -p <pkg>`, `vp lint`/`vp fmt` on changed files (and `vp build` for web).
- Focus on development; after review, merge and push `main` so the user can test. Ask before
  pushing unless the user has said to push. Gate failures are fixed "in post".
- Briefs must tell units the same (no verify, no dev servers/browsers, no live scenario runs).
- Session four: the user asked for **lighter review** — one reviewer pass reporting HIGHs only, fix
  rounds without a second review; small UI units get a head-agent rules scan instead of a reviewer.

## Where things stand

`main` is pushed with the whole of **slice E3** merged (session four). **Not yet tested live by the
user**: `e2e-relay`, the E2 slice end to end (`e2e-social`), the worker/origin integrity wiring and
the harness against Railway staging.

### Merged in session four

| Area          | What landed                                                                                                                                                                                                                                                                                  | Review                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| E3 API        | relay lifecycle: retire (`retired_at` + token rotation, 401 forever), offline relays rejoin after a passing health check, draining heartbeat → offline + out of `KEYS.relays`, suspended relays authenticate but never publish, CAS status writes + re-read after HSET, README state diagram | 1 HIGH + race → fixed         |
| E3 relay (Go) | draining heartbeat on SIGTERM, drain serves only current sessions then flushes receipts, explicit heartbeat state machine (offline/401/404/412 → re-register; suspended → 410), LL-HLS blocking-reload re-check, local-stack README                                                          | 1 HIGH (drain delay) → fixed  |
| E3 web        | `/relays` (create/list/retire, token + run command once), `relays-link`, player `data-source` across `switchTo`, throttled heartbeat carry-over                                                                                                                                              | head rules scan               |
| E3 harness    | `e2e-relay` (six steps, Go relay helper, TypeScript liar relay with inflated signed receipts), knobs in `harness/src/relay-plan.ts`; `inFull: false` (needs Go + private-network relays, ~15 min)                                                                                            | not reviewed (harness only)   |
| P2P tracker   | `services/tracker`: WebTorrent WS tracker, completed-exchange links, `p2pChannelNet` per-channel network sets that leaving never shrinks, newer-token socket replacement, backpressure 1 MiB, IPv6 /64 connection key                                                                        | 2 HIGH (farm evasion) → fixed |
| P2P integrity | per-session evidence: own-channel announce + exchange with another network + channel-wide cap of 16 per network + linked network under the cap; read errors never evidence                                                                                                                   | rework after HIGH             |
| Legal         | draft legal documents seeded by the migrate job (not test DBs), legal API, consent on the `write` rate limit with bounded input                                                                                                                                                              | 1 HIGH (no seed) → fixed      |
| Head          | `KEYS.p2pChannelNet` + amended `P2P_EVIDENCE` rule, `@commonair/db` legal exports, migration `0012` backfills `retired_at` for relays retired by the old remove                                                                                                                              | orchestrator                  |

### Merged in session three

| Area                    | What landed                                                                                                                                                                                                                                                                                                                                                           | Review                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Worker integrity (2L)   | four integrity jobs on the `integrity` queue (schedulers + Valkey run locks, lapses logged/counted), consumer fetch evidence with ack isolated from apply, origin `SegmentFetch.obj`, viewer-count republish, scheduled jobs retry with backoff, SIGHUP CIDR reload keeps a good list, `integrity-basic` scenario, worker README                                      | no HIGH; fixes applied      |
| API round 3             | appeals (create/mine/queue/resolve: CAS + audit, no outbox event by decision), heartbeat floor returns before any write, canonical IP hashing (RFC 5952, `::ffff:` unwrap) on both hash paths, `pinnedGet` hard deadline, auth paths from contracts, README rate-limit table. P2P `assignedSource` **reverted** (see open items). `channels.get` → `viewer.following` | 2 HIGH → fixed, re-reviewed |
| Safe-regex + chat (2B)  | `packages/safe-regex` (moved from the API) with a sound cost model (nested alternations in repeated groups refused, sums across alternatives, O(n) unbounded repeats); chat re-validates stored filters on load and runs regex filter sets in a Bun worker pool with a hard timeout, quarantine, capped zombie threads, token-bucket respawns, queue-wait deadline    | 2 HIGH → fixed, re-reviewed |
| E2 web (3A)             | `/` is the directory (spotlight/new/live/following, `StreamCard`, empty/skeleton states), follow button (optimistic, stale-poll safe) + follower count, chat moderation menu (timeout 600 s / ban with `ConfirmDialog`), deleted rows, inline notices, sign-in-again toast                                                                                            | no HIGH; fixes applied      |
| E2 harness (2J)         | `e2e-social` (five steps of `e2-selectors.md`, `--set via=api` backend-only mode), E2 selectors parsed from both docs, tmi.js event recording (CLEARCHAT/timeout/ban/messagedeleted/notices)                                                                                                                                                                          | no HIGH; fixes applied      |
| Head (contracts/config) | `@commonair/contracts/auth` (`AUTH_ROUTES`, `ALTCHA_FIELD`), `E.APPEAL_SUBJECTS`, `ircEnv` + `ORIGIN_ISSUANCE_ENABLED` in config, `Channel.viewer`, harness Mailpit basic auth (`HARNESS_MAILPIT_AUTH`), IRC health port 6681 published in compose                                                                                                                    | orchestrator                |

## For the user to run (agents: don't, unless asked)

```
# E3: needs Go and OUTBOUND_ALLOW_PRIVATE_NETWORKS=true in .env
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay --set via=api
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay --set liar=false --set drain=false
podman compose --profile p2p up -d tracker                   # P2P tracker
bun scripts/infra.ts stack                                   # rebuild + start everything
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-social
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-social --set via=api   # backend only
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-basic
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run viewers
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run integrity-basic
VERIFY_INFRA=external bun run verify
# Staging: make a demo channel live. Sign in as demo_streamer1, then on /dashboard copy the
# server URL (rtmp://<mediamtx proxy>/live) and the stream key (`<slug>?key=<secret>`).
ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac -f flv "<server URL>/<stream key>"
```

Test the web app from `PUBLIC_URL` (3100 here): the API strips cookies from untrusted origins, so a
dev server on another port makes every browser `/rpc` call anonymous (follows "roll back").
Staging: set `HARNESS_*` URLs from `railway domain list` and `HARNESS_MAILPIT_AUTH` from the
`mailpit` service's `MP_UI_AUTH` (docs/deploy/railway.md), then `smoke` and `e2e-basic`.

## Open items (not done)

- **E3 follow-ups (session four):**
  - `playback_sessions.relay_until` (contract + DB): today a session switched off a relay is
    re-recorded as `origin`/no relay, which fails safe (time before the switch is judged as origin,
    honest relay viewers can be undercounted). With `relay_until`, integrity can judge the relay
    part against receipts and the rest against origin fetches.
  - Web: 320 px, keyboard flow and toasts on `/relays`, and the hls.js handover on `switchTo`, are
    unchecked in a browser. Optional: `formatBytes` into `packages/ui`; a `source` field on the
    heartbeat response so the player stops decoding the token's `src` claim for display.
  - Harness: `e2e-relay` is not in `full`; the liar's 5× served bytes is ~1.25× issuance on a
    multi-rendition ladder (still suspended as "repeated"; `--set liarFactor` raises it).
  - Tracker: no test with a real p2p-media-loader client yet; `clientIp`/`canonicalIp`/netrange
    helpers are copied into `services/tracker/src/ip.ts` (move into `@commonair/service`).
  - Info hashes are still client-chosen (the per-channel cap makes that harmless for evidence);
    deriving the allowed set from the channel's swarm ids would also stop junk swarms.
  - Legal: `LegalDocument` DTO lacks `requiresAcceptance` (clients send every id); no retention job
    for anonymous consent rows.
- **Contract requests still open:** `CidrClassifier` public `size` getter; `WordFilter` DTO
  `invalid`/`invalidReason`; `appeals.create` on the `write` bucket; `ISSUANCE_KEYS` into contracts.
- Overturning a moderation appeal records the decision only (does not lift the ban).
- IP canonicalization changed `ip_hash` for clients Bun reported as `::ffff:a.b.c.d`: owner-IP
  exclusion for broadcasts live across that deploy compares the old `last_used_ip_hash` until the
  streamer re-publishes (services/api README).
- Some regex filters the old API check accepted are now refused (e.g. `(?:https?://)?\S+`,
  `(?:a(?:bc|bd))+`; safe rewrites are suggested in the error text).
- Media: internal RTSP password in ffmpeg argv. Integrity: CDN-delivered sessions not fetch-judged.
  Web: ALTCHA tick colour token, large chunk warning (`hls-*.js` 574 kB); LOW: the moderation
  `IconButton`-inside-`DropdownMenuTrigger` pattern needs a keyboard check in a browser.

## Next slices

E3 is built; milestone E3 is reached when the user's live `e2e-relay` run passes. **E4 starts with
the application design-system track** (shadcn CLI primitives under one theme, shared compositions in
`packages/ui`, page stories per mockup board, enforcement tests, apps/web migration; the user's
session-four prompt has the full brief and the mockup canvas URL), then money on top of it (manual
adapter, then Stripe against stripe-mock). E5 co-op; E6 the rest. Each slice: a
`docs/testing/<slice>-selectors.md` contract, briefs in `.claude/briefs/<slice>/`, API + worker +
web + harness scenario together.

## Known issues and process lessons

- A chat integration test ("a timeout issued on A is enforced on B …", 5 s) times out under
  parallel test load; it passes alone. Avoid running several packages' `test:int` concurrently.
- Stale `commonair-it-*` compose stacks from old integration runs may be lying around; remove them
  if they get in the way. `podman compose up` can hang when another process runs compose: kill it
  and use `VERIFY_INFRA=external`.
- Worktrees: tell every unit to `git merge main` first; after merging a branch that adds a
  workspace package, run `bun install` in the main checkout before `tsc` (module resolution); resume a finished unit with SendMessage for
  its fix round (it keeps context). Old worktrees under `.claude/worktrees/` can be cleaned up.
- Local machine: an unrelated Vite dev server holds `[::1]:3000`; the local `.env` uses
  `WEB_PORT=3100`, `PUBLIC_URL`/`AUTH_TRUSTED_ORIGINS` on 3100. The local `.env` has
  `NODE_ENV=development` (overrides the images' production mode; fine locally).
- Review before merge keeps paying off: this session's reviews caught a client flag that would have
  let viewbots bypass fetch checks, an exponential regex bypass, and unbounded worker respawns.
