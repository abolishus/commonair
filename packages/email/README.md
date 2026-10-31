<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/email

Transactional and member email for CommonAir: React Email templates, message catalogs (English
and Spanish, every locale bundled), and an SMTP mailer (nodemailer).

## Sending

```ts
import { coreEnv, instanceSite, loadEnv, mailEnv } from "@commonair/config";
import { createMailer } from "@commonair/email";

const site = instanceSite(loadEnv(coreEnv));
const mailer = createMailer(loadEnv(mailEnv), { site /*, catalogs: { de, fr } */ });

const messageId = await mailer.send(
  "passwordReset",
  { resetUrl: `${site.publicUrl}/reset-password?token=…`, expiresInMinutes: 30, locale: user.locale },
  user.email,
);
// on shutdown
await mailer.close();
```

- `send(template, props, to)` renders HTML and a plain-text alternative, sets `From`
  (`MAIL_FROM`, otherwise `"<instance name>" <noreply@…>`: the flagship's noreply contact on the
  flagship, `noreply@<public host>` elsewhere), `Auto-Submitted: auto-generated`, and for
  member announcements (governance vote opened / result published, the go-live digest)
  `List-Unsubscribe` plus RFC 8058 `List-Unsubscribe-Post`. The unsubscribe URL must accept a
  one-click `POST`.
- `to` must be one bare address; anything else throws `InvalidRecipientError`.
- **Links are declared per template** (`links: ["resetUrl"]`). Each declared field must be an
  absolute http(s) URL on the instance's `PUBLIC_URL` origin, without credentials, whitespace,
  control characters or backslashes, or rendering throws `EmailLinkError` (naming the field, not
  the value). The normalised `url.href` is what is rendered and put into `List-Unsubscribe`.
  Every other field is free text, always rendered as escaped text, never as a link, so a title
  that contains a URL cannot block a required notice. Signed downloads (data exports) go through
  an instance page that checks the session and redirects, never a raw storage URL.
- **Link lists** (`linkLists: [{ field: "channels", key: "url" }]`) declare array fields whose
  items carry a link; each item's link is checked and normalised exactly like a `links` field
  (the `EmailLinkError` names `channels[1].url`, never the value).
- **Unsubscribe URLs** are `${PUBLIC_URL}/api/email/unsubscribe?list=<list>&token=<token>`
  (`EMAIL_UNSUBSCRIBE_PATH`; lists `go_live` and `governance`; the token is
  `signUnsubscribeToken(AUTH_SECRET, userId, list)` from `@commonair/tokens`, with no expiry). The
  API answers a `POST` (RFC 8058 one-click) by turning that list's email off, and a `GET` with a
  303 to the web confirm page `/settings/notifications/unsubscribe` with the same query.
- STARTTLS is required (`requireTLS`) when `SMTP_REQUIRE_TLS=true`, and always when SMTP
  credentials are configured without implicit TLS. `close()` waits for in-flight sends, then
  rejects new ones with `MailerClosedError`.
- Tests use `new MemoryMailer({ site })`, which renders identically and records `sent`.

## Templates

| id                                            | data                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------- |
| `verifyEmail`                                 | `displayName`, `verifyUrl`, `expiresInMinutes`                                     |
| `magicLink`                                   | `signInUrl`, `expiresInMinutes`                                                    |
| `passwordReset`                               | `resetUrl`, `expiresInMinutes`                                                     |
| `twoFactorEnabled` / `twoFactorDisabled`      | `changedAt`, `securityUrl`                                                         |
| `newSignIn`                                   | `signedInAt`, `device`, `approximateLocation?`, `sessionsUrl`                      |
| `streamKeyRevoked`                            | `channelName`, `detectedAt`, `foundIn?`, `streamKeysUrl`                           |
| `dataExportReady`                             | `downloadUrl`, `expiresAt`                                                         |
| `accountDeletionScheduled`                    | `deleteAt`, `cancelUrl`                                                            |
| `accountDeletionCompleted`                    | `deletedAt`                                                                        |
| `payoutSent`                                  | `amountCents`, `currency`, `sentAt`, `reference`, `earningsUrl`                    |
| `chargebackNotice`                            | `kind` (`chargeback`/`clawback`), amount, `occurredAt`, `reference`, …             |
| `governanceVoteOpened`                        | `proposalTitle`, `closesAt`, `voteUrl`, `unsubscribeUrl`                           |
| `governanceResultPublished`                   | `proposalTitle`, `outcome`, `turnout` (0..1), `resultUrl`, `unsubscribeUrl`        |
| `councilReviewRequested` (to council members) | `proposalTitle`, `reviewEndsAt`, `respondUrl`                                      |
| `goLiveDigest` (opt-in go-live digest)        | `channels` (`name`, `title`, `url`; 20 listed), `settingsUrl`, `unsubscribeUrl`    |
| `dmcaNoticeReceived`                          | `contentTitle`, `noticeRef`, `receivedAt`, `noticeUrl`                             |
| `contentRestored`                             | `contentTitle`, `restoredAt`, `contentUrl`                                         |
| `appealDecided`                               | `appealRef`, `kind`, `outcome` (`upheld`/`overturned`), `decidedAt`, `decisionUrl` |

Dates are `Date` or ISO 8601 strings and are shown in UTC; money is integer minor units with an
ISO 4217 currency. `TemplateData<"payoutSent">` gives the exact type.

Design rules: semantic headings, high contrast in light and dark (`prefers-color-scheme`),
system font stack, **no remote assets** (no images, fonts, pixels or stylesheets), and an
instance footer with the contact address and the AGPL §13 source link (`instanceSite()`).

## Translations

The strings live in `src/messages/locales/<lang>/<group>.json`, one file per template group
(`layout`, `account`, `security`, `privacy`, `payments`, `governance`, `notify`, `trust`), flat
`block.field` keys (`verifyEmail.subject`) in the ICU subset of ADR 0029 (`{name}`, `plural` with
`#`, `select`; see `apps/web/src/i18n/README.md`). English is the source; `EmailCatalog` is typed
from the English JSON (`src/messages/en.ts`), so a missing key is a type error in a template.
Translator notes: [`src/messages/NOTES.md`](src/messages/NOTES.md).

- **Every locale is bundled** (`BUNDLED`, `src/messages/bundled.ts`): mail renders on the server
  only. Today: `en`, `es`. Adding a language is adding `locales/<lang>/*.json` and one line in
  `bundled.ts` (a test fails until it is there).
- **Resolution**: a `locale` per message (null: `site.defaultLocale`); the exact tag, then its
  language (`es-MX` → `es`), then English. Passing `catalogs` (a `PartialCatalog` per tag) to the
  mailer or `renderEmail` replaces the bundled set.
- **Fallback per string**: a missing string, one that does not parse, or one whose arguments differ
  from English's renders English (`catalogFallbacks(partial)` lists them). The tests require every
  bundled locale at 100% with argument parity (`checkCatalog`, `coverage`).
- **Direction** comes from the locale (`localeDirection`, `<html dir>`), not from a string.

## Preview

```sh
bun run preview                    # → .preview/index.html (gitignored)
bun run preview --locale es        # Spanish (any bundled locale)
bun run preview --locale de        # English strings, German date/number formatting
```

## Tests

`bun run test` renders every template (text snapshots in English and Spanish, link and asset
checks, catalog parity and coverage, plurals, a pseudo-locale
that must replace every visible string). `bun run test:int` sends through Mailpit
(`localhost:1025`) and reads the message back from its API.
