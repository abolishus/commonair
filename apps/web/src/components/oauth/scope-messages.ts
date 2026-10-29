// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every OAuth scope in plain words (ADR 0027 §1: `oauth.scope.<name>`, colons as dots). The
 * English in `@commonair/contracts/scopes` is API reference text; this is what a viewer or a
 * streamer reads before granting it. Literal keys only, so the i18n tests can see each one.
 */
import type { Scope } from "@commonair/contracts/scopes";
import type { MessageKey } from "../../i18n/index.ts";

export interface ScopeMessage {
  /** A few words: what the app may do. */
  title: MessageKey;
  /** One sentence. */
  body: MessageKey;
}

export const SCOPE_MESSAGES: Readonly<Record<Scope, ScopeMessage>> = {
  "chat:read": { title: "oauth.scope.chat.read.title", body: "oauth.scope.chat.read.body" },
  "chat:edit": { title: "oauth.scope.chat.edit.title", body: "oauth.scope.chat.edit.body" },
  "moderator:manage:chat": {
    title: "oauth.scope.moderator.manage.chat.title",
    body: "oauth.scope.moderator.manage.chat.body",
  },
  "channel:manage": { title: "oauth.scope.channel.manage.title", body: "oauth.scope.channel.manage.body" },
  "channel:read:subscriptions": {
    title: "oauth.scope.channel.read.subscriptions.title",
    body: "oauth.scope.channel.read.subscriptions.body",
  },
  "channel:read:tips": { title: "oauth.scope.channel.read.tips.title", body: "oauth.scope.channel.read.tips.body" },
  "channel:manage:polls": {
    title: "oauth.scope.channel.manage.polls.title",
    body: "oauth.scope.channel.manage.polls.body",
  },
  "channel:manage:predictions": {
    title: "oauth.scope.channel.manage.predictions.title",
    body: "oauth.scope.channel.manage.predictions.body",
  },
  "channel:manage:raids": {
    title: "oauth.scope.channel.manage.raids.title",
    body: "oauth.scope.channel.manage.raids.body",
  },
  "channel:manage:bot": { title: "oauth.scope.channel.manage.bot.title", body: "oauth.scope.channel.manage.bot.body" },
  "channel:read:points": {
    title: "oauth.scope.channel.read.points.title",
    body: "oauth.scope.channel.read.points.body",
  },
  "channel:manage:points": {
    title: "oauth.scope.channel.manage.points.title",
    body: "oauth.scope.channel.manage.points.body",
  },
  "user:read:email": { title: "oauth.scope.user.read.email.title", body: "oauth.scope.user.read.email.body" },
  "user:read:follows": { title: "oauth.scope.user.read.follows.title", body: "oauth.scope.user.read.follows.body" },
  "user:manage:follows": {
    title: "oauth.scope.user.manage.follows.title",
    body: "oauth.scope.user.manage.follows.body",
  },
  "clips:edit": { title: "oauth.scope.clips.edit.title", body: "oauth.scope.clips.edit.body" },
};

/**
 * Scopes that reach private data or act with real weight (the brief's list): marked "sensitive"
 * wherever they are shown.
 */
export const SENSITIVE_SCOPES: ReadonlySet<Scope> = new Set<Scope>([
  "user:read:email",
  "channel:manage",
  "moderator:manage:chat",
  "channel:manage:points",
]);

export const isSensitiveScope = (scope: Scope): boolean => SENSITIVE_SCOPES.has(scope);
