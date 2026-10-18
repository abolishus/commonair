// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmailCatalog } from "./messages/en.ts";
import type { TemplateDefinition, TemplateId } from "./template.tsx";
import { magicLink, passwordReset, verifyEmail } from "./templates/account.tsx";
import { councilReviewRequested, governanceResultPublished, governanceVoteOpened } from "./templates/governance.tsx";
import { chargebackNotice, payoutSent } from "./templates/payments.tsx";
import { accountDeletionCompleted, accountDeletionScheduled, dataExportReady } from "./templates/privacy.tsx";
import { newSignIn, streamKeyRevoked, twoFactorDisabled, twoFactorEnabled } from "./templates/security.tsx";
import { appealDecided, contentRestored, dmcaNoticeReceived } from "./templates/trust.tsx";

/** Every email the platform sends, by id. The catalog has one message block per id. */
export const templates = {
  verifyEmail,
  magicLink,
  passwordReset,
  twoFactorEnabled,
  twoFactorDisabled,
  newSignIn,
  streamKeyRevoked,
  dataExportReady,
  accountDeletionScheduled,
  accountDeletionCompleted,
  payoutSent,
  chargebackNotice,
  governanceVoteOpened,
  governanceResultPublished,
  councilReviewRequested,
  dmcaNoticeReceived,
  contentRestored,
  appealDecided,
} satisfies { [K in TemplateId]: TemplateDefinition<never, EmailCatalog[K]> };

export type Templates = typeof templates;

/** The data a template needs, e.g. `TemplateData<"payoutSent">`. */
export type TemplateData<K extends TemplateId> =
  Templates[K] extends TemplateDefinition<infer D, EmailCatalog[K]> ? D : never;

export const TEMPLATE_IDS = Object.keys(templates) as TemplateId[];
