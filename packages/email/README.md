<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/email

Transactional and member email for CommonAir: React Email templates, an English message
catalog, and an SMTP mailer (nodemailer).

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
  member announcements (governance vote opened / result published) `List-Unsubscribe` plus
  RFC 8058 `List-Unsubscribe-Post`. The unsubscribe URL must accept a one-click `POST`.
- `to` must be one bare address; anything else throws `InvalidRecipientError`.
- **Links are declared per template** (`links: ["resetUrl"]`). Each declared field must be an
  absolute http(s) URL on the instance's `PUBLIC_URL` origin, without credentials, whitespace,
  control characters or backslashes, or rendering throws `EmailLinkError` (naming the field, not
  the value). The normalised `url.href` is what is rendered and put into `List-Unsubscribe`.
  Every other field is free text, always rendered as escaped text, never as a link, so a title
  that contains a URL cannot block a required notice. Signed downloads (data exports) go through
  an instance page that checks the session and redirects, never a raw storage URL.
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
| `dmcaNoticeReceived`                          | `contentTitle`, `noticeRef`, `receivedAt`, `noticeUrl`                             |
| `contentRestored`                             | `contentTitle`, `restoredAt`, `contentUrl`                                         |
| `appealDecided`                               | `appealRef`, `kind`, `outcome` (`upheld`/`overturned`), `decidedAt`, `decisionUrl` |

Dates are `Date` or ISO 8601 strings and are shown in UTC; money is integer minor units with an
ISO 4217 currency. `TemplateData<"payoutSent">` gives the exact type.

Design rules: semantic headings, high contrast in light and dark (`prefers-color-scheme`),
system font stack, **no remote assets** (no images, fonts, pixels or stylesheets), and an
instance footer with the contact address and the AGPL §13 source link (`instanceSite()`).

## Translations

`src/messages/en.ts` is the catalog and its shape (`EmailCatalog`). A translation is a
`PartialCatalog`; missing strings fall back to English. Pass catalogs to the mailer and a
`locale` per message; `pt-BR` falls back to `pt`, then English. Set `layout.dir` to `"rtl"` for
right-to-left languages. Keep every `{placeholder}`.

## Preview

```sh
bun run preview                    # → .preview/index.html (gitignored)
bun run preview --locale de        # German date/number formatting
```

## Tests

`bun run test` renders every template (text snapshots, link and asset checks, a pseudo-locale
that must replace every visible string). `bun run test:int` sends through Mailpit
(`localhost:1025`) and reads the message back from its API.
