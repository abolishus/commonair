<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# B8-server: the batch 6 and batch 7 server follow-ups

You are implementing unit B8-server for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U6, (g), (h), (i), (j) and (r), the follow-ups
  table, the path ownership and the shared rules are binding.
- `.claude/briefs/b8/contract-step.md`:
  - §3.1 (the two federation events and their routes);
  - §3.3 (`ImportChoices.fields`);
  - §3.5 (the `staff_action` statement facts);
  - §3.6 (the giveaway export stub and your two jobs);
  - §4.3–§4.4.
- The ADRs: ADR 0037 (accepted 2026-11-02), ADR 0030 (federation), ADR 0031 (Twitch import),
  ADR 0019 (statements of reasons) and ADR 0039 §2 and §4.
- `.claude/briefs/b7/B7-followups.md` (finding 1), and PROGRESS "Batch 7 contract step merged",
  open items.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`b8/server`, cut from the contract step's sha. B8-web runs beside you, in other files.

## Why

Eight small server items were left open by batches 6 and 7. Each has evidence in the README's
follow-ups table. Together they close gaps in correctness, privacy and data retention before
launch.

## You own (write only these)

- `services/api/src/auth/index.ts`: the `databaseHooks.user.update` hooks only (`:252-290`).
- `services/api/src/chat/surge.ts`.
- `services/api/src/federation/settings.ts`.
- `services/worker/src/federation/**`.
- `services/worker/src/exports/giveaways.ts`. Not `collectors.ts`: the contract step registered
  your section.
- `services/worker/src/moderation/sor-{build,schemas,deliver}.ts`.
- `packages/email/src/templates/trust.tsx`: the `enforcementStatement` template (`:220` onward)
  only. Also the `enforcementStatement.staffAction.*` keys in
  `packages/email/src/messages/locales/{en,es}/` (the file the contract step put them in).
- `services/worker/src/jobs/{portability-incoming-cleanup,import-record-expiry}.ts`, and their logic
  in `services/worker/src/portability/{incoming-cleanup,record-expiry}.ts` (new).
- `services/worker/src/twitch-import/**`.
- `services/worker/src/portability/import/apply.ts`: the channel-field application only.
- `apps/web/src/components/twitch-import/**`, `apps/web/src/i18n/locales/{en,es}/n3-import.json`
  and `keys/n3-import.gen.ts`.
- `harness/src/b8/server.ts`.
- Tests named after these files.

**Read-only:** `packages/{contracts,db,config}/**`, `services/worker/src/b7/outbox-jobs.ts`,
`services/worker/src/exports/collectors.ts`, `services/worker/src/jobs/index.ts`, the rest of the
portability worker, and `services/api/src/interact/**`. Anything else is a **contract request**.
That includes the privacy draft line for the 30-day Twitch data expiry (decision (j)).

## Build

1. **Lapsed ban at sign-in (decision (g)).** Better Auth's admin plugin clears a lapsed ban when the
   user signs in, and no `channel.suspension {suspended:false}` is written.
   - **First, prove** whether that clear goes through `databaseHooks.user.update`
     (`services/api/src/auth/index.ts:252-290`). Write a failing integration test that signs in a
     user whose ban has lapsed and checks for the event.
   - **If it does,** the `after` hook writes the event when `banned` went from true to false and
     the user owns a channel.
   - **If it does not,** use a `session.create.after` hook that detects the clear by comparing with
     the `ban-expiry` sweep's marker.
   - That hook is not transactional (`:268-270`), so the 5-minute `ban-expiry` sweep stays the
     backstop. **Never double-emit:** both paths go through one function that writes the event only
     if no unsuspension for that suspension exists yet. Use a conditional insert keyed on the
     suspension's id, or a lock.
2. **Giveaway entries and wins in the data export.** `interact-giveaways.json` holds the caller's
   entries (giveaway title, channel, entered at, their own pseudonym) and their wins (rank, drawn
   at). It never holds other users' pseudonyms or the salt. A deleted giveaway's rows are not
   exported.
3. **A raid surge keeps `raid`** (`services/api/src/chat/surge.ts:111-118`). When a moderator starts
   a surge that is already on because of a raid, the extend branch already keeps `stored`. The
   fresh-start branch drops `raid` when a raid surge has lapsed and is restarted inside its carry
   window. Keep `raid` (`fromChannel`, `verifiedCount`) whenever the stored override has one and the
   raid's surge window (`RAID_RULES.surgeMinutes`) has not passed. Clear it on `suppress`.
4. **Federation events (decision (h)).**
   - `settings.ts` stops calling `sendActorDelete` (`:85`, `:216`) and stops deleting follower rows.
     Turning federation off writes `channel.federation {enabled:false}` in the same transaction as
     the setting. Disabling the actor (suspension, account deletion) writes
     `federation.actor.disabled`.
   - The worker's deliver and cleanup jobs, routed by `b7JobsFor`, do the actor `Delete` fan-out
     and the follower cleanup.
   - A toggle never emits the public `channel.update`.
   - The after-commit `Delete` for a deleted account (the batch 7 wave 2 fix) moves to the same
     event.
