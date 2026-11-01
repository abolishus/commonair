// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media session hooks (batch 6 decision (n)): per-broadcast work that runs beside the ladder
 * without editing `session.ts` or `service.ts`. A feature registers `{onStart, onEnd}` once at
 * service start (`captions/index.ts` does); every broadcast session then calls `onStart` when it
 * starts and `onEnd` when it stops.
 *
 * - Hooks run concurrently with the ladder, recorder and samplers and are guarded: a hook that
 *   throws is logged and never stops the broadcast or another hook.
 * - `onEnd` runs on every stop (`final` false when the service is shutting down and a successor
 *   resumes the broadcast) and is awaited **before** the VOD finalize job is enqueued, so a hook
 *   that writes under the VOD's prefix (captions: `<prefix>captions/<lang>.vtt`) finishes before
 *   `vod-finalize` lists and moves that prefix. A hook must not write under the prefix after its
 *   `onEnd` has resolved. A stop that fails and is retried calls `onEnd` again: keep it idempotent.
 * - `onStart` is not awaited by the ladder: a slow hook delays nothing else.
 */
import type { BROADCAST_KINDS } from "@commonair/contracts/enums";
import type { Logger } from "@commonair/observability";
import { errorCategory } from "./moderation/logging.ts";

/** What a hook learns about a broadcast session. */
export interface MediaSessionInfo {
  broadcastId: string;
  channelId: string;
  slug: string;
  /** MediaMTX path, `live/<slug>`. */
  path: string;
  /** `rehearsal` sessions get no captions, DVR or simulcast (decision (g)). */
  kind: (typeof BROADCAST_KINDS)[number];
  startedAt: Date;
  /** The VOD being recorded, or null when the channel keeps no VODs. */
  vodId: string | null;
}

export interface SessionEnd {
  /** True when the broadcast ended; false when this process is shutting down (the broadcast may resume elsewhere). */
  final: boolean;
}

export interface MediaSessionHook {
  /** For logs. */
  name: string;
  onStart(session: MediaSessionInfo): Promise<void>;
  onEnd(session: MediaSessionInfo, end: SessionEnd): Promise<void>;
}

export class MediaSessionHooks {
  private readonly hooks: MediaSessionHook[] = [];

  constructor(private readonly logger?: Logger) {}

  register(hook: MediaSessionHook): void {
    if (this.hooks.some((h) => h.name === hook.name)) throw new Error(`session hook already registered: ${hook.name}`);
    this.hooks.push(hook);
  }

  get names(): string[] {
    return this.hooks.map((h) => h.name);
  }

  /** Every hook's `onStart`; resolves once all have settled. Never rejects. */
  start(session: MediaSessionInfo): Promise<void> {
    return this.each(session, "onStart", (h) => h.onStart(session));
  }

  /** Every hook's `onEnd`; resolves once all have settled. Never rejects. */
  end(session: MediaSessionInfo, end: SessionEnd): Promise<void> {
    return this.each(session, "onEnd", (h) => h.onEnd(session, end));
  }

  private async each(
    session: MediaSessionInfo,
    phase: "onStart" | "onEnd",
    fn: (h: MediaSessionHook) => Promise<void>,
  ): Promise<void> {
    await Promise.all(
      this.hooks.map(async (h) => {
        try {
          await fn(h);
        } catch (err) {
          this.logger?.warn("media session hook failed", {
            hook: h.name,
            phase,
            broadcastId: session.broadcastId,
            error: errorCategory(err),
          });
        }
      }),
    );
  }
}
