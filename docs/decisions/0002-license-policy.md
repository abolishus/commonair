<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0002: Dependency license policy

- Status: accepted
- Date: 2026-10-18 (licenses below verified on this date)

## Context

CommonAir is AGPL-3.0-or-later and run by a cooperative. Anyone must be able to
run, study, modify and redistribute the whole stack without a proprietary
licence or a vendor's permission. Several popular infrastructure projects have
moved to source-available licenses (BUSL, SSPL, Elastic, RSAL, Commons Clause),
and some libraries ship free and paid tiers under one name. We need a rule that
a machine can enforce and that a reviewer can audit.

## Decision

Every dependency, including dev and build-only tools, must be under an
OSI-approved license. The allowlist lives in `scripts/licenses.ts`:

MIT, MIT-0, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD, ISC, MPL-2.0,
LGPL-2.1-only/-or-later, LGPL-3.0-only/-or-later, GPL-2.0-only/-or-later,
GPL-3.0-only/-or-later, AGPL-3.0-only/-or-later, OFL-1.1, Unlicense,
BlueOak-1.0.0, Zlib, Python-2.0, BSL-1.0 (Boost, not Business Source),
PostgreSQL.

Always denied, even if someone adds them to the allowlist by mistake: BUSL-\*,
SSPL-\*, Elastic-\*, RSAL, anything with Commons Clause, CC-BY-NC-\*,
PolyForm-\*.

SPDX expressions are evaluated: `OR` needs one allowed side, `AND` needs both,
`WITH <exception>` keeps the base license (exceptions only add permissions).

CI enforcement (`scripts/check-licenses.ts`, run by `scripts/verify.ts`):

1. **npm**: every installed `package.json` in every workspace's `node_modules`
   (including Bun's `.bun` store and dev dependencies). Our own `@commonair/*`
   packages are skipped; `reuse lint` covers them.
2. **Container images**: every `image:` in `compose.yaml` must be fully
   qualified and have an entry in `infra/image-licenses.json` (license, source
   URL of the LICENSE checked, pinned tag, notes) whose license passes the
   allowlist. Images we build ourselves (templated `${...}` tags) are covered by
   their inputs.
3. **Go**: the relay is stdlib-only by default. Any module that appears in
   `go list -m all` must be listed in `relay/module-licenses.json` with an
   allowed license.

A failure blocks the merge. Adding an allowlist id or a per-package exception
needs an amendment to this ADR.

## Judgment calls

- **Data-only packages** (explicit per-package exceptions in
  `scripts/licenses.ts`): `caniuse-lite` (CC-BY-4.0 browser-support table),
  `spdx-license-ids` (CC0-1.0), `spdx-exceptions` (CC-BY-3.0). These are
  non-code data used at build time. CC licenses are not OSI licenses, but they
  are free-culture licenses that grant every right we need; we do not extend
  this to code.
- **FFmpeg** is installed from Debian trixie packages in our own Bun-based media
  image. Debian builds the standard flavour with `--enable-gpl` (libx264,
  libx265), so the binaries are GPL-2.0-or-later (the optional
  `libavcodec-extra` flavour adds `--enable-version3`, making it
  GPL-3.0-or-later). We run it as a separate process and both are compatible
  with AGPL-3.0-or-later. We publish the image's source (Dockerfile plus Debian
  source package references).
- **Grafana, Loki, Tempo** (AGPL-3.0-only) and **Garage** (AGPL-3.0-only) run
  unmodified as separate programs that we talk to over the network. Their
  license does not change ours. Only `grafana/grafana` (OSS) is allowed;
  `grafana/grafana-enterprise` is proprietary and must never be used.
