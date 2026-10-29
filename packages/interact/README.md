<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/interact

Interactivity domain code (E8, ADR 0026) that both the API and the worker need: ending a poll,
locking and resolving a prediction, cancelling or executing a raid, ending a goal, the views and
the event payload builders. The worker cannot import `services/api`, so these rules live here
once. `src/index.ts` and `src/outbox.ts` (`emitEvent`, `broadcasterFields`, `userFields`,
`pointsChangePayload`) belong to the orchestrator and are read-only for the units;
`src/polls.ts` and `src/predictions.ts` are E8-polls', `src/raids.ts` and `src/goals.ts`
E8-raids-goals', and `src/accrual.ts` E8-points'. Each unit adds its own `tests/<file>.test.ts`
and `tests/<file>.int.test.ts`. Points move only through `postPointsInTx` in `@commonair/db`.
