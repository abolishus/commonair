// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What the checklist reads and writes; the real API by default, a fake in tests. */
import type { StreamSetupState } from "@commonair/contracts/dto";
import type { StreamSetupMarkable } from "@commonair/contracts/enums";
import { api } from "../../lib/api.ts";
import type { StreamHealthDto } from "../../lib/stream-health.ts";
import type { Ingest } from "./encoder-guide.tsx";

export interface SetupClient {
  state(channel: string): Promise<StreamSetupState>;
  mark(channel: string, step: StreamSetupMarkable): Promise<unknown>;
  ingest(channel: string): Promise<Ingest>;
  obsConfig(channel: string): Promise<{ filename: string; json: string }>;
  /** `stream.rotateKey`: the full key, shown once. */
  createKey(channel: string): Promise<{ key: string; prefix: string }>;
  health(channel: string): Promise<StreamHealthDto>;
  /** Follows made through every move link (`portability.links.list`), summed. */
  followLinkConversions(channel: string): Promise<number>;
  /** A new, open-ended move link (`portability.links.create`); its URL is returned once. */
  createFollowLink(channel: string): Promise<{ url: string }>;
}

export const apiSetupClient: SetupClient = {
  state: (channel) => api().stream.setupState({ channel }),
  mark: (channel, step) => api().stream.setupMark({ channel, step }),
  ingest: (channel) => api().stream.ingest({ channel }),
  obsConfig: (channel) => api().stream.obsConfig({ channel }),
  createKey: (channel) => api().stream.rotateKey({ channel }),
  health: (channel) => api().stream.health({ channel }),
  followLinkConversions: async (channel) =>
    (await api().portability.links.list({ channel })).reduce((n, l) => n + l.conversions, 0),
  createFollowLink: async (channel) => {
    const link = await api().portability.links.create({ channel, expiresAt: null });
    return { url: link.url };
  },
};