- **Bun** is MIT but statically links JavaScriptCore/WebKit (LGPL-2.0-or-later,
  relinkable as described in Bun's `LICENSE.md`). LGPL-2.0-or-later is
  OSI-approved; the image entry records `MIT AND LGPL-2.0-or-later`, so
  `LGPL-2.0-or-later` must be added to the allowlist before `oven/bun` is
  referenced directly in `compose.yaml`.
- **Unlicense** (`postgres` npm package) and the **PostgreSQL License** are both
  OSI-approved and allowed.
- **Hugeicons**: only `@hugeicons/core-free-icons` and `@hugeicons/react` are
  allowed. Both are MIT (the package `LICENSE.md` and README say the icons and
  the code are MIT). Hugeicons Pro (sold separately) is not open source
  and is forbidden.
- **Rubik** (`@fontsource-variable/rubik`): the package is OFL-1.1 (font
  files). Fontsource's build tooling is MIT.
- **Vite+** (`vite-plus`, `@voidzero-dev/vite-plus-core`, and the
  `@voidzero-dev/vite-plus-<platform>` native binaries) is MIT at v1.3.0.
  Its bundled third-party code is MIT, ISC, BlueOak-1.0.0, Apache-2.0,
  BSD-2-Clause and one CC0-1.0 file (`string-hash`). These are listed in the
  package `LICENSE` and are not separate npm packages, so the checker does not
  see them. None is proprietary.
- **drizzle-kit** says `MIT` in `package.json` and ships no LICENSE file. Its
  source lives in the `drizzle-orm` repository, which is Apache-2.0. Both are
  allowed; we record the package as MIT per its metadata.
- **`node-datachannel`** (MPL-2.0; a transitive dependency of the
  `bittorrent-tracker` client side) declares `"MPL 2.0"`, which is not a valid
  SPDX id. If it gets installed, add an alias `"MPL 2.0" → "MPL-2.0"` rather
  than an exception.
- **Open-core vendors** (BullMQ/BullMQ Pro, Hugeicons/Hugeicons Pro): we use
  only the MIT packages listed below, never the paid tiers.

## Verified licenses

Checked from the repository LICENSE at the release tag, or from the LICENSE
inside the published npm tarball.

### Container images and services

| Component                         | Version            | License                   | Source                                                                                   |
| --------------------------------- | ------------------ | ------------------------- | ---------------------------------------------------------------------------------------- |
| PostgreSQL                        | 17.11              | PostgreSQL                | https://github.com/postgres/postgres/blob/REL_17_11/COPYRIGHT                            |
| Valkey                            | 9.1.2              | BSD-3-Clause              | https://github.com/valkey-io/valkey/blob/9.1.2/COPYING                                   |
| Garage                            | v2.4.1             | AGPL-3.0-only             | https://github.com/deuxfleurs-org/garage/blob/v2.4.1/LICENSE                             |
| MediaMTX                          | 1.21.2             | MIT                       | https://github.com/bluenviron/mediamtx/blob/v1.21.2/LICENSE                              |
| Mailpit                           | v1.31.6            | MIT                       | https://github.com/axllent/mailpit/blob/v1.31.6/LICENSE                                  |
| Grafana OSS                       | 13.2.4             | AGPL-3.0-only             | https://github.com/grafana/grafana/blob/v13.2.4/LICENSE                                  |
| Prometheus                        | v3.15.0            | Apache-2.0                | https://github.com/prometheus/prometheus/blob/v3.15.0/LICENSE                            |
| Loki                              | 3.7.8              | AGPL-3.0-only             | https://github.com/grafana/loki/blob/v3.7.8/LICENSE                                      |
| Tempo                             | 3.1.0              | AGPL-3.0-only             | https://github.com/grafana/tempo/blob/v3.1.0/LICENSE                                     |
| OpenTelemetry Collector (contrib) | 0.163.1            | Apache-2.0                | https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.163.1/LICENSE |
| Caddy                             | 2.11.7             | Apache-2.0                | https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE                                |
| stripe-mock                       | v0.206.0           | MIT                       | https://github.com/stripe/stripe-mock/blob/v0.206.0/LICENSE                              |
| Bun                               | 1.4.3              | MIT AND LGPL-2.0-or-later | https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md                                |
| Go toolchain                      | 1.27.2             | BSD-3-Clause              | https://github.com/golang/go/blob/go1.27.2/LICENSE                                       |
| distroless static                 | debian13 / nonroot | Apache-2.0                | https://github.com/GoogleContainerTools/distroless/blob/main/LICENSE                     |
| Alpine (musl, BusyBox)            | 3.24.2             | MIT AND GPL-2.0-only      | https://git.musl-libc.org/cgit/musl/plain/COPYRIGHT                                      |
| Playwright image                  | v1.64.1-noble      | Apache-2.0                | https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE                             |
| WAL-G                             | v3.0.9             | Apache-2.0                | https://github.com/wal-g/wal-g/blob/v3.0.9/LICENSE.md                                    |
| pgBackRest (alternative)          | 2.60.0             | MIT                       | https://github.com/pgbackrest/pgbackrest/blob/release/2.60.0/LICENSE                     |
| bittorrent-tracker                | 11.2.3             | MIT                       | https://github.com/webtorrent/bittorrent-tracker/blob/v11.2.3/LICENSE                    |
| aquatic (not used)                | v0.9.0             | Apache-2.0                | https://github.com/greatest-ape/aquatic/blob/v0.9.0/LICENSE                              |
| FFmpeg (Debian trixie build)      | 7.1.x              | GPL-2.0-or-later          | https://salsa.debian.org/multimedia-team/ffmpeg/-/blob/debian/trixie/debian/rules        |

### npm packages

| Package                                                                       | Version           | License        | Source                                                                               |
| ----------------------------------------------------------------------------- | ----------------- | -------------- | ------------------------------------------------------------------------------------ |
| @tanstack/react-start, react-router                                           | 1.169.3, 1.170.45 | MIT            | https://github.com/TanStack/router/blob/main/LICENSE                                 |
| @tanstack/react-query                                                         | 5.104.4           | MIT            | https://github.com/TanStack/query/blob/main/LICENSE                                  |
| @tanstack/react-form                                                          | 1.33.5            | MIT            | https://github.com/TanStack/form/blob/main/LICENSE                                   |
| @tanstack/react-table                                                         | 9.3.1             | MIT            | https://github.com/TanStack/table/blob/main/LICENSE                                  |
| @tanstack/react-virtual                                                       | 3.14.21           | MIT            | https://github.com/TanStack/virtual/blob/main/LICENSE                                |
| tailwindcss, @tailwindcss/vite                                                | 4.3.3             | MIT            | https://github.com/tailwindlabs/tailwindcss/blob/main/LICENSE                        |
| shadcn                                                                        | 4.22.1            | MIT            | https://github.com/shadcn-ui/ui/blob/main/LICENSE.md                                 |
| @base-ui/react                                                                | 1.9.0             | MIT            | https://github.com/mui/base-ui/blob/master/LICENSE                                   |
| @hugeicons/react, @hugeicons/core-free-icons                                  | 1.1.10, 4.3.5     | MIT            | https://github.com/hugeicons/hugeicons/blob/main/packages/core-free-icons/LICENSE.md |
| @fontsource-variable/rubik                                                    | 5.3.0             | OFL-1.1        | package tarball `LICENSE`                                                            |
| sonner                                                                        | 2.0.8             | MIT            | https://github.com/emilkowalski/sonner/blob/main/LICENSE.md                          |
| cmdk (used by shadcn `command`)                                               | 1.1.1             | MIT            | https://github.com/dip/cmdk/blob/main/LICENSE.md                                     |
| class-variance-authority                                                      | 0.7.1             | Apache-2.0     | https://github.com/joe-bell/cva/blob/main/LICENSE                                    |
| clsx                                                                          | 2.1.1             | MIT            | https://github.com/lukeed/clsx/blob/master/license                                   |
| tailwind-merge                                                                | 3.7.0             | MIT            | https://github.com/dcastil/tailwind-merge/blob/main/LICENSE.md                       |
| tw-animate-css                                                                | 1.4.0             | MIT            | https://github.com/Wombosvideo/tw-animate-css/blob/main/LICENSE                      |
| @orpc/server, client, contract, openapi, zod, tanstack-query                  | 1.15.7            | MIT            | https://github.com/middleapi/orpc/blob/main/LICENSE                                  |
| zod                                                                           | 4.6.7             | MIT            | https://github.com/colinhacks/zod/blob/main/LICENSE                                  |
| drizzle-orm                                                                   | 0.45.4            | Apache-2.0     | https://github.com/drizzle-team/drizzle-orm/blob/0.45.4/LICENSE                      |
| drizzle-kit                                                                   | 0.31.11           | MIT (metadata) | https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-kit/package.json       |
| postgres                                                                      | 3.4.9             | Unlicense      | https://github.com/porsager/postgres/blob/v3.4.9/UNLICENSE                           |
| iovalkey                                                                      | 0.4.0             | MIT            | https://github.com/valkey-io/iovalkey/blob/main/LICENSE                              |
| bullmq                                                                        | 6.3.16            | MIT            | https://github.com/taskforcesh/bullmq/blob/master/LICENSE                            |
| better-auth, @better-auth/passkey                                             | 1.7.10            | MIT            | https://github.com/better-auth/better-auth/blob/main/LICENSE.md                      |
| react, react-dom                                                              | 19.3.1            | MIT            | https://github.com/react/react/blob/main/LICENSE                                     |
| @react-email/components, @react-email/render                                  | 1.0.12, 2.1.1     | MIT            | https://github.com/resend/react-email/blob/canary/LICENSE.md                         |
| nodemailer                                                                    | 10.1.7            | MIT-0          | https://github.com/nodemailer/nodemailer/blob/master/LICENSE                         |
| hls.js                                                                        | 1.7.3             | Apache-2.0     | https://github.com/video-dev/hls.js/blob/master/LICENSE                              |
| p2p-media-loader-core, -hlsjs                                                 | 4.0.0             | Apache-2.0     | https://github.com/Novage/p2p-media-loader/blob/main/LICENSE                         |
| altcha, altcha-lib                                                            | 3.4.0, 2.6.0      | MIT            | https://github.com/altcha-org/altcha/blob/main/LICENSE.txt                           |
| stripe                                                                        | 23.0.0            | MIT            | https://github.com/stripe/stripe-node/blob/master/LICENSE                            |
| tmi.js                                                                        | 1.8.5             | MIT            | https://github.com/tmijs/tmi.js/blob/main/LICENSE                                    |
| @playwright/test                                                              | 1.64.1            | Apache-2.0     | https://github.com/microsoft/playwright/blob/v1.64.1/LICENSE                         |
| storybook, @storybook/react-vite                                              | 10.6.2            | MIT            | https://github.com/storybookjs/storybook/blob/v10.6.2/LICENSE                        |
| @opentelemetry/api                                                            | 1.9.1             | Apache-2.0     | https://github.com/open-telemetry/opentelemetry-js/blob/main/LICENSE                 |
| @opentelemetry/sdk-node, exporter-trace-otlp-http, exporter-metrics-otlp-http | 0.223.0           | Apache-2.0     | https://github.com/open-telemetry/opentelemetry-js/blob/main/LICENSE                 |
| @opentelemetry/auto-instrumentations-node                                     | 0.81.2            | Apache-2.0     | https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/LICENSE         |
| pino                                                                          | 10.4.0            | MIT            | https://github.com/pinojs/pino/blob/main/LICENSE                                     |
| aws4fetch (chosen over @aws-sdk/client-s3 3.1152.0, Apache-2.0)               | 1.0.20            | MIT            | https://github.com/mhart/aws4fetch/blob/master/LICENSE                               |
| @cyclonedx/cyclonedx-npm                                                      | 6.0.1             | Apache-2.0     | https://github.com/CycloneDX/cyclonedx-node-npm/blob/main/LICENSE                    |
| ws                                                                            | 8.22.0            | MIT            | https://github.com/websockets/ws/blob/master/LICENSE                                 |
| prom-client                                                                   | 15.1.3            | Apache-2.0     | https://github.com/prometheus/client_js/blob/main/LICENSE                            |
| croner                                                                        | 10.0.1            | MIT            | https://github.com/Hexagon/croner/blob/master/LICENSE                                |
| @simplewebauthn/server                                                        | 14.0.3            | MIT            | https://github.com/MasterKale/SimpleWebAuthn/blob/master/LICENSE.md                  |
| uuidv7 (chosen over ulid 3.0.2, MIT)                                          | 1.2.1             | Apache-2.0     | https://github.com/LiosK/uuidv7/blob/main/LICENSE                                    |
| @noble/ed25519, @noble/curves                                                 | 3.2.0, 2.4.0      | MIT            | https://github.com/paulmillr/noble-curves/blob/main/LICENSE                          |
| msw                                                                           | 3.0.3             | MIT            | https://github.com/mswjs/msw/blob/main/LICENSE.md                                    |
| vite-plus, @voidzero-dev/vite-plus-core, native binaries                      | 1.3.0             | MIT            | https://github.com/voidzero-dev/vite-plus/blob/v1.3.0/LICENSE                        |

## Consequences

- Each new dependency or image adds an entry, or CI fails. Image entries record
  the LICENSE URL that was actually read.
- We cannot adopt source-available infrastructure (for example Redis 7.4.x
  under RSAL/SSPL, or BUSL-licensed tools) or paid icon/UI tiers.
- AGPL services are run unmodified. If we ever patch Garage, Grafana, Loki or
  Tempo, we publish the patched source alongside our own.
- GPL FFmpeg and LGPL WebKit (inside Bun) make us publish the Dockerfiles and
  source references for the media image, which our AGPL obligations already
  require.
- `tmi.js` has had no stable release since 2021 (1.8.5). Its license is fine,
  but it is a maintenance risk; keep it behind an adapter.
- Licenses can change between releases. We re-verify on major upgrades and
  when the checker flags a change.
