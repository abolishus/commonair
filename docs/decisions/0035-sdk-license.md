<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0035: Apache-2.0 for the SDK

- Status: accepted (2026-10-29)
- Date: 2026-10-29

## Context

ADR 0027 §5 adds `@commonair/sdk`, a client library published to npmjs.com: a typed API client,
OAuth helpers (PKCE, device flow, refresh), an EventSub WebSocket client and webhook signature
verification. It left the SDK's licence open. Every package in the repository is
AGPL-3.0-or-later (AGENTS.md rule 1), and the SDK skeleton in E9's contract step was going to
follow until this was decided.

The SDK is different from the rest of the code: third parties embed it in their own bots and apps,
which can carry any licence, open or closed, and run anywhere. An AGPL client library would make
many of those authors license their whole bot under the AGPL or avoid the SDK and hand-roll PKCE,
device polling, refresh rotation, reconnects and signature checks, which is exactly the error-prone
work the SDK exists to remove. The platform's freedoms come from the server being AGPL; a client
that talks to its public API adds nothing to them by being copyleft.

## Decision

`packages/sdk` is licensed **Apache-2.0**. Nothing else changes licence: the platform, the
harness, the other packages and the docs keep their licences (AGENTS.md rule 1).

- **Why Apache-2.0** rather than MIT: it is as permissive for embedders, and it carries an
  explicit patent grant and patent-termination clause, which matters for a library that implements
  protocols (OAuth 2.1, RFC 8628, EventSub).
- **Scope**: `packages/sdk/**` only, including its examples and its README (the npm tarball holds
  one licence). `docs/developers/sdk.md` stays CC-BY-SA-4.0 like every other doc.
- **Contributions** to the SDK are still made under the DCO (`git commit -s`), like the rest of the
  repository. Contributors license their SDK changes under Apache-2.0.
- **REUSE.** `LICENSES/Apache-2.0.txt` (from `reuse download Apache-2.0`); every file under
  `packages/sdk/` that can carry a header has an `SPDX-License-Identifier` of `Apache-2.0`; a `REUSE.toml`
  annotation with `precedence = "override"` covers `packages/sdk/**`, so its JSON files are not
  caught by the repository-wide `**/package.json` and `**/*.json` AGPL annotation.
- **License check.** `scripts/check-licenses.ts` no longer skips our own packages blindly: it
  checks that `@commonair/sdk` declares `Apache-2.0` and every other `@commonair/*` package
  declares `AGPL-3.0-or-later`. The SDK's own `tests/license.test.ts` checks what that script
  cannot: headers, runtime dependencies (allowlisted and compatible with Apache-2.0) and the files
  the build inlines.
- **Inlined contract code.** `@commonair/contracts` is private, so the build inlines the parts the
  SDK needs (schemas, OAuth and EventSub helpers, the contract type) into the published bundle
  (ADR 0027 §5). Those files are AGPL-3.0-or-later today, and a bundle that contains them could
  not be offered under Apache-2.0 alone. The contract files the bundle pulls in (the exact list
  comes from the build's metafile, E9-sdk) are therefore dual-licensed
  `AGPL-3.0-or-later OR Apache-2.0`. The maintainer confirms that change before the first publish;
  every contribution to those files so far is the maintainer's, under the DCO, so no other consent
  is needed today. Any later contributor to a dual-licensed file contributes under both.
- **Publishing.** The package is `"private": false`, but nothing is published until the maintainer
  creates the `@commonair` npm organisation and adds `sdk-publish.yml` as the trusted publisher
  (ADR 0027 §5). Only `packages/sdk/dist` is ever published.

## Consequences

- Bot and app authors can depend on `@commonair/sdk` under any licence, keeping only the Apache-2.0
  notice and licence text.
- Changes to the SDK cannot be required to stay open; changes to the platform still are, because
  the server stays AGPL-3.0-or-later.
- Two licences in one repository: the REUSE annotation, the SPDX headers and the two licence
  checks keep the boundary at `packages/sdk/**` and the dual-licensed contract files. A new
  contract file the SDK starts inlining needs the dual licence first, and the SDK's licence test
  fails until it has it.
- ADR 0027's consequence "The SDK is AGPL-3.0-or-later like every package" is superseded by this
  ADR.

## Alternatives considered

- **AGPL-3.0-or-later like every package.** Rejected: it deters the bot and app authors the SDK is
  for, and protects nothing the AGPL server does not already protect.
- **MIT.** As permissive, but no patent grant.
- **LGPL-3.0 or MPL-2.0.** Weak copyleft keeps changes to the SDK open, but bundlers and closed
  apps make the obligations hard to follow, and the gain is small for a thin client.
