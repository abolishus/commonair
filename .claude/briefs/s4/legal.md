<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **legal documents (seed drafts + API)** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md ("Open items": `legal.current` has no seed docs
locally), docs/architecture.md, ADR 0001 (name/identity) and GOVERNANCE.md first. Do not look
outside the repository. You work in your own git worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `packages/db/src/legal/**` (new: the draft documents and their loader)
- `packages/db/src/seed.ts` (add the legal seed next to the governance seed; keep its
  insert-if-absent behavior) and `packages/db/tests/seed*.int.test.ts`
- `services/api/src/routes/legal.ts`, `services/api/src/lib/legal.ts`,
  `services/api/tests/legal*.test.ts`

## Contracts you must honor (read-only for you)

- `legal.current` / `legal.get` / `legal.consent` in `packages/contracts/src/api/router.ts`,
  `LegalDocument` DTO, `LEGAL_DOCUMENT_KINDS` (`terms`, `privacy`, `guidelines`, `cookies`,
  `dmca_policy`), tables `legal_documents` (`is_draft`, `requires_acceptance`, unique
  `(kind, version)`), `legal_acceptances`, the consent table (find it in `packages/db/src/schema`).
- Identity rules: the instance name/contacts come from `instanceSite()` / `SITE` at runtime — never
  hardcode the domain or emails (`scripts/check-domains.ts` fails on stray literals). Write
  placeholders like `{{instanceName}}`, `{{contacts.privacy}}`, `{{contacts.dmca}}` in the bodies and
  render them in the API from the instance env.
- Other units edit `services/api/tests/round3.int.test.ts`, `services/chat`, `packages/governance`,
  `packages/integrity`, `services/worker`, `services/tracker`, `services/media`, `apps/web` in
  parallel. Do not touch them.

## Build

1. **Draft documents** (Markdown, CC-BY-SA-4.0 SPDX headers, in English) for all five kinds,
   version `2026-10-18-draft`, `is_draft = true`, each opening with a clear "Draft pending lawyer
   review" notice. Content fit for a member-owned, AGPL, no-tracker streaming co-op: terms
   (13+ gate, mature content, relays/P2P bandwidth sharing, co-op membership pointer), privacy
   (data we keep, IP hashing, integrity signals, retention, export and deletion with
   pseudonymized retention per ADR 0004, no third-party trackers), community guidelines,
   cookies/storage (first-party only, consent choices), DMCA/copyright policy with
   counter-notice. `requires_acceptance`: terms, privacy, guidelines = true; cookies,
   dmca_policy = false. Keep each reasonable (roughly 300–900 words).
2. **Seed**: insert-if-absent by `(kind, version)` from the loader; the seed must work inside the
   migrate container (bundle the text as TS string modules or read files relative to
   `import.meta.dir` — check how the migrate image/`packages/db` is packaged and pick what works).
3. **API**: implement `legal.current` (latest published version per kind, placeholders rendered),
   `legal.get` (current or a specific version, 404 otherwise), `legal.consent` (store choices for
   the signed-in user or `anonymousId`; validate `policyVersion` against the current cookies
   document; rate-limit as `write` if the meta allows, else note it as a contract request).
   Check that sign-up's existing legal acceptance (`services/api/src/lib/legal.ts`) works with
   the seeded drafts.

## Tests you must add

- Seed integration test: seeding twice inserts once; every kind present.
- API tests: current returns five kinds with placeholders rendered (no `{{` left), get by
  version/404, consent stored for signed-in and anonymous callers, wrong `policyVersion` → 400.

## Done means (session four process rules — every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers and every browser/visual check. You do not. Run:
  your packages' `bun run test` and `bun run test:int` (the data services are already up at the
  `.env.example` defaults; never run `podman compose` or `scripts/infra.ts`), `bunx tsc -p <pkg>
  --noEmit`, `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`, `vp build` for
  `apps/web`, `go test ./...` / `go vet ./...` for `relay/`. Do not run several packages'
  `test:int` at the same time (shared Postgres/Valkey load makes timing tests flaky).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.
