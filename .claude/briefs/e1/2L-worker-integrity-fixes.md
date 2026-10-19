<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# 2L worker integrity — review fixes

You are implementing the review fixes for the worker integrity unit of CommonAir (worktree
/Users/joshe/Repos/bcon/.claude/worktrees/agent-a07b926d662d5d4bd, branch
`worktree-agent-a07b926d662d5d4bd`). Read AGENTS.md, PLAN.md, docs/architecture.md and
`.claude/briefs/e1/2L-worker-integrity.md` first. Do not look outside the repository. Work only in
the worktree path above. Start with `git merge main --no-edit`.

## You own (write only these)

- `services/worker/**`
- `harness/scenarios/integrity-basic.ts`

## Contracts you must honor (read-only for you)

- `packages/integrity`, `packages/contracts`, `packages/config`, `services/origin`.

## Build

1. **(MED) No double evidence on ack failure.** `services/worker/src/segments/consumer.ts` (~line 162,
   `processResilient`): when `writeAggregate` + `recordFetches` succeed but `xack` fails, the
   batch-level catch re-applies every entry. Make the ack retried/isolated on its own (an ack
   failure must not re-run aggregation or evidence recording in this process). Fix the comment that
   claims a committed batch is never re-applied (XAUTOCLAIM after a crash before the ack can still
   redeliver; say so honestly).
2. **(LOW-MED) Tests for the evidence failure path**: a unit test where `recordFetches`'s Valkey
   `multi`/exec rejects → warn log + `outcome:"failed"` metric, batch still acked, no throw; and a
   test for the ack-failure path from item 1 (aggregate/evidence applied exactly once).
3. **(LOW) Lock lapses are visible**: `services/worker/src/integrity/lock.ts` — a failed renewal or
   reaching `maxHoldMs` logs a warning (structured, job name only) and increments
   `worker.integrity.runs{outcome:"lock_lapsed"}`. Test it.
4. **(LOW) Classifier reload keeps a good list**: `services/worker/src/integrity/classifier.ts` —
   if a reload parses to 0 ranges while the previous list had some, keep the previous list and
   warn. Test it. Document atomic replacement (rename) for operators in the worker README.
5. **(LOW) Harness guard**: `harness/scenarios/integrity-basic.ts` — before asserting every bot is
   excluded from Postgres rows, assert the number of bot rows found equals the number of bots with
   a clear message ("DATABASE_URL does not point at the stack under test?").
6. **Docs**: add/extend `services/worker/README.md` with the integrity jobs (names, intervals,
   batch caps, run locks, metrics, the scheduled-job retry/backoff behavior, SIGHUP reload).

## Tests you must add

- Items 2, 3 and 4 above, as unit tests (integration tests if a real Valkey is needed; Valkey is
  running at the `.env.example` default).

## Done means

- `bun run verify --quick` passes plus `cd services/worker && bun run test:int` (Postgres/Valkey are
  up with the `.env.example` defaults; if a port differs read `/Users/joshe/Repos/bcon/.env`).
- No files outside your ownership list changed (`git status`).
- Do not run `podman compose` (the head agent rebuilds images).
- Commit in the worktree with `git commit -s` (Conventional Commits, e.g.
  `fix(worker): …`), ending the message with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Only commit if the gate is green
  (check the exit code).
- Final message: what changed, test counts, anything left undone.
