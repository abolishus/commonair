<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## E6 rules every unit follows (read all of this)

**Slice.** E6 finishes Phase 4: simulcast to a mock RTMP target, overlay alerts, VOD and clip
management, data export, account deletion (pseudonymization), the backup/restore drill, the
load test at PLAN size, and `full` (plus `--profile no-proprietary`) covering every Phase 4
scenario. **The spec every unit builds against is `docs/testing/e6-selectors.md`**: rules,
flow tables, the export archive format, routes, test ids, test hooks and every scenario. Read it
in full. If the spec and your brief disagree, the spec wins; report the disagreement. Policy:
`docs/decisions/0021-e6-operations-policies.md`. Pseudonymization and enforcement: ADR 0004.

**Read first.** AGENTS.md (all of it: append-only columns, outbox, audit, logging without PII,
money in integer cents, design rules, house primitives), then the contract the head agent
committed on `main` (`93bab15`, `64ddf72`, `6a3d3d0`):

- `packages/contracts/src/api/router.ts`: `interact.alerts.*`, `interact.overlays.{token,status,revoke,state}`
  (search `overlays:`), `vods.*`, `clips.*`, `me.exports.*`, `me.deletion.*`,
  `admin.expediteDeletion`, `admin.legalHold`, `stream.simulcast.*`, `me.bots.createToken`.
- `api/entities.ts`: `AlertConfig`, `OverlayTokenStatus`, `OverlayAlert`, `ExportJob`,
  `DeletionRequest`, `Vod`, `Clip`. `shapes.ts`: `AlertTemplate`. `enums.ts`: `ALERT_TYPES`,
  `EXPORT_KINDS`, `JOB_STATUSES`, `DELETION_STATUSES`, `VISIBILITIES`, `SIMULCAST_STATUSES`.
- `events.ts`: `BUS.overlay(channelId)`, `OVERLAY_EVENTS_PATH`, `BUS.events`, `channel.tip`,
  `channel.follow`, `channel.subscribe`, `channel.subscription.gift`.
- `internal.ts`: `INTERNAL_ROUTES.opsTick`, `OpsTickBody`, `OpsJobResult`, `OPS_TICK_JOBS`,
  `EXPORT_JOBS`, `ExportBuildJob`, `exportObjectKey`, `EXPORT_TTL_SECONDS`,
  `EXPORT_COOLDOWN_SECONDS`, `EXPORT_FORMAT_VERSION`, `QUEUES.exports/deletions/retention`.
- `packages/config/src/env.ts`: `opsEnv` (`OPS_TEST_HOOKS`), `mailEnv`, `storageEnv`
  (`S3_BUCKET_EXPORTS`, `S3_PUBLIC_ENDPOINT`), `OUTBOUND_ALLOW_PRIVATE_NETWORKS`.
- `packages/db/src/schema/interactive.ts` (`alert_configs`, `overlay_tokens` with `expires_at`
  and the one-active index), `safety.ts` (`data_exports`, `account_deletions`, `legal_holds`),
  `media.ts` (`vods`, `clips`, `simulcast_*`), migration `0022_e6_ops.sql`.
- Existing code you build on: `services/api/src/lib/orpc.ts` (overlay token resolution),
  `services/api/src/coop/hooks.ts` (the pattern for a test hook), `services/worker/src/deletion/`,
  `services/worker/src/housekeeping.ts` (`enforceVodRetention`), `packages/storage`
  (`presignGet`), `packages/email` (`dataExportReady`, `accountDeletionScheduled`,
  `accountDeletionCompleted` in `templates/privacy.tsx`).

**Rules a reviewer marks HIGH when broken** (the spec's "Rules every unit honors" in full):

- **Exports**: another user's data (id, email, username, display name, message text, IP, payment
  detail) or any secret in an archive; a presigned link for any key other than the export's own,
  or one that outlives `expires_at`; `me.exports.list` returning another user's export; an
  expired export still downloadable.
- **Overlay tokens**: a token that authenticates anything except `interact.overlays.state` and
  the overlay stream for its own channel; an expired or revoked token accepted; an open stream
  that survives revocation or expiry for more than 30 s; a token value stored or logged; a frame
  carrying a payer id, email, or an anonymous tipper's name.
- **Deletion**: a ledger, payment, audit or history row lost; the user's email, username, display
  name or free text left in `ledger_*`, `payments`, `tips`, `audit_log`, `*_history`, `events` or
  `webhook_deliveries`; held data touched or held media deleted.
- **Restore drill**: a check that would pass with a trigger, protection function or app-role grant
  missing, or with an unbalanced ledger; any step that touches the running stack's database.
- **Database-first (ADR 0004).** Services connect as the app role. Never weaken or work around a
  trigger (no owner connection in services, no `session_replication_role`). If a trigger blocks a
  legitimate flow, stop and report a contract request.
- **Audit and outbox** in the same transaction as the change (spec lists the audit actions).
  Audit `details`: ids, enums and numbers only.
- **No PII or secrets in logs** (no emails, IPs, tokens, stream/simulcast keys, signed URLs).
- **Errors**: contract `ORPCError` codes; never SQL text or stack traces to clients.

**Web rules** (units C and D). AGENTS.md "Design rules (web)" and "House primitives" are hard
rules, enforced by `apps/web/tests/source-policy.test.ts` and `packages/ui/tests/source-policy.test.ts`.
Pages are built only from `packages/ui` layouts, blocks and components; the existing stories
(`packages/ui/stories/pages/Overlays.stories.tsx`, `Content.stories.tsx`, `Settings.stories.tsx`,
`StreamSetup.stories.tsx`) show the intended composition. A missing composition is a contract
request, never page-local styling. Every e1–e5 test id stays intact. User-facing strings go
through i18n.

**Process.** You work in your own git worktree: run `git merge main --no-edit` first, then
`bun install` if `node_modules` is missing. Do not edit contracts, db schema/migrations, config,
root `package.json`, `bun.lock`, `scripts/`, `compose.yaml`, `harness/compose.*.yaml` or root
lint config: report a contract request instead. No new npm dependencies (`fflate` is already
available to the worker and the harness; `@commonair/email` to the worker; `@commonair/ledger`
and `@commonair/storage` to the harness). Never add anything to `trustedDependencies`.

## Done means (every brief)

- **Targeted checks only, shortest path.** The user runs the gate (`bun run verify`), image
  rebuilds, harness scenarios against the live stack, dev servers, Storybook and every
  browser/visual check. You do not. Run only: your package's unit tests for the files you
  touched and its `test:int` for your new integration test files
  (`bun --bun vp test run <files>`; the data services are already up at the `.env.example`
  defaults; source `.env` first: `set -a && . ../../.env && set +a`), `bunx tsc -p <pkg> --noEmit`,
  `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`; `vp build` only for
  `apps/web` (unit D). Never run `podman compose`, `scripts/infra.ts` or the full `verify`.
  Never run several packages' integration tests at the same time.
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits) and explicit paths, never
  `git commit -a`; message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`,
  once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.

## Review (the head agent runs this; know what you will be held to)

An independent reviewer reads your diff against this file, the spec and AGENTS.md **before**
merge. Any HIGH is fixed and gets a focused re-review. Data export, overlay tokens, account
deletion and the backup/restore drill also get a **second, security-focused reviewer** even when
the first finds no HIGH.
