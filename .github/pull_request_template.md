<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

## What and why

<!-- What does this change do, and why? Link the issue: "Closes #123". -->

## How it was tested

<!-- Tests added, harness scenarios run, manual checks. -->

## Checklist

- [ ] The PR title follows [Conventional Commits](https://www.conventionalcommits.org/) (`type(scope): summary`).
- [ ] Every commit is signed off (`git commit -s`) under the [DCO](https://developercertificate.org/).
- [ ] `bun run verify` is green locally.
- [ ] Tests are added or updated for every behavior change.
- [ ] Docs are updated, and an ADR is added in `docs/decisions/` for any significant decision.
- [ ] No secrets, credentials, or real `.env` files are included.
- [ ] Every new file has an SPDX header (`reuse lint` passes).
- [ ] This does not change a protected setting or its enforcement, or it links the passed governance decision that authorizes it.