5. **Statements of reasons for staff actions (B7 CR6).** For `report.resolve`, `user.suspend` and
   `channel.suspend` with no moderation case:
   - `sor-build` emits `facts.kind = "staff_action"`;
   - the email renders the action, clause and time, and never a case reference.
   - Today the email reads "reviewed case MA-…", which does not exist. Fix that in the template and
     test it in `en` and `es`.
6. **Import archive cleanup (decision (i)).** `portability-incoming-cleanup` (daily) deletes
   `incoming/portability/` archives whose import is `failed`, or `previewed` and older than 24 h. It
   then clears `archive_key`.
   - It never touches `queued` or `running` imports.
   - It deletes objects with no import row at all only when they are older than 24 h, so an upload
     in flight is never deleted.
   - Apply has always deleted after success (`services/worker/src/portability/import/index.ts:93-96`).
7. **Twitch import data expires (decision (j)).** `import-record-expiry` (daily):
   - 30 days after `finished_at`, set `preview = '{}'` and `result = null` on Twitch imports
     (`packages/db/src/schema/b7.ts:153-155`);
   - keep `status`, `source`, the times and the assertion fields for the audit trail;
   - write one `audit_log` row per run with a count, and no names.
     Bundle imports (`source = commonair`) are out of scope: they hold no third-party data.
8. **Per-field Twitch choices.**
   - `ImportChoices.fields` selects which channel fields apply. In `apply.ts`'s channel section, an
     absent `fields` means all of them, so bundle imports are unchanged.
   - Web, in `components/twitch-import/`: a checkbox per field in the preview, each with the
     current and imported value, and the test id `twitch-import-field`.
   - Strings go in `n3-import`, in `en` and `es`.

## Edge cases

- **A lapsed ban on a user with no channel:** no event.
- **A ban cleared by an admin** (not lapsed): the existing paths already write it. Do not duplicate
  them.
- **Two sign-ins at once:** one event.
- **A giveaway export** for a user who entered and was then banned: the entry is still theirs to
  export.
- **Archive cleanup when the storage delete fails:** keep `archive_key` and retry the next day.
- **Record expiry on an import that is still `running` after 30 days:** skip it and log a warn.

## Tests you must add

- **API integration:**
  - the lapsed-ban event at sign-in, exactly once, and once more with the sweep racing it;
  - the surge restart keeping `raid`, and `suppress` clearing it;
  - federation off writing `channel.federation` and no `channel.update`;
  - no `deliver` job queued by the API.
- **Worker integration:**
  - the giveaway export (own rows only, no salt);
  - `staff_action` statements for each source action;
  - archive cleanup (each status, the 24 h boundary, the orphan, a failed delete);
  - record expiry (the 30-day boundary, kept columns, the audit row);
  - federation fan-out from the events (the `Delete` reaches the in-harness peer in the
    `federation` scenario, below);
  - field choices applying only the chosen fields.
- **Email:** the `staff_action` statement in `en` and `es`, with no case id.
- **Web unit:** the field checkboxes, and axe.
- **Harness** `harness/src/b8/server.ts`:
  - `trust-safety`: `sor-staff-action`, `lapsed-ban-signin`;
  - `interact`: `raid-restart-keeps-raid`;
  - `federation`: `actor-disabled-event`. The peer receives the `Delete` after a suspension, and
    the API queued no deliver job;
  - `portability`: `incoming-cleanup`. Use a test hook to age the import;
  - `data-export`: `giveaway-section`;
  - `twitch-import`: `field-choices`, `import-expiry`. Use a test hook to age `finished_at`.
    Ask for any test hook you need as a contract request on `INTERNAL_ROUTES` (the harness hooks),
    with the exact diff.

## Reviewer focus

- The lapsed-ban event fires once, never twice with the sweep.
- The giveaway export holds the caller's own rows only: no other pseudonyms, no salt.
- The federation events are internal, never `channel.update`, and the API no longer queues delivery
  itself.
- The archive cleanup never deletes an import in progress or a fresh upload.
- Twitch data is cleared, but not the audit row or the status.
- The statement email cites no case that does not exist.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api`, `services/worker` and `packages/email`, one at a
  time;
- `bunx tsc -p` for each;
- `bun --bun vp test run` in `apps/web` and `harness`, and `vp build`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user the scenario runs:

```bash
bun harness/src/cli.ts run trust-safety --set b8=sor-staff-action,lapsed-ban-signin
```

```bash
bun harness/src/cli.ts run federation --set b8=actor-disabled-event
```

```bash
bun harness/src/cli.ts run twitch-import --set b8=field-choices,import-expiry
```

Then the user checks the Twitch import preview by hand under `en`, `es` and `en-XA`, at 320 px,
in dark and light themes, keyboard only.
