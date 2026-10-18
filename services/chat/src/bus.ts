// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Valkey pub/sub with reference-counted subscriptions: an instance listens on a room's
 * channels only while it has local members there. Pub/sub channel names are not affected
 * by a client `keyPrefix`, so `prefix` namespaces them explicitly (tests use it for isolation).
 */
import type { ValkeyClient } from "@commonair/service";
import type { Logger } from "@commonair/observability";
import { BUS } from "@commonair/contracts";

export type BusHandler = (message: string) => void;

export class Bus {
  private readonly subs = new Map<string, { refs: number; ready: Promise<unknown>; handler: BusHandler }>();

  constructor(
    private readonly pub: ValkeyClient,
    private readonly sub: ValkeyClient,
    private readonly prefix: string,
    private readonly logger: Logger,
  ) {
    sub.on("message", (channel: string, message: string) => {
      const entry = this.subs.get(channel);
      if (!entry) return;
      try {
        entry.handler(message);
      } catch (err) {
        this.logger.error("bus handler failed", { err, channel });
      }
    });
  }

  readonly names = {
    chat: (channelId: string) => this.prefix + BUS.chat(channelId),
    control: (channelId: string) => this.prefix + BUS.chatControl(channelId),
    events: () => this.prefix + BUS.events,
    live: () => this.prefix + BUS.live,
  };

  /** Subscribe (or add a reference). The first subscriber's handler is used for the channel. */
  async acquire(channel: string, handler: BusHandler): Promise<void> {
    const entry = this.subs.get(channel);
    if (entry) {
      entry.refs++;
      await entry.ready;
      return;
    }
    const ready = this.sub.subscribe(channel);
    this.subs.set(channel, { refs: 1, ready, handler });
    try {
      await ready;
    } catch (err) {
      this.subs.delete(channel);
      throw err;
    }
  }

  async release(channel: string): Promise<void> {
    const entry = this.subs.get(channel);
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    this.subs.delete(channel);
    // Commands on one connection run in order, so a racing re-acquire's SUBSCRIBE lands after this.
    await this.sub
      .unsubscribe(channel)
      .catch((err: unknown) => this.logger.warn("unsubscribe failed", { err, channel }));
  }

  isSubscribed(channel: string): boolean {
    return this.subs.has(channel);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.pub.publish(channel, message);
  }
}
