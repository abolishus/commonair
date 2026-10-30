// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "./format.ts";
export * from "./mailer.ts";
export * from "./messages/index.ts";
export * from "./registry.ts";
export * from "./render.tsx";
export * from "./samples.ts";
export type { EmailContext, TemplateDefinition, TemplateId } from "./template.tsx";
export type * from "./templates/account.tsx";
export type * from "./templates/governance.tsx";
export { GO_LIVE_DIGEST_MAX_CHANNELS } from "./templates/notify.tsx";
export type * from "./templates/notify.tsx";
export type * from "./templates/payments.tsx";
export type * from "./templates/privacy.tsx";
export type * from "./templates/security.tsx";
export type * from "./templates/trust.tsx";
