<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2M: Email templates and the OpenTelemetry SDK (`packages/email`, `packages/observability/src/sdk.ts`)

## You own

- `packages/email/**` (new package `@commonair/email`)
- `packages/observability/src/sdk.ts`, `packages/observability/tests/sdk*.test.ts`, and the `dependencies` you add to `packages/observability/package.json` (do not change `logger.ts`, `telemetry.ts`, `index.ts` except to add `export * from "./sdk.ts"` if needed — that one-line change in index.ts is allowed)

## Contracts (read-only)

- `@commonair/config` (`instanceSite`, `SITE`, mailEnv), `packages/observability/src/telemetry.ts` (`registerSdk`, `initTelemetry` — your SDK module calls `registerSdk(...)` on import).

## Build — email

1. React Email templates (`@react-email/components`, `@react-email/render`; verify MIT) in `src/templates/*.tsx`: verify email, magic link sign-in, password reset, two-factor enabled/disabled notice, new sign-in from new device, stream key revoked (leak detected), data export ready (with expiry), account deletion scheduled (with cancel link and date) and completed, payout sent, chargeback/clawback notice, governance: vote opened / result published, council review requested (to council members), DMCA notice received / content restored, appeal decided. Lean, accessible (semantic headings, high contrast, no images required, dark-mode-friendly), **no remote assets** (no tracking pixels, no remote fonts/images; system font stack in email — Rubik is not embedded in emails), plain-text alternative for every template.
2. **i18n-ready**: every template takes a `messages` object (typed per template) plus `locale`; ship English defaults in `src/messages/en.ts`; no inline user-facing literals in the TSX.
3. Instance identity from `instanceSite()` (name, public URL, contacts, source link in the footer — AGPL §13 transparency), never hard-coded.
4. `createMailer(env)` (nodemailer SMTP from `mailEnv`, MIT-0) with `send(template, props, to)` → renders HTML + text, sets `From` (`MAIL_FROM` or instance name + noreply contact), `List-Unsubscribe` where appropriate (governance/announcements), and returns the message id. A `MemoryMailer` for tests.
5. `bun run preview` script rendering all templates with sample props to `packages/email/.preview/*.html` (gitignored by `.preview/` — you own the package, add a package-local `.gitignore`).

## Build — OTel SDK

`src/sdk.ts`: register an SDK init with `registerSdk` using `@opentelemetry/sdk-node` (0.223.0) + OTLP HTTP exporters for traces, metrics and **logs** (so services' structured logs also flow to the collector → Loki): resource attributes (service.name, service.version, deployment.environment), batch processors, periodic metric reader (15 s). Verify it works **under Bun** (sdk-node's auto-instrumentations rely on Node require hooks — do NOT use auto-instrumentations; instead provide manual helpers: `withSpan(name, fn)`, an HTTP server middleware helper for `Bun.serve` fetch handlers that creates server spans with route/status and propagates W3C trace context, and a `fetch` wrapper that injects `traceparent`). Also bridge the existing logger: add an exported `otelLogSink()` that the logger can use as its `write` target in addition to stdout (do not edit logger.ts; offer `createLogger({ ..., write: teeToOtel(stdoutWrite) })` usage in the README).

## Tests

- Email: render every template with sample data; snapshot the text versions; assert no `http(s)://` URLs other than the instance's own public URL and source link appear; assert no `<img` with remote src; i18n: rendering with a dummy locale catalog changes all visible strings; MemoryMailer captures; SMTP integration test sends to Mailpit (`localhost:1025`) and reads it back via its API (`http://localhost:8025/api/v1/messages`, filter by a unique recipient).
- OTel: an in-process OTLP HTTP receiver (Bun.serve) receives spans/metrics/logs from the SDK under Bun; traceparent propagation through the fetch wrapper and server helper.

## Done means

Common rules; READMEs for both.
