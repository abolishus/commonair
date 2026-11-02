<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-release-prep: upgrade from a published release, the `v0.1.0` changelog, current self-hosting docs

You are implementing unit R0-release-prep for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U2, U3, U4 and U5, "What U4 changes", the path
  ownership and the shared rules are binding.
- `.claude/briefs/next/R0-release.md`. §3 is the real-server list, and "Done means" includes the
  "ten green main runs" rule.
- ADR 0023 (releases and signing), `docs/self-hosting/verifying.md` and
  `docs/self-hosting/upgrades.md`.
- `.claude/briefs/s1/S1-b-external.md`, merged in wave 1.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`r0/release-prep`, cut from `main` after wave 1 merged. S1-h runs beside you and owns
`docs/self-hosting/{backups,managed-services}.md` and the dump e2e files.

## Why

U2: rc.3 is cut from `main` once batch 8's dispatch run is green, installed fresh on the staging
droplet, taken through R0 §3, and `v0.1.0` is tagged from the same commit. Three things stand in the
way, and engineering can fix them:

1. **The e2e has never upgraded from a published release.** It builds two releases of the same tree
   and upgrades between them (`scripts/selfhost/e2e.ts:24-31`). A stranger upgrades from what we
   published, signed, on ghcr.
2. **`CHANGELOG.md` holds only the Phase 0 scaffolding** under `[Unreleased]`. Nothing from Phases
   1–5 or batches 1–8 is there.
3. **The self-hosting docs predate batches 2–7.** They do not cover whisper captions, coturn, web
   push, federation, the Twitch import flags, or batch 8's external state.

U3 also changes the cadence after `v0.1.0`: a minor every two weeks from the newest commit with a
green full dispatch run. So the changelog tooling must run from tags, not batches.

## You own (write only these)

- `scripts/selfhost/e2e.ts` (from S1-b, who owned it in wave 1) and
  `scripts/selfhost/e2e-from-release.ts` (new).
- `docs/self-hosting/**`, except `backups.md` and `managed-services.md` (S1-h's).
- `CHANGELOG.md`.
- `scripts/release/changelog.ts`.
- `docs/operators/flakes.md` (new): the flake log.
- Tests named after these files.

**Read-only:** `scripts/selfhost.sh`, `.github/**`, `scripts/release/**` except `changelog.ts`,
`ROADMAP.md`, and `infra/**`. Anything else is a **contract request**, for example a CI job for the
from-release mode (send the exact diff).

## Build

1. **`e2e.ts --from-release <tag>`** (logic in `e2e-from-release.ts`):
   - download the published bundle, `SHA256SUMS` and its `.sigstore.json` for `<tag>` from the
     GitHub release;
   - verify them **exactly** as `verifying.md` tells a stranger to: `cosign verify-blob` with the
     certificate identity and issuer from that page, then `sha256sum -c`;
   - install with `selfhost.sh install --version <tag> --require-signature`;
   - seed a little data (a user, a channel, a follow, a ledger posting through the API);
   - upgrade to the candidate built from the tree, as today's step 4 does;
   - check that the data survived, `migrate` ran once, and `status` reports the new version;
   - then roll back as today.
     Run it first with `v0.1.0-rc.2`. The images come from ghcr, so it needs network access. Mark
     the mode so CI can run it on the `workflow_dispatch` run only.
2. **If rc.2 cannot be upgraded from**, for example because a migration assumes a later state or an
   env key was renamed, record exactly what blocks it, with the fix or a decision proposal, in your
   final message. The README milestone accepts "passes, or what blocks it is recorded with a
   decision". Do not paper over it in the e2e.
3. **The `v0.1.0` changelog.** Write `## [0.1.0] - unreleased` in Keep a Changelog form. Cover:
   - Phase 1 (the platform);
   - Phases 2–5 as they shipped;
   - batches 1–8: R0, S1, E7–E9, N1–N4, P1, W0–W3 and M1.
     Group by user-facing area: streaming and playback, chat, money, co-op, safety, federation and
     portability, self-hosting, developer platform. Build it from PROGRESS.md and the ADRs, not from
     commit subjects. Keep the rc.1 and rc.2 sections short, pointing at their tags.
4. **`changelog.ts` for U3's cadence.**
   - Add `--since-tag` (default: the newest `v*` tag that is not a prerelease), so a release every
     two weeks gets notes since the last minor.
   - Add a `--check` mode that fails if `CHANGELOG.md` has no section for `--version`. The
     orchestrator can add it to `release.yml` (send a contract request).
5. **The self-hosting docs reading pass.** Read every page under `docs/self-hosting/` against the
   code at HEAD, and fix what is stale. At least these:
   - **captions:** `--captions` and the AVX2 check (`captions.md`);
   - **TURN:** `--turn-relay` (`p2p.md`), including the DigitalOcean firewall's relay range, a
     carried item;
   - **web push:** `--web-push` (`web-push.md`);
   - **federation and the Twitch import:** both off by default. Say what turning them on needs,
     linking ADRs 0030 and 0031, in `configuration.md`. S1-b also edited that page in wave 1, so
     extend it, do not rewrite it;
   - **external Postgres and Valkey** (S1-b) and the dumps (S1-h): link `managed-services.md` from
     `README.md`, `install.md` and `requirements.md`;
   - **verifying a release** with cosign 3.x, and checking that the identity strings match
     `release.yml`;
   - **`upgrades.md`:** the release cadence (U3: a minor every two weeks, patches as needed) and
     upgrading across several minors.
     Every command in the docs must be one the code accepts. Write a test that extracts the
     `selfhost.sh` flags from the docs' code blocks and checks that each is in `parse_flags` and
     `usage`.
6. **The flake log** (`docs/operators/flakes.md`). This is R0's "ten green main runs" rule.
   - A table of runs since batch 8's contract step: the run id, the sha, green or not, and which
     known flake recurred.
   - The README's flake watch list (`clock-mediamtx.int`, `media.int` "T0 live", the moderation
     ONNX, the transcode ladder) and R0's two (ingest-whip, integrity-basic).
   - Fill it from `gh run list --branch main --workflow ci` as far as the data allows, and explain
     how the orchestrator keeps it.

## Edge cases

- **The release asset names** must match what `release.yml` publishes. Read them from the release,
  not from a hard-coded list, and fail clearly if one is missing.
- **A cosign identity that changes between releases** (workflow path or ref): the from-release mode
  verifies with the identity that was right for that tag. Document how.
- **A rate-limited ghcr pull:** retry with backoff. The optional Zot mirror from R0-e still works.
- **Offline runs:** `--from-release` refuses with a clear message instead of hanging.

## Tests you must add

- **Unit:**
  - the release asset selection;
  - the verify command lines (identity, issuer);
  - `--since-tag` selection over prerelease and release tags;
  - `--check`;
  - the docs flag test above.
- **The from-release e2e itself:** run locally only if it is a reasonable targeted check, because
  it pulls every image. Otherwise give the exact command for CI and for the agent track.

## Reviewer focus

- The from-release mode verifies signatures and checksums exactly as `verifying.md` says.
- The changelog covers Phases 1–5 and batches 1–8 in user terms.
- The docs cover every service and flag added since rc.2, and every documented command exists.
- The flake log is accurate against the run history.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run scripts/selfhost scripts/release`;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message gives:

- the CI diff for the from-release mode;
- the rc.2 result or blocker;
- the commands for the release hand-off.

The commands for the release hand-off:

```bash
sudo bun scripts/selfhost/e2e.ts --distro debian --from-release v0.1.0-rc.2
```

```bash
bun scripts/release/changelog.ts --version 0.1.0 --check
```
