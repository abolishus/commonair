// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The calls the developer console (`/developer`, `/developer/apps/$appId`, `/developer/bots`) and
 * the admin apps page (`/admin/apps`) make, as small interfaces: the routes pass the real API,
 * tests pass fakes.
 */
import type { Api } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";

type Out<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;
type In<F extends (...args: never[]) => unknown> = Parameters<F>[0];

type Dev = Api["developer"];

export type OAuthAppDto = Out<Dev["apps"]["list"]>[number];
export type OAuthAppSecretDto = Out<Dev["apps"]["rotateSecret"]>;
export type AppCreateInput = In<Dev["apps"]["create"]>;
export type AppUpdateInput = In<Dev["apps"]["update"]>;
export type CatalogEntry = Out<Dev["events"]["catalog"]>[number];
export type SubscriptionDto = Out<Dev["events"]["list"]>["items"][number];
export type SubscribeInput = In<Dev["events"]["subscribe"]>;
export type DeliveryDto = Out<Dev["events"]["deliveries"]>["items"][number];
export type AccessTokenDto = Out<Dev["tokens"]["list"]>[number];
export type BotDto = Out<Api["me"]["bots"]["list"]>[number];
export type BotCreateInput = In<Api["me"]["bots"]["create"]>;
export type BotTokenInput = In<Api["me"]["bots"]["createToken"]>;
export type AdminOAuthAppDto = Out<Dev["admin"]["list"]>["items"][number];
export type SuspensionReason = In<Dev["admin"]["suspend"]>["reason"];

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Rows per page on every paged list here. */
export const PAGE_SIZE = 25;

export interface DeveloperClient {
  apps: {
    list(): Promise<OAuthAppDto[]>;
    create(input: AppCreateInput): Promise<{ app: OAuthAppDto; secret: OAuthAppSecretDto | null }>;
    update(input: AppUpdateInput): Promise<OAuthAppDto>;
    rotateSecret(input: { id: string }): Promise<OAuthAppSecretDto>;
    remove(input: { id: string }): Promise<unknown>;
  };
  events: {
    catalog(): Promise<CatalogEntry[]>;
    list(input: { appId: string; cursor?: string; limit: number }): Promise<Page<SubscriptionDto>>;
    subscribe(input: SubscribeInput): Promise<SubscriptionDto>;
    unsubscribe(input: { id: string }): Promise<unknown>;
    deliveries(input: { id: string; cursor?: string; limit: number }): Promise<Page<DeliveryDto>>;
    sendTest(input: { id: string }): Promise<{ eventId: string }>;
    redeliver(input: { id: string }): Promise<unknown>;
  };
  tokens: {
    list(): Promise<AccessTokenDto[]>;
    revoke(input: { id: string }): Promise<unknown>;
  };
  bots: {
    list(): Promise<BotDto[]>;
    create(input: BotCreateInput): Promise<BotDto>;
    createToken(input: BotTokenInput): Promise<{ token: AccessTokenDto; accessToken: string }>;
  };
}

export interface AdminAppsClient {
  list(input: { q?: string; suspended?: boolean; cursor?: string; limit: number }): Promise<Page<AdminOAuthAppDto>>;
  suspend(input: { id: string; reason: SuspensionReason }): Promise<AdminOAuthAppDto>;
  unsuspend(input: { id: string }): Promise<AdminOAuthAppDto>;
}

export function developerClient(): DeveloperClient {
  const a = api();
  const d = a.developer;
  return {
    apps: {
      list: () => d.apps.list(),
      create: (input) => d.apps.create(input),
      update: (input) => d.apps.update(input),
      rotateSecret: (input) => d.apps.rotateSecret(input),
      remove: (input) => d.apps.remove(input),
    },
    events: {
      catalog: () => d.events.catalog(),
      list: (input) => d.events.list(input),
      subscribe: (input) => d.events.subscribe(input),
      unsubscribe: (input) => d.events.unsubscribe(input),
      deliveries: (input) => d.events.deliveries(input),
      sendTest: (input) => d.events.sendTest(input),
      redeliver: (input) => d.events.redeliver(input),
    },
    tokens: {
      list: () => d.tokens.list(),
      revoke: (input) => d.tokens.revoke(input),
    },
    bots: {
      list: () => a.me.bots.list(),
      create: (input) => a.me.bots.create(input),
      createToken: (input) => a.me.bots.createToken(input),
    },
  };
}

export function adminAppsClient(): AdminAppsClient {
  const d = api().developer.admin;
  return {
    list: (input) => d.list(input),
    suspend: (input) => d.suspend(input),
    unsuspend: (input) => d.unsuspend(input),
  };
}
