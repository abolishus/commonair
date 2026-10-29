<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0034: CodeQL for static analysis in CI

- Status: accepted (2026-10-29)
- Date: 2026-10-29

## Context

The OpenSSF Scorecard SAST check scored 0: nothing analysed the code for security bugs beyond
lint and type checks. Scorecard recognises a short list of analysers (CodeQL, SonarCloud, Snyk,
Qodana, Pysa). CodeQL is the only one that covers TypeScript, Go and GitHub Actions workflows,
runs entirely inside GitHub Actions with no account or token, and costs nothing for public
repositories.

CodeQL is not open source. Its CLI and query engine are under the GitHub CodeQL Terms and
Conditions, which allow use on open-source code; only the queries (`github/codeql`) and the
Action (`github/codeql-action`) are MIT. That conflicts with the spirit of rule 2 in AGENTS.md
(OSI licenses only), which is written for dependencies of the platform.

## Decision

Run CodeQL (`.github/workflows/codeql.yml`) on pushes and pull requests to `main` and weekly, for
`javascript-typescript`, `go` and `actions`, with the `security-extended` query suite. Findings go
to the repository's Security tab.

This is allowed because it is a CI service, like the GitHub-hosted runners themselves, and not a
dependency: nothing in the platform, the harness, `selfhost.sh` or the verification gate needs it.
`bun run verify` does not run it, and a fork or a mirror off GitHub loses nothing but this report.
The Action is pinned to a commit SHA like every other (ADR 0022).

## Consequences

- A second opinion on taint-style bugs (injection, path traversal, SSRF, unsafe redirects)
  across the API, workers, relay and workflows, and a non-zero Scorecard SAST score.
- Findings do not block a push. Each new alert is triaged: fixed, or dismissed in the Security
  tab with a reason.
- If an OSI-licensed analyser that Scorecard recognises becomes available (Semgrep CE is
  LGPL-2.1 but not recognised today), it can replace CodeQL without changing anything else.
