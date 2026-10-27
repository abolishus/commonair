// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmailCatalog } from "./messages/en.ts";
import type { TemplateDefinition, TemplateId } from "./template.tsx";
import { magicLink, passwordReset, verifyEmail } from "./templates/account.tsx";
import { councilReviewRequested, governanceResultPublished, governanceVoteOpened } from "./templates/governance.tsx";
import { chargebackNotice, payoutSent } from "./templates/payments.tsx";
import { accountDeletionCompleted, accountDeletionScheduled, dataExportReady } from "./templates/privacy.tsx";
import { newSignIn, streamKeyRevoked, twoFactorDisabled, twoFactorEnabled } from "./templates/security.tsx";
import {
  appealDecided,
  contentRestored,
  dmcaCounterNoticeForwarded,
  dmcaNoticeDecided,
  dmcaNoticeReceived,
} from "./templates/trust.tsx";

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
  dmcaNoticeDecided,
  dmcaCounterNoticeForwarded,
  contentRestored,
  appealDecided,
} satisfies {
  [K in TemplateId]: Omit<TemplateDefinition<never, EmailCatalog[K]>, "links"> & { links: readonly string[] };
};

export type Templates = typeof templates;

/** The data a template needs, e.g. `TemplateData<"payoutSent">`. */
export type TemplateData<K extends TemplateId> = Templates[K] extends { body(ctx: never, data: infer D): unknown }
  ? D
  : never;

export const TEMPLATE_IDS = Object.keys(templates) as TemplateId[];
